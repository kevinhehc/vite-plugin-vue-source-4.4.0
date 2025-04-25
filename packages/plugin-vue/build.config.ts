// unbuild 是一个用于构建 Vite / Vue / Nuxt 等现代 JavaScript 项目的库构建工具，
// 它由 Nuxt 团队开发，目标是替代传统的 Rollup 或 tsup 等工具，专门为构建库（Library）而优化。
import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['src/index'],
  externals: ['vite', 'vue/compiler-sfc', '@vue/compiler-sfc'],
  clean: true,
  declaration: true,
  rollup: {
    emitCJS: true,
    inlineDependencies: true,
  },
})
