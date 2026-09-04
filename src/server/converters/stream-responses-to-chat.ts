import type { ServerResponse } from "node:http"
import type { SecretEntry } from "../types.ts"
import { formatSSE } from "../sse.ts"
import { StreamRestorer } from "../utils/secret-vault.ts"

/** Responses SSE 事件（宽松解析） */
type ResponsesSSEEvent = { type?: string; [key: string]: unknown }

/**
 * Responses SSE → Chat Completions SSE 转换（CC 入口 + openai-responses 端点组合）
 * 输出标准 CC chunk 序列：首个 role chunk → content/reasoning/tool_calls delta → finish chunk（含 usage）
 */
export async function streamResponsesToChat(
  upstream: ReadableStream<Uint8Array>,
  raw: ServerResponse,
  secrets: SecretEntry[],
  requestModel: string,
  onText?: (text: string) => void,
  onToolCall?: (name: string, args: string, callId: string) => void,
  onTokenUsage?: (inputTokens: number, outputTokens: number, cacheReadTokens: number) => void,
  onStreamError?: (err: string) => void,
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

  const ccId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24)
  const created = Math.floor(Date.now() / 1000)

  let sentRole = false
  let fullText = ""
  const textRestorer = new StreamRestorer(secrets)

  /** 工具调用累积器：itemId → { index, name, args, callId } */
  const toolCalls = new Map<string, { index: number; name: string; args: string; callId: string }>()
  let nextToolIndex = 0

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let finishReason: string | null = null

  function sendChunk(chunk: Record<string, unknown>) {
    raw.write(formatSSE("", { ...chunk, id: ccId, object: "chat.completion.chunk", created, model: requestModel }))
    raw.flushHeaders()
  }

  function ensureRole() {
    if (sentRole) return
    sentRole = true
    sendChunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })
  }

  function handleEvent(ev: ResponsesSSEEvent) {
    switch (ev.type) {
      case "response.output_text.delta": {
        ensureRole()
        const delta = String(ev.delta ?? "")
        if (!delta) return
        const restored = textRestorer.feed(delta)
        fullText += restored
        onText?.(restored)
        sendChunk({ choices: [{ index: 0, delta: { content: restored }, finish_reason: null }] })
        break
      }
      case "response.reasoning_text.delta": {
        ensureRole()
        const delta = String(ev.delta ?? "")
        if (!delta) return
        const restored = textRestorer.feed(delta)
        onText?.(restored)
        sendChunk({ choices: [{ index: 0, delta: { reasoning_content: restored }, finish_reason: null }] })
        break
      }
      case "response.output_item.added": {
        const item = ev.item as { type?: string; id?: string; call_id?: string; name?: string } | undefined
        if (item?.type === "function_call") {
          ensureRole()
          const callId = item.call_id ?? item.id ?? "call_" + Math.random().toString(36).slice(2, 10)
          toolCalls.set(item.id ?? callId, { index: nextToolIndex++, name: item.name ?? "", args: "", callId })
        }
        break
      }
      case "response.function_call_arguments.delta": {
        const itemId = String(ev.item_id ?? "")
        const tu = toolCalls.get(itemId)
        if (tu && ev.delta) tu.args += String(ev.delta)
        break
      }
      case "response.function_call_arguments.done": {
        const itemId = String(ev.item_id ?? "")
        const tu = toolCalls.get(itemId)
        if (tu && ev.arguments && !tu.args) tu.args = String(ev.arguments)
        break
      }
      case "response.output_item.done": {
        const item = ev.item as { type?: string; id?: string; call_id?: string; name?: string; arguments?: string } | undefined
        if (item?.type === "function_call" && toolCalls.size === 0) {
          ensureRole()
          toolCalls.set(item.id ?? item.call_id ?? "fc", { index: nextToolIndex++, name: item.name ?? "", args: item.arguments ?? "", callId: item.call_id ?? item.id ?? "call" })
        }
        break
      }
      case "response.completed": {
        const resp = ev.response as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }, status?: string, output?: { type?: string }[] } | undefined
        if (resp?.usage) {
          inputTokens = resp.usage.input_tokens ?? 0
          outputTokens = resp.usage.output_tokens ?? 0
          cacheReadTokens = resp.usage.input_tokens_details?.cached_tokens ?? 0
        }
        if (resp?.status === "incomplete") finishReason = "length"
        break
      }
      case "response.failed": {
        const resp = ev.response as { error?: { message?: string } } | undefined
        throw new Error(resp?.error?.message ?? "Upstream response failed")
      }
      default:
        break
    }
  }

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
    await pump()
  }

  function finishStream() {
    ensureRole()
    if (toolCalls.size > 0) {
      for (const [, tu] of toolCalls) {
        sendChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: tu.index, id: tu.callId, type: "function", function: { name: tu.name, arguments: tu.args } }] }, finish_reason: null }] })
      }
      finishReason = "tool_calls"
    }
    const usage = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: cacheReadTokens > 0 ? { cached_tokens: cacheReadTokens } : undefined,
    }
    sendChunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason ?? "stop" }], usage })
    raw.write("data: [DONE]\n\n")
    raw.flushHeaders()
    onTokenUsage?.(inputTokens, outputTokens, cacheReadTokens)
    raw.end()
  }

  function failStream(errMsg: string) {
    console.error("[responses-cc] Stream interrupted: " + errMsg)
    onStreamError?.(errMsg)
    if (raw.writable) {
      sendChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })
      raw.write("data: [DONE]\n\n")
      raw.flushHeaders()
    }
    raw.end()
  }

  await pump().catch((err) => {
    failStream((err as Error).message)
    reader.cancel().catch(() => {})
  })
}
