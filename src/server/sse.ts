import type { AnthropicSSEEvent, OpenAIStreamChunk } from "./types.ts"

/** 格式化为带事件名的 SSE 文本 */
export function formatSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** 格式化为无事件名的 SSE 文本（OpenAI 格式） */
export function formatSSEData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/** 格式化 OpenAI 流结束标记 */
export function formatSSEDone(): string {
  return "data: [DONE]\n\n"
}

/**
 * 从 SSE 文本块中解析出事件列表
 * 处理可能跨 chunk 的不完整行
 */
export function parseSSEBuffer(buffer: string): { events: SSEParsedEvent[]; remaining: string } {
  const events: SSEParsedEvent[] = []
  const lines = buffer.split("\n")
  /** 最后一个元素可能不完整 */
  const remaining = buffer.endsWith("\n") ? "" : (lines.pop() ?? "")

  let currentEvent: SSEParsedEvent | null = null

  for (const line of lines) {
    /** 空行表示事件结束 */
    if (line === "") {
      if (currentEvent) {
        events.push(currentEvent)
        currentEvent = null
      }
      continue
    }

    if (line.startsWith("event:")) {
      if (!currentEvent) currentEvent = { event: "", data: "" }
      currentEvent.event = line.slice(6).trim()
    } else if (line.startsWith("data:")) {
      if (!currentEvent) currentEvent = { event: "", data: "" }
      const dataStr = line.slice(5).trim()
      if (dataStr === "[DONE]") {
        currentEvent.data = "[DONE]"
      } else {
        currentEvent.data = dataStr
      }
    }
    /** 忽略 id:, retry:, 注释行(:...) */
  }

  /** 处理末尾未关闭的事件 */
  if (currentEvent && currentEvent.data) {
    events.push(currentEvent)
  }

  return { events, remaining }
}

export interface SSEParsedEvent {
  event: string
  data: string
}

/** 解析 Anthropic SSE 事件数据为类型化对象 */
export function parseAnthropicEvent(parsed: SSEParsedEvent): AnthropicSSEEvent | null {
  if (parsed.event === "ping") return { type: "ping" }
  if (parsed.event === "error") {
    return { type: "error", error: JSON.parse(parsed.data).error }
  }

  const data = JSON.parse(parsed.data)
  switch (parsed.event) {
    case "message_start":
    case "content_block_start":
    case "content_block_delta":
    case "content_block_stop":
    case "message_delta":
    case "message_stop":
      return data as AnthropicSSEEvent
    default:
      return null
  }
}

/** 解析 OpenAI SSE 数据为 StreamChunk */
export function parseOpenAIChunk(parsed: SSEParsedEvent): OpenAIStreamChunk | "DONE" | null {
  if (parsed.data === "[DONE]") return "DONE"
  return JSON.parse(parsed.data) as OpenAIStreamChunk
}
