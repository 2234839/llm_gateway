import type { FastifyInstance } from "fastify"
import type { OpenAIChatCompletionRequest, OpenAIChatCompletionResponse, AuthContext } from "../types.ts"
import { convertRequestToAnthropic } from "../converters/to-anthropic.ts"
import { convertResponseToOpenAI } from "../converters/resp-to-openai.ts"
import { streamAnthropicToOpenAI } from "../converters/stream-to-openai.ts"
import { extractOpenAIText, extractOpenAIResponseSummary, extractOpenAIContentTypes } from "../utils/extract-text.ts"
import { logRequestSummary, nextReqId } from "../utils/log-summary.ts"
import { emitEvent } from "../utils/event-bus.ts"
import { checkQuota } from "../quota.ts"

export async function openaiRoutes(fastify: FastifyInstance) {
  /** POST /v1/chat/completions — OpenAI Chat Completions API 入口 */
  fastify.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as OpenAIChatCompletionRequest
    const model = body.model
    const startTime = Date.now()
    console.log(`[openai] Received request for model: ${model}`)

    let providerId = ""
    let targetModel = ""
    let providerName = ""
    let statusCode = 200
    let errorMsg: string | null = null
    let inputTokens = 0
    let outputTokens = 0
    let cacheCreationTokens = 0
    let cacheReadTokens = 0
    let outputText = ""
    let fullMessageText = ""
    const isStream = body.stream ?? false
    const reqId = nextReqId()
    const auth = (request as any).authContext as AuthContext | null

    /** 提取输入摘要：最后一条 user 消息 */
    const inputSummary = extractLastUserMessage(body) ?? model

    const collectStreamText = (text: string) => {
      outputText += text
      if (isStream) emitEvent({ type: "request_stream", requestId: reqId, text })
    }
    /** 流式工具调用累积器：key 为 tool call index */
    const toolCallAccumulator = new Map<number, { name: string; args: string }>()
    const collectStreamToolCall = (idx: number, name: string | undefined, args: string | undefined) => {
      const existing = toolCallAccumulator.get(idx)
      if (existing) {
        if (args) existing.args += args
      } else if (name) {
        toolCallAccumulator.set(idx, { name, args: args ?? "" })
      }
    }
    const flushToolCalls = () => {
      for (const [, tc] of toolCallAccumulator) {
        outputText += (outputText ? "\n" : "") + `[tool_call: ${tc.name}(${tc.args})]`
      }
    }

    /** 配额检查 */
    if (auth) {
      const quotaResult = checkQuota(fastify.db, auth)
      if (!quotaResult.allowed) {
        return reply.status(429).send({
          error: { message: quotaResult.reason!, type: "rate_limit_error", code: "rate_limit_exceeded" },
        })
      }
    }

    try {
      const messageText = extractOpenAIText(body)
      fullMessageText = messageText
      const contentTypes = extractOpenAIContentTypes(body)
      const { provider, targetModel: tm, providerConfig, rulePattern } = fastify.registry.resolve(model, { messageText, contentTypes, groupId: auth?.groupId })
      providerId = providerConfig.id
      targetModel = tm
      providerName = providerConfig.name

      emitEvent({ type: "request_start", requestId: reqId, model, targetModel: tm, provider: providerName, input: inputSummary, rulePattern, keyName: auth?.keyName, groupName: auth?.groupName })

      const semaphore = fastify.registry.getSemaphore(providerConfig.id)
      await semaphore?.acquire()
      emitEvent({ type: "upstream_start", requestId: reqId, providerId })
      try {
        if (provider.type === "openai" || provider.type === "azure-openai" || provider.type === "custom") {
          /** OpenAI 兼容提供商 — 透传 */
          if (isStream) {
            const upstream = await provider.sendStreamRequest({ ...body, model: targetModel, stream_options: { include_usage: true } }, {})
            if (!upstream.ok) {
              const errBody = await upstream.text()
              statusCode = upstream.status
              errorMsg = errBody
              reply.status(upstream.status)
              return reply.send({ error: { message: errBody, type: "server_error" } })
            }
            reply.hijack()
            return await streamPassthroughOpenAI(upstream.body!, reply.raw, collectStreamText, collectStreamToolCall, flushToolCalls, (i, o) => {
              inputTokens += i
              outputTokens += o
            })
          }

          const upstream = await provider.sendRequest({ ...body, model: targetModel }, {})
          if (!upstream.ok) {
            const errBody = await upstream.text()
            statusCode = upstream.status
            errorMsg = errBody
            reply.status(upstream.status)
            return reply.send({ error: { message: errBody, type: "server_error" } })
          }
          const resp = await upstream.json() as Record<string, unknown>
          const respUsage = (resp as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
          inputTokens = respUsage?.prompt_tokens ?? 0
          outputTokens = respUsage?.completion_tokens ?? 0
          outputText = extractOpenAIResponseSummary(resp)
          return reply.send(resp)
        }

        /** Anthropic 提供商 — 转换格式 */
        const anthropicBody = convertRequestToAnthropic(body, targetModel)
        const upstreamHeaders: Record<string, string> = {
          "anthropic-version": "2023-06-01",
        }

        if (isStream) {
          const upstream = await provider.sendStreamRequest(
            anthropicBody as unknown as Record<string, unknown>,
            upstreamHeaders,
          )
          if (!upstream.ok) {
            const errBody = await upstream.text()
            statusCode = upstream.status
            errorMsg = errBody
            reply.status(upstream.status)
            return reply.send({ error: { message: errBody, type: "server_error" } })
          }
          reply.hijack()
          await streamAnthropicToOpenAI(upstream.body!, reply.raw, model, collectStreamText, flushToolCalls, (i, o, cc, cr) => {
            inputTokens = i
            outputTokens = o
            cacheCreationTokens = cc
            cacheReadTokens = cr
          })
          return
        }

        const upstream = await provider.sendRequest(
          anthropicBody as unknown as Record<string, unknown>,
          upstreamHeaders,
        )
        if (!upstream.ok) {
          const errBody = await upstream.text()
          statusCode = upstream.status
          errorMsg = errBody
          reply.status(upstream.status)
          return reply.send({ error: { message: errBody, type: "server_error" } })
        }

        const anthropicResp = await upstream.json() as Record<string, unknown>
        const anthroUsage = (anthropicResp as { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }).usage
        inputTokens = anthroUsage?.input_tokens ?? 0
        outputTokens = anthroUsage?.output_tokens ?? 0
        cacheCreationTokens = anthroUsage?.cache_creation_input_tokens ?? 0
        cacheReadTokens = anthroUsage?.cache_read_input_tokens ?? 0
        const converted = convertResponseToOpenAI(
          anthropicResp as unknown as import("../types.ts").AnthropicMessagesResponse,
        )
        outputText = converted.choices?.[0]?.message?.content ?? ""
        return reply.send(converted)
      } finally {
        emitEvent({ type: "upstream_end", requestId: reqId, providerId })
        semaphore?.release()
      }
    } catch (err) {
      statusCode = 400
      errorMsg = (err as Error).message
      return reply.status(400).send({
        error: {
          message: errorMsg,
          type: "invalid_request_error",
        },
      })
    } finally {
      const durationMs = Date.now() - startTime
      emitEvent({ type: "request_end", requestId: reqId, durationMs, statusCode, error: errorMsg, tokenUsage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } })
      fastify.db.addLog({
        method: "POST",
        path: "/v1/chat/completions",
        model,
        providerId,
        targetModel,
        stream: isStream,
        statusCode,
        durationMs,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        apiKeyId: auth?.keyId ?? null,
        groupId: auth?.groupId ?? null,
        error: errorMsg,
        inputContent: fullMessageText,
        outputContent: outputText || null,
      })
      logRequestSummary({
        reqId, model, targetModel, provider: providerName, input: inputSummary,
        output: outputText, durationMs, stream: isStream, statusCode, error: errorMsg,
      })
    }
  })
}

function streamPassthroughOpenAI(
  upstream: ReadableStream<Uint8Array>,
  raw: import("node:http").ServerResponse,
  onText?: (text: string) => void,
  onToolCall?: (idx: number, name: string | undefined, args: string | undefined) => void,
  onEnd?: () => void,
  onTokenUsage?: (inputTokens: number, outputTokens: number) => void,
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

  function pump(): Promise<void> {
    return reader.read().then(({ done, value }) => {
      if (done) {
        onEnd?.()
        raw.end()
        return
      }
      raw.write(value)
      /** 从 SSE chunk 中提取文本内容、工具调用和 token 用量 */
      if (onText || onToolCall || onTokenUsage) {
        const chunk = decoder.decode(value, { stream: true })
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue
          try {
            const obj = JSON.parse(line.slice(6))
            const delta = obj.choices?.[0]?.delta
            if (delta?.content) onText?.(delta.content)
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                onToolCall?.(tc.index, tc.function?.name, tc.function?.arguments)
              }
            }
            if (obj.usage) {
              onTokenUsage?.(obj.usage.prompt_tokens ?? 0, obj.usage.completion_tokens ?? 0)
            }
          } catch { /* skip */ }
        }
      }
      return pump()
    })
  }

  return pump()
}

/** 提取最后一条 user 消息的文本 */
function extractLastUserMessage(body: OpenAIChatCompletionRequest): string | null {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i]!
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") return msg.content
    return msg.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && "text" in p)
      .map(p => p.text)
      .join(" ")
  }
  return null
}

