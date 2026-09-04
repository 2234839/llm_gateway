import type { ServerResponse } from "node:http"
import type { AnthropicSSEEvent, SecretEntry } from "../types.ts"
import { parseSSEBuffer, parseAnthropicEvent, formatSSE } from "../sse.ts"
import { StreamRestorer } from "../utils/secret-vault.ts"

/** 轻量输出 item（构造 response 对象用） */
type OutputItemLite = { type: string; id?: string; role?: string; status?: string; content?: unknown[]; call_id?: string; name?: string; arguments?: string }

/** 生成短随机 id */
function rid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * 将 Anthropic SSE 流实时转换为 Responses SSE 流（Responses 入口 + Anthropic 端点组合）
 * 事件序列与 streamChatToResponses 保持一致。
 */
export async function streamAnthropicToResponsesDirect(
  upstream: ReadableStream<Uint8Array>,
  raw: ServerResponse,
  originalModel: string,
  onText?: (text: string) => void,
  onTokenUsage?: (inputTokens: number, outputTokens: number, cacheCreationTokens: number, cacheReadTokens: number) => void,
  onStreamError?: (err: string) => void,
  secrets: SecretEntry[] = [],
) {
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": raw.req?.headers.origin ?? "*",
  })
  raw.flushHeaders()
  raw.socket?.setNoDelay(true)

  const responseId = rid("resp")
  let sequenceNumber = 0

  let inputTokens = 0
  let outputTokens = 0
  let cacheCreationTokens = 0
  let cacheReadTokens = 0
  let stopReason: string | null = null

  const messageId = rid("msg")
  let messageItemAdded = false
  let fullText = ""
  const textRestorer = new StreamRestorer(secrets)

  /** tool_use 块累积器：index → { itemId, callId, name, args } */
  const toolUses = new Map<number, { itemId: string; callId: string; name: string; args: string }>()
  /** 当前块状态（Anthropic content_block 事件驱动） */
  let currentBlockType: string | null = null
  let currentBlockIndex = 0
  /** tool_use 参数还原器（每个 tool_use 块独立） */
  let argsRestorer = new StreamRestorer(secrets)

  function send(event: string, data: Record<string, unknown>) {
    raw.write(formatSSE(event, { ...data, sequence_number: sequenceNumber++ }))
    raw.flushHeaders()
  }

  function buildResponseObject(status: string, outputItems: OutputItemLite[] = []): Record<string, unknown> {
    return {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: originalModel,
      output: outputItems,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        input_tokens_details: cacheReadTokens > 0 ? { cached_tokens: cacheReadTokens } : undefined,
      },
    }
  }

  function ensureMessageItem(): void {
    if (messageItemAdded) return
    messageItemAdded = true
    send("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: messageId, role: "assistant", status: "in_progress", content: [] },
    })
    send("response.content_part.added", {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })
  }

  function finishMessageItem(): void {
    if (!messageItemAdded) return
    messageItemAdded = false
    send("response.content_part.done", {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: fullText, annotations: [] },
    })
    send("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText, annotations: [] }] },
    })
  }

  function emitToolCallItems(): void {
    let outputIndex = 1
    for (const [, tu] of toolUses) {
      send("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { type: "function_call", id: tu.itemId, call_id: tu.callId, name: tu.name, arguments: "" },
      })
      send("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: tu.itemId,
        output_index: outputIndex,
        delta: tu.args,
      })
      send("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: tu.itemId,
        output_index: outputIndex,
        arguments: tu.args,
      })
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { type: "function_call", id: tu.itemId, call_id: tu.callId, name: tu.name, arguments: tu.args },
      })
      outputIndex++
    }
  }

  function handleAnthropicEvent(event: AnthropicSSEEvent): void {
    switch (event.type) {
      case "message_start":
        inputTokens = event.message.usage?.input_tokens ?? 0
        outputTokens = event.message.usage?.output_tokens ?? 0
        cacheCreationTokens = event.message.usage?.cache_creation_input_tokens ?? 0
        cacheReadTokens = event.message.usage?.cache_read_input_tokens ?? 0
        break
      case "content_block_start":
        currentBlockIndex = event.index
        currentBlockType = event.content_block.type
        if (event.content_block.type === "tool_use") {
          const block = event.content_block as { type: "tool_use"; id?: string; name?: string }
          toolUses.set(event.index, {
            itemId: rid("fc"),
            callId: block.id ?? rid("call"),
            name: block.name ?? "",
            args: "",
          })
          argsRestorer = new StreamRestorer(secrets)
        }
        break
      case "content_block_delta": {
        const delta = event.delta
        if (delta.type === "text_delta" && delta.text) {
          ensureMessageItem()
          const restored = textRestorer.feed(delta.text)
          fullText += restored
          onText?.(restored)
          send("response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: restored,
          })
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          const restored = textRestorer.feed(delta.thinking)
          onText?.(restored)
          send("response.reasoning_text.delta", {
            type: "response.reasoning_text.delta",
            item_id: "rs_0",
            output_index: 0,
            delta: restored,
          })
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          const tu = toolUses.get(event.index)
          if (tu) {
            tu.args += argsRestorer.feed(delta.partial_json)
          }
        }
        break
      }
      case "content_block_stop":
        currentBlockType = null
        break
      case "message_delta":
        stopReason = event.delta.stop_reason
        if (event.usage.output_tokens) outputTokens = event.usage.output_tokens
        if (event.usage.input_tokens) inputTokens = event.usage.input_tokens
        if (event.usage.cache_creation_input_tokens) cacheCreationTokens = event.usage.cache_creation_input_tokens
        if (event.usage.cache_read_input_tokens) cacheReadTokens = event.usage.cache_read_input_tokens
        break
      case "message_stop":
      case "ping":
        break
      case "error":
        throw new Error(event.error.message)
    }
  }

  function finishStream(): void {
    finishMessageItem()
    emitToolCallItems()
    const status = stopReason === "max_tokens" ? "incomplete" : "completed"
    const outputItems: OutputItemLite[] = []
    if (fullText) outputItems.push({ type: "message", id: messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText, annotations: [] }] })
    for (const [, tu] of toolUses) {
      outputItems.push({ type: "function_call", id: tu.itemId, call_id: tu.callId, name: tu.name, arguments: tu.args })
    }
    send("response.completed", {
      type: "response.completed",
      response: buildResponseObject(status, outputItems),
    })
    onTokenUsage?.(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens)
    raw.end()
  }

  function failStream(errMsg: string): void {
    console.error(`[responses] Anthropic stream interrupted: ${errMsg}`)
    onStreamError?.(errMsg)
    if (raw.writable) {
      send("response.failed", {
        type: "response.failed",
        response: buildResponseObject("failed"),
      })
    }
    raw.end()
  }

  send("response.created", { type: "response.created", response: buildResponseObject("in_progress") })
  send("response.in_progress", { type: "response.in_progress", response: buildResponseObject("in_progress") })

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  async function pump(): Promise<void> {
    const { done, value } = await reader.read()
    if (done) {
      finishStream()
      return
    }
    if (!raw.writable) {
      reader.cancel().catch(() => {})
      return
    }
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
    const { events, remaining } = parseSSEBuffer(buffer)
    buffer = remaining
    for (const ev of events) {
      const parsed = parseAnthropicEvent(ev)
      if (parsed) handleAnthropicEvent(parsed)
    }
    await pump()
  }

  await pump().catch((err) => {
    failStream((err as Error).message)
    reader.cancel().catch(() => {})
  })
}
