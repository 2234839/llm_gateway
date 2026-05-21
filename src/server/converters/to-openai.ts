import type {
  AnthropicMessagesRequest,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAITool,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  OpenAIUserMessage,
} from "../types.ts"

/**
 * Anthropic Messages 请求体 → OpenAI Chat Completions 请求体
 */
export function convertRequestToOpenAI(body: AnthropicMessagesRequest, targetModel: string): OpenAIChatCompletionRequest {
  const messages: OpenAIChatMessage[] = []

  /** system 顶层字段 → messages 中的 system message */
  if (body.system) {
    const systemText = typeof body.system === "string"
      ? body.system
      : body.system.map(b => b.text).join("\n")
    messages.push({ role: "system", content: systemText })
  }

  /** 转换消息列表 */
  for (const msg of body.messages) {
    const converted = convertMessage(msg)
    messages.push(...converted)
  }

  const result: OpenAIChatCompletionRequest = {
    model: targetModel,
    messages,
    max_tokens: body.max_tokens,
    stream: body.stream,
  }

  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.stop_sequences) result.stop = body.stop_sequences

  /** 转换工具定义 */
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools.map(convertTool)
  }

  /** 转换 tool_choice */
  if (body.tool_choice) {
    result.tool_choice = convertToolChoice(body.tool_choice)
  }

  /** 流式时请求 usage */
  if (body.stream) {
    result.stream_options = { include_usage: true }
  }

  /** Anthropic metadata.user_id 映射到 OpenAI user */
  if (body.metadata?.user_id) {
    result.user = body.metadata.user_id
  }

  /** 透传思考模式参数（DeepSeek / GLM 等模型支持） */
  if (body.thinking) {
    result.thinking = { type: body.thinking.type }
  }
  /** Anthropic output_config.effort → OpenAI reasoning_effort（xhigh 映射为 high） */
  if (body.output_config?.effort) {
    result.reasoning_effort = body.output_config.effort === "xhigh" ? "high" : body.output_config.effort
  }

  return result
}

function convertMessage(msg: AnthropicMessage): OpenAIChatMessage[] {
  const results: OpenAIChatMessage[] = []

  if (typeof msg.content === "string") {
    results.push({ role: msg.role, content: msg.content } as OpenAIChatMessage)
    return results
  }

  /** content block 数组需要拆分处理 */
  if (msg.role === "user") {
    results.push(...convertUserContentBlocks(msg.content))
  } else {
    results.push(...convertAssistantContentBlocks(msg.content))
  }

  return results
}

function convertUserContentBlocks(blocks: AnthropicContentBlock[]): OpenAIChatMessage[] {
  const results: OpenAIChatMessage[] = []
  const userParts: Exclude<OpenAIUserMessage["content"], string> = []
  const toolResults: AnthropicToolResultBlock[] = []

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        userParts.push({ type: "text", text: block.text })
        break
      case "image":
        if (block.source.type === "base64") {
          userParts.push({
            type: "image_url",
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          })
        } else {
          userParts.push({
            type: "image_url",
            image_url: { url: block.source.url },
          })
        }
        break
      case "tool_result":
        toolResults.push(block)
        break
      default:
        /** thinking, redacted_thinking, input_audio 等无法映射到 OpenAI 格式，记录并跳过 */
        console.warn(`[to-openai] skipping unsupported user content block type: ${(block as { type: string }).type}`)
        break
    }
  }

  /** tool_result 拆分为独立的 role: "tool" 消息（必须在 user 文本之前，OpenAI 要求紧跟 assistant tool_calls） */
  for (const tr of toolResults) {
    const raw = tr.content
    const content = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(b => {
      if ("text" in b) return b.text
      /** 图片内容：保留 base64 数据描述，OpenAI tool message content 不支持 image_url */
      const img = b as { type: "image"; source: { type: string; media_type?: string; data?: string } }
      return `[image: ${img.source.media_type ?? "unknown"}, ${img.source.data?.length ?? 0} bytes]`
    }).join("\n") : ""
    results.push({ role: "tool", tool_call_id: tr.tool_use_id, content: tr.is_error ? `[ERROR] ${content}` : content })
  }

  /** 保留非 tool_result 的 user 内容（放在 tool_result 之后） */
  if (userParts.length > 0) {
    results.push({ role: "user", content: userParts })
  }

  return results
}

function convertAssistantContentBlocks(blocks: AnthropicContentBlock[]): OpenAIChatMessage[] {
  const textParts: string[] = []
  const toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = []
  /** 合并所有 thinking 块的内容，映射到 DeepSeek/OpenAI 的 reasoning_content 字段 */
  const thinkingParts: string[] = []

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        textParts.push(block.text)
        break
      case "thinking":
        thinkingParts.push(block.thinking)
        break
      case "tool_use": {
        const tb = block as AnthropicToolUseBlock
        toolCalls.push({
          id: tb.id,
          type: "function",
          function: { name: tb.name, arguments: JSON.stringify(tb.input) },
        })
        break
      }
      /** redacted_thinking 无法映射，跳过 */
    }
  }

  const msg: OpenAIChatMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  }

  if (thinkingParts.length > 0) {
    (msg as { reasoning_content?: string }).reasoning_content = thinkingParts.join("")
  }

  if (toolCalls.length > 0) {
    (msg as { tool_calls: typeof toolCalls }).tool_calls = toolCalls
  }

  return [msg]
}

function convertTool(tool: { name: string; description?: string; input_schema: Record<string, unknown> }): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }
}

function convertToolChoice(choice: AnthropicMessagesRequest["tool_choice"]): OpenAIChatCompletionRequest["tool_choice"] {
  if (!choice) return undefined
  switch (choice.type) {
    case "auto":
      return "auto"
    case "any":
      return "required"
    case "none":
      return "none"
    case "tool":
      return { type: "function", function: { name: choice.name } }
    default:
      return undefined
  }
}
