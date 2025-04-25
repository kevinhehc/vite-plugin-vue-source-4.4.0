import path from 'node:path'
import fs from 'node:fs'
import type { SFCBlock, SFCDescriptor } from 'vue/compiler-sfc'
import type { PluginContext, TransformPluginContext } from 'rollup'
import type { RawSourceMap } from 'source-map-js'
import type { EncodedSourceMap as TraceEncodedSourceMap } from '@jridgewell/trace-mapping'
import { TraceMap, eachMapping } from '@jridgewell/trace-mapping'
import type { EncodedSourceMap as GenEncodedSourceMap } from '@jridgewell/gen-mapping'
import { addMapping, fromMap, toEncodedMap } from '@jridgewell/gen-mapping'
import { normalizePath, transformWithEsbuild } from 'vite'
import {
  createDescriptor,
  getDescriptor,
  getPrevDescriptor,
  setSrcDescriptor,
} from './utils/descriptorCache'
import {
  canInlineMain,
  isUseInlineTemplate,
  resolveScript,
  scriptIdentifier,
} from './script'
import { transformTemplateInMain } from './template'
import { isEqualBlock, isOnlyTemplateChanged } from './handleHotUpdate'
import { createRollupError } from './utils/error'
import { EXPORT_HELPER_ID } from './helper'
import type { ResolvedOptions } from '.'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
// .vue 文件主模块的 转译处理器（transformer），负责将 <script>、<template>、<style>、<custom-block> 等不同 block 生成最终的 JS 模块代码。
export async function transformMain(
  code: string, // SFC 的原始源代码
  filename: string, // 当前 .vue 文件路径
  options: ResolvedOptions, // 插件配置（已解析）
  pluginContext: TransformPluginContext, // 当前插件上下文
  ssr: boolean, // 是否为 SSR 构建
  asCustomElement: boolean, // 是否作为自定义元素构建
): Promise<any> {
  // 获取上次的 descriptor（用于比较）；
  // 解析当前 .vue 文件得到结构描述符 descriptor；
  // 捕获解析错误，停止编译。
  const { devServer, isProduction, devToolsEnabled } = options

  const prevDescriptor = getPrevDescriptor(filename)
  const { descriptor, errors } = createDescriptor(filename, code, options)

  if (fs.existsSync(filename))
    // set descriptor for HMR if it's not set yet
    getDescriptor(filename, options, true, true)

  if (errors.length) {
    errors.forEach((error) =>
      pluginContext.error(createRollupError(filename, error)),
    )
    return null
  }

  // feature information
  const attachedProps: [string, string][] = []
  const hasScoped = descriptor.styles.some((s) => s.scoped)

  // script
  // 调用 genScriptCode 生成 JS 的 _sfc_main 组件定义；
  // 如果是 <script setup>，这里也会做语法转换。
  const { code: scriptCode, map: scriptMap } = await genScriptCode(
    descriptor,
    options,
    pluginContext,
    ssr,
  )

  // template
  const hasTemplateImport =
    descriptor.template && !isUseInlineTemplate(descriptor, !devServer)

  let templateCode = ''
  let templateMap: RawSourceMap | undefined = undefined
  if (hasTemplateImport) {
    // 如果不是 inline 模式（即不是在 <script setup> 中内嵌 template），则单独导入模板；
    // 会生成 render 或 ssrRender 函数；
    // 添加到组件属性中：attachedProps.push(['render', '_sfc_render'])
    ;({ code: templateCode, map: templateMap } = await genTemplateCode(
      descriptor,
      options,
      pluginContext,
      ssr,
    ))
  }

  if (hasTemplateImport) {
    attachedProps.push(
      ssr ? ['ssrRender', '_sfc_ssrRender'] : ['render', '_sfc_render'],
    )
  } else {
    // #2128
    // User may empty the template but we didn't provide rerender function before
    if (
      prevDescriptor &&
      !isEqualBlock(descriptor.template, prevDescriptor.template)
    ) {
      attachedProps.push([ssr ? 'ssrRender' : 'render', '() => {}'])
    }
  }

  // styles
  // 遍历 <style> 标签，生成对应的 import；
  // 支持 scoped、module、src、custom element；
  // 若是 asCustomElement，则注入 styles 属性；
  // 若含有 module，注入 __cssModules 属性；
  // 最后将 scoped ID 注入到组件上：
  const stylesCode = await genStyleCode(
    descriptor,
    pluginContext,
    asCustomElement,
    attachedProps,
  )

  // custom blocks
  // 历 <custom-block>，生成 import 并执行（如 block0(_sfc_main)）；
  // 支持 <i18n>, <docs>, <test> 等自定义插件处理。
  const customBlocksCode = await genCustomBlockCode(descriptor, pluginContext)

  const output: string[] = [
    scriptCode,
    templateCode,
    stylesCode,
    customBlocksCode,
  ]
  if (hasScoped) {
    // 在开发模式或开启 devtools 时注入 __file 字段用于调试或 devtools 显示组件名。
    attachedProps.push([`__scopeId`, JSON.stringify(`data-v-${descriptor.id}`)])
  }
  if (devToolsEnabled || (devServer && !isProduction)) {
    // expose filename during serve for devtools to pickup
    attachedProps.push([
      `__file`,
      JSON.stringify(isProduction ? path.basename(filename) : filename),
    ])
  }

  // HMR
  // 处理 HMR 热更新逻辑
  if (
    devServer &&
    devServer.config.server.hmr !== false &&
    !ssr &&
    !isProduction
  ) {
    output.push(`_sfc_main.__hmrId = ${JSON.stringify(descriptor.id)}`)
    output.push(
      `typeof __VUE_HMR_RUNTIME__ !== 'undefined' && ` +
        `__VUE_HMR_RUNTIME__.createRecord(_sfc_main.__hmrId, _sfc_main)`,
    )
    // check if the template is the only thing that changed
    if (prevDescriptor && isOnlyTemplateChanged(prevDescriptor, descriptor)) {
      output.push(`export const _rerender_only = true`)
    }
    output.push(
      `import.meta.hot.accept(mod => {`,
      `  if (!mod) return`,
      `  const { default: updated, _rerender_only } = mod`,
      `  if (_rerender_only) {`,
      `    __VUE_HMR_RUNTIME__.rerender(updated.__hmrId, updated.render)`,
      `  } else {`,
      `    __VUE_HMR_RUNTIME__.reload(updated.__hmrId, updated)`,
      `  }`,
      `})`,
    )
  }

  // SSR module registration by wrapping user setup
  // SSR 运行时注册
  // 用于在服务端渲染过程中注册当前组件到 ssrContext.modules；
  // Vue SSR 的模块缓存系统依赖此机制。
  if (ssr) {
    const normalizedFilename = normalizePath(
      path.relative(options.root, filename),
    )
    output.push(
      `import { useSSRContext as __vite_useSSRContext } from 'vue'`,
      `const _sfc_setup = _sfc_main.setup`,
      `_sfc_main.setup = (props, ctx) => {`,
      `  const ssrContext = __vite_useSSRContext()`,
      `  ;(ssrContext.modules || (ssrContext.modules = new Set())).add(${JSON.stringify(
        normalizedFilename,
      )})`,
      `  return _sfc_setup ? _sfc_setup(props, ctx) : undefined`,
      `}`,
    )
  }

  let resolvedMap: RawSourceMap | undefined = undefined
  if (options.sourceMap) {
    if (scriptMap && templateMap) {
      // if the template is inlined into the main module (indicated by the presence
      // of templateMap), we need to concatenate the two source maps.

      const gen = fromMap(
        // version property of result.map is declared as string
        // but actually it is `3`
        scriptMap as Omit<RawSourceMap, 'version'> as TraceEncodedSourceMap,
      )
      const tracer = new TraceMap(
        // same above
        templateMap as Omit<RawSourceMap, 'version'> as TraceEncodedSourceMap,
      )
      const offset = (scriptCode.match(/\r?\n/g)?.length ?? 0) + 1
      eachMapping(tracer, (m) => {
        if (m.source == null) return
        addMapping(gen, {
          source: m.source,
          original: { line: m.originalLine, column: m.originalColumn },
          generated: {
            line: m.generatedLine + offset,
            column: m.generatedColumn,
          },
        })
      })

      // same above
      resolvedMap = toEncodedMap(gen) as Omit<
        GenEncodedSourceMap,
        'version'
      > as RawSourceMap
      // if this is a template only update, we will be reusing a cached version
      // of the main module compile result, which has outdated sourcesContent.
      resolvedMap.sourcesContent = templateMap.sourcesContent
    } else {
      // if one of `scriptMap` and `templateMap` is empty, use the other one
      resolvedMap = scriptMap ?? templateMap
    }
  }

  // 构造组件默认导出语句
  // 使用 _export_sfc() 包裹注入的 props 属性，如 render、__file、__scopeId 等；
  // 最终 export default 输出组件。
  if (!attachedProps.length) {
    output.push(`export default _sfc_main`)
  } else {
    output.push(
      `import _export_sfc from '${EXPORT_HELPER_ID}'`,
      `export default /*#__PURE__*/_export_sfc(_sfc_main, [${attachedProps
        .map(([key, val]) => `['${key}',${val}]`)
        .join(',')}])`,
    )
  }

  // handle TS transpilation
  // TypeScript 支持与 SourceMap 合并
  let resolvedCode = output.join('\n')
  const lang = descriptor.scriptSetup?.lang || descriptor.script?.lang

  if (
    lang &&
    /tsx?$/.test(lang) &&
    !descriptor.script?.src // only normal script can have src
  ) {
    const { code, map } = await transformWithEsbuild(
      resolvedCode,
      filename,
      {
        loader: 'ts',
        target: 'esnext',
        sourcemap: options.sourceMap,
      },
      resolvedMap,
    )
    resolvedCode = code
    resolvedMap = resolvedMap ? (map as any) : resolvedMap
  }

  return {
    code: resolvedCode,
    map: resolvedMap || {
      mappings: '',
    },
    meta: {
      vite: {
        lang: descriptor.script?.lang || descriptor.scriptSetup?.lang || 'js',
      },
    },
  }
}

// 根据 <template> 是否是内联、是否使用语言预处理器（如 Pug）、是否使用 src 外部引入，
// 来判断是否直接编译、或是通过虚拟模块导入模板的 render / ssrRender 函数。
async function genTemplateCode(
  descriptor: SFCDescriptor, // 当前 .vue 文件的结构描述
  options: ResolvedOptions, // 插件配置
  pluginContext: PluginContext, // 当前插件上下文
  ssr: boolean, // 是否为 SSR 构建
) {
  // 取 <template> 块 + 是否 scoped 样式
  // 拿到模板内容；
  // 判断是否使用了 <style scoped>，因为这会影响模板中生成的 scoped class 名。
  const template = descriptor.template!
  const hasScoped = descriptor.styles.some((style) => style.scoped)

  // If the template is not using pre-processor AND is not using external src,
  // compile and inline it directly in the main module. When served in vite this
  // saves an extra request per SFC which can improve load performance.
  // 如果 <template> 没有使用预处理器（如 pug），且不是 src 外部引入；
  // 直接调用 transformTemplateInMain() 编译 template 并内联到主模块中；
  // 避免另起一个模块，有利于优化加载性能（少发一个请求）。
  if ((!template.lang || template.lang === 'html') && !template.src) {
    return transformTemplateInMain(
      template.content,
      descriptor,
      options,
      pluginContext,
      ssr,
    )
  } else {
    // 若使用 src="./tpl.html"，需要建立文件与 .vue 的映射关系（为 transform 阶段查回原 descriptor）；
    if (template.src) {
      await linkSrcToDescriptor(
        template.src,
        descriptor,
        pluginContext,
        hasScoped,
      )
    }

    // 构造 template 虚拟模块路径
    // 生成类似下面的路径：
    // MyComp.vue?vue&type=template&scoped=xxxx&lang=js
    const src = template.src || descriptor.filename
    const srcQuery = template.src
      ? hasScoped
        ? `&src=${descriptor.id}`
        : '&src=true'
      : ''
    const scopedQuery = hasScoped ? `&scoped=${descriptor.id}` : ``
    const attrsQuery = attrsToQuery(template.attrs, 'js', true)
    const query = `?vue&type=template${srcQuery}${scopedQuery}${attrsQuery}`

    // 构造 import 语句
    // 最终输出类似这样的代码段：
    // import { render as _sfc_render } from "MyComp.vue?vue&type=template&lang=js"
    // 或者在 SSR 中：
    // import { ssrRender as _sfc_ssrRender } from "MyComp.vue?vue&type=template&lang=js"
    // 这样主模块就可以把 _sfc_render 函数绑定到 _sfc_main 上了。
    const request = JSON.stringify(src + query)
    const renderFnName = ssr ? 'ssrRender' : 'render'

    return {
      code: `import { ${renderFnName} as _sfc_${renderFnName} } from ${request}`,
      map: undefined,
    }
  }
}

// 会判断是否可以将 <script> 内容直接嵌入主模块（inline），或者需通过虚拟模块路径导入，
// 并支持处理外部 src 引用、支持 export *、支持 lang="ts" 等语言标记，同时返回最终 JS 代码及 SourceMap。
async function genScriptCode(
  descriptor: SFCDescriptor,
  options: ResolvedOptions,
  pluginContext: PluginContext,
  ssr: boolean,
): Promise<{
  code: string
  map: RawSourceMap | undefined
}> {
  // 默认先给 _sfc_main（即 scriptIdentifier）赋一个空对象；
  // map 是 source map，后面可能来自 script block。
  let scriptCode = `const ${scriptIdentifier} = {}`
  let map: RawSourceMap | undefined

  // 解析有效的 script block
  // 该函数负责解析 <script> 和 <script setup>，并合并成一个统一的 script block。
  const script = resolveScript(descriptor, options, ssr)
  if (script) {
    // If the script is js/ts and has no external src, it can be directly placed
    // in the main module.
    if (canInlineMain(descriptor, options)) {
      // 如果满足以下条件：
      // 没有使用 src；
      // 语言是支持内联的（如 ts 或 js）；
      // 没有特殊选项禁用 inline；
      // 就直接把内容嵌入主模块中：
      if (!options.compiler.version) {
        // if compiler-sfc exposes no version, it's < 3.3 and doesn't support
        // genDefaultAs option.
        // 若 compiler 版本小于 3.3，使用 rewriteDefault() 插入默认导出名
        const userPlugins = options.script?.babelParserPlugins || []
        const defaultPlugins =
          script.lang === 'ts'
            ? userPlugins.includes('decorators')
              ? (['typescript'] as const)
              : (['typescript', 'decorators-legacy'] as const)
            : []
        // rewriteDefault() 会把：
        // export default { ... }
        // 改成：
        // const _sfc_main = { ... }
        // 这样主模块可以直接引用组件逻辑。
        scriptCode = options.compiler.rewriteDefault(
          script.content,
          scriptIdentifier,
          [...defaultPlugins, ...userPlugins],
        )
      } else {
        // 若是 Vue 3.3+，直接使用内容：
        scriptCode = script.content
      }
      map = script.map
    } else {
      // 不能内联时，使用虚拟模块导入
      // 如果使用 src="./logic.js"，建立 .vue 与该文件的映射；
      // 用于后续在子模块中反查所属 .vue 文件。
      if (script.src) {
        await linkSrcToDescriptor(script.src, descriptor, pluginContext, false)
      }
      const src = script.src || descriptor.filename
      const langFallback = (script.src && path.extname(src).slice(1)) || 'js'
      const attrsQuery = attrsToQuery(script.attrs, langFallback)
      const srcQuery = script.src ? `&src=true` : ``
      const query = `?vue&type=script${srcQuery}${attrsQuery}`
      const request = JSON.stringify(src + query)
      scriptCode =
        `import _sfc_main from ${request}\n` + `export * from ${request}` // support named exports
    }
  }
  return {
    code: scriptCode,
    map,
  }
}

// 为 .vue 文件中的所有 <style> 块生成对应的 import 代码，同时处理 scoped、module、src、customElement 模式的差异，并返回最终的样式导入代码和注入属性。
async function genStyleCode(
  descriptor: SFCDescriptor, // 当前 .vue 文件的结构描述符
  pluginContext: PluginContext, // Vite 插件上下文
  asCustomElement: boolean, // 是否是自定义元素模式
  attachedProps: [string, string][], // 要注入到组件对象上的属性（附加）
) {
  // tylesCode: 保存最终生成的 import 语句；
  // cssModulesMap: 记录 CSS Modules 的变量映射。
  let stylesCode = ``
  let cssModulesMap: Record<string, string> | undefined
  if (descriptor.styles.length) {
    // 遍历所有 <style> 块
    for (let i = 0; i < descriptor.styles.length; i++) {
      const style = descriptor.styles[i]
      if (style.src) {
        // 若是 <style src="...">，建立映射
        await linkSrcToDescriptor(
          style.src,
          descriptor,
          pluginContext,
          style.scoped,
        )
      }
      // 构造样式路径和属性 query 字符串（如 &lang=scss&scoped）。
      const src = style.src || descriptor.filename
      // do not include module in default query, since we use it to indicate
      // that the module needs to export the modules json
      const attrsQuery = attrsToQuery(style.attrs, 'css')

      // 外部文件 &src=true
      // 如果是 scoped：加入 &src=vue-file-id 来标记
      const srcQuery = style.src
        ? style.scoped
          ? `&src=${descriptor.id}`
          : '&src=true'
        : ''

      // 自定义元素强制 inline
      // scoped 样式添加 &scoped=vue-id 表示需作用域处理
      const directQuery = asCustomElement ? `&inline` : ``
      const scopedQuery = style.scoped ? `&scoped=${descriptor.id}` : ``
      const query = `?vue&type=style&index=${i}${srcQuery}${directQuery}${scopedQuery}`
      // 拼接完整的 styleRequest
      const styleRequest = src + query + attrsQuery
      if (style.module) {
        // 如果是 <style module>，调用 genCSSModulesCode 自动加 .module.css；
        // 生成：import style0 from "...module.css"；
        // 把变量映射注入到 cssModulesMap，后续注入到组件。
        if (asCustomElement) {
          throw new Error(
            `<style module> is not supported in custom elements mode.`,
          )
        }
        const [importCode, nameMap] = genCSSModulesCode(
          i,
          styleRequest,
          style.module,
        )
        stylesCode += importCode
        Object.assign((cssModulesMap ||= {}), nameMap)
      } else {
        // 如果是自定义元素，需要拿到样式对象（所以起别名 _style_i）；
        // 普通情况直接 import 即可。
        if (asCustomElement) {
          stylesCode += `\nimport _style_${i} from ${JSON.stringify(
            styleRequest,
          )}`
        } else {
          stylesCode += `\nimport ${JSON.stringify(styleRequest)}`
        }
      }
      // TODO SSR critical CSS collection
    }
    if (asCustomElement) {
      // 在自定义元素中，把所有 _style_i 组成数组注入到组件属性上，用于运行时注册样式。
      attachedProps.push([
        `styles`,
        `[${descriptor.styles.map((_, i) => `_style_${i}`).join(',')}]`,
      ])
    }
  }
  if (cssModulesMap) {
    // CSS Modules 映射注入
    const mappingCode =
      Object.entries(cssModulesMap).reduce(
        (code, [key, value]) => code + `"${key}":${value},\n`,
        '{\n',
      ) + '}'
    stylesCode += `\nconst cssModules = ${mappingCode}`
    attachedProps.push([`__cssModules`, `cssModules`])
  }
  return stylesCode
}

// 它生成将样式文件作为 CSS Module 引入的代码，以及对应的变量名映射表（通常是 $style），以便在组件内注入样式 class 名字映射。
function genCSSModulesCode(
  index: number, // 第几个 <style> 标签（从 0 开始）
  request: string, // 原始样式文件请求路径（带 query 参数）
  moduleName: string | boolean, // 模块名称，true 表示默认用 $style
): [importCode: string, nameMap: Record<string, string>] {
  // 样式模块的变量名（如：style0、style1），用于后面 import。
  const styleVar = `style${index}`

  // 用户可能写了 <style module="myStyle">，那就绑定为 myStyle；
  // 若写的是 <style module>，默认注入为 $style。
  const exposedName = typeof moduleName === 'string' ? moduleName : '$style'

  // inject `.module` before extension so vite handles it as css module
  // 把 .css、.scss 等改为 .module.css，Vite 会自动按 CSS Module 模式处理。
  const moduleRequest = request.replace(/\.(\w+)$/, '.module.$1')

  // import 代码行：动态导入 CSS Module；
  // nameMap：提供变量注入到组件内部的键值对（比如注入 {$style: style0}）。
  return [
    `\nimport ${styleVar} from ${JSON.stringify(moduleRequest)}`,
    { [exposedName]: styleVar },
  ]

  // 示例
  // 假设有以下 <style>：

  // <style module>
  // .red {
  //   color: red;
  // }
  // </style>

  // 调用：
  // genCSSModulesCode(0, "MyComp.vue?vue&type=style&index=0&lang.css", true)

  // 返回：

  // [
  //   '\nimport style0 from "MyComp.vue?vue&type=style&index=0&lang.module.css"',
  //   { $style: 'style0' }
  // ]

  // 这个结果会被插入组件的模块代码中：

  // import style0 from "MyComp.vue?vue&type=style&index=0&lang.module.css"
  // const __cssModules = { $style: style0 }

  // 后续模板中用 $style.red 就会被映射为 style0.red，类名会根据 CSS Modules 的规则进行作用域转换。
}

// 该函数会为 .vue 文件中的所有 <customBlock> 自动生成 import 语句和执行逻辑，
// 让它们在模块加载时执行，如 import block0 from "...?vue&type=xxx"，并调用 block0(_sfc_main)。
async function genCustomBlockCode(
  // descriptor: 当前 .vue 文件的 SFC 描述器；
  // pluginContext: 当前插件上下文，提供 resolve() 等功能。
  descriptor: SFCDescriptor,
  pluginContext: PluginContext,
) {
  // 应用场景：什么是 <customBlock>？
  // Vue SFC 支持以下用法：
  // <custom-block foo="bar">
  // console.log('hello custom block')
  // </custom-block>
  // 在构建阶段，这些块不会参与组件的编译输出，但插件可以拦截这些 custom block 来实现：
  // 国际化（如 <i18n>）
  // 文档注释
  // 单元测试挂载
  // 或者运行时注入行为
  let code = ''

  // 逐个处理 .vue 文件中的 <custom-block>，每个 block 都会被转换为一个虚拟模块。
  for (let index = 0; index < descriptor.customBlocks.length; index++) {
    const block = descriptor.customBlocks[index]
    // 若 block 有 src 引入，建立映射关系
    if (block.src) {
      await linkSrcToDescriptor(block.src, descriptor, pluginContext, false)
    }
    const src = block.src || descriptor.filename
    const attrsQuery = attrsToQuery(block.attrs, block.type)
    const srcQuery = block.src ? `&src=true` : ``
    const query = `?vue&type=${block.type}&index=${index}${srcQuery}${attrsQuery}`
    const request = JSON.stringify(src + query)

    // 引入 custom block 的模块（会在 transform() 处理）；
    // 如果导出是一个函数，就执行它并传入 setup() 函数中生成的组件变量 _sfc_main；
    // 这样 custom block 可以动态注入数据到组件。
    code += `import block${index} from ${request}\n`
    code += `if (typeof block${index} === 'function') block${index}(_sfc_main)\n`
  }

  // 若 SFC 文件中有：
  // <custom-block foo="bar">
  // console.log('custom')
  // </custom-block>
  // 转换后相当于：
  // import block0 from "MyComp.vue?vue&type=custom&index=0&foo=bar"
  // if (typeof block0 === 'function') block0(_sfc_main)
  return code
}

/**
 * For blocks with src imports, it is important to link the imported file
 * with its owner SFC descriptor so that we can get the information about
 * the owner SFC when compiling that file in the transform phase.
 *
 * 用于处理 <script src="...">、<style src="..."> 等 带 src 引用的 SFC block，
 * 它确保这些外部引入的资源文件与所属 .vue 文件的描述符（descriptor）建立映射关系，从而在后续的构建或转换阶段可以正确处理。
 *
 * 将 <script src="..."> 或 <style src="..."> 引入的资源文件，与其所属的 .vue 文件描述信息绑定，
 * 方便后续处理这个资源文件时，可以查出它来自哪个 .vue 文件，以及是否是 scoped 的。
 */
// 在 Vue SFC 中，有以下用法：
// <script src="./logic.ts"></script>
// <style scoped src="./style.scss"></style>
// 这些 src 属性引用的文件是 外部资源文件，Vite 插件需要知道：
// 哪个 .vue 文件引入了它；
// 它是哪个 block（style/script/custom）；
// 它是否设置了 scoped；
// 后面在 transform() 中处理这些子模块文件时，能够“反向查找”它的 owner。
async function linkSrcToDescriptor(
  src: string, // 被引用的资源路径
  descriptor: SFCDescriptor, // 当前 .vue 文件的 descriptor
  pluginContext: PluginContext, // Vite 插件上下文，用于 resolve 模块
  scoped?: boolean, // 该 block 是否使用 scoped（只对 style 有意义）
) {
  // 使用 Vite 的 resolve() 方法解析 src 路径；
  // descriptor.filename 是当前 .vue 文件路径，它作为 src 的相对路径基础；
  // 如果 resolve() 成功，会拿到 .id（也就是模块路径 + 查询参数）
  // 否则就退回原始路径 src。
  const srcFile =
    (await pluginContext.resolve(src, descriptor.filename))?.id || src
  // #1812 if the src points to a dep file, the resolved id may contain a
  // version query.
  // 解决 issue #1812：srcFile 可能是 some-file.css?import&v=123 这样带 query 的路径；
  // 所以用 .replace(/\?.*$/, '') 去掉查询参数，只保留纯路径；
  // 调用 setSrcDescriptor() 把这个外部文件与 descriptor 绑定起来，同时标记是否是 scoped。
  setSrcDescriptor(srcFile.replace(/\?.*$/, ''), descriptor, scoped)
}

// these are built-in query parameters so should be ignored
// if the user happen to add them as attrs
// 这表示某些属性 不会出现在 query 中，比如用于内部处理的字段。
const ignoreList = [
  'id',
  'index',
  'src',
  'type',
  'lang',
  'module',
  'scoped',
  'generic',
]

// 用于将 <template>, <script>, <style> 等 SFC（Single File Component）块的 attrs 属性（例如 lang="ts"、scoped、module 等）转换为查询参数字符串，以便内部模块处理和虚拟模块标识。
function attrsToQuery(
  attrs: SFCBlock['attrs'], // 一个对象，代表 SFC 中某块的所有属性
  langFallback?: string, // 如果没有指定 lang，则使用该值作为默认语言（如 'js'）
  forceLangFallback = false, // 是否强制使用 langFallback 替代 attrs.lang
): string {
  let query = ``
  // 遍历 attrs 生成查询参数
  for (const name in attrs) {
    const value = attrs[name]
    if (!ignoreList.includes(name)) {
      query += `&${encodeURIComponent(name)}${
        value ? `=${encodeURIComponent(value)}` : ``
      }`
    }
  }
  if (langFallback || attrs.lang) {
    query +=
      `lang` in attrs
        ? forceLangFallback
          ? `&lang.${langFallback}` // 强制使用 fallback
          : `&lang.${attrs.lang}` // 正常使用 attrs.lang
        : `&lang.${langFallback}` // 没有 lang 属性时 fallback
  }

  // 案例
  // <style scoped lang="scss">
  // 输出内容长这样
  // attrsToQuery({ scoped: true, lang: 'scss' })
  // // => &scoped&lang=scss&lang.scss
  // 用于构造 .vue?type=style&scoped&lang=scss&lang.scss 这样的子模块路径。
  return query
}
