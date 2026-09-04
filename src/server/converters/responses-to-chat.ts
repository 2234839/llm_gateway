import type {
  OpenAIResponsesRequest,
  OpenAIResponseInputItem,
  OpenAIResponseContentBlock,
  OpenAIResponsesTool,
  OpenAIChatCompletionRequest,
  OpenAIChatMessage,
  OpenAISystemMessage,
  OpenAIUserMessage,
  OpenAIAssistantMessage,
  OpenAIToolMessage,
  OpenAITool,
} from "../types.ts"

/**
 * OpenAI Responses 请求体 → Chat Completions 请求体
 * 网关内部以 Chat Completions 为中间格式：Responses 入口转换到 CC，
 * 再复用 CC→Anthropic / CC 直通链路。
 */
export function convertResponsesToChat(body: OpenAIResponsesRequest): OpenAIChatCompletionRequest {
  const messages: OpenAIChatMessage[] = []

  /** instructions 作为第一条 system 消息 */
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions })
  }

  const items = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: body.input } as OpenAIResponseInputItem]
    : body.input ?? []

  for (const item of items) {
    if (isMessageItem(item)) {
      const role = item.role === "system" || item.role === "developer" ? "system" : item.role
      if (role === "system") {
        const text = extractBlocksText(item.content ?? "")
        if (text) messages.push({ role: "system", content: text } satisfies OpenAISystemMessage)
      } else if (role === "user") {
        messages.push(convertUserItem(item.content ?? ""))
      } else {
        messages.push(convertAssistantItemContent(item.content ?? ""))
      }
    } else if (item.type === "function_call") {
      /** function_call item 归并为 assistant 消息的 tool_calls */
      appendToLastAssistant(messages, {
        id: item.call_id ?? "",
        type: "function",
        function: { name: item.name ?? "", arguments: item.arguments ?? "" },
      })
    } else if (item.type === "function_call_output") {
      const output = typeof item.output === "string"
        ? item.output
        : (item.output ?? []).map(b => b.type === "output_text" || b.type === "input_text" ? (b.text ?? "") : "").join("\n")
      messages.push({ role: "tool", tool_call_id: item.call_id ?? "", content: output } satisfies OpenAIToolMessage)
    } else if (item.type === "reasoning") {
      /** reasoning item：明文 content 归并到相邻 assistant 消息；summary 不支持，跳过 */
      const texts = extractReasoningText(item.content)
      if (texts) appendToLastAssistantText(messages, texts)
    } else {
      /** web_search_call 等其他 item 类型：跳过（无状态网关无法恢复） */
    }
  }

  const result: OpenAIChatCompletionRequest = {
    model: body.model,
    messages,
    stream: body.stream,
  }
  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools
      .filter(t => t.type === "function" && t.name)
      .map(t => ({
        type: "function",
        function: {
          name: t.name!,
          description: t.description ?? "",
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      } satisfies OpenAITool))
  }
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === "string") {
      result.tool_choice = body.tool_choice
    } else if (body.tool_choice?.type === "function" && body.tool_choice.name) {
      result.tool_choice = { type: "function", function: { name: body.tool_choice.name } }
    }
  }
  /** Responses 的 text.format → CC 的 response_format（json_schema 结构兼容） */
  const format = body.text?.format
  if (format && typeof format === "object" && format.type && format.type !== "text") {
    result.response_format = format as unknown as OpenAIChatCompletionRequest["response_format"]
  }
  if (body.user) result.user = body.user
  /** reasoning.effort → CC 的 reasoning_effort（DeepSeek / GLM 等模型支持） */
  if (body.reasoning?.effort) result.reasoning_effort = body.reasoning.effort

  return result
}

/** 类型守卫：是否为 message item（type 缺省视为 message） */
function isMessageItem(item: OpenAIResponseInputItem): item is OpenAIResponseInputItem & { role: string; content: string | OpenAIResponseContentBlock[] } {
  if (item.type !== undefined && item.type !== "message") return false
  return typeof item.role === "string"
}

/** 向最后一条 assistant 消息追加 tool_call（无则新建） */
function appendToLastAssistant(messages: OpenAIChatMessage[], toolCall: { id: string; type: "function"; function: { name: string; arguments: string } }): void {
  const last = messages[messages.length - 1]
  if (last && last.role === "assistant") {
    last.tool_calls = [...(last.tool_calls ?? []), toolCall]
  } else {
    messages.push({ role: "assistant", content: "", tool_calls: [toolCall] } satisfies OpenAIAssistantMessage)
  }
}

/** 向最后一条 assistant 消息追加文本（reasoning 明文回传场景） */
function appendToLastAssistantText(messages: OpenAIChatMessage[], text: string): void {
  const last = messages[messages.length - 1]
  if (last && last.role === "assistant") {
    last.content = ((last.content ?? "") + "\n" + text).trim() ? ((last.content ?? "") + "\n" + text) : text
  } else {
    messages.push({ role: "assistant", content: text } satisfies OpenAIAssistantMessage)
  }
}

/** 提取 reasoning item 的明文 content（OpenAI 新格式：[{type:"reasoning_text", text}]） */
function extractReasoningText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map(c => (c && typeof c === "object" && (c as { type?: string }).type === "reasoning_text" ? (c as { text?: string }).text ?? "" : ""))
    .filter(Boolean)
    .join("\n")
}

/** 提取内容块数组的纯文本 */
function extractBlocksText(content: string | OpenAIResponseContentBlock[]): string {
  if (typeof content === "string") return content
  return (content ?? [])
    .filter(b => (b.type === "input_text" || b.type === "output_text") && b.text)
    .map(b => b.text!)
    .join("\n")
}

/** user item → CC user 消息（图片转 image_url part） */
function convertUserItem(content: string | OpenAIResponseContentBlock[]): OpenAIUserMessage {
  if (typeof content === "string") return { role: "user", content }
  const parts: { type: "text" | "image_url"; text?: string; image_url?: { url: string } }[] = []
  for (const b of content ?? []) {
    if ((b.type === "input_text" || b.type === "output_text") && b.text) {
      parts.push({ type: "text", text: b.text })
    } else if (b.type === "input_image" && (b.image_url || b.file_id)) {
      parts.push({ type: "image_url", image_url: { url: (b.image_url ?? b.file_id)! } })
    }
  }
  return { role: "user", content: parts.length > 0 ? parts : "" }
}

/** assistant item 的 content → CC assistant 消息 */
function convertAssistantItemContent(content: string | OpenAIResponseContentBlock[]): OpenAIAssistantMessage {
  const text = extractBlocksText(content)
  return { role: "assistant", content: text || null }
}

/** 从 Responses 请求体提取全部文本（路由匹配 messageText 用） */
export function extractResponsesText(body: OpenAIResponsesRequest): string {
  const parts: string[] = []
  if (body.instructions) parts.push(body.instructions)
  if (typeof body.input === "string") {
    parts.push(body.input)
  } else {
    for (const item of body.input ?? []) {
      if (isMessageItem(item)) {
        const text = extractBlocksText(item.content ?? "")
        if (text) parts.push(text)
      } else if (item.type === "function_call") {
        parts.push(`[tool_call: ${item.name}(${item.arguments})]`)
      } else if (item.type === "function_call_output") {
        const output = typeof item.output === "string" ? item.output : extractBlocksText(item.output ?? [])
        parts.push(`[tool_result: ${output}]`)
      }
    }
  }
  return parts.join("\n")
}

/** 从 Responses 请求体提取内容类型集合（路由匹配 contentTypes 用） */
export function extractResponsesContentTypes(body: OpenAIResponsesRequest): Set<string> {
  const types = new Set<string>()
  if (typeof body.input !== "string" && Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isMessageItem(item)) continue
      const content = item.content
      if (typeof content === "string" || !content) continue
      for (const b of content) {
        if (b.type === "input_image") types.add("image")
      }
    }
  }
  return types
}

/** Responses 工具定义转换辅助（供日志提取复用） */
export function responsesToolsToChatTools(tools: OpenAIResponsesTool[] | undefined): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools
    .filter(t => t.type === "function" && t.name)
    .map(t => ({
      type: "function",
      function: {
        name: t.name!,
        description: t.description ?? "",
        parameters: t.parameters ?? { type: "object", properties: {} },
      },
    }))
}
