// 用来支持 Vue 组件额外导出逻辑 的辅助模块，
// 它的作用是在编译时为 Vue SFC 组件添加额外的导出信息（比如给组件添加 __file、__scopeId、或者用户自定义的静态属性等）。

// \0 是一个特殊字符（null 字符），告诉 Vite / Rollup 这是一个虚拟模块 ID，不会从文件系统中加载。
// plugin-vue:export-helper 是这个虚拟模块的名称，用于识别和注入。
export const EXPORT_HELPER_ID = '\0plugin-vue:export-helper'

// 这个字符串导出的是一个函数体，在 Vue SFC 转换过程中被动态注入并调用。
export const helperCode = `
export default (sfc, props) => {
  const target = sfc.__vccOpts || sfc;
  for (const [key, val] of props) {
    target[key] = val;
  }
  return target;
}
`

// 为什么用 __vccOpts？
// const target = sfc.__vccOpts || sfc
// 如果 sfc 是用 defineComponent() 导出的，Vue 会挂上一个内部属性 __vccOpts
// 所以插件修改的是实际的组件配置对象（即选项式 API 的 export default {}）
