import type {
  OpenAIChatCompletionResponse,
  AnthropicMessagesResponse,
  AnthropicStopReason,
  AnthropicResponseContentBlock,
  OpenAIFinishReason,
} from "../types.ts"

/**
 * OpenAI Chat Completions 响应 → Anthropic Messages 响应
 */
export function convertResponseToAnthropic(
  resp: OpenAIChatCompletionResponse,
  originalModel: string,
): AnthropicMessagesResponse {
  const choice = resp.choices?.[0]
  if (!choice) {
    return {
      id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model: originalModel,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: resp.usage?.prompt_tokens ?? 0,
        output_tokens: resp.usage?.completion_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: resp.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    }
  }

  const content: AnthropicResponseContentBlock[] = []

  /** reasoning_content 映射为 thinking block（DeepSeek/OpenAI reasoning 扩展） */
  if (choice.message.reasoning_content) {
    content.push({ type: "thinking", thinking: choice.message.reasoning_content })
  }

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content })
  }

  if (choice.message.refusal) {
    content.push({ type: "text", text: `[Refusal] ${choice.message.refusal}` })
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function.arguments) ?? {} } catch { console.warn(`[resp-to-anthropic] Malformed tool call arguments for ${tc.function.name}: ${tc.function.arguments?.slice(0, 100)}`) }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: args,
      })
    }
  }

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    content: content.length > 0 ? content : [{ type: "text", text: "" }],
    model: originalModel,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: resp.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  }
}

function mapFinishReason(reason: OpenAIFinishReason): AnthropicStopReason {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "content_filter":
      return "refusal"
    default:
      return "end_turn"
  }
}
