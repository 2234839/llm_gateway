import type {
  OpenAIResponsesResponse,
  OpenAIResponseOutputItem,
  OpenAIChatCompletionResponse,
  OpenAIUsage,
} from "../types.ts"

/**
 * Chat Completions 非流式响应 → Responses 非流式响应
 * 网关内部以 Chat Completions 为中间格式：上游（openai/anthropic 转换后）的 CC 响应
 * 转回 Responses 格式返回给客户端。
 */
export function convertChatToResponses(resp: OpenAIChatCompletionResponse, originalModel: string): OpenAIResponsesResponse {
  const choice = resp.choices?.[0]
  const message = choice?.message
  const output: OpenAIResponseOutputItem[] = []

  /** reasoning_content → reasoning item（Codex 等客户端会回传 reasoning item） */
  if (message?.reasoning_content) {
    output.push({
      type: "reasoning",
      id: `rs_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    } as OpenAIResponseOutputItem)
  }

  /** 文本内容 → message item */
  if (message?.content !== null && message?.content !== undefined && message.content !== "") {
    output.push({
      type: "message",
      id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    })
  }

  /** tool_calls → function_call items（顺序保持在文本之后） */
  if (Array.isArray(message?.tool_calls)) {
    for (const tc of message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      })
    }
  }

  const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const finishMap: Record<string, string> = { stop: "completed", tool_calls: "completed", length: "incomplete", content_filter: "incomplete" }
  const status = finishMap[choice?.finish_reason ?? ""] ?? "completed"

  return {
    id: resp.id ? `resp_${resp.id.replace(/^chatcmpl-/, "")}` : `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "response",
    created_at: resp.created ?? Math.floor(Date.now() / 1000),
    status: status as OpenAIResponsesResponse["status"],
    model: originalModel,
    output,
    usage: {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens ?? (usage.prompt_tokens + usage.completion_tokens),
      input_tokens_details: usage.prompt_tokens_details,
      output_tokens_details: usage.output_tokens_details,
    },
  }
}

/** 从 Responses 非流式响应提取输出文本摘要（日志用） */
export function extractResponsesResponseText(resp: OpenAIResponsesResponse): string {
  const parts: string[] = []
  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) parts.push(c.text)
      }
    } else if (item.type === "reasoning") {
      const summary = (item.summary ?? []) as { type?: string; text?: string }[]
      for (const s of summary) {
        if (s.type === "summary_text" && s.text) parts.push(`[thinking] ${s.text} [/thinking]`)
      }
    } else if (item.type === "function_call") {
      parts.push(`[tool_call: ${item.name}(${item.arguments})]`)
    }
  }
  return parts.join("\n")
}

/** 从 OpenAI usage（CC 格式）构造 Responses usage 对象 */
export function chatUsageToResponsesUsage(usage: OpenAIUsage): OpenAIResponsesResponse["usage"] {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens ?? (usage.prompt_tokens + usage.completion_tokens),
    input_tokens_details: usage.prompt_tokens_details,
    output_tokens_details: usage.output_tokens_details,
  }
}
