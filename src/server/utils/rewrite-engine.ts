/**
 * 内容改写引擎：对请求体执行管道式匹配替换
 *
 * 纯函数模块，不依赖 Fastify / DB。
 * 按 priority 串行执行所有匹配的 rewrite rule，每条规则独立判断和执行。
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicSystemBlock,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAIContentPart,
  RewriteAction,
  RewriteMatchCondition,
  RewriteRule,
  RewriteScope,
} from "../types"
import { getCachedPicomatch } from "../providers/registry"

// ========== 导出接口 ==========

export interface RewriteContext {
  /** 请求路径，如 /v1/chat/completions 或 /v1/messages */
  path: string
  /** 请求模型名 */
  model: string
}

export interface RewriteResult {
  /** 是否有任何规则匹配并执行了替换 */
  matched: boolean
  /** 匹配的规则名称列表 */
  matchedRules: string[]
  /** 执行过程中的错误 */
  errors: string[]
}

interface RewritePreviewItem {
  logId: number
  model: string
  path: string
  original: string | null
  rewritten: string | null
  matched: boolean
  matchedRules: string[]
}

export interface RewritePreviewResult {
  results: RewritePreviewItem[]
}

// ========== 安全限制 ==========

/** 正则 pattern 最大长度 */
const MAX_PATTERN_LENGTH = 5000
/** 单次 replace_all 最大替换次数 */
const MAX_REPLACE_ITERATIONS = 10000
/** 已知 ReDoS 危险模式的启发式检测 */
const REDOS_DANGEROUS = /\([^)]*[+*][^)]*\)[+*]/

// ========== 正则安全编译 ==========

/** 安全编译正则：限制长度，拒绝已知危险模式 */
function safeCompileRegex(pattern: string, flags: string): RegExp | null {
  if (!pattern || pattern.length > MAX_PATTERN_LENGTH) return null
  if (REDOS_DANGEROUS.test(pattern)) return null
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/** 正则缓存：同一 pattern+flags 只编译一次 */
const regexCache = new Map<string, RegExp | null>()
function getCachedSafeRegex(pattern: string, flags: string): RegExp | null {
  const key = `${flags}::${pattern}`
  const cached = regexCache.get(key)
  if (cached !== undefined) return cached
  const re = safeCompileRegex(pattern, flags)
  regexCache.set(key, re)
  if (regexCache.size > 200) {
    const first = regexCache.keys().next().value
    if (first !== undefined) regexCache.delete(first)
  }
  return re
}

// ========== 动作执行 ==========

/** 对单个文本字符串执行替换动作 */
function applyAction(text: string, action: RewriteAction, matchPattern?: string, matchFlags?: string): string {
  switch (action.type) {
    case "replace":
    case "replace_all": {
      const pattern = action.pattern || matchPattern
      if (!pattern) return text

      /** 判断匹配条件是否为 regex 类型 —— 如果 action.pattern 存在则按 action 自身的模式来 */
      const effectiveFlags = action.flags ?? matchFlags ?? ""
      const globalFlag = action.type === "replace_all" ? "g" : ""
      const re = getCachedSafeRegex(pattern, effectiveFlags + globalFlag)
      if (!re) return text

      /** 安全替换：限制替换迭代次数 */
      if (action.type === "replace_all") {
        let count = 0
        return text.replace(re, () => {
          if (++count > MAX_REPLACE_ITERATIONS) return arguments[0]
          return action.replacement
        })
      }
      return text.replace(re, action.replacement)
    }
    case "prepend":
      return action.replacement + text
    case "append":
      return text + action.replacement
  }
}

// ========== 匹配条件检查 ==========

/** 按 scope 从各角色文本中选取匹配目标 */
function buildTextByScope(
  conditions: RewriteMatchCondition[],
  textByScope: Record<RewriteScope, string>,
): string {
  /** 收集所有涉及的 scope，去重 */
  const scopes = new Set<RewriteScope>(conditions.map(c => c.scope || "all"))
  const parts: string[] = []
  for (const scope of scopes) {
    const t = textByScope[scope]
    if (t) parts.push(t)
  }
  return parts.join("\n")
}

/** 检查匹配条件是否命中 */
function matchesConditions(conditions: RewriteMatchCondition[], textByScope: Record<RewriteScope, string>): boolean {
  if (!conditions.length) return false
  const operator = conditions[0]?.operator ?? "and"

  const results = conditions.map(cond => {
    const text = buildTextByScope([cond], textByScope)
    if (!text) return false

    if (cond.type === "keyword") return text.includes(cond.pattern)
    const re = getCachedSafeRegex(cond.pattern, cond.flags ?? "")
    return re ? re.test(text) : false
  })

  return operator === "or" ? results.some(Boolean) : results.every(Boolean)
}

/** 检查规则是否匹配当前上下文（modelPattern + pathPattern） */
function matchesContext(rule: RewriteRule, context: RewriteContext): boolean {
  if (rule.modelPattern) {
    if (!getCachedPicomatch(rule.modelPattern)(context.model)) return false
  }
  if (rule.pathPattern) {
    if (!getCachedPicomatch(rule.pathPattern)(context.path)) return false
  }
  return true
}

/** 判断消息角色是否在 scope 内 */
function roleInScope(role: string, scope: RewriteScope): boolean {
  if (scope === "all") return true
  if (scope === "system") return role === "system"
  if (scope === "user") return role === "user"
  if (scope === "assistant") return role === "assistant"
  return true
}

// ========== OpenAI 格式改写 ==========

/** 从 OpenAI 消息中提取按角色分组的文本 */
function extractOpenAITextByScope(body: OpenAIChatCompletionRequest): Record<RewriteScope, string> {
  const parts: Record<RewriteScope, string[]> = { all: [], system: [], user: [], assistant: [] }

  for (const msg of body.messages) {
    const text = extractOpenAIMessageText(msg)
    if (!text) continue
    parts.all.push(text)
    const role = msg.role as string
    if (role === "system") parts.system.push(text)
    else if (role === "user") parts.user.push(text)
    else if (role === "assistant") parts.assistant.push(text)
  }

  return {
    all: parts.all.join("\n"),
    system: parts.system.join("\n"),
    user: parts.user.join("\n"),
    assistant: parts.assistant.join("\n"),
  }
}

function extractOpenAIMessageText(msg: OpenAIChatMessage): string {
  if ("content" in msg) {
    if (typeof msg.content === "string") return msg.content
    if (Array.isArray(msg.content)) {
      return (msg.content as OpenAIContentPart[])
        .filter(p => p.type === "text" && p.text)
        .map(p => p.text!)
        .join("\n")
    }
  }
  return ""
}

/** 对 OpenAI 格式请求体执行管道式内容改写 */
export function rewriteOpenAI(body: OpenAIChatCompletionRequest, rules: RewriteRule[], context: RewriteContext): RewriteResult {
  const result: RewriteResult = { matched: false, matchedRules: [], errors: [] }

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!matchesContext(rule, context)) continue

    const textByScope = extractOpenAITextByScope(body)
    const matchConditions = rule.match ?? []
    if (!matchesConditions(matchConditions, textByScope)) continue

    /** 规则命中，执行替换 */
    result.matched = true
    result.matchedRules.push(rule.name)

    const action = rule.action
    const matchPattern = matchConditions[0]?.pattern
    const matchFlags = matchConditions[0]?.flags

    /** 收集规则中所有涉及的 scope，确定要处理哪些消息 */
    const targetScopes = new Set<RewriteScope>(matchConditions.map(c => c.scope || "all"))

    for (const msg of body.messages) {
      const role = msg.role as string
      const shouldProcess = [...targetScopes].some(s => roleInScope(role, s))
      if (!shouldProcess) continue

      applyActionToContent(msg, action, matchPattern, matchFlags)
    }
  }

  return result
}

/** 对单条消息的 content 执行动作 */
function applyActionToContent(
  msg: OpenAIChatMessage,
  action: RewriteAction,
  matchPattern?: string,
  matchFlags?: string,
): void {
  const content = msg.content
  if (typeof content === "string") {
    ;(msg as unknown as Record<string, unknown>).content = applyAction(content, action, matchPattern, matchFlags)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = applyAction(block.text, action, matchPattern, matchFlags)
      }
    }
  }
}

// ========== Anthropic 格式改写 ==========

/** 从 Anthropic 请求中提取按角色分组的文本 */
function extractAnthropicTextByScope(body: AnthropicMessagesRequest): Record<RewriteScope, string> {
  const parts: Record<RewriteScope, string[]> = { all: [], system: [], user: [], assistant: [] }

  /** system 是顶层字段 */
  const systemText = extractAnthropicSystemText(body.system)
  if (systemText) {
    parts.system.push(systemText)
    parts.all.push(systemText)
  }

  for (const msg of body.messages) {
    const text = extractAnthropicMessageText(msg)
    if (!text) continue
    parts.all.push(text)
    if (msg.role === "user") parts.user.push(text)
    else if (msg.role === "assistant") parts.assistant.push(text)
  }

  return {
    all: parts.all.join("\n"),
    system: parts.system.join("\n"),
    user: parts.user.join("\n"),
    assistant: parts.assistant.join("\n"),
  }
}

function extractAnthropicSystemText(system: string | AnthropicSystemBlock[] | undefined): string {
  if (!system) return ""
  if (typeof system === "string") return system
  return system.filter(b => b.type === "text").map(b => b.text).join("\n")
}

function extractAnthropicMessageText(msg: AnthropicMessage): string {
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content)) {
    const parts: string[] = []
    for (const block of msg.content as AnthropicContentBlock[]) {
      if (block.type === "text") parts.push(block.text)
      else if (block.type === "thinking") parts.push(`[thinking] ${block.thinking} [/thinking]`)
      else if (block.type === "tool_use") parts.push(`[tool_call: ${block.name}(${JSON.stringify(block.input)})]`)
      else if (block.type === "tool_result") parts.push(`[tool_result: ...]`)
    }
    return parts.join("\n")
  }
  return ""
}

/** 对 Anthropic 格式请求体执行管道式内容改写 */
export function rewriteAnthropic(body: AnthropicMessagesRequest, rules: RewriteRule[], context: RewriteContext): RewriteResult {
  const result: RewriteResult = { matched: false, matchedRules: [], errors: [] }

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!matchesContext(rule, context)) continue

    const textByScope = extractAnthropicTextByScope(body)
    const matchConditions = rule.match ?? []
    if (!matchesConditions(matchConditions, textByScope)) continue

    result.matched = true
    result.matchedRules.push(rule.name)

    const action = rule.action
    const matchPattern = matchConditions[0]?.pattern
    const matchFlags = matchConditions[0]?.flags

    const targetScopes = new Set<RewriteScope>(matchConditions.map(c => c.scope || "all"))

    /** 处理顶层 system 字段 */
    if (targetScopes.has("system") || targetScopes.has("all")) {
      if (typeof body.system === "string" && body.system) {
        body.system = applyAction(body.system, action, matchPattern, matchFlags)
      } else if (Array.isArray(body.system)) {
        for (const block of body.system) {
          if (block.type === "text") {
            block.text = applyAction(block.text, action, matchPattern, matchFlags)
          }
        }
      }
    }

    /** 处理 messages */
    for (const msg of body.messages) {
      const role = msg.role
      const shouldProcess = [...targetScopes].some(s => roleInScope(role, s))
      if (!shouldProcess) continue

      if (typeof msg.content === "string") {
        msg.content = applyAction(msg.content, action, matchPattern, matchFlags)
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content as AnthropicContentBlock[]) {
          if (block.type === "text") {
            block.text = applyAction(block.text, action, matchPattern, matchFlags)
          }
        }
      }
    }
  }

  return result
}

// ========== 纯文本改写（预览用） ==========

/** 对纯文本执行改写（用于日志预览） */
export function rewriteText(text: string, rules: RewriteRule[], context: RewriteContext): RewriteResult {
  const result: RewriteResult = { matched: false, matchedRules: [], errors: [] }
  let current = text

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!matchesContext(rule, context)) continue

    /** 纯文本没有角色区分，用全部文本匹配 */
    const textByScope: Record<RewriteScope, string> = { all: current, system: current, user: current, assistant: current }
    const matchConditions = rule.match ?? []
    if (!matchesConditions(matchConditions, textByScope)) continue

    result.matched = true
    result.matchedRules.push(rule.name)

    const action = rule.action
    const matchPattern = matchConditions[0]?.pattern
    const matchFlags = matchConditions[0]?.flags
    current = applyAction(current, action, matchPattern, matchFlags)
  }

  /** 将最终结果写回 —— 调用方需要自行比较 original vs current */
  return result
}

/** 对纯文本执行改写并返回改写后文本（预览 API 专用） */
export function rewriteTextWithResult(text: string, rules: RewriteRule[], context: RewriteContext): { result: RewriteResult; rewritten: string } {
  const result: RewriteResult = { matched: false, matchedRules: [], errors: [] }
  let current = text

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!matchesContext(rule, context)) continue

    const textByScope: Record<RewriteScope, string> = { all: current, system: current, user: current, assistant: current }
    const matchConditions = rule.match ?? []
    if (!matchesConditions(matchConditions, textByScope)) continue

    result.matched = true
    result.matchedRules.push(rule.name)

    const action = rule.action
    const matchPattern = matchConditions[0]?.pattern
    const matchFlags = matchConditions[0]?.flags
    current = applyAction(current, action, matchPattern, matchFlags)
  }

  return { result, rewritten: current }
}
