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
  const choice = resp.choices[0]!
  const content: AnthropicResponseContentBlock[] = []

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content })
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })
    }
  }

  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    content,
    model: originalModel,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0,
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
      return "end_turn"
    default:
      return "end_turn"
  }
}
