import type { OpenAIChatCompletionRequest, OpenAIResponsesRequest, OpenAIResponseInputItem, OpenAIResponseContentBlock } from "../types.ts"

/**
 * Chat Completions 请求 → Responses 请求
 * system 消息 → instructions；messages → input items；tools/tool_choice/reasoning 直接映射
 */
export function convertChatToResponsesRequest(body: OpenAIChatCompletionRequest, targetModel: string): OpenAIResponsesRequest {
  const input: OpenAIResponseInputItem[] = []
  let instructions: string | undefined

  for (const msg of body.messages ?? []) {
    const role = (msg as { role: string }).role
    if (role === "system" || role === "developer") {
      instructions = instructions ? instructions + "\n\n" + extractText(msg.content) : extractText(msg.content)
      continue
    }
    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: (msg as { tool_call_id?: string }).tool_call_id ?? "",
        output: extractText(msg.content),
      })
      continue
    }
    if (role === "assistant") {
      const toolCalls = (msg as { tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] }).tool_calls
      if (toolCalls && toolCalls.length > 0) {
        /** assistant 消息含 tool_calls：拆分为 reasoning（如有）+ function_call items + 文本消息 */
        const reasoning = (msg as { reasoning_content?: string }).reasoning_content
        if (reasoning) {
          input.push({ type: "reasoning", content: [{ type: "input_text", text: reasoning }], summary: [] })
        }
        for (const tc of toolCalls) {
          input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
        }
        const text = extractText(msg.content)
        if (text) {
          input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })
        }
        continue
      }
      const reasoning = (msg as { reasoning_content?: string }).reasoning_content
      if (reasoning) {
        input.push({ type: "reasoning", content: [{ type: "input_text", text: reasoning }], summary: [] })
      }
      const text = extractText(msg.content)
      if (text) {
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })
      }
      continue
    }
    /** user 消息 → input message item */
    input.push({ type: "message", role: "user", content: toInputContent(msg.content) })
  }

  const req: OpenAIResponsesRequest = {
    model: targetModel,
    input,
    stream: body.stream,
  }
  if (instructions) req.instructions = instructions
  if (body.max_tokens) req.max_output_tokens = body.max_tokens
  if (body.temperature !== undefined) req.temperature = body.temperature
  if (body.top_p !== undefined) req.top_p = body.top_p
  if (body.reasoning_effort) req.reasoning = { effort: body.reasoning_effort }
  if (body.tools) {
    req.tools = body.tools
      .filter((t) => t.type === "function")
      .map((t) => ({ type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: t.function.strict }))
  }
  if (body.tool_choice) {
    /** CC 的 {type:"function", function:{name}} → Responses 的 {type:"function", name} */
    const tc = body.tool_choice as string | { type: string; function?: { name?: string } }
    if (tc === "auto" || tc === "none" || tc === "required") {
      req.tool_choice = tc
    } else if (typeof tc === "object" && tc.type === "function" && tc.function?.name) {
      req.tool_choice = { type: "function", name: tc.function.name }
    } else {
      req.tool_choice = "auto"
    }
  }
  return req
}

/** 提取消息文本（string 或 parts 数组） */
function extractText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return (content as { type?: string; text?: string }[])
      .filter((p) => p.type === "text" || p.type === "output_text" || p.type === "input_text" || typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("")
  }
  return ""
}

/** user content → input content parts（文本 + 图片） */
function toInputContent(content: unknown): string | OpenAIResponseContentBlock[] {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return (content as { type?: string; text?: string; image_url?: { url: string } }[]).map((p): OpenAIResponseContentBlock => {
      if (p.type === "image_url" && p.image_url?.url) {
        return { type: "input_image", image_url: p.image_url.url }
      }
      return { type: "input_text", text: p.text ?? "" }
    })
  }
  return String(content)
}
