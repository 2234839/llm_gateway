import type {
  AnthropicMessagesResponse,
  OpenAIChatCompletionResponse,
  OpenAIFinishReason,
} from "../types.ts"

/**
 * Anthropic Messages 响应 → OpenAI Chat Completions 响应
 */
export function convertResponseToOpenAI(
  resp: AnthropicMessagesResponse,
): OpenAIChatCompletionResponse {
  let content: string | null = null
  const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = []

  /** 合并 thinking 块内容到 reasoning_content 字段 */
  let reasoningContent: string | null = null

  for (const block of resp.content ?? []) {
    if (block.type === "text") {
      content = (content ?? "") + block.text
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      })
    } else if (block.type === "thinking") {
      reasoningContent = (reasoningContent ?? "") + block.thinking
    } else if (block.type !== "redacted_thinking") {
      console.warn(`[resp-to-openai] skipping unsupported content block type: ${(block as { type: string }).type}`)
    }
  }

  const message: OpenAIChatCompletionResponse["choices"][number]["message"] = {
    role: "assistant",
    content,
  }
  if (reasoningContent) {
    message.reasoning_content = reasoningContent
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapStopReason(resp.stop_reason),
    }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
      /** Anthropic 扩展字段，保留 cache token 信息 */
      cache_creation_input_tokens: resp.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: resp.usage?.cache_read_input_tokens ?? 0,
    },
  }
}

function mapStopReason(reason: string | null): OpenAIFinishReason {
  switch (reason) {
    case "end_turn":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool_calls"
    case "stop_sequence":
      return "stop"
    case "refusal":
      return "content_filter"
    case "pause_turn":
      return "stop"
    default:
      return "stop"
  }
}
