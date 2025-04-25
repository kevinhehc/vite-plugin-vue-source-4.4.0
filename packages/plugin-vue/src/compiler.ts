// 找到正确版本的 vue/compiler-sfc（优先使用用户项目里的）
// 检查 Vue 是否为 3.x（因为 Vue 2.7 也提供了 compiler-sfc，但不兼容）
// 加载并返回该编译器对象供插件其他地方调用
// extend the descriptor so we can store the scopeId on it

// 给 vue/compiler-sfc 里的 SFCDescriptor 类型添加一个额外的 id 字段。
// 这个 id 是在插件内部使用的，比如用于：
// 生成 scope ID
// 缓存 key
// HMR 标识等
declare module 'vue/compiler-sfc' {
  interface SFCDescriptor {
    id: string
  }
}

import { createRequire } from 'node:module'
import type * as _compiler from 'vue/compiler-sfc'

// 先从用户项目根目录查找 vue/compiler-sfc
// 找不到就查找插件自己的依赖（fallback）
// 如果没找到或版本不符合要求，抛出错误
export function resolveCompiler(root: string): typeof _compiler {
  // resolve from project root first, then fallback to peer dep (if any)
  const compiler = tryResolveCompiler(root) || tryResolveCompiler()
  if (!compiler) {
    throw new Error(
      `Failed to resolve vue/compiler-sfc.\n` +
        `@vitejs/plugin-vue requires vue (>=3.2.25) ` +
        `to be present in the dependency tree.`,
    )
  }

  return compiler
}

// 使用 tryRequire 加载 vue/package.json，提取版本号
// 只允许 Vue 3+ 版本
// 然后尝试加载 vue/compiler-sfc
function tryResolveCompiler(root?: string) {
  const vueMeta = tryRequire('vue/package.json', root)
  // make sure to check the version is 3+ since 2.7 now also has vue/compiler-sfc
  if (vueMeta && vueMeta.version.split('.')[0] >= 3) {
    return tryRequire('vue/compiler-sfc', root)
  }
}

// 这行创建了一个兼容 CommonJS 风格的 require()，可以在 ESM 模块里用。
const _require = createRequire(import.meta.url)
function tryRequire(id: string, from?: string) {
  try {
    // 如果指定了 from（项目根路径），就从该路径优先解析模块
    // 否则直接 require(id)
    // 不会抛错，失败则返回 undefined（用于优雅失败）
    return from
      ? _require(_require.resolve(id, { paths: [from] }))
      : _require(id)
  } catch (e) {}
}
