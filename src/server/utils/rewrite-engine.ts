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
function applyAction(text: string, action: RewriteAction): string {
  switch (action.type) {
    case "regex_replace": {
      if (!action.pattern) return text
      const re = getCachedSafeRegex(action.pattern, (action.flags ?? "") + "g")
      if (!re) return text
      /** 安全替换：限制替换迭代次数 */
      let count = 0
      return text.replace(re, (...args) => {
        if (++count > MAX_REPLACE_ITERATIONS) return args[0] as string
        return action.replacement
      })
    }
    case "text_replace": {
      if (!action.pattern) return text
      /** 纯文本字面量替换，不走正则 */
      return text.split(action.pattern).join(action.replacement)
    }
    case "prepend":
      return action.replacement + text
    case "append":
      return text + action.replacement
  }
}

/** 计算某个动作的作用 scope 集合：动作自身 scope 优先，否则用 match 条件涉及的 scopes，都没有则作用于全部消息 */
function actionScopes(action: RewriteAction, matchConditions: RewriteMatchCondition[]): Set<RewriteScope> {
  if (action.scope) return new Set([action.scope])
  const scopes = new Set<RewriteScope>(matchConditions.map(c => c.scope || "all"))
  if (scopes.size === 0) scopes.add("all")
  return scopes
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

/** 检查匹配条件是否命中：条件为空表示无条件生效 */
function matchesConditions(conditions: RewriteMatchCondition[], textByScope: Record<RewriteScope, string>): boolean {
  if (!conditions.length) return true
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

  /** 工具描述属于系统注入内容，计入 system 桶 */
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool.function?.description) {
        parts.system.push(tool.function.description)
        parts.all.push(tool.function.description)
      }
    }
  }

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

    /** 规则命中，按顺序执行动作组；只有内容实际发生变化才计入命中（避免"命中但没改任何东西"的误导） */
    const beforeText = textByScope.all
    for (const action of rule.actions) {
      const targetScopes = actionScopes(action, matchConditions)
      for (const msg of body.messages) {
        const role = msg.role as string
        const shouldProcess = [...targetScopes].some(s => roleInScope(role, s))
        if (!shouldProcess) continue

        applyActionToContent(msg, action)
      }
      /** 工具描述属于系统注入内容：scope 命中 system/all 时同步改写（如 Claude Code 把指令藏在 Bash 工具描述里） */
      if ((targetScopes.has("system") || targetScopes.has("all")) && Array.isArray(body.tools)) {
        for (const tool of body.tools) {
          if (typeof tool.function?.description === "string") {
            tool.function.description = applyAction(tool.function.description, action)
          }
        }
      }
    }
    if (extractOpenAITextByScope(body).all !== beforeText) {
      result.matched = true
      result.matchedRules.push(rule.name)
    }
  }

  return result
}

/** 对单条消息的 content 执行动作 */
function applyActionToContent(
  msg: OpenAIChatMessage,
  action: RewriteAction,): void {
  const content = msg.content
  if (typeof content === "string") {
    ;(msg as unknown as Record<string, unknown>).content = applyAction(content, action)
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = applyAction(block.text, action)
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

  /** 工具描述属于系统注入内容，计入 system 桶 */
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool.description) {
        parts.system.push(tool.description)
        parts.all.push(tool.description)
      }
    }
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

    /** 只有内容实际发生变化才计入命中（避免"命中但没改任何东西"的误导） */
    const beforeText = textByScope.all

    for (const action of rule.actions) {
      const targetScopes = actionScopes(action, matchConditions)

      /** 处理顶层 system 字段 */
      if (targetScopes.has("system") || targetScopes.has("all")) {
        if (typeof body.system === "string" && body.system) {
          body.system = applyAction(body.system, action)
        } else if (Array.isArray(body.system)) {
          for (const block of body.system) {
            if (block.type === "text") {
              block.text = applyAction(block.text, action)
            }
          }
        }
        /** 工具描述属于系统注入内容：同步改写（如 Claude Code 把指令藏在 Bash 工具描述里） */
        if (Array.isArray(body.tools)) {
          for (const tool of body.tools) {
            if (typeof tool.description === "string") {
              tool.description = applyAction(tool.description, action)
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
          msg.content = applyAction(msg.content, action)
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content as AnthropicContentBlock[]) {
            if (block.type === "text") {
              block.text = applyAction(block.text, action)
            }
          }
        }
      }
    }
    if (extractAnthropicTextByScope(body).all !== beforeText) {
      result.matched = true
      result.matchedRules.push(rule.name)
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
    for (const action of rule.actions) {
      current = applyAction(current, action)
    }
  }

  /** 将最终结果写回 —— 调用方需要自行比较 original vs current */
  return result
}

/** 对纯文本执行改写并返回改写后文本（预览 API 专用） */
export function rewriteTextWithResult(text: string, rules: RewriteRule[], context: RewriteContext): { result: RewriteResult; rewritten: string } {
  const { result, rewritten } = rewriteTextWithSteps(text, rules, context)
  return { result, rewritten }
}

/** 单个动作的改写步骤快照（预览展示用） */
export interface RewriteStep {
  /** 命中的规则名 */
  ruleName: string
  /** 动作备注名（用户自定义，可选） */
  actionName?: string
  /** 该动作执行前的文本 */
  before: string
  /** 该动作执行后的文本 */
  after: string
}

/** 对纯文本执行改写，逐步记录每个动作的 before/after（预览 API 专用） */
export function rewriteTextWithSteps(text: string, rules: RewriteRule[], context: RewriteContext): { result: RewriteResult; steps: RewriteStep[]; rewritten: string } {
  const result: RewriteResult = { matched: false, matchedRules: [], errors: [] }
  const steps: RewriteStep[] = []
  let current = text

  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!matchesContext(rule, context)) continue

    const textByScope: Record<RewriteScope, string> = { all: current, system: current, user: current, assistant: current }
    const matchConditions = rule.match ?? []
    if (!matchesConditions(matchConditions, textByScope)) continue

    result.matched = true
    result.matchedRules.push(rule.name)

    for (const action of rule.actions) {
      const before = current
      current = applyAction(current, action)
      steps.push({ ruleName: rule.name, actionName: action.name, before, after: current })
    }
  }

  return { result, steps, rewritten: current }
}
