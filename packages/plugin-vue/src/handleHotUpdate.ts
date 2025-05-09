import _debug from 'debug'
import type { SFCBlock, SFCDescriptor } from 'vue/compiler-sfc'
import type { HmrContext, ModuleNode } from 'vite'
import { isCSSRequest } from 'vite'

import {
  createDescriptor,
  getDescriptor,
  invalidateDescriptor,
} from './utils/descriptorCache'
import {
  getResolvedScript,
  invalidateScript,
  setResolvedScript,
} from './script'
import type { ResolvedOptions } from '.'

const debug = _debug('vite:hmr')

const directRequestRE = /(?:\?|&)direct\b/

/**
 * Vite-specific HMR handling
 *
 * 当 .vue 文件内容更新时，Vite 会调用这个函数，让 vite-plugin-vue 判断需要：
 * 1、精准更新某些模块
 * 2、或者整页刷新（full reload）
 */
export async function handleHotUpdate(
  { file, modules, read }: HmrContext,
  options: ResolvedOptions,
): Promise<ModuleNode[] | void> {
  // 读取当前 .vue 文件的新旧结构（SFCDescriptor）

  // prevDescriptor：上一次解析的 Vue 文件结构（缓存）
  const prevDescriptor = getDescriptor(file, options, false, true)
  if (!prevDescriptor) {
    // file hasn't been requested yet (e.g. async component)
    return
  }

  const content = await read()
  // 新内容解析出的 Vue 文件结构
  const { descriptor } = createDescriptor(file, content, options, true)

  let needRerender = false
  const affectedModules = new Set<ModuleNode | undefined>()
  const mainModule = getMainModule(modules)
  const templateModule = modules.find((m) => /type=template/.test(m.url))

  // Script 是否变了？

  const scriptChanged = hasScriptChanged(prevDescriptor, descriptor)
  if (scriptChanged) {
    affectedModules.add(getScriptModule(modules) || mainModule)
  }

  // Template 是否变了？
  // 如果只有 <template> 变了而 <script> 没变，就直接复用旧的 compiled script，避免额外重新编译。
  if (!isEqualBlock(descriptor.template, prevDescriptor.template)) {
    // when a <script setup> component's template changes, it will need correct
    // binding metadata. However, when reloading the template alone the binding
    // metadata will not be available since the script part isn't loaded.
    // in this case, reuse the compiled script from previous descriptor.
    if (!scriptChanged) {
      setResolvedScript(
        descriptor,
        getResolvedScript(prevDescriptor, false)!,
        false,
      )
    }
    affectedModules.add(templateModule)
    needRerender = true
  }

  let didUpdateStyle = false
  const prevStyles = prevDescriptor.styles || []
  const nextStyles = descriptor.styles || []

  // force reload if CSS vars injection changed
  if (prevDescriptor.cssVars.join('') !== descriptor.cssVars.join('')) {
    affectedModules.add(mainModule)
  }

  // force reload if scoped status has changed
  if (prevStyles.some((s) => s.scoped) !== nextStyles.some((s) => s.scoped)) {
    // template needs to be invalidated as well
    affectedModules.add(templateModule)
    affectedModules.add(mainModule)
  }

  // only need to update styles if not reloading, since reload forces
  // style updates as well.
  for (let i = 0; i < nextStyles.length; i++) {
    const prev = prevStyles[i]
    const next = nextStyles[i]
    if (!prev || !isEqualBlock(prev, next)) {
      didUpdateStyle = true
      const mod = modules.find(
        (m) =>
          m.url.includes(`type=style&index=${i}`) &&
          m.url.endsWith(`.${next.lang || 'css'}`) &&
          !directRequestRE.test(m.url),
      )
      if (mod) {
        affectedModules.add(mod)
        if (mod.url.includes('&inline')) {
          affectedModules.add(mainModule)
        }
      } else {
        // new style block - force reload
        affectedModules.add(mainModule)
      }
    }
  }
  if (prevStyles.length > nextStyles.length) {
    // style block removed - force reload
    affectedModules.add(mainModule)
  }

  const prevCustoms = prevDescriptor.customBlocks || []
  const nextCustoms = descriptor.customBlocks || []

  // custom blocks update causes a reload
  // because the custom block contents is changed and it may be used in JS.
  // Custom Blocks 是否变了？
  // 如果变了，也要强制触发更新。
  if (prevCustoms.length !== nextCustoms.length) {
    // block removed/added, force reload
    affectedModules.add(mainModule)
  } else {
    for (let i = 0; i < nextCustoms.length; i++) {
      const prev = prevCustoms[i]
      const next = nextCustoms[i]
      if (!prev || !isEqualBlock(prev, next)) {
        const mod = modules.find((m) =>
          m.url.includes(`type=${prev.type}&index=${i}`),
        )
        if (mod) {
          affectedModules.add(mod)
        } else {
          affectedModules.add(mainModule)
        }
      }
    }
  }

  const updateType = []
  if (needRerender) {
    updateType.push(`template`)
    // template is inlined into main, add main module instead
    if (!templateModule) {
      affectedModules.add(mainModule)
    } else if (mainModule && !affectedModules.has(mainModule)) {
      const styleImporters = [...mainModule.importers].filter((m) =>
        isCSSRequest(m.url),
      )
      styleImporters.forEach((m) => affectedModules.add(m))
    }
  }
  if (didUpdateStyle) {
    updateType.push(`style`)
  }
  if (updateType.length) {
    // invalidate the descriptor cache so that the next transform will
    // re-analyze the file and pick up the changes.
    invalidateDescriptor(file)
    debug(`[vue:update(${updateType.join('&')})] ${file}`)
  }
  return [...affectedModules].filter(Boolean) as ModuleNode[]
}

// 比较两个 SFC 块（如 <script> 或 <style>）是否内容一致。
export function isEqualBlock(a: SFCBlock | null, b: SFCBlock | null): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  // src imports will trigger their own updates
  if (a.src && b.src && a.src === b.src) return true
  if (a.content !== b.content) return false
  const keysA = Object.keys(a.attrs)
  const keysB = Object.keys(b.attrs)
  if (keysA.length !== keysB.length) {
    return false
  }
  return keysA.every((key) => a.attrs[key] === b.attrs[key])
}

export function isOnlyTemplateChanged(
  prev: SFCDescriptor,
  next: SFCDescriptor,
): boolean {
  return (
    !hasScriptChanged(prev, next) &&
    prev.styles.length === next.styles.length &&
    prev.styles.every((s, i) => isEqualBlock(s, next.styles[i])) &&
    prev.customBlocks.length === next.customBlocks.length &&
    prev.customBlocks.every((s, i) => isEqualBlock(s, next.customBlocks[i]))
  )
}

// 内部会比对：
// <script> 内容
// <script setup> 内容
// <script setup> 的 import 是否受 <template> 改动影响
function hasScriptChanged(prev: SFCDescriptor, next: SFCDescriptor): boolean {
  if (!isEqualBlock(prev.script, next.script)) {
    return true
  }
  if (!isEqualBlock(prev.scriptSetup, next.scriptSetup)) {
    return true
  }

  // vue core #3176
  // <script setup lang="ts"> prunes non-unused imports
  // the imports pruning depends on template, so script may need to re-compile
  // based on template changes
  const prevResolvedScript = getResolvedScript(prev, false)
  // this is only available in vue@^3.2.23
  const prevImports = prevResolvedScript?.imports
  if (prevImports) {
    return !next.template || next.shouldForceReload(prevImports)
  }

  return false
}

// 找出该 .vue 文件的主模块（用于热更新）
function getMainModule(modules: ModuleNode[]) {
  return (
    modules
      .filter((m) => !/type=/.test(m.url) || /type=script/.test(m.url))
      // #9341
      // We pick the module with the shortest URL in order to pick the module
      // with the lowest number of query parameters.
      .sort((m1, m2) => {
        return m1.url.length - m2.url.length
      })[0]
  )
}

// 找出该模块对应的 <script> 子模块
function getScriptModule(modules: ModuleNode[]) {
  return modules.find((m) => /type=script.*&lang\.\w+$/.test(m.url))
}

// 用于处理 type 依赖的更新（比如组件用的类型文件 .d.ts 发生变化）
export function handleTypeDepChange(
  affectedComponents: Set<string>,
  { modules, server: { moduleGraph } }: HmrContext,
): ModuleNode[] {
  const affected = new Set<ModuleNode>()
  for (const file of affectedComponents) {
    invalidateScript(file)
    const mods = moduleGraph.getModulesByFile(file)
    if (mods) {
      const arr = [...mods]
      affected.add(getScriptModule(arr) || getMainModule(arr))
    }
  }
  return [...modules, ...affected]
}
