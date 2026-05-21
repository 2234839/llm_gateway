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

  /** 修复 Anthropic 消息序列：
   *  1. 确保每个 assistant(tool_use) 后紧跟包含对应 tool_result 的 user 消息
   *  2. 移除没有 tool_use 来源的孤立 tool_result
   *  3. 确保 messages[0] 不是 assistant
   */
  repairAnthropicMessages(messages)

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

  /** 透传思考模式参数（DeepSeek / GLM 等模型支持） */
  if (body.thinking) {
    result.thinking = { type: body.thinking.type }
  }
  /** OpenAI reasoning_effort → Anthropic output_config.effort */
  if (body.reasoning_effort) {
    result.output_config = { effort: body.reasoning_effort }
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

  /**
   * reasoning_content 映射规则：
   * - 有 reasoning_signature → thinking block（DeepSeek AnthropicFB 标准格式）
   * - 无 reasoning_signature → 作为 text 嵌入内容（避免 thinking block 缺少 signature 被拒绝）
   */
  if (msg.reasoning_content) {
    if (msg.reasoning_signature) {
      blocks.push({ type: "thinking", thinking: msg.reasoning_content, signature: msg.reasoning_signature })
    } else {
      console.warn(`[to-anthropic] assistant message has reasoning_content (${msg.reasoning_content.length} chars) but no reasoning_signature — embedding as text`)
      blocks.push({ type: "text", text: msg.reasoning_content })
    }
  }

  /** DeepSeek thinking mode 要求所有 assistant 消息必须包含 thinking block。
   *  如果 assistant 消息有 tool_calls 但没有 reasoning_content，
   *  说明之前一轮有 thinking 但本轮 context 中丢失了（压缩、截断等）。
   *  此时无法满足要求 — 记录但不做额外处理，因为无法凭空创建 signature。
   */
  if (!msg.reasoning_content && msg.tool_calls && msg.tool_calls.length > 0) {
    console.warn(`[to-anthropic] assistant(tool_calls) has no reasoning_content — DeepSeek thinking mode may reject this`)
  }

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

/** 从 content blocks 中提取所有 tool_use id */
function extractToolUseIds(content: string | AnthropicContentBlock[]): string[] {
  if (typeof content === "string") return []
  const ids: string[] = []
  for (const block of content) {
    if (block.type === "tool_use") ids.push(block.id)
  }
  return ids
}

/** 从 content blocks 中提取所有 tool_result 的 tool_use_id */
function extractToolResultIds(content: string | AnthropicContentBlock[]): string[] {
  if (typeof content === "string") return []
  const ids: string[] = []
  for (const block of content) {
    if (block.type === "tool_result") ids.push(block.tool_use_id)
  }
  return ids
}

/**
 * 修复 Anthropic 消息序列中的 tool_use / tool_result 配对问题
 *
 * Anthropic API 严格要求：
 *   - assistant(tool_use) 后面**必须紧跟**包含对应 tool_result 的 user 消息
 *   - 中间不能夹其他消息
 *   - 孤立的 tool_result 要移除
 *   - 无 tool_result 的 tool_use 要移除
 *   - messages 不能以 assistant 开头
 */
function repairAnthropicMessages(messages: AnthropicMessage[]): void {
  /** 收集所有 tool_result id（全局扫描） */
  const allToolResultIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "user") continue
    for (const id of extractToolResultIds(msg.content)) {
      allToolResultIds.add(id)
    }
  }

  /** 第一遍：清理无响应的 tool_use 和纯文本 assistant */
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    const useIds = extractToolUseIds(msg.content)
    if (useIds.length === 0) continue

    const validIds = useIds.filter(id => allToolResultIds.has(id))
    if (validIds.length === useIds.length) continue

    if (validIds.length === 0) {
      msg.content = msg.content.filter(b => b.type !== "tool_use")
      if ((msg.content as AnthropicContentBlock[]).length === 0) msg.content = ""
    } else {
      const validSet = new Set(validIds)
      msg.content = msg.content.filter(b => b.type !== "tool_use" || validSet.has(b.id))
    }
  }

  /** 收集所有剩余 tool_use id */
  const allToolUseIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    for (const id of extractToolUseIds(msg.content)) {
      allToolUseIds.add(id)
    }
  }

  /** 第二遍：清理孤立 tool_result */
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== "user" || typeof msg.content === "string") continue
    const resultIds = extractToolResultIds(msg.content)
    const orphanIds = resultIds.filter(id => !allToolUseIds.has(id))
    if (orphanIds.length === 0) continue

    const orphanSet = new Set(orphanIds)
    msg.content = (msg.content as AnthropicContentBlock[]).filter(
      b => b.type !== "tool_result" || !orphanSet.has(b.tool_use_id)
    )
    if ((msg.content as AnthropicContentBlock[]).length === 0) {
      messages.splice(i, 1)
    }
  }

  /** 第三遍：确保 assistant(tool_use) 后紧跟 user(tool_result)。
   *  如果中间夹了非 tool_result 的 user 消息，把后面的 tool_result 移到紧跟的位置。
   */
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role !== "assistant" || typeof msg.content === "string") continue
    const useIds = extractToolUseIds(msg.content)
    if (useIds.length === 0) continue

    /** 下一条消息必须是 user，且包含所有对应 tool_result */
    if (i + 1 >= messages.length) {
      /** assistant(tool_use) 是最后一条消息，没有 tool_result → 移除 tool_use */
      msg.content = (msg.content as AnthropicContentBlock[]).filter(b => b.type !== "tool_use")
      if ((msg.content as AnthropicContentBlock[]).length === 0) msg.content = ""
      continue
    }

    const next = messages[i + 1]!
    if (next.role === "user" && typeof next.content !== "string") {
      const nextResultIds = extractToolResultIds(next.content)
      const useSet = new Set(useIds)
      const covered = nextResultIds.filter(id => useSet.has(id))
      if (covered.length === useIds.length) continue  /** 已紧跟，OK */
    }

    /** 没有紧跟 → 在后面找所有对应的 tool_result，收集后插入紧跟位置 */
    const useSet = new Set(useIds)
    const foundResults: AnthropicContentBlock[] = []
    const removeIndices: number[] = []

    for (let j = i + 1; j < messages.length; j++) {
      const m = messages[j]!
      if (m.role !== "user" || typeof m.content === "string") continue
      const resultBlocks = (m.content as AnthropicContentBlock[]).filter(
        b => b.type === "tool_result" && useSet.has(b.tool_use_id)
      )
      if (resultBlocks.length > 0) {
        foundResults.push(...resultBlocks)
        /** 从原消息中移除这些 tool_result */
        const resultSet = new Set(resultBlocks.map(b => (b as { tool_use_id: string }).tool_use_id))
        m.content = (m.content as AnthropicContentBlock[]).filter(
          b => b.type !== "tool_result" || !resultSet.has((b as { tool_use_id: string }).tool_use_id)
        )
        if ((m.content as AnthropicContentBlock[]).length === 0) {
          removeIndices.push(j)
        }
      }
    }

    /** 移除空壳消息（从后向前） */
    for (let k = removeIndices.length - 1; k >= 0; k--) {
      messages.splice(removeIndices[k]!, 1)
    }

    /** 在 assistant 后面插入合并的 tool_result user 消息 */
    if (foundResults.length > 0) {
      messages.splice(i + 1, 0, { role: "user", content: foundResults })
    } else {
      /** 找不到任何 tool_result → 移除 tool_use */
      msg.content = (msg.content as AnthropicContentBlock[]).filter(b => b.type !== "tool_use")
      if ((msg.content as AnthropicContentBlock[]).length === 0) msg.content = ""
    }
  }

  /** 第四遍：合并连续的 user 消息（Anthropic 允许但最好合并） */
  /** 第五遍：确保 messages 不以 assistant 开头 */
  while (messages.length > 0 && messages[0]!.role === "assistant") {
    messages.shift()
  }

  /** 最终安全检查：确保没有空 user 消息 */
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role === "user") {
      if (typeof msg.content === "string" && msg.content === "") {
        messages.splice(i, 1)
      } else if (Array.isArray(msg.content) && msg.content.length === 0) {
        messages.splice(i, 1)
      }
    }
  }
}
