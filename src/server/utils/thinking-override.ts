/**
 * 思考选项改写：在协议转换后、发往上游前，对出站请求体中的思考相关参数做统一改写
 *
 * 纯函数模块，不依赖 Fastify / DB。
 * 涉及的协议字段：Anthropic 的 thinking / output_config.effort，OpenAI 的 thinking / reasoning_effort。
 * 注意：GLM 等模型在 OpenAI 协议下也支持 thinking 字段，因此两种出站协议都会处理 thinking。
 */

import type { ThinkingOverride } from "../types.ts"

/** 出站请求体的目标协议 */
export type OutboundProtocol = "anthropic" | "openai"

/** 从请求体中提取思考相关参数的快照（用于日志展示，无思考参数时返回 null） */
export function extractThinkingSnapshot(body: Record<string, unknown>): Record<string, unknown> | null {
  const snapshot: Record<string, unknown> = {}
  if (body.thinking !== undefined) snapshot.thinking = body.thinking
  if (body.reasoning_effort !== undefined) snapshot.reasoning_effort = body.reasoning_effort
  if (body.output_config !== undefined) snapshot.output_config = body.output_config
  return Object.keys(snapshot).length > 0 ? snapshot : null
}

/** 思考改写结果摘要，用于请求日志展示 */
export interface ThinkingOverrideResult {
  /** 是否实际改写了出站体 */
  applied: boolean
  /** 人类可读的改写摘要，如 "effort=low, thinking=disabled" */
  summary: string
}

/** 判断出站体中是否已存在客户端传入的思考参数 */
function hasClientThinking(body: Record<string, unknown>): boolean {
  return body.thinking !== undefined || body.reasoning_effort !== undefined || body.output_config !== undefined
}

/** 移除出站体中所有思考相关字段 */
function stripThinkingFields(body: Record<string, unknown>) {
  delete body.thinking
  delete body.reasoning_effort
  delete body.output_config
}

/**
 * 对出站请求体应用思考选项改写，返回改写结果（无 override 或未生效时返回 null）
 *
 * 字段优先级：strip > enabled:false > 其余字段
 * mode=default 时，若客户端已传任何思考参数则完全不干预
 */
export function applyThinkingOverride(
  body: Record<string, unknown>,
  override: ThinkingOverride | undefined,
  protocol: OutboundProtocol,
): ThinkingOverrideResult | null {
  if (!override) return null

  /** default 模式：客户端已带思考参数时不干预 */
  if (override.mode === "default" && hasClientThinking(body)) return null

  if (override.strip) {
    const had = hasClientThinking(body)
    stripThinkingFields(body)
    return { applied: had, summary: "strip all thinking fields" }
  }

  const parts: string[] = []

  /** enabled:false 优先于 effort/budgetTokens：显式关闭思考时忽略强度配置 */
  if (override.enabled === false) {
    stripThinkingFields(body)
    body.thinking = { type: "disabled" }
    return { applied: true, summary: "thinking=disabled" }
  }

  if (override.effort) {
    if (protocol === "anthropic") {
      body.output_config = { effort: override.effort }
    } else {
      body.reasoning_effort = override.effort
    }
    parts.push(`effort=${override.effort}`)
  }

  if (override.budgetTokens !== undefined) {
    /** budget_tokens 是 Anthropic 协议专属，且语义上必须开启思考 */
    if (protocol === "anthropic") {
      body.thinking = { type: "enabled", budget_tokens: override.budgetTokens }
      parts.push(`budget_tokens=${override.budgetTokens}`)
    }
  } else if (override.enabled === true) {
    /** 保留已有的 budget_tokens（可能由 effort 转换或客户端传入），仅强制开启 */
    const existing = body.thinking as { type?: string; budget_tokens?: number } | undefined
    body.thinking = existing?.budget_tokens
      ? { type: "enabled", budget_tokens: existing.budget_tokens }
      : { type: "enabled" }
    parts.push("thinking=enabled")
  }

  if (parts.length === 0) return null
  return { applied: true, summary: parts.join(", ") }
}
