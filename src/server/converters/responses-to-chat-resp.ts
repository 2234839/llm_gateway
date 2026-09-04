import type { OpenAIResponsesResponse, OpenAIChatCompletionResponse } from "../types.ts"

/**
 * Responses 响应 → Chat Completions 响应
 * message/reasoning/function_call output items → choices[0].message；usage 字段映射
 */
export function convertResponsesToChatResponse(resp: OpenAIResponsesResponse, requestModel: string): OpenAIChatCompletionResponse {
  let text = ""
  let reasoning = ""
  const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = []
  let finishReason: string | null = null

  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) text += c.text
      }
    } else if (item.type === "reasoning") {
      for (const s of item.summary ?? []) {
        if (s.type === "summary_text" && s.text) reasoning += s.text
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "call_" + Math.random().toString(36).slice(2, 10),
        type: "function",
        function: { name: item.name ?? "", arguments: item.arguments ?? "{}" },
      })
      if (finishReason === null) finishReason = "tool_calls"
    }
  }

  if (resp.status === "incomplete") finishReason = "length"
  if (finishReason === null) finishReason = "stop"

  const message: Record<string, unknown> = { role: "assistant", content: text || null }
  if (reasoning) message.reasoning_content = reasoning
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  return {
    id: resp.id ?? "chatcmpl-" + Math.random().toString(36).slice(2, 12),
    object: "chat.completion",
    created: resp.created_at ?? Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [{ index: 0, message: message as OpenAIChatCompletionResponse["choices"][number]["message"], finish_reason: finishReason }],
    usage: {
      prompt_tokens: resp.usage?.input_tokens ?? 0,
      completion_tokens: resp.usage?.output_tokens ?? 0,
      total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
      prompt_tokens_details: resp.usage?.input_tokens_details?.cached_tokens ? { cached_tokens: resp.usage.input_tokens_details.cached_tokens } : undefined,
      completion_tokens_details: resp.usage?.output_tokens_details?.reasoning_tokens ? { reasoning_tokens: resp.usage.output_tokens_details.reasoning_tokens } : undefined,
    },
  } as OpenAIChatCompletionResponse
}
