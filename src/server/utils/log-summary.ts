/** ANSI 颜色（仅用于终端日志） */
export const C = {
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
}

/** 截取文本摘要，最多 maxLen 个字符 */
export function truncate(text: string, maxLen = 80): string {
  const clean = text.replace(/\n/g, " ").trim()
  if (clean.length <= maxLen) return clean
  return clean.slice(0, maxLen) + "..."
}

/** 生成短请求 ID（6 位） */
let reqCounter = 0
export function nextReqId(): string {
  reqCounter = (reqCounter + 1) % 0xFFFFFF
  return reqCounter.toString(36).padStart(4, "0")
}

/** 输出请求摘要日志 */
export function logRequestSummary(info: {
  reqId: string
  model: string
  targetModel: string
  provider: string
  input: string
  output: string
  durationMs: number
  stream: boolean
  statusCode: number
  error?: string | null
}) {
  const {
    reqId, model, targetModel, provider, input, output,
    durationMs, stream, statusCode, error,
  } = info

  const sc = statusCode >= 400 ? C.red : C.green
  const mc = durationMs > 1000 ? C.red : durationMs > 200 ? C.yellow : C.dim

  const lines: string[] = []

  /** 第一行：请求ID + 状态 */
  lines.push(
    `${C.magenta}[${reqId}]${C.reset} ${sc}${statusCode}${C.reset} ${mc}${durationMs}ms${C.reset} ${C.cyan}${model}${C.reset} → ${targetModel} @ ${provider} ${stream ? "(stream)" : ""}`
  )

  /** 第二行：输入摘要 */
  lines.push(`  ${C.dim}in:${C.reset} ${truncate(input)}`)

  /** 第三行：输出摘要或错误 */
  if (error) {
    lines.push(`  ${C.red}err:${C.reset} ${truncate(error, 120)}`)
  } else {
    lines.push(`  ${C.dim}out:${C.reset} ${truncate(output)}`)
  }

  console.log(lines.join("\n"))
}
