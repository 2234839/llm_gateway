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

  /** OpenAI user 字段映射到 Anthropic metadata.user_id */
  if (body.user) {
    result.metadata = { user_id: body.user }
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
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        blocks.push({
          type: "image",
          source: { type: "url", url },
        })
      }
    } else if (part.type !== "text" && part.type !== "image_url") {
      /** input_audio, refusal 等无法映射到 Anthropic 格式，记录并跳过 */
      console.warn(`[to-anthropic] skipping unsupported user content part type: ${(part as { type: string }).type}`)
    }
  }

  return { role: "user", content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }] }
}

function convertAssistantMessage(msg: OpenAIAssistantMessage): AnthropicMessage {
  const blocks: AnthropicContentBlock[] = []

  if (msg.content) {
    blocks.push({ type: "text", text: msg.content })
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(tc.function.arguments) ?? {} } catch { /* malformed arguments, use empty object */ }
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: args,
      })
    }
  }

  return { role: "assistant", content: blocks.length > 0 ? blocks : "" }
}

function convertToolMessage(msg: OpenAIToolMessage): AnthropicMessage {
  const rawContent = msg.content ?? ""
  /** 检测从 Anthropic 转换来的错误标记 */
  const isError = rawContent.startsWith("[ERROR] ")
  const content = isError ? rawContent.slice(8) : rawContent
  return {
    role: "user",
    content: [{
      type: "tool_result",
      tool_use_id: msg.tool_call_id,
      content,
      ...(isError ? { is_error: true } : {}),
    }],
  }
}

function convertTool(tool: { function: { name: string; description?: string; parameters: Record<string, unknown> } }): AnthropicTool {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
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
        return { type: "any", disable_parallel_tool_use: true }
    }
  }
  if (typeof choice === "object" && choice.type === "function") {
    return { type: "tool", name: choice.function.name }
  }
  return { type: "auto" }
}
