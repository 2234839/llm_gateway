import type { ServerResponse } from "node:http"
import type { AnthropicStopReason, OpenAIStreamChunk } from "../types.ts"
import { parseSSEBuffer, formatSSE, type SSEParsedEvent } from "../sse.ts"

interface ToolCallState {
  id: string
  name: string
  claudeIndex: number
  started: boolean
  args: string
}

/**
 * 将 OpenAI SSE 流实时转换为 Anthropic SSE 流，写入 Fastify reply.raw
 */
export async function streamOpenAIToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  raw: ServerResponse,
  originalModel: string,
  inputTokens: number,
  onText?: (text: string) => void,
  onToolCall?: (name: string, input: string) => void,
  onTokenUsage?: (finalInputTokens: number, finalOutputTokens: number) => void,
) {
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
  raw.flushHeaders()
  raw.socket?.setNoDelay(true)

  const msgId = `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
  let currentContentIndex = -1
  let hasOpenBlock = false
  const toolCallMap = new Map<number, ToolCallState>()
  let outputTokens = 0
  let started = false
  let finished = false

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  function writeEvent(event: string, data: unknown) {
    raw.write(formatSSE(event, data))
  }

  function startMessage() {
    if (started) return
    started = true
    writeEvent("message_start", {
      type: "message_start",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        content: [],
        model: originalModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    })
  }

  /** 当前打开的 block 类型，用于判断是否需要切换 */
  let currentBlockType: "text" | "tool_use" | null = null

  function openTextBlock() {
    if (hasOpenBlock && currentBlockType === "text") {
      /** 已经是 text block，直接复用 */
      return
    }
    if (hasOpenBlock) {
      /** 当前是 tool_use block，先关闭 */
      closeCurrentBlock()
    }
    currentContentIndex++
    hasOpenBlock = true
    currentBlockType = "text"
    writeEvent("content_block_start", {
      type: "content_block_start",
      index: currentContentIndex,
      content_block: { type: "text", text: "" },
    })
  }

  function closeCurrentBlock() {
    if (!hasOpenBlock) return
    writeEvent("content_block_stop", {
      type: "content_block_stop",
      index: currentContentIndex,
    })
    hasOpenBlock = false
    currentBlockType = null
  }

  function openToolBlock(toolIndex: number, id: string, name: string) {
    closeCurrentBlock()
    const claudeIndex = currentContentIndex + 1
    currentContentIndex = claudeIndex
    toolCallMap.set(toolIndex, { id, name, claudeIndex, started: true, args: "" })
    hasOpenBlock = true
    currentBlockType = "tool_use"
    writeEvent("content_block_start", {
      type: "content_block_start",
      index: claudeIndex,
      content_block: { type: "tool_use", id, name, input: {} },
    })
  }

  function finish(stopReason: AnthropicStopReason) {
    if (finished) return
    finished = true
    closeCurrentBlock()
    /** 如果没有任何 content block，补一个空 text block */
    if (currentContentIndex === -1) {
      openTextBlock()
    }
    closeCurrentBlock()
    /** 刷出所有工具调用摘要 */
    if (onToolCall) {
      for (const [, state] of toolCallMap) {
        onToolCall(state.name, state.args)
      }
    }
    writeEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    writeEvent("message_stop", { type: "message_stop" })
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const { events, remaining } = parseSSEBuffer(buffer)
      buffer = remaining

      for (const event of events) {
        const chunk = parseOpenAIChunk(event)
        if (!chunk || chunk === "DONE") {
          if (chunk === "DONE") {
            finish(outputTokens > 0 ? "end_turn" : "end_turn")
          }
          continue
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        startMessage()

        const delta = choice.delta

        /** 文本内容 */
        if (delta.content) {
          openTextBlock()
          writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: currentContentIndex,
            delta: { type: "text_delta", text: delta.content },
          })
          onText?.(delta.content)
          outputTokens++
        }

        /** 工具调用 */
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (tc.id && tc.function?.name) {
              /** 新工具调用开始 */
              openToolBlock(idx, tc.id, tc.function.name)
            }

            const state = toolCallMap.get(idx)
            if (state && tc.function?.arguments) {
              state.args += tc.function.arguments
              writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: state.claudeIndex,
                delta: { type: "input_json_delta", partial_json: tc.function.arguments },
              })
              outputTokens++
            }
          }
        }

        /** 流结束 */
        if (choice.finish_reason) {
          finish(mapFinishReason(choice.finish_reason))
          break
        }

        /** OpenAI usage（最后一个 chunk） */
        if (chunk.usage) {
          outputTokens = chunk.usage.completion_tokens || outputTokens
        }
      }
    }

    /** 如果流正常结束但没收到 finish_reason，主动结束 */
    if (started && raw.writable) {
      finish("end_turn")
    }
  } finally {
    onTokenUsage?.(inputTokens, outputTokens)
    raw.end()
  }
}

function parseOpenAIChunk(event: SSEParsedEvent): OpenAIStreamChunk | "DONE" | null {
  if (event.data === "[DONE]") return "DONE"
  try {
    return JSON.parse(event.data) as OpenAIStreamChunk
  } catch {
    return null
  }
}

function mapFinishReason(reason: string): AnthropicStopReason {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    default:
      return "end_turn"
  }
}
