import type { CompilerError } from 'vue/compiler-sfc'
import type { RollupError } from 'rollup'

// 将 Vue SFC 编译阶段产生的错误（如 CompilerError 或 SyntaxError）转换为 Rollup 能识别的错误格式 RollupError，
// 从而使这些错误能被正确显示在终端、IDE 控制台中，或被 Vite 捕获并处理。
export function createRollupError(
  id: string,
  error: CompilerError | SyntaxError,
): RollupError {
  const { message, name, stack } = error
  const rollupError: RollupError = {
    id,
    plugin: 'vue',
    message,
    name,
    stack,
  }

  if ('code' in error && error.loc) {
    rollupError.loc = {
      file: id,
      line: error.loc.start.line,
      column: error.loc.start.column,
    }
  }

  return rollupError
}
