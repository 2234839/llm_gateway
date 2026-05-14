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

  for (const block of resp.content) {
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
    }
  }

  const message: OpenAIChatCompletionResponse["choices"][number]["message"] = {
    role: "assistant",
    content,
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
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
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
    default:
      return "stop"
  }
}
