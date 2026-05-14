import type { FastifyInstance } from "fastify"
import type { AnthropicMessagesRequest, AnthropicErrorResponse } from "../types.ts"
import { convertRequestToOpenAI } from "../converters/to-openai.ts"
import { convertResponseToAnthropic } from "../converters/resp-to-anthropic.ts"
import { streamOpenAIToAnthropic } from "../converters/stream-to-anthropic.ts"
import { extractAnthropicText, extractAnthropicResponseSummary, extractAnthropicContentTypes } from "../utils/extract-text.ts"
import { logRequestSummary, nextReqId } from "../utils/log-summary.ts"

export async function anthropicRoutes(fastify: FastifyInstance) {
  /** POST /v1/messages — Anthropic Messages API 入口 */
  fastify.post("/v1/messages", async (request, reply) => {
    const body = request.body as AnthropicMessagesRequest
    const model = body.model
    const startTime = Date.now()

    /** 提取上游 headers（需要透传的） */
    const upstreamHeaders: Record<string, string> = {}
    const h = request.headers
    if (h["anthropic-version"]) upstreamHeaders["anthropic-version"] = h["anthropic-version"] as string
    if (h["anthropic-beta"]) upstreamHeaders["anthropic-beta"] = h["anthropic-beta"] as string

    let providerId = ""
    let targetModel = ""
    let providerName = ""
    let statusCode = 200
    let errorMsg: string | null = null
    let inputTokens = 0
    let outputTokens = 0
    let outputText = ""
    const isStream = body.stream ?? false
    const reqId = nextReqId()

    /** 提取输入摘要：最后一条 user 消息 */
    const inputSummary = extractLastAnthropicUserMessage(body) ?? model

    const collectStreamText = (text: string) => { outputText += text }
    const collectStreamToolCall = (name: string, input: string) => { outputText += (outputText ? "\n" : "") + `[tool_call: ${name}(${input})]` }

    try {
      const messageText = extractAnthropicText(body)
      const contentTypes = extractAnthropicContentTypes(body)
      const { provider, targetModel: tm, providerConfig } = fastify.registry.resolve(model, { messageText, contentTypes })
      providerId = providerConfig.id
      targetModel = tm
      providerName = providerConfig.name

      const semaphore = fastify.registry.getSemaphore(providerConfig.id)
      await semaphore?.acquire()
      try {
        if (provider.type === "anthropic") {
          /** Anthropic 直连 — 透传 */
          if (isStream) {
            const upstream = await provider.sendStreamRequest(
              { ...body, model: targetModel },
              upstreamHeaders,
            )

            if (!upstream.ok) {
              const errBody = await upstream.text()
              statusCode = upstream.status
              errorMsg = errBody
              reply.status(upstream.status)
              return reply.send(errBody)
            }

            reply.hijack()
            return await streamPassthrough(upstream.body!, reply.raw, collectStreamText, collectStreamToolCall)
          }

          const upstream = await provider.sendRequest(
            { ...body, model: targetModel },
            upstreamHeaders,
          )

          if (!upstream.ok) {
            const errBody = await upstream.text()
            statusCode = upstream.status
            errorMsg = errBody
            reply.status(upstream.status)
            return reply.send(errBody)
          }

          const respBody = await upstream.json()
          inputTokens = (respBody as { usage?: { input_tokens?: number } }).usage?.input_tokens ?? 0
          outputTokens = (respBody as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0
          outputText = extractAnthropicResponseSummary(respBody as import("../types.ts").AnthropicMessagesResponse)
          return reply.send(respBody)
        }

        /** 非 Anthropic 提供商 — 转换格式 */
        const openaiBody = convertRequestToOpenAI(body, targetModel)

        if (isStream) {
          const upstream = await provider.sendStreamRequest(openaiBody as unknown as Record<string, unknown>, {})

          if (!upstream.ok) {
            const errBody = await upstream.text()
            statusCode = upstream.status
            errorMsg = errBody
            reply.status(upstream.status)
            return reply.send(convertErrorToAnthropic(errBody, upstream.status))
          }

          inputTokens = estimateInputTokens(body)
          reply.hijack()
          await streamOpenAIToAnthropic(upstream.body!, reply.raw, model, inputTokens, collectStreamText, collectStreamToolCall)
          return
        }

        const upstream = await provider.sendRequest(openaiBody as unknown as Record<string, unknown>, {})

        if (!upstream.ok) {
          const errBody = await upstream.text()
          statusCode = upstream.status
          errorMsg = errBody
          reply.status(upstream.status)
          return reply.send(convertErrorToAnthropic(errBody, upstream.status))
        }

        const openaiResp = await upstream.json() as Record<string, unknown>
        const converted = convertResponseToAnthropic(
          openaiResp as unknown as import("../types.ts").OpenAIChatCompletionResponse,
          model,
        )
        inputTokens = converted.usage.input_tokens
        outputTokens = converted.usage.output_tokens
        outputText = converted.content
          ?.map(b => {
            if (b.type === "text") return b.text
            if (b.type === "tool_use") return `[tool_call: ${b.name}(${JSON.stringify(b.input)})]`
            return ""
          })
          .filter(Boolean)
          .join("\n") ?? ""
        return reply.send(converted)
      } finally {
        semaphore?.release()
      }
    } catch (err) {
      statusCode = 400
      errorMsg = (err as Error).message
      return reply.status(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: errorMsg },
      } satisfies AnthropicErrorResponse)
    } finally {
      const durationMs = Date.now() - startTime
      fastify.db.addLog({
        method: "POST",
        path: "/v1/messages",
        model,
        providerId,
        targetModel,
        stream: isStream,
        statusCode,
        durationMs,
        inputTokens,
        outputTokens,
        error: errorMsg,
      })
      logRequestSummary({
        reqId, model, targetModel, provider: providerName, input: inputSummary,
        output: outputText, durationMs, stream: isStream, statusCode, error: errorMsg,
      })
    }
  })

  /** GET /v1/models — 模型发现 */
  fastify.get("/v1/models", async (_request, reply) => {
    const models = fastify.registry.getAvailableModels()

    return reply.send({
      data: models.map(m => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: m.owned_by,
      })),
      first_id: models[0]?.id ?? "",
      last_id: models[models.length - 1]?.id ?? "",
      has_more: false,
    })
  })

  /** POST /v1/messages/count_tokens — 透传 token 计数 */
  fastify.post("/v1/messages/count_tokens", async (request, reply) => {
    return reply.send({
      input_tokens: estimateInputTokens(request.body as AnthropicMessagesRequest),
    })
  })
}

/** SSE 透传（Anthropic 直连时使用），同时收集文本摘要 */
function streamPassthrough(
  upstream: ReadableStream<Uint8Array>,
  raw: import("node:http").ServerResponse,
  onText?: (text: string) => void,
  onToolCall?: (name: string, input: string) => void,
) {
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
  raw.flushHeaders()
  raw.socket?.setNoDelay(true)

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  /** 工具调用累积状态 */
  let currentToolName = ""
  let currentToolArgs = ""

  function pump(): Promise<void> {
    return reader.read().then(({ done, value }) => {
      if (done) {
        raw.end()
        return
      }
      raw.write(value)
      /** 从 SSE 中提取 text_delta 和工具调用 */
      if (onText || onToolCall) {
        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue
          try {
            const obj = JSON.parse(line.slice(6))
            if (obj.type === "content_block_start" && obj.content_block?.type === "tool_use") {
              currentToolName = obj.content_block.name
              currentToolArgs = ""
            } else if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
              onText?.(obj.delta.text)
            } else if (obj.type === "content_block_delta" && obj.delta?.type === "input_json_delta") {
              currentToolArgs += obj.delta.partial_json
            } else if (obj.type === "content_block_stop" && currentToolName) {
              onToolCall?.(currentToolName, currentToolArgs)
              currentToolName = ""
              currentToolArgs = ""
            }
          } catch { /* skip */ }
        }
      }
      return pump()
    })
  }

  return pump()
}

function convertErrorToAnthropic(errorBody: string, status: number): AnthropicErrorResponse {
  let message = errorBody
  try {
    const parsed = JSON.parse(errorBody)
    message = parsed.error?.message || parsed.message || errorBody
  } catch { /* keep original */ }

  return {
    type: "error",
    error: {
      type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error",
      message,
    },
  }
}

/** 提取最后一条 user 消息的文本 */
function extractLastAnthropicUserMessage(body: AnthropicMessagesRequest): string | null {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i]!
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") return msg.content
    return msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map(b => b.text)
      .join(" ")
  }
  return null
}


/** 粗略估算输入 token 数 */
function estimateInputTokens(body: AnthropicMessagesRequest): number {
  let chars = 0
  if (typeof body.system === "string") chars += body.system.length
  else if (body.system) chars += body.system.reduce((sum, b) => sum + b.text.length, 0)

  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ("text" in block) chars += (block as { text: string }).text.length
      }
    }
  }

  return Math.ceil(chars / 4)
}
