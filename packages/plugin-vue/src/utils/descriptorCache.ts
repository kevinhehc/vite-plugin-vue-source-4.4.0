import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import slash from 'slash'
import type { CompilerError, SFCDescriptor } from 'vue/compiler-sfc'
import type { ResolvedOptions, VueQuery } from '..'

// 文件整体功能概述
// 它实现了对 Vue SFC 的：
// 1、解析
// 2、缓存
// 3、热更新状态追踪
// 4、唯一 ID 生成
// 5、Scoped <style> 源文件支持

// compiler-sfc should be exported so it can be re-used
// 用于保存 compiler.parse 之后的结果，包含：
// descriptor: 描述 Vue 文件结构（script、template、style）
// errors: 解析错误
export interface SFCParseResult {
  descriptor: SFCDescriptor
  errors: (CompilerError | SyntaxError)[]
}

// 正常开发构建时使用的 SFC 缓存
export const cache = new Map<string, SFCDescriptor>()
// 热更新（HMR）时使用的缓存
export const hmrCache = new Map<string, SFCDescriptor>()
// 用于记录上一次的 descriptor，便于对比或恢复
const prevCache = new Map<string, SFCDescriptor | undefined>()

// 用传入的 compiler 解析 Vue SFC 文件
// 计算唯一 id（根据路径 + 内容）用于 HMR 或 CSS scope
// 存入对应缓存（cache 或 hmrCache）
export function createDescriptor(
  filename: string,
  source: string,
  { root, isProduction, sourceMap, compiler }: ResolvedOptions,
  hmr = false,
): SFCParseResult {
  const { descriptor, errors } = compiler.parse(source, {
    filename,
    sourceMap,
  })

  // ensure the path is normalized in a way that is consistent inside
  // project (relative to root) and on different systems.
  const normalizedPath = slash(path.normalize(path.relative(root, filename)))
  descriptor.id = getHash(normalizedPath + (isProduction ? source : ''))
  ;(hmr ? hmrCache : cache).set(filename, descriptor)
  return { descriptor, errors }
}

export function getPrevDescriptor(filename: string): SFCDescriptor | undefined {
  return prevCache.get(filename)
}

// 把旧的解析缓存删除，并存入 prevCache，用于热更新时对比变更。
export function invalidateDescriptor(filename: string, hmr = false): void {
  const _cache = hmr ? hmrCache : cache
  const prev = _cache.get(filename)
  _cache.delete(filename)
  if (prev) {
    prevCache.set(filename, prev)
  }
}

// 获取并可选解析
// 如果没有缓存并设置 createIfNotFound: true，就自动读取并解析文件。
export function getDescriptor(
  filename: string,
  options: ResolvedOptions,
  createIfNotFound = true,
  hmr = false,
): SFCDescriptor | undefined {
  const _cache = hmr ? hmrCache : cache
  if (_cache.has(filename)) {
    return _cache.get(filename)!
  }
  if (createIfNotFound) {
    const { descriptor, errors } = createDescriptor(
      filename,
      fs.readFileSync(filename, 'utf-8'),
      options,
      hmr,
    )
    if (errors.length && !hmr) {
      throw errors[0]
    }
    return descriptor
  }
}

// 用于 <style src="..."> 语法的特殊处理，处理跨文件的 <style> 块，并考虑 scoped 情况。
// 当同一个 CSS 文件被多个 Vue 文件作为 <style src> 引入时，需要为每个 Vue 文件生成唯一的 descriptor。
export function getSrcDescriptor(
  filename: string,
  query: VueQuery,
): SFCDescriptor {
  if (query.scoped) {
    return cache.get(`${filename}?src=${query.src}`)!
  }
  return cache.get(filename)!
}

export function getTempSrcDescriptor(
  filename: string,
  query: VueQuery,
): SFCDescriptor {
  // this is only used for pre-compiled <style src> with scoped flag
  return {
    filename,
    id: query.id || '',
    styles: [
      {
        scoped: query.scoped,
        loc: {
          start: { line: 0, column: 0 },
        },
      },
    ],
  } as SFCDescriptor
}

// 手动设置缓存
export function setSrcDescriptor(
  filename: string,
  entry: SFCDescriptor,
  scoped?: boolean,
): void {
  if (scoped) {
    // if multiple Vue files use the same src file, they will be overwritten
    // should use other key
    cache.set(`${filename}?src=${entry.id}`, entry)
    return
  }
  cache.set(filename, entry)
}

// 用于生成唯一 ID
// 确保每个 SFC 文件有唯一 id，用于：
// HMR 比对
// Scoped CSS 作用域名生成
function getHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').substring(0, 8)
}
