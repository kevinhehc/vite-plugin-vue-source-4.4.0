import path from 'node:path'
import slash from 'slash'
import type {
  CompilerOptions,
  SFCDescriptor,
  SFCTemplateCompileOptions,
  SFCTemplateCompileResults,
} from 'vue/compiler-sfc'
import type { PluginContext, TransformPluginContext } from 'rollup'
import { getResolvedScript, resolveScript } from './script'
import { createRollupError } from './utils/error'
import type { ResolvedOptions } from '.'

// 把 Vue 单文件组件的 <template> 编译成 JS 模块，并在开发环境下为其注入 HMR 热更新支持。
export async function transformTemplateAsModule(
  // 参数	类型	说明
  // code	string	<template> 的原始源码内容
  // descriptor	SFCDescriptor	.vue 文件结构描述信息
  // options	ResolvedOptions	插件的配置（是否生产环境、是否开启 HMR 等）
  // pluginContext	TransformPluginContext	当前 Vite 插件的上下文（用于发警告、缓存、错误处理）
  // ssr	boolean	是否在 SSR 模式下构建
  code: string,
  descriptor: SFCDescriptor,
  options: ResolvedOptions,
  pluginContext: TransformPluginContext,
  ssr: boolean,
): Promise<{
  code: string
  map: any
}> {
  // 编译 template
  const result = compile(code, descriptor, options, pluginContext, ssr)

  let returnCode = result.code
  if (
    options.devServer &&
    options.devServer.config.server.hmr !== false &&
    !ssr &&
    !options.isProduction
  ) {
    // 条件触发的逻辑：
    // 当前有 dev server（即正在开发）
    // SSR 模式关闭
    // 非生产环境
    // HMR 没有被手动禁用
    returnCode += `\nimport.meta.hot.accept(({ render }) => {
      __VUE_HMR_RUNTIME__.rerender(${JSON.stringify(descriptor.id)}, render)
    })`
    // import.meta.hot.accept(({ render }) => {
    //   __VUE_HMR_RUNTIME__.rerender('component-id', render)
    // 这是 Vue 的 HMR runtime 机制
    // 会将新的 render() 函数热替换到现有组件中
    // 避免整个页面 reload，提高开发体验
  }

  return {
    code: returnCode,
    map: result.map,
  }
}

/**
 * transform the template directly in the main SFC module
 * 这个函数不是生成独立的 template 模块，而是为了将 <template> 的 render 函数“直接嵌入到主模块（script 模块）中”。
 * 它通常用于：
 * inline 模式（template 不拆分成独立模块）
 * SSR 构建
 * 合并代码，减少模块数量
 */
export function transformTemplateInMain(
  // 参数	类型	说明
  // code	string	<template> 原始源码
  // descriptor	SFCDescriptor	.vue 文件的结构信息
  // options	ResolvedOptions	插件配置
  // pluginContext	PluginContext	Vite 插件上下文，用于报错/缓存等
  // ssr	boolean	是否在 SSR 模式下构建
  code: string,
  descriptor: SFCDescriptor,
  options: ResolvedOptions,
  pluginContext: PluginContext,
  ssr: boolean,
): SFCTemplateCompileResults {
  // 这里底层是调用 vue/compiler-sfc.compileTemplate() 得到：
  // export function render() { ... }
  // 或 SSR 情况下是：
  // export function ssrRender() { ... }
  const result = compile(code, descriptor, options, pluginContext, ssr)
  return {
    ...result,
    // 替换导出名称 → 变成变量（让主模块能引用）
    code: result.code.replace(
      /\nexport (function|const) (render|ssrRender)/,
      '\n$1 _sfc_$2',
    ),
  }
}

// 调用 vue/compiler-sfc 的 compileTemplate() 方法来编译 Vue <template>，并处理所有编译错误/提示，最后将编译结果返回给调用者。
export function compile(
  code: string, // 原始 template 内容
  descriptor: SFCDescriptor, // .vue 文件的结构
  options: ResolvedOptions, // 插件配置（包含 compiler）
  pluginContext: PluginContext, // Vite 插件上下文（用于报错）
  ssr: boolean, // 是否为 SSR 构建
): any {
  const filename = descriptor.filename

  // 虽然这里是处理 <template>，但还是要预先解析 script 块，因为：
  // script setup 会影响 template（比如自动导入变量、bindings）
  // compileTemplate 需要 binding metadata 来正确处理表达式中的标识符（如 msg, count）
  resolveScript(descriptor, options, ssr)

  // vue/compiler-sfc.compileTemplate()
  const result = options.compiler.compileTemplate({
    ...resolveTemplateCompilerOptions(descriptor, options, ssr)!,
    source: code,
  })

  // 如果是字符串报错（简易错误），直接构造 Vite 报错
  // 如果是 CompilerError，用 createRollupError() 转换成 Rollup 格式，提供文件、行号等信息
  if (result.errors.length) {
    result.errors.forEach((error) =>
      pluginContext.error(
        typeof error === 'string'
          ? { id: filename, message: error }
          : createRollupError(filename, error),
      ),
    )
  }

  // 有些编译器会输出 tip（建议、性能优化等），例如：
  // "Avoid using large v-if trees"、"Prefer v-show when possible"
  if (result.tips.length) {
    result.tips.forEach((tip) =>
      pluginContext.warn({
        id: filename,
        message: tip,
      }),
    )
  }

  return result
}

// 生成完整的配置对象，确保 <template> 能正确编译，包括作用域、路径解析、预处理器、TS 支持等。
// 这个函数负责根据当前 .vue 文件 (descriptor) 和插件配置 (options)，动态构造一个 SFCTemplateCompileOptions（去掉 source 字段）传给 Vue 编译器。
export function resolveTemplateCompilerOptions(
  descriptor: SFCDescriptor, // 当前 .vue 文件结构信息
  options: ResolvedOptions, // 插件整体配置（包括 dev/build 模式）
  ssr: boolean, // 是否 SSR 渲染
): Omit<SFCTemplateCompileOptions, 'source'> | undefined {
  // 如果没有 <template>，返回 undefined
  const block = descriptor.template
  if (!block) {
    return
  }

  // 解析 <script> 提前绑定信息（用于 compileTemplate）
  const resolvedScript = getResolvedScript(descriptor, ssr)
  // 如果是 scoped，需要设置 scopeId 给 template 编译器，用于生成作用域 CSS 属性。
  const hasScoped = descriptor.styles.some((s) => s.scoped)
  const { id, filename, cssVars } = descriptor

  // 处理资源路径
  let transformAssetUrls = options.template?.transformAssetUrls
  // compiler-sfc should export `AssetURLOptions`
  let assetUrlOptions //: AssetURLOptions | undefined
  if (options.devServer) {
    // during dev, inject vite base so that compiler-sfc can transform
    // relative paths directly to absolute paths without incurring an extra import
    // request
    if (filename.startsWith(options.root)) {
      // 使得 <img src> 的路径能转换成 http://localhost:5173/src/assets/...
      const devBase = options.devServer.config.base
      assetUrlOptions = {
        base:
          (options.devServer.config.server?.origin ?? '') +
          devBase +
          slash(path.relative(options.root, path.dirname(filename))),
      }
    }
  } else if (transformAssetUrls !== false) {
    // build: force all asset urls into import requests so that they go through
    // the assets plugin for asset registration
    // 强制所有资源都走 Vite 的静态资源插件（包括绝对路径）。
    assetUrlOptions = {
      includeAbsolute: true,
    }
  }

  // 合并用户配置的 transformAssetUrls
  if (transformAssetUrls && typeof transformAssetUrls === 'object') {
    // presence of array fields means this is raw tags config
    if (Object.values(transformAssetUrls).some((val) => Array.isArray(val))) {
      transformAssetUrls = {
        ...assetUrlOptions,
        tags: transformAssetUrls as any,
      }
    } else {
      transformAssetUrls = { ...assetUrlOptions, ...transformAssetUrls }
    }
  } else {
    transformAssetUrls = assetUrlOptions
  }

  let preprocessOptions = block.lang && options.template?.preprocessOptions
  // 模板预处理器（如 pug）支持
  if (block.lang === 'pug') {
    preprocessOptions = {
      doctype: 'html',
      ...preprocessOptions,
    }
  }

  // if using TS, support TS syntax in template expressions
  const expressionPlugins: CompilerOptions['expressionPlugins'] =
    options.template?.compilerOptions?.expressionPlugins || []
  // 支持 typescript 表达式插件（如模板中写 msg as string）
  const lang = descriptor.scriptSetup?.lang || descriptor.script?.lang
  if (lang && /tsx?$/.test(lang) && !expressionPlugins.includes('typescript')) {
    expressionPlugins.push('typescript')
  }

  return {
    ...options.template,
    id,
    filename,
    scoped: hasScoped,
    slotted: descriptor.slotted,
    isProd: options.isProduction,
    inMap: block.src ? undefined : block.map,
    ssr,
    ssrCssVars: cssVars,
    transformAssetUrls,
    preprocessLang: block.lang === 'html' ? undefined : block.lang,
    preprocessOptions,
    compilerOptions: {
      ...options.template?.compilerOptions,
      scopeId: hasScoped ? `data-v-${id}` : undefined,
      bindingMetadata: resolvedScript ? resolvedScript.bindings : undefined,
      expressionPlugins,
      sourceMap: options.sourceMap,
    },
  }
}
