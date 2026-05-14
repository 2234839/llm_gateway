import type { OpenAIChatCompletionRequest, AnthropicMessagesRequest, AnthropicMessagesResponse } from "../types.ts"

/** 从 OpenAI 格式请求中提取全部消息文本，用换行拼接 */
export function extractOpenAIText(body: OpenAIChatCompletionRequest): string {
  const parts: string[] = []
  for (const msg of body.messages) {
    const text = extractOpenAIMessageText(msg)
    if (text) parts.push(text)
  }
  return parts.join("\n")
}

function extractOpenAIMessageText(msg: OpenAIChatCompletionRequest["messages"][number]): string {
  switch (msg.role) {
    case "system":
      return msg.content
    case "user":
      if (typeof msg.content === "string") return msg.content
      return msg.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text" && "text" in part)
        .map(part => part.text)
        .join("\n")
    case "assistant": {
      const parts: string[] = []
      if (msg.content) parts.push(msg.content)
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push(`[tool_call: ${tc.function.name}(${tc.function.arguments})]`)
        }
      }
      return parts.join("\n")
    }
    case "tool":
      return `[tool_result: ${msg.content}]`
  }
}

/** 从 Anthropic 格式请求中提取全部消息文本，用换行拼接 */
export function extractAnthropicText(body: AnthropicMessagesRequest): string {
  const parts: string[] = []

  if (typeof body.system === "string" && body.system) {
    parts.push(body.system)
  } else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block.type === "text") parts.push(block.text)
    }
  }

  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      if (msg.content) parts.push(msg.content)
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push(block.text)
        } else if (block.type === "tool_use") {
          parts.push(`[tool_call: ${block.name}(${JSON.stringify(block.input)})]`)
        } else if (block.type === "tool_result") {
          const resultText = typeof block.content === "string"
            ? block.content
            : block.content.map(b => b.text).join("")
          parts.push(`[tool_result: ${resultText}]`)
        }
      }
    }
  }

  return parts.join("\n")
}

/** 从 OpenAI 非流式响应中提取输出摘要（含工具调用） */
export function extractOpenAIResponseSummary(resp: Record<string, unknown>): string {
  const choices = resp.choices as { message?: { content?: string; tool_calls?: { function: { name: string; arguments: string } }[] } }[] | undefined
  const choice = choices?.[0]
  if (!choice?.message) return ""

  const parts: string[] = []
  if (choice.message.content) parts.push(choice.message.content)
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      parts.push(`[tool_call: ${tc.function.name}(${tc.function.arguments})]`)
    }
  }
  return parts.join("\n")
}

/** 从 Anthropic 格式请求中检测多模态内容类型 */
export function extractAnthropicContentTypes(body: AnthropicMessagesRequest): Set<string> {
  const types = new Set<string>()
  for (const msg of body.messages) {
    if (typeof msg.content === "string") continue
    for (const block of msg.content) {
      if (block.type === "image") {
        if (block.source.media_type.startsWith("application/")) {
          types.add("file")
        } else {
          types.add("image")
        }
      } else if (block.type === "tool_use") {
        types.add("tool_use")
      }
    }
  }
  return types
}

/** 从 OpenAI 格式请求中检测多模态内容类型 */
export function extractOpenAIContentTypes(body: OpenAIChatCompletionRequest): Set<string> {
  const types = new Set<string>()
  for (const msg of body.messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      types.add("tool_use")
    }
    if (typeof msg.content === "string" || !msg.content) continue
    for (const part of msg.content) {
      if (part.type === "image_url" && part.image_url) {
        const url = part.image_url.url
        if (url.startsWith("data:")) {
          const mimeMatch = url.match(/^data:([^;]+)/)
          if (mimeMatch && mimeMatch[1]!.startsWith("application/")) {
            types.add("file")
          } else {
            types.add("image")
          }
        } else {
          types.add("image")
        }
      }
    }
  }
  return types
}

/** 从 Anthropic 非流式响应中提取输出摘要（含工具调用） */
export function extractAnthropicResponseSummary(resp: AnthropicMessagesResponse): string {
  if (!resp.content) return ""
  const parts: string[] = []
  for (const block of resp.content) {
    if (block.type === "text") {
      parts.push(block.text)
    } else if (block.type === "tool_use") {
      parts.push(`[tool_call: ${block.name}(${JSON.stringify(block.input)})]`)
    }
  }
  return parts.join("\n")
}
