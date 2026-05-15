import type { ServerResponse } from "node:http"
import type { AnthropicSSEEvent, OpenAIFinishReason } from "../types.ts"
import { parseSSEBuffer, parseAnthropicEvent, formatSSEData, formatSSEDone, type SSEParsedEvent } from "../sse.ts"

/**
 * 将 Anthropic SSE 流实时转换为 OpenAI SSE 流，写入 Fastify reply.raw
 */
export async function streamAnthropicToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  raw: ServerResponse,
  originalModel: string,
  onText?: (text: string) => void,
  onToolCall?: (name: string, input: string) => void,
  onTokenUsage?: (inputTokens: number, outputTokens: number, cacheCreationTokens: number, cacheReadTokens: number) => void,
  onStreamError?: (err: string) => void,
  signal?: AbortSignal,
) {
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
  raw.flushHeaders()
  raw.socket?.setNoDelay(true)

  const chatId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  let outputTokens = 0
  let cachedInputTokens = 0
  let cachedCacheCreation = 0
  let cachedCacheRead = 0
  let started = false
  let finished = false
  let currentToolCallIndex = 0
  /** 当前工具调用累积器：name -> 累积的 arguments JSON */
  let currentToolName = ""
  let currentToolArgs = ""
  /** 当前是否在 thinking 块中 */
  let inThinkingBlock = false

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  /** 客户端断连时主动取消上游 reader */
  if (signal) {
    signal.addEventListener("abort", () => reader.cancel().catch(() => {}), { once: true })
  }

  function writeChunk(delta: Record<string, unknown>, finishReason: OpenAIFinishReason = null) {
    const chunk = {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model: originalModel,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    }
    raw.write(formatSSEData(chunk))
    raw.flushHeaders()
  }

  function writeUsage(promptTokens: number, completionTokens: number) {
    const usage: Record<string, unknown> = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    }
    if (cachedCacheCreation > 0 || cachedCacheRead > 0) {
      usage.cache_creation_input_tokens = cachedCacheCreation
      usage.cache_read_input_tokens = cachedCacheRead
    }
    const chunk = {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model: originalModel,
      choices: [],
      usage,
    }
    raw.write(formatSSEData(chunk))
    raw.flushHeaders()
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      /** 客户端已断连，取消上游读取释放连接 */
      if (!raw.writable) {
        reader.cancel().catch(() => {})
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const { events, remaining } = parseSSEBuffer(buffer)
      buffer = remaining

      for (const event of events) {
        const anthropicEvent = parseAnthropicEvent(event)
        if (!anthropicEvent) continue

        switch (anthropicEvent.type) {
          case "message_start": {
            /** 第一个 chunk 包含 role */
            const usage = anthropicEvent.message.usage
            cachedInputTokens = usage?.input_tokens ?? 0
            cachedCacheCreation = usage?.cache_creation_input_tokens ?? 0
            cachedCacheRead = usage?.cache_read_input_tokens ?? 0
            writeChunk({ role: "assistant", content: "" })
            started = true
            break
          }

          case "content_block_start": {
            const block = anthropicEvent.content_block
            if (block && typeof block === "object" && "type" in block && block.type === "tool_use") {
              const toolBlock = block as { type: "tool_use"; id: string; name: string }
              currentToolName = toolBlock.name
              currentToolArgs = ""
              writeChunk({
                tool_calls: [{
                  index: currentToolCallIndex,
                  id: toolBlock.id,
                  type: "function",
                  function: { name: toolBlock.name, arguments: "" },
                }],
              })
              currentToolCallIndex++
            } else if (block && typeof block === "object" && "type" in block && block.type === "thinking") {
              inThinkingBlock = true
              const marker = "[thinking] "
              writeChunk({ content: marker })
              onText?.(marker)
            }
            break
          }

          case "content_block_delta": {
            const delta = anthropicEvent.delta
            if (delta.type === "text_delta") {
              writeChunk({ content: delta.text })
              onText?.(delta.text)
            } else if (delta.type === "thinking_delta") {
              /** thinking 内容作为文本输出（与非流式保持一致） */
              writeChunk({ content: delta.thinking })
              onText?.(delta.thinking)
            } else if (delta.type === "input_json_delta") {
              currentToolArgs += delta.partial_json
              if (currentToolCallIndex > 0) {
                writeChunk({
                  tool_calls: [{
                    index: currentToolCallIndex - 1,
                    function: { arguments: delta.partial_json },
                  }],
                })
              }
            }
            /** signature_delta 在 OpenAI 格式中无对应，跳过 */
            break
          }

          case "content_block_stop":
            if (currentToolName) {
              onToolCall?.(currentToolName, currentToolArgs)
              currentToolName = ""
              currentToolArgs = ""
            }
            if (inThinkingBlock) {
              const endMarker = " [/thinking]\n"
              writeChunk({ content: endMarker })
              onText?.(endMarker)
              inThinkingBlock = false
            }
            break

          case "message_delta": {
            if (finished) break
            finished = true
            const stopReason = anthropicEvent.delta.stop_reason
            const finishReason = mapStopReason(stopReason)
            /** 部分 Anthropic 兼容服务商（如 GLM）在 message_start 返回 input_tokens: 0，在 message_delta 才返回真实值 */
            if (anthropicEvent.usage?.input_tokens) cachedInputTokens = anthropicEvent.usage.input_tokens
            if (anthropicEvent.usage?.cache_creation_input_tokens) cachedCacheCreation = anthropicEvent.usage.cache_creation_input_tokens
            if (anthropicEvent.usage?.cache_read_input_tokens) cachedCacheRead = anthropicEvent.usage.cache_read_input_tokens
            outputTokens = anthropicEvent.usage?.output_tokens ?? outputTokens
            writeChunk({}, finishReason)

            /** 发送 usage chunk（prompt_tokens 从 message_start 缓存） */
            writeUsage(cachedInputTokens, outputTokens)
            break
          }

          case "message_stop": {
            raw.write(formatSSEDone())
            raw.flushHeaders()
            break
          }

          case "ping":
            break

          case "error": {
            if (inThinkingBlock) {
              writeChunk({ content: " [/thinking]\n" })
              inThinkingBlock = false
            }
            finished = true
            writeChunk({ content: `[Error] ${anthropicEvent.error.message}` }, "stop")
            raw.write(formatSSEDone())
            break
          }
        }
      }
    }

    /** message_stop 已写入 [DONE]，此处仅在流意外中断时兜底 */
    if (started && !finished && raw.writable) {
      raw.write(formatSSEDone())
    }
  } catch (err) {
    /** 上游流式传输中断，释放 reader 锁并通知调用方 */
    reader.cancel().catch(() => {})
    const errMsg = "Stream interrupted: " + (err as Error).message
    console.error(`[stream-to-openai] Stream interrupted: ${(err as Error).message}`)
    onStreamError?.(errMsg)
    if (raw.writable) {
      const errorData = JSON.stringify({ error: { message: errMsg, type: "server_error" } })
      raw.write(`data: ${errorData}\n\n`)
      raw.write(formatSSEDone())
    }
  } finally {
    onTokenUsage?.(cachedInputTokens, outputTokens, cachedCacheCreation, cachedCacheRead)
    if (raw.writable) raw.end()
  }
}

function mapStopReason(reason: string | null): OpenAIFinishReason {
  switch (reason) {
    case "end_turn":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool_calls"
    case "stop_sequence":
      return "stop"
    case "refusal":
      return "content_filter"
    case "pause_turn":
      return "stop"
    default:
      return "stop"
  }
}
