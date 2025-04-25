import type { SFCDescriptor } from 'vue/compiler-sfc'
import type { ExistingRawSourceMap, TransformPluginContext } from 'rollup'
import type { RawSourceMap } from 'source-map-js'
import { formatPostcssSourceMap } from 'vite'
import type { ResolvedOptions } from '.'

// 专门用来处理 .vue 文件中每一个 <style> 区块的转换逻辑。
// 使用 vue/compiler-sfc.compileStyleAsync() 编译某个 <style> 块，处理 scoped 样式、v-bind() CSS 变量等 Vue 专属功能，并返回最终的 CSS 和 source map。
export async function transformStyle(
  // 参数	类型	说明
  // code	string	<style> block 的源码
  // descriptor	SFCDescriptor	当前 .vue 文件的解析信息
  // index	number	当前处理的是第几个 <style>
  // options	ResolvedOptions	插件的全局配置
  // pluginContext	TransformPluginContext	用于发出错误信息
  // filename	string	当前文件路径（真实文件名）
  code: string,
  descriptor: SFCDescriptor,
  index: number,
  options: ResolvedOptions,
  pluginContext: TransformPluginContext,
  filename: string,
): Promise<any> {
  // 取出对应的 <style> block
  // 每个 .vue 文件可能有多个 <style>：
  const block = descriptor.styles[index]
  // vite already handles pre-processors and CSS module so this is only
  // applying SFC-specific transforms like scoped mode and CSS vars rewrite (v-bind(var))
  // 调用 compileStyleAsync 编译样式
  // 该函数主要处理：
  // ✅ scoped 样式处理（为选择器加 [data-v-xxxx])
  // ✅ v-bind() 样式变量支持
  // ✅ 与 PostCSS 插件链整合（如 autoprefixer）
  const result = await options.compiler.compileStyleAsync({
    ...options.style,
    filename: descriptor.filename,
    id: `data-v-${descriptor.id}`,
    isProd: options.isProduction,
    source: code,
    scoped: block.scoped,
    ...(options.cssDevSourcemap
      ? {
          // 用于开发模式下 CSS 的调试能力（source map 映射到 .vue 文件）。
          postcssOptions: {
            map: {
              from: filename,
              inline: false,
              annotation: false,
            },
          },
        }
      : {}),
  })

  // 捕捉所有 CSS 编译错误（包括语法错误、插件错误等）
  // 如果错误位置可知（line 和 column），会加上 .vue 文件内的正确位置偏移
  if (result.errors.length) {
    result.errors.forEach((error: any) => {
      if (error.line && error.column) {
        error.loc = {
          file: descriptor.filename,
          line: error.line + block.loc.start.line,
          column: error.column,
        }
      }
      pluginContext.error(error)
    })
    return null
  }

  // Vue 编译器返回的 result.map 是标准的 PostCSS map，这里使用 formatPostcssSourceMap() 将其转成 Rollup/Vite 可识别的格式。
  const map = result.map
    ? await formatPostcssSourceMap(
        // version property of result.map is declared as string
        // but actually it is a number
        result.map as Omit<RawSourceMap, 'version'> as ExistingRawSourceMap,
        filename,
      )
    : ({ mappings: '' } as any)

  return {
    code: result.code,
    map: map,
  }
}
