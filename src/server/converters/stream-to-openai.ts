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
  let currentToolCallIndex = 0
  /** 当前工具调用累积器：name -> 累积的 arguments JSON */
  let currentToolName = ""
  let currentToolArgs = ""

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

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
  }

  function writeUsage(promptTokens: number, completionTokens: number) {
    const chunk = {
      id: chatId,
      object: "chat.completion.chunk",
      created,
      model: originalModel,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }
    raw.write(formatSSEData(chunk))
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

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
            }
            break
          }

          case "content_block_delta": {
            const delta = anthropicEvent.delta
            if (delta.type === "text_delta") {
              writeChunk({ content: delta.text })
              onText?.(delta.text)
              outputTokens++
            } else if (delta.type === "input_json_delta") {
              currentToolArgs += delta.partial_json
              writeChunk({
                tool_calls: [{
                  index: currentToolCallIndex - 1,
                  function: { arguments: delta.partial_json },
                }],
              })
              outputTokens++
            }
            /** thinking_delta 和 signature_delta 在 OpenAI 格式中无对应，跳过 */
            break
          }

          case "content_block_stop":
            if (currentToolName) {
              onToolCall?.(currentToolName, currentToolArgs)
              currentToolName = ""
              currentToolArgs = ""
            }
            break

          case "message_delta": {
            const stopReason = anthropicEvent.delta.stop_reason
            const finishReason = mapStopReason(stopReason)
            outputTokens = anthropicEvent.usage?.output_tokens ?? outputTokens
            writeChunk({}, finishReason)

            /** 发送 usage chunk */
            writeUsage(0, outputTokens)
            break
          }

          case "message_stop": {
            raw.write(formatSSEDone())
            break
          }

          case "ping":
            break

          case "error": {
            writeChunk({ content: `[Error] ${anthropicEvent.error.message}` }, "stop")
            raw.write(formatSSEDone())
            break
          }
        }
      }
    }

    if (started && raw.writable) {
      raw.write(formatSSEDone())
    }
  } finally {
    onTokenUsage?.(cachedInputTokens, outputTokens, cachedCacheCreation, cachedCacheRead)
    raw.end()
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
    default:
      return "stop"
  }
}
