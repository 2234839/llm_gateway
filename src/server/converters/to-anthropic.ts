import type {
  OpenAIChatCompletionRequest,
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicTool,
  AnthropicContentBlock,
  AnthropicToolChoice,
  OpenAIChatMessage,
  OpenAIAssistantMessage,
  OpenAIUserMessage,
  OpenAIToolMessage,
  OpenAISystemMessage,
} from "../types.ts"

/**
 * OpenAI Chat Completions 请求体 → Anthropic Messages 请求体
 */
export function convertRequestToAnthropic(body: OpenAIChatCompletionRequest, targetModel: string): AnthropicMessagesRequest {
  const messages: AnthropicMessage[] = []
  let system: string | undefined

  for (const msg of body.messages) {
    const role = msg.role
    if (role === "system") {
      const sysMsg = msg as OpenAISystemMessage
      system = system ? `${system}\n${sysMsg.content}` : sysMsg.content
      continue
    }

    if (role === "user") {
      messages.push(convertUserMessage(msg as OpenAIUserMessage))
    } else if (role === "assistant") {
      messages.push(convertAssistantMessage(msg as OpenAIAssistantMessage))
    } else if (role === "tool") {
      messages.push(convertToolMessage(msg as OpenAIToolMessage))
    }
  }

  const result: AnthropicMessagesRequest = {
    model: targetModel,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
    messages,
    stream: body.stream,
  }

  if (system) result.system = system
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.stop) {
    result.stop_sequences = typeof body.stop === "string" ? [body.stop] : body.stop
  }

  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map(convertTool)
  }

  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice)
  }

  return result
}

function convertUserMessage(msg: OpenAIUserMessage): AnthropicMessage {
  if (typeof msg.content === "string") {
    return { role: "user", content: msg.content }
  }

  const blocks: AnthropicContentBlock[] = []
  for (const part of msg.content) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text })
    } else if (part.type === "image_url" && part.image_url) {
      const url = part.image_url.url
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/)
        if (match) {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: match[1]!, data: match[2]! },
          })
        }
      }
    }
  }

  return { role: "user", content: blocks }
}

function convertAssistantMessage(msg: OpenAIAssistantMessage): AnthropicMessage {
  const blocks: AnthropicContentBlock[] = []

  if (msg.content) {
    blocks.push({ type: "text", text: msg.content })
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })
    }
  }

  return { role: "assistant", content: blocks.length > 0 ? blocks : "" }
}

function convertToolMessage(msg: OpenAIToolMessage): AnthropicMessage {
  /** Anthropic 中 tool_result 放在 user 消息的 content 数组里 */
  return {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: msg.tool_call_id,
      content: msg.content,
    }],
  }
}

function convertTool(tool: OpenAIChatCompletionRequest["tools"] extends (infer T)[] | undefined ? T : never): AnthropicTool {
  const t = tool as { function: { name: string; description?: string; parameters: Record<string, unknown> } }
  return {
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }
}

function convertToolChoice(choice: OpenAIChatCompletionRequest["tool_choice"]): AnthropicToolChoice | undefined {
  if (!choice) return undefined
  if (typeof choice === "string") {
    switch (choice) {
      case "auto":
        return { type: "auto" }
      case "none":
        return { type: "none" }
      case "required":
        return { type: "any" }
    }
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name }
  }
  return { type: "auto" }
}
