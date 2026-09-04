import type { ServerResponse } from "node:http"
import type { OpenAIFinishReason, SecretEntry } from "../types.ts"
import { parseSSEBuffer, formatSSE, type SSEParsedEvent } from "../sse.ts"
import { StreamRestorer } from "../utils/secret-vault.ts"

/** 轻量输出 item（构造 response 对象用） */
type OutputItemLite = { type: string; id?: string; role?: string; status?: string; content?: unknown[]; summary?: unknown[]; call_id?: string; name?: string; arguments?: string }

/** 生成短随机 id（Responses item id 格式） */
function rid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/**
 * 将 OpenAI Chat Completions SSE 流实时转换为 Responses SSE 流，写入 Fastify reply.raw
 * Responses SSE 事件序列（Codex 客户端依赖）：
 *   response.created → response.in_progress →
 *   response.output_item.added(message) → response.content_part.added →
 *   response.output_text.delta ... → response.content_part.done → response.output_item.done →
 *   function_call items（added → arguments.delta → arguments.done → item.done）→
 *   response.completed（携带完整 response 对象与 usage）
 */
export async function streamChatToResponses(
  upstream: ReadableStream<Uint8Array>,
  raw: ServerResponse,
  originalModel: string,
  onText?: (text: string) => void,
  onToolCall?: (name: string, args: string) => void,
  onTokenUsage?: (inputTokens: number, outputTokens: number, cacheReadTokens: number) => void,
  onStreamError?: (err: string) => void,
  /** 密钥保护：占位符 → 真实密钥（仅写往客户端的内容还原，日志回调仍是占位符版） */
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
  /** 事件序列号（Responses 协议要求递增） */
  let sequenceNumber = 0

  /** 聚合状态 */
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let finishReason: OpenAIFinishReason = null
  let usageReported = false

  /** 文本 message item 状态 */
  const messageId = rid("msg")
  let messageItemAdded = false
  let fullText = ""
  /** 密钥还原器（文本/推理内容共用） */
  const textRestorer = new StreamRestorer(secrets)

  /** tool_calls 累积器：index → item；流结束时统一以 function_call items 发出 */
  const toolCalls = new Map<number, { itemId: string; callId: string; name: string; args: string }>()

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

  /** 确保文本 message item 已添加（首个 delta 到达时懒添加） */
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

  /** 完成文本 message item（content_part.done + output_item.done） */
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

  /** 发送 function_call item 事件组（流结束时统一发出） */
  function emitToolCallItems(): void {
    let outputIndex = 1
    for (const [, tc] of toolCalls) {
      send("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { type: "function_call", id: tc.itemId, call_id: tc.callId, name: tc.name, arguments: "" },
      })
      send("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: tc.itemId,
        output_index: outputIndex,
        delta: tc.args,
      })
      send("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: tc.itemId,
        output_index: outputIndex,
        arguments: tc.args,
      })
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: outputIndex,
        item: { type: "function_call", id: tc.itemId, call_id: tc.callId, name: tc.name, arguments: tc.args },
      })
      onToolCall?.(tc.name, tc.args)
      outputIndex++
    }
  }

  function handleEvent(ev: SSEParsedEvent): void {
    if (ev.data === "[DONE]") return
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(ev.data) as Record<string, unknown>
    } catch {
      return
    }
    const choices = obj.choices as { delta?: Record<string, unknown>; finish_reason?: OpenAIFinishReason }[] | undefined
    const choice = choices?.[0]
    const delta = choice?.delta

    if (typeof delta?.content === "string" && delta.content) {
      ensureMessageItem()
      const restored = textRestorer.feed(delta.content)
      fullText += restored
      onText?.(restored)
      send("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: restored,
      })
    }
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
      /** CC reasoning 扩展 → 归并到 message item 的文本流（客户端无独立 reasoning 渲染时仍可见） */
      const restored = textRestorer.feed(delta.reasoning_content)
      onText?.(restored)
      send("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        delta: restored,
      })
    }
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
        const idx = tc.index ?? 0
        const existing = toolCalls.get(idx)
        if (existing) {
          if (tc.function?.arguments) existing.args += tc.function.arguments
          if (tc.function?.name && !existing.name) existing.name = tc.function.name
        } else {
          toolCalls.set(idx, {
            itemId: rid("fc"),
            callId: tc.id ?? rid("call"),
            name: tc.function?.name ?? "",
            args: tc.function?.arguments ?? "",
          })
        }
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason
    if (obj.usage) {
      usageReported = true
      const u = obj.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
      inputTokens = u.prompt_tokens ?? 0
      outputTokens = u.completion_tokens ?? 0
      cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0
    }
  }

  function finishStream(): void {
    /** 无 usage 报告时用已聚合文本长度近似（chars/4） */
    if (!usageReported) outputTokens = Math.ceil(fullText.length / 4)
    finishMessageItem()
    emitToolCallItems()
    const status = finishReason === "length" || finishReason === "content_filter" ? "incomplete" : "completed"
    const outputItems: OutputItemLite[] = []
    if (fullText) outputItems.push({ type: "message", id: messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText, annotations: [] }] })
    for (const [, tc] of toolCalls) {
      outputItems.push({ type: "function_call", id: tc.itemId, call_id: tc.callId, name: tc.name, arguments: tc.args })
    }
    send("response.completed", {
      type: "response.completed",
      response: buildResponseObject(status, outputItems),
    })
    onTokenUsage?.(inputTokens, outputTokens, cacheReadTokens)
    raw.end()
  }

  function failStream(errMsg: string): void {
    console.error(`[responses] Stream interrupted: ${errMsg}`)
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
      handleEvent(ev)
    }
    await pump()
  }

  await pump().catch((err) => {
    failStream((err as Error).message)
    reader.cancel().catch(() => {})
  })
}
