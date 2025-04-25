import fs from 'node:fs'
import type { Plugin, ViteDevServer } from 'vite'
import { createFilter } from 'vite'
/* eslint-disable import/no-duplicates */
import type {
  SFCBlock,
  SFCScriptCompileOptions,
  SFCStyleCompileOptions,
  SFCTemplateCompileOptions,
} from 'vue/compiler-sfc'
import type * as _compiler from 'vue/compiler-sfc'
/* eslint-enable import/no-duplicates */
import { computed, shallowRef } from 'vue'
import { version } from '../package.json'
import { resolveCompiler } from './compiler'
import { parseVueRequest } from './utils/query'
import {
  getDescriptor,
  getSrcDescriptor,
  getTempSrcDescriptor,
} from './utils/descriptorCache'
import { getResolvedScript, typeDepToSFCMap } from './script'
import { transformMain } from './main'
import { handleHotUpdate, handleTypeDepChange } from './handleHotUpdate'
import { transformTemplateAsModule } from './template'
import { transformStyle } from './style'
import { EXPORT_HELPER_ID, helperCode } from './helper'

export { parseVueRequest } from './utils/query'
export type { VueQuery } from './utils/query'

export interface Options {
  include?: string | RegExp | (string | RegExp)[]
  exclude?: string | RegExp | (string | RegExp)[]

  isProduction?: boolean

  // options to pass on to vue/compiler-sfc
  script?: Partial<
    Pick<
      SFCScriptCompileOptions,
      | 'babelParserPlugins'
      | 'globalTypeFiles'
      | 'defineModel'
      | 'propsDestructure'
      | 'fs'
      | 'reactivityTransform'
      | 'hoistStatic'
    >
  >
  template?: Partial<
    Pick<
      SFCTemplateCompileOptions,
      | 'compiler'
      | 'compilerOptions'
      | 'preprocessOptions'
      | 'preprocessCustomRequire'
      | 'transformAssetUrls'
    >
  >
  style?: Partial<Pick<SFCStyleCompileOptions, 'trim'>>

  /**
   * Transform Vue SFCs into custom elements.
   * - `true`: all `*.vue` imports are converted into custom elements
   * - `string | RegExp`: matched files are converted into custom elements
   *
   * @default /\.ce\.vue$/
   */
  customElement?: boolean | string | RegExp | (string | RegExp)[]

  /**
   * Enable Vue reactivity transform (experimental).
   * https://vuejs.org/guide/extras/reactivity-transform.html
   * - `true`: transform will be enabled for all vue,js(x),ts(x) files except
   *           those inside node_modules
   * - `string | RegExp`: apply to vue + only matched files (will include
   *                      node_modules, so specify directories if necessary)
   * - `false`: disable in all cases
   *
   * @deprecated the Reactivity Transform proposal has been dropped. This
   * feature will be removed from Vue core in 3.4. If you intend to continue
   * using it, disable this and switch to the [Vue Macros implementation](https://vue-macros.sxzz.moe/features/reactivity-transform.html).
   *
   * @default false
   */
  reactivityTransform?: boolean | string | RegExp | (string | RegExp)[]

  /**
   * Use custom compiler-sfc instance. Can be used to force a specific version.
   */
  compiler?: typeof _compiler
}

export interface ResolvedOptions extends Options {
  compiler: typeof _compiler
  root: string
  sourceMap: boolean
  cssDevSourcemap: boolean
  devServer?: ViteDevServer
  devToolsEnabled?: boolean
}

// 定义了 vite:vue 插件的主入口。它允许 Vite 正确解析 .vue 文件、
// 处理 <script setup>、模板、样式等，同时支持响应式语法转换（refTransform），以及 SSR、HMR 等功能。
export default function vuePlugin(rawOptions: Options = {}): Plugin {
  // 使用 Vue 的 shallowRef 包裹 options，以便在插件生命周期内动态更新设置
  const options = shallowRef<ResolvedOptions>({
    isProduction: process.env.NODE_ENV === 'production',
    compiler: null as any, // to be set in buildStart
    include: /\.vue$/,
    customElement: /\.ce\.vue$/,
    reactivityTransform: false,
    ...rawOptions,
    root: process.cwd(),
    sourceMap: true,
    cssDevSourcemap: false,
    devToolsEnabled: process.env.NODE_ENV !== 'production',
  })

  // 生成用于 .vue 文件过滤的函数。
  const filter = computed(() =>
    createFilter(options.value.include, options.value.exclude),
  )

  // 决定是否把某个 .vue 文件当成自定义元素组件处理。
  const customElementFilter = computed(() =>
    typeof options.value.customElement === 'boolean'
      ? () => options.value.customElement as boolean
      : createFilter(options.value.customElement),
  )

  // 决定是否启用对 ref() 自动解包语法（即响应式语法 sugar）转换。
  const refTransformFilter = computed(() =>
    options.value.reactivityTransform === false
      ? () => false
      : options.value.reactivityTransform === true
      ? createFilter(/\.(j|t)sx?$/, /node_modules/)
      : createFilter(options.value.reactivityTransform),
  )

  return {
    // 插件名称，用于调试和日志。
    name: 'vite:vue',

    // 暴露插件 API（比如供其他插件获取 vue 插件版本或当前配置）
    api: {
      get options() {
        return options.value
      },
      set options(value) {
        options.value = value
      },
      version,
    },

    // HMR 更新钩子：handleHotUpdate
    handleHotUpdate(ctx) {
      // 检查是否需要清除类型缓存；
      // 若该文件与某个 .vue 文件有依赖关系，处理依赖变更；
      // 若是 .vue 文件，执行热更新逻辑。
      if (options.value.compiler.invalidateTypeCache) {
        options.value.compiler.invalidateTypeCache(ctx.file)
      }
      if (typeDepToSFCMap.has(ctx.file)) {
        return handleTypeDepChange(typeDepToSFCMap.get(ctx.file)!, ctx)
      }
      if (filter.value(ctx.file)) {
        return handleHotUpdate(ctx, options.value)
      }
    },

    // config 和 configResolved：配置钩子
    config(config) {
      // 确保非 SSR 构建中只使用唯一的 Vue 实例；
      // 自动注入 __VUE_OPTIONS_API__ 和 __VUE_PROD_DEVTOOLS__ 宏；
      // 对 SSR 的构建启用特定 external 设置。
      return {
        resolve: {
          dedupe: config.build?.ssr ? [] : ['vue'],
        },
        define: {
          __VUE_OPTIONS_API__: config.define?.__VUE_OPTIONS_API__ ?? true,
          __VUE_PROD_DEVTOOLS__: config.define?.__VUE_PROD_DEVTOOLS__ ?? false,
        },
        ssr: {
          // @ts-ignore -- config.legacy.buildSsrCjsExternalHeuristics will be removed in Vite 5
          external: config.legacy?.buildSsrCjsExternalHeuristics
            ? ['vue', '@vue/server-renderer']
            : [],
        },
      }
    },

    // 将 Vite 最终解析后的配置结果合并到插件配置中。
    configResolved(config) {
      options.value = {
        ...options.value,
        root: config.root,
        sourceMap: config.command === 'build' ? !!config.build.sourcemap : true,
        cssDevSourcemap: config.css?.devSourcemap ?? false,
        isProduction: config.isProduction,
        devToolsEnabled:
          !!config.define!.__VUE_PROD_DEVTOOLS__ || !config.isProduction,
      }
    },

    // 记录开发服务器实例，用于热更新监听。
    configureServer(server) {
      options.value.devServer = server
    },

    // 初始化 Vue SFC 编译器；监听文件删除以清理类型缓存。
    buildStart() {
      const compiler = (options.value.compiler =
        options.value.compiler || resolveCompiler(options.value.root))
      if (compiler.invalidateTypeCache) {
        options.value.devServer?.watcher.on('unlink', (file) => {
          compiler.invalidateTypeCache(file)
        })
      }
    },

    // 对 export helper 做特殊处理；
    // .vue 的子资源请求返回虚拟模块 ID。
    async resolveId(id) {
      // component export helper
      if (id === EXPORT_HELPER_ID) {
        return id
      }
      // serve sub-part requests (*?vue) as virtual modules
      if (parseVueRequest(id).query.vue) {
        return id
      }
    },

    // 核心逻辑：加载 .vue 文件的各个 block（script/template/style/custom block）模块内容。
    load(id, opt) {
      const ssr = opt?.ssr === true
      if (id === EXPORT_HELPER_ID) {
        return helperCode
      }

      const { filename, query } = parseVueRequest(id)

      // select corresponding block for sub-part virtual modules
      if (query.vue) {
        if (query.src) {
          return fs.readFileSync(filename, 'utf-8')
        }
        const descriptor = getDescriptor(filename, options.value)!
        let block: SFCBlock | null | undefined
        if (query.type === 'script') {
          // handle <script> + <script setup> merge via compileScript()
          block = getResolvedScript(descriptor, ssr)
        } else if (query.type === 'template') {
          block = descriptor.template!
        } else if (query.type === 'style') {
          block = descriptor.styles[query.index!]
        } else if (query.index != null) {
          block = descriptor.customBlocks[query.index]
        }
        if (block) {
          return {
            code: block.content,
            map: block.map as any,
          }
        }
      }
    },

    // 处理代码转换逻辑：
    // 针对 .vue 主文件，调用 transformMain；
    // 针对子 block 模块，分别调用 transformTemplateAsModule 或 transformStyle；
    // 若开启了 refTransform，对普通 JS/TS 文件也可转换响应式变量。
    transform(code, id, opt) {
      const ssr = opt?.ssr === true
      const { filename, query } = parseVueRequest(id)

      if (query.raw || query.url) {
        return
      }

      if (!filter.value(filename) && !query.vue) {
        if (
          !query.vue &&
          refTransformFilter.value(filename) &&
          options.value.compiler.shouldTransformRef(code)
        ) {
          return options.value.compiler.transformRef(code, {
            filename,
            sourceMap: true,
          })
        }
        return
      }

      if (!query.vue) {
        // main request
        return transformMain(
          code,
          filename,
          options.value,
          this,
          ssr,
          customElementFilter.value(filename),
        )
      } else {
        // sub block request
        const descriptor = query.src
          ? getSrcDescriptor(filename, query) ||
            getTempSrcDescriptor(filename, query)
          : getDescriptor(filename, options.value)!

        if (query.type === 'template') {
          return transformTemplateAsModule(
            code,
            descriptor,
            options.value,
            this,
            ssr,
          )
        } else if (query.type === 'style') {
          return transformStyle(
            code,
            descriptor,
            Number(query.index || 0),
            options.value,
            this,
            filename,
          )
        }
      }
    },
  }
}
