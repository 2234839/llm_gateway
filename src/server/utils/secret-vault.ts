import type { AnthropicMessagesRequest, OpenAIChatCompletionRequest, SecretEntry } from "../types.ts"

/**
 * 密钥保护（Secret Vault）核心：
 * - 出站脱敏：请求发给上游前，把真实密钥字面量替换为占位符（GWKEY_xxxxxxxx）
 * - 入站还原：响应（含 SSE 流式）发回客户端前，把占位符替换回真实密钥
 * - 日志脱敏：写日志 / 推 dashboard 事件前把真实密钥重新替换为占位符
 * 占位符只含 [A-Za-z0-9_]，在 JSON、正则、URL、tokenizer 中都是安全原子，不会被转义或切断
 */

/** 占位符统一前缀 */
export const PLACEHOLDER_PREFIX = "GWKEY_"

/** 生成新占位符：GWKEY_ + 8 位随机小写字母数字 */
export function generatePlaceholder(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  let suffix = ""
  for (let i = 0; i < 8; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)]
  return PLACEHOLDER_PREFIX + suffix
}

/** 占位符格式校验：GWKEY_ + 6-16 位字母数字 */
export function isValidPlaceholder(p: string): boolean {
  return new RegExp(`^${PLACEHOLDER_PREFIX}[a-z0-9]{6,16}$`).test(p)
}

/** 把文本中的真实密钥替换为占位符（日志脱敏 / 输出清洗用） */
export function maskText(text: string, secrets: SecretEntry[]): string {
  let out = text
  for (const s of secrets) {
    if (s.value) out = out.split(s.value).join(s.placeholder)
  }
  return out
}

/**
 * 流式还原状态机：把流式 delta 中的占位符替换回真实密钥。
 * 难点是占位符可能被切在两个 delta 之间（LLM 逐 token 输出），
 * 因此对"可能是占位符前缀"的尾部保持缓冲，直到确认或排除。
 * 每个独立的文本流上下文（每个 text 块 / 每个工具参数累积）应使用独立实例。
 */
export class StreamRestorer {
  /** 待处理缓冲（含上次遗留的可能前缀尾部） */
  private buffer = ""
  /** 按占位符长度降序排列，保证最长优先匹配 */
  private readonly sorted: { placeholder: string; value: string }[]

  constructor(secrets: SecretEntry[]) {
    this.sorted = secrets
      .filter(s => s.value && s.enabled)
      .map(s => ({ placeholder: s.placeholder, value: s.value }))
      .sort((a, b) => b.placeholder.length - a.placeholder.length)
  }

  get enabled(): boolean {
    return this.sorted.length > 0
  }

  /** 喂入一段 delta，返回可安全立即发给客户端的文本 */
  feed(chunk: string): string {
    if (!this.enabled) return chunk
    this.buffer += chunk
    let out = ""
    while (this.buffer.length > 0) {
      /** 1. 完整占位符匹配 → 替换 */
      let matched = false
      for (const s of this.sorted) {
        if (this.buffer.startsWith(s.placeholder)) {
          out += s.value
          this.buffer = this.buffer.slice(s.placeholder.length)
          matched = true
          break
        }
        /** 占位符出现在缓冲中间（前面有足够安全的非前缀文本） */
        const idx = this.buffer.indexOf(s.placeholder)
        if (idx > 0) {
          /** 先发出占位符之前"确定安全"的部分：保留最长可能前缀在缓冲里 */
          const safeEnd = idx + s.placeholder.length
          out += this.buffer.slice(0, idx) + s.value
          this.buffer = this.buffer.slice(safeEnd)
          matched = true
          break
        }
      }
      if (matched) continue
      /** 2. 无完整匹配：找出缓冲中最后一个可能构成占位符前缀的起点，之前的全部发出 */
      const holdFrom = this.lastPossiblePrefixStart(this.buffer)
      if (holdFrom < 0) {
        out += this.buffer
        this.buffer = ""
      } else {
        out += this.buffer.slice(0, holdFrom)
        this.buffer = this.buffer.slice(holdFrom)
      }
      /** 缓冲里只剩可能前缀且已不可能匹配任何占位符 → 放弃等待 */
      if (this.buffer.length > 0 && !this.couldStillMatch(this.buffer)) {
        out += this.buffer
        this.buffer = ""
      }
      break
    }
    return out
  }

  /** 流结束（或内容块边界）时调用，发出剩余缓冲 */
  flush(): string {
    const rest = this.buffer
    this.buffer = ""
    return rest
  }

  /** 缓冲末尾是否可能是某个占位符的前缀：返回应保留的起始下标，-1 表示无需保留 */
  private lastPossiblePrefixStart(buf: string): number {
    /** 占位符都以 GWKEY_ 开头，锚点是最后一个 'G' */
    const anchor = buf.lastIndexOf("G")
    if (anchor === -1) return -1
    /** 从锚点到末尾的后缀是否是任一占位符的前缀 */
    const tail = buf.slice(anchor)
    if (!this.sorted.some(s => s.placeholder.startsWith(tail))) return -1
    return anchor
  }

  /** 缓冲是否仍可能匹配占位符开头（不可能则立即放弃缓冲） */
  private couldStillMatch(buf: string): boolean {
    if (!buf.startsWith("G")) return false
    for (const s of this.sorted) {
      if (s.placeholder.startsWith(buf) || buf.startsWith(s.placeholder)) return true
    }
    return false
  }
}

/** 递归遍历对象，替换所有字符串字段中的占位符（非流式响应用） */
export function restoreObjectDeep(obj: unknown, secrets: SecretEntry[]): unknown {
  const sorted = secrets.filter(s => s.value && s.enabled)
  if (sorted.length === 0) return obj
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      let out = node
      for (const s of sorted) out = out.split(s.placeholder).join(s.value)
      return out
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node && typeof node === "object") {
      const result: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node)) result[k] = walk(v)
      return result
    }
    return node
  }
  return walk(obj)
}

/** 遍历字符串的通用辅助：对可变字符串引用执行替换 */
function replaceInString(s: string, secrets: SecretEntry[]): string {
  return maskText(s, secrets)
}

/**
 * 出站脱敏 — Anthropic Messages 请求体：
 * 遍历 system / messages[].content（string 与 blocks[].text）/ tools[].description，把真实密钥替换为占位符。
 * 就地修改 body，返回替换是否发生。
 */
export function maskAnthropicBody(body: AnthropicMessagesRequest, secrets: SecretEntry[]): boolean {
  const active = secrets.filter(s => s.value && s.enabled)
  if (active.length === 0) return false
  let changed = false
  const mask = (s: string): string => {
    const out = replaceInString(s, active)
    if (out !== s) changed = true
    return out
  }
  if (typeof body.system === "string") body.system = mask(body.system)
  else if (Array.isArray(body.system)) {
    for (const b of body.system) if (b.type === "text" && typeof b.text === "string") b.text = mask(b.text)
  }
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") msg.content = mask(msg.content)
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === "text" && typeof b.text === "string") b.text = mask(b.text)
        else if (b.type === "tool_result" && typeof b.content === "string") b.content = mask(b.content)
        else if (b.type === "tool_result" && Array.isArray(b.content)) {
          for (const tb of b.content) if (tb.type === "text" && typeof tb.text === "string") tb.text = mask(tb.text)
        }
      }
    }
  }
  for (const tool of body.tools ?? []) {
    if (typeof tool.description === "string" && tool.description) tool.description = mask(tool.description)
  }
  return changed
}

/**
 * 出站脱敏 — OpenAI Chat Completions 请求体：
 * 遍历 messages[].content（string 与 parts[].text）/ tools[].function.description，把真实密钥替换为占位符。
 */
export function maskOpenAIBody(body: OpenAIChatCompletionRequest, secrets: SecretEntry[]): boolean {
  const active = secrets.filter(s => s.value && s.enabled)
  if (active.length === 0) return false
  let changed = false
  const mask = (s: string): string => {
    const out = replaceInString(s, active)
    if (out !== s) changed = true
    return out
  }
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") msg.content = mask(msg.content)
    else if (Array.isArray(msg.content)) {
      for (const p of msg.content) if (typeof p?.text === "string") p.text = mask(p.text)
    }
    /** assistant 历史里的工具调用参数（字符串化 JSON）同样脱敏 */
    if ("tool_calls" in msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) if (typeof tc.function?.arguments === "string") tc.function.arguments = mask(tc.function.arguments)
    }
  }
  for (const tool of body.tools ?? []) {
    if (typeof tool.function?.description === "string" && tool.function.description) tool.function.description = mask(tool.function.description)
  }
  return changed
}
