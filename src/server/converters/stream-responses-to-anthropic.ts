import type { ServerResponse } from "node:http"
import type { SecretEntry } from "../types.ts"
import { formatSSE } from "../sse.ts"
import { StreamRestorer } from "../utils/secret-vault.ts"

/** Responses SSE 事件（宽松解析） */
type ResponsesSSEEvent = { type?: string; [key: string]: unknown }

/** 工具调用累积状态 */
interface ToolCallState {
  id: string
  name: string
  claudeIndex: number
  args: string
  restorer: StreamRestorer
}

/**
 * 将 Responses SSE 流实时转换为 Anthropic SSE 流（Anthropic 入口 + openai-responses 端点组合）
 */
export async function streamResponsesToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  raw: ServerResponse,
  originalModel: string,
  inputTokens: number,
  onText?: (text: string) => void,
  onToolCall?: (name: string, input: string) => void,
  onTokenUsage?: (finalInputTokens: number, finalOutputTokens: number, cacheReadTokens: number) => void,
  onStreamError?: (err: string) => void,
  secrets: SecretEntry[] = [],
) {
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
  raw.flushHeaders()
  raw.socket?.setNoDelay(true)

  const msgId = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24)
  let currentContentIndex = -1
  let hasOpenBlock = false
  const toolCallMap = new Map<string, ToolCallState>()
  let outputTokens = 0
  let realInputTokens = inputTokens
  let cacheReadTokens = 0
  let started = false
  let finished = false

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const textRestorer = new StreamRestorer(secrets)
  const makeRestorer = () => new StreamRestorer(secrets)

  function writeEvent(event: string, data: unknown) {
    raw.write(formatSSE(event, data))
    raw.flushHeaders()
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
        usage: { input_tokens: realInputTokens, output_tokens: 1 },
      },
    })
  }

  let currentBlockType: "text" | "tool_use" | "thinking" | null = null

  function openTextBlock() {
    if (hasOpenBlock && currentBlockType === "text") return
    if (hasOpenBlock) closeCurrentBlock()
    currentContentIndex++
    hasOpenBlock = true
    currentBlockType = "text"
    writeEvent("content_block_start", {
      type: "content_block_start",
      index: currentContentIndex,
      content_block: { type: "text", text: "" },
    })
  }

  function openThinkingBlock() {
    if (hasOpenBlock && currentBlockType === "thinking") return
    if (hasOpenBlock) closeCurrentBlock()
    currentContentIndex++
    hasOpenBlock = true
    currentBlockType = "thinking"
    writeEvent("content_block_start", {
      type: "content_block_start",
      index: currentContentIndex,
      content_block: { type: "thinking", thinking: "" },
    })
  }

  function closeCurrentBlock() {
    if (!hasOpenBlock) return
    if ((currentBlockType === "text" || currentBlockType === "thinking") && textRestorer.enabled) {
      const tail = textRestorer.flush()
      if (tail) {
        writeEvent("content_block_delta", {
          type: "content_block_delta",
          index: currentContentIndex,
          delta: currentBlockType === "text"
            ? { type: "text_delta", text: tail }
            : { type: "thinking_delta", thinking: tail },
        })
      }
    }
    if (currentBlockType === "tool_use") {
      const state = [...toolCallMap.values()].find(st => st.claudeIndex === currentContentIndex)
      if (state?.restorer.enabled) {
        const tail = state.restorer.flush()
        if (tail) {
          writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: currentContentIndex,
            delta: { type: "input_json_delta", partial_json: tail },
          })
        }
      }
    }
    writeEvent("content_block_stop", {
      type: "content_block_stop",
      index: currentContentIndex,
    })
    hasOpenBlock = false
    currentBlockType = null
  }

  function openToolBlock(itemId: string, id: string, name: string) {
    closeCurrentBlock()
    const claudeIndex = currentContentIndex + 1
    currentContentIndex = claudeIndex
    toolCallMap.set(itemId, { id, name, claudeIndex, args: "", restorer: makeRestorer() })
    hasOpenBlock = true
    currentBlockType = "tool_use"
    writeEvent("content_block_start", {
      type: "content_block_start",
      index: claudeIndex,
      content_block: { type: "tool_use", id, name, input: {} },
    })
  }

  function finish(stopReason: string, error?: { type: string; message: string }) {
    if (finished) return
    finished = true
    closeCurrentBlock()
    if (currentContentIndex === -1) {
      openTextBlock()
    }
    closeCurrentBlock()
    if (onToolCall) {
      for (const [, state] of toolCallMap) {
        if (state.name) onToolCall(state.name, state.args)
      }
    }
    if (error) {
      writeEvent("error", { type: "error", error })
    }
    writeEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    writeEvent("message_stop", { type: "message_stop" })
  }

  function handleEvent(ev: ResponsesSSEEvent) {
    switch (ev.type) {
      case "response.output_item.added": {
        const item = ev.item as { type?: string; id?: string; call_id?: string; name?: string } | undefined
        if (item?.type === "function_call") {
          startMessage()
          const itemId = item.id ?? item.call_id ?? "fc"
          const callId = item.call_id ?? item.id ?? "call_" + Math.random().toString(36).slice(2, 10)
          openToolBlock(itemId, callId, item.name ?? "")
        }
        break
      }
      case "response.output_text.delta": {
        startMessage()
        const delta = String(ev.delta ?? "")
        if (!delta) return
        openTextBlock()
        const restored = textRestorer.feed(delta)
        onText?.(restored)
        writeEvent("content_block_delta", {
          type: "content_block_delta",
          index: currentContentIndex,
          delta: { type: "text_delta", text: restored },
        })
        break
      }
      case "response.reasoning_text.delta": {
        startMessage()
        const delta = String(ev.delta ?? "")
        if (!delta) return
        openThinkingBlock()
        const restored = textRestorer.feed(delta)
        onText?.(restored)
        writeEvent("content_block_delta", {
          type: "content_block_delta",
          index: currentContentIndex,
          delta: { type: "thinking_delta", thinking: restored },
        })
        break
      }
      case "response.function_call_arguments.delta": {
        const itemId = String(ev.item_id ?? "")
        const state = toolCallMap.get(itemId)
        if (state && ev.delta) {
          state.args += state.restorer.feed(String(ev.delta))
        }
        break
      }
      case "response.function_call_arguments.done": {
        const itemId = String(ev.item_id ?? "")
        const state = toolCallMap.get(itemId)
        if (state && ev.arguments && !state.args) {
          state.args = state.restorer.feed(String(ev.arguments))
        }
        break
      }
      case "response.completed": {
        const resp = ev.response as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }, status?: string } | undefined
        if (resp?.usage) {
          realInputTokens = resp.usage.input_tokens ?? realInputTokens
          outputTokens = resp.usage.output_tokens ?? outputTokens
          cacheReadTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0
        }
        const stopReason = toolCallMap.size > 0 ? "tool_use" : resp?.status === "incomplete" ? "max_tokens" : "end_turn"
        finish(stopReason)
        onTokenUsage?.(realInputTokens, outputTokens, cacheReadTokens)
        break
      }
      case "response.failed": {
        const resp = ev.response as { error?: { message?: string } } | undefined
        finish("end_turn", { type: "api_error", message: resp?.error?.message ?? "Upstream response failed" })
        break
      }
      default:
        break
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!raw.writable) {
        reader.cancel().catch(() => {})
        break
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (!data) continue
        let ev: ResponsesSSEEvent
        try {
          ev = JSON.parse(data) as ResponsesSSEEvent
        } catch {
          continue
        }
        handleEvent(ev)
      }
    }
    /** 流结束但未收到 response.completed（如上游中断），按完成处理 */
    if (!finished) {
      finish(toolCallMap.size > 0 ? "tool_use" : "end_turn")
      onTokenUsage?.(realInputTokens, outputTokens, cacheReadTokens)
    }
  } catch (err) {
    const errMsg = (err as Error).message
    console.error("[responses-anthropic] Stream interrupted: " + errMsg)
    onStreamError?.(errMsg)
    finish("end_turn", { type: "api_error", message: "Stream interrupted: " + errMsg })
  }
  raw.end()
}
