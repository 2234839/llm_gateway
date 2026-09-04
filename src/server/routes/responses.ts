import type { FastifyInstance } from "fastify"
import type { OpenAIResponsesRequest, SecretEntry } from "../types.ts"
import { convertResponsesToChat, extractResponsesText, extractResponsesContentTypes } from "../converters/responses-to-chat.ts"
import { estimateTokenCount } from "../providers/registry.ts"
import { logRequestSummary, nextReqId } from "../utils/log-summary.ts"
import { emitEvent } from "../utils/event-bus.ts"
import { acquireRpmSlot, checkQuota, recordRpmRequest, recordUsage } from "../quota.ts"
import { createDisconnectSignal } from "../utils/disconnect.ts"
import { withUpstreamRetry } from "../utils/retry.ts"
import { restoreObjectDeep, maskText } from "../utils/secret-vault.ts"

/**
 * POST /v1/responses — OpenAI Responses API 入口
 * 内部转换为 Chat Completions 中间格式，再走现有 openai 直通/anthropic 转换链路；
 * 上游为 openai-responses 协议端点时直通。
 */
export async function responsesRoutes(fastify: FastifyInstance) {
  fastify.post("/v1/responses", async (request, reply) => {
    const body = request.body as OpenAIResponsesRequest
    const model = body.model
    if (!model) {
      return reply.status(400).send({
        error: { message: "model is required", type: "invalid_request_error", code: "missing_model" },
      })
    }
    /** input 与 instructions 至少一个（与 Responses 规范一致） */
    const hasInput = typeof body.input === "string" ? body.input.length > 0 : Array.isArray(body.input) && body.input.length > 0
    if (!hasInput && !body.instructions) {
      return reply.status(400).send({
        error: { message: "input or instructions is required and must be non-empty", type: "invalid_request_error", code: "missing_input" },
      })
    }

    const startTime = Date.now()
    console.log(`[responses] Received request for model: ${model}`)

    /** 生成网关级别的 request-id，附加到响应 header */
    const gatewayRequestId = `gw_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    reply.header("x-request-id", gatewayRequestId)
    reply.header("x-gateway-request-id", gatewayRequestId)

    let providerId = ""
    let targetModel = ""
    let providerName = ""
    let statusCode = 0
    let errorMsg: string | null = null
    let inputTokens = 0
    let outputTokens = 0
    let cacheCreationTokens = 0
    let cacheReadTokens = 0
    let outputText = ""
    const fallbackAttempts: { providerId: string; providerName: string; targetModel: string; statusCode: number; error: string }[] = []
    const isStream = body.stream ?? false
    const reqId = nextReqId()
    const auth = request.authContext

    /** 流式文本批量缓冲：每 100ms 或请求结束时刷新，减少 SSE 事件频率 */
    let streamBuffer = ""
    let streamTimer: ReturnType<typeof setTimeout> | null = null
    const flushStreamBuffer = () => {
      streamTimer = null
      if (streamBuffer) {
        emitEvent({ type: "request_stream", requestId: reqId, text: streamBuffer })
        streamBuffer = ""
      }
    }
    const collectStreamText = (text: string) => {
      outputText += text
      if (isStream) {
        streamBuffer += text
        if (!streamTimer) streamTimer = setTimeout(flushStreamBuffer, 100)
      }
    }
    const setStreamError = (err: string) => {
      errorMsg = err
      statusCode = 502
    }

    /** 密钥保护条目 */
    let secretEntries: SecretEntry[] = []

    try {
      const messageText = extractResponsesText(body)
      const contentTypes = extractResponsesContentTypes(body)
      /** 密钥保护条目：还原入站占位符 → 真实密钥 */
      secretEntries = fastify.db.getSecrets()
      const routeResult = fastify.registry.resolve(model, { messageText, contentTypes, groupId: auth?.groupId, clientProtocol: "openai-responses", tokenCount: estimateTokenCount(messageText) + (body.max_output_tokens ?? 0) })

      /** 配额检查 */
      if (auth) {
        const quotaResult = checkQuota(fastify.db, auth)
        if (!quotaResult.allowed) {
          if (quotaResult.type === "rpm" && routeResult.routeRule?.retryQpmLimit) {
            try {
              await acquireRpmSlot(auth.keyId, auth.keyLimits.rpmLimit, auth.groupLimits.rpmLimit, request.signal)
            } catch {
              if (quotaResult.retryAfterMs) reply.header("Retry-After", Math.ceil(quotaResult.retryAfterMs / 1000))
              return reply.status(429).send({
                error: { message: quotaResult.reason!, type: "rate_limit_error", code: "rate_limit_exceeded" },
              })
            }
          } else {
            if (quotaResult.retryAfterMs) reply.header("Retry-After", Math.ceil(quotaResult.retryAfterMs / 1000))
            return reply.status(429).send({
              error: { message: quotaResult.reason!, type: "rate_limit_error", code: "rate_limit_exceeded" },
            })
          }
        } else {
          recordRpmRequest(auth.keyId, auth.keyLimits.rpmLimit, auth.groupLimits.rpmLimit)
        }
      }

      const { provider, targetModel: tm, providerConfig, rulePattern, fallbacks, fallbackOnClientError } = routeResult

      /** 附加路由调试 header */
      reply.header("x-gateway-provider", encodeURIComponent(providerConfig.name))
      reply.header("x-gateway-model", encodeURIComponent(tm))

      /** 构建尝试列表：主 provider + fallbacks（按 responses 协议选择端点） */
      const candidates: { providerId: string; providerName: string; provider: import("../types.ts").Provider; providerConfig: import("../types.ts").ProviderConfig; targetModel: string }[] = [
        { providerId: providerConfig.id, providerName: providerConfig.name, provider, providerConfig, targetModel: tm },
      ]
      for (const fb of fallbacks) {
        const fbProvider = fastify.registry.getProvider(fb.providerId, "openai-responses")
        const fbConfig = fastify.registry.getProviderConfig(fb.providerId)
        if (fbProvider && fbConfig) {
          candidates.push({ providerId: fbConfig.id, providerName: fbConfig.name, provider: fbProvider, providerConfig: fbConfig, targetModel: fb.targetModel || tm })
        }
      }

      emitEvent({ type: "request_start", requestId: reqId, model, targetModel: tm, provider: providerConfig.name, providerId: providerConfig.id, input: messageText.slice(0, 200), rulePattern, keyName: auth?.keyName, groupName: auth?.groupName })

      const retryOptions = {
        retryOn429: routeResult.routeRule?.retryQpmLimit === true,
        retryOn529: routeResult.routeRule?.retryOn529 === true,
        retryAllFailures: routeResult.routeRule?.retryAllFailures === true,
      }

      /** 依次尝试每个候选 provider */
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const { provider: currentProvider, providerConfig: currentConfig, targetModel: currentTarget } = candidates[attempt]!

        providerId = currentConfig.id
        targetModel = currentTarget
        providerName = currentConfig.name

        if (attempt > 0) {
          console.log(`[responses] Fallback #${attempt} → ${providerName} / ${targetModel}`)
        }

        const semaphore = fastify.registry.getSemaphore(currentConfig.id)
        const { signal: clientSignal, cleanup: cleanupDisconnect } = createDisconnectSignal(request)
        try {
          await semaphore?.acquire(clientSignal)
        } catch {
          cleanupDisconnect()
          return
        }
        emitEvent({ type: "upstream_start", requestId: reqId, providerId, providerName })
        try {
          const result = await withUpstreamRetry(
            () => handleResponsesUpstream(currentProvider, currentConfig, currentTarget, body, isStream, reply, collectStreamText, setStreamError, clientSignal, secretEntries),
            retryOptions,
            clientSignal,
            providerName,
            reqId,
            providerId,
            "[responses]",
          )

          emitEvent({ type: "upstream_end", requestId: reqId, providerId })
          if (result.ok) {
            if (result.streamHijacked) {
              if (statusCode === 0) statusCode = 200
            } else {
              statusCode = result.statusCode
            }
            inputTokens = result.inputTokens
            outputTokens = result.outputTokens
            cacheCreationTokens = result.cacheCreationTokens
            cacheReadTokens = result.cacheReadTokens
            if (result.outputText) outputText = result.outputText
            semaphore?.release()
            cleanupDisconnect()
            return
          }
          semaphore?.release()
          statusCode = result.statusCode
          errorMsg = result.errorMsg
          fallbackAttempts.push({ providerId, providerName, targetModel, statusCode, error: result.errorMsg ?? "" })
          console.warn(`[responses] Provider "${providerName}" failed (${statusCode}): ${result.errorMsg}`)

          if (!fallbackOnClientError && statusCode >= 400 && statusCode < 500 && statusCode !== 429 && statusCode !== 408) {
            cleanupDisconnect()
            reply.status(statusCode)
            return reply.send({ error: { message: errorMsg ?? "Upstream error", type: "server_error", code: "upstream_error" } })
          }
        } catch (err) {
          emitEvent({ type: "upstream_end", requestId: reqId, providerId })
          semaphore?.release()
          cleanupDisconnect()
          throw err
        }
        cleanupDisconnect()
      }

      reply.status(statusCode || 502)
      return reply.send({ error: { message: errorMsg ?? "All providers failed", type: "server_error", code: "all_providers_failed" } })
    } catch (err) {
      const msg = (err as Error).message
      const isNetworkError = msg.startsWith("Provider ") && (msg.includes("timed out") || msg.includes("connection failed") || msg.includes("aborted"))
      statusCode = isNetworkError ? 502 : 400
      errorMsg = msg
      return reply.status(statusCode).send({
        error: { message: errorMsg, type: isNetworkError ? "server_error" : "invalid_request_error" },
      })
    } finally {
      if (streamTimer) { clearTimeout(streamTimer); flushStreamBuffer() }
      const durationMs = Date.now() - startTime
      emitEvent({ type: "request_end", requestId: reqId, durationMs, statusCode, error: errorMsg, tokenUsage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } })
      if (fallbackAttempts.length > 0) {
        reply.header("x-gateway-fallback-attempts", fallbackAttempts.length)
      }
      fastify.db.addLog({
        method: "POST",
        path: "/v1/responses",
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
        inputContent: messageTextOf(body),
        outputContent: outputText ? maskText(outputText, secretEntries) || null : null,
        fallbackAttempts: fallbackAttempts.length > 0 ? JSON.stringify(fallbackAttempts) : null,
      })
      recordUsage(auth?.keyId ?? null, inputTokens + outputTokens)
      logRequestSummary({
        reqId, model, targetModel, provider: providerName, input: messageTextOf(body) ?? model,
        output: outputText, durationMs, stream: isStream, statusCode, error: errorMsg,
      })
    }
  })
}

/** 提取入站请求的文本摘要（日志 input 用） */
function messageTextOf(body: OpenAIResponsesRequest): string | null {
  const text = extractResponsesText(body)
  return text ? text.slice(0, 500) : null
}

/** Responses 上游处理：openai-responses 直通；其他协议转 CC 后发送 */
async function handleResponsesUpstream(
  provider: import("../types.ts").Provider,
  providerConfig: import("../types.ts").ProviderConfig,
  targetModel: string,
  body: OpenAIResponsesRequest,
  isStream: boolean,
  reply: import("fastify").FastifyReply,
  onText: (text: string) => void,
  onStreamError?: (err: string) => void,
  signal?: AbortSignal,
  secrets: SecretEntry[] = [],
): Promise<{
  ok: boolean
  statusCode: number
  errorMsg: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  outputText: string | null
  streamHijacked?: boolean
}> {
  try {
    /** openai-responses 端点直通（同协议零转换） */
    if (provider.type === "openai-responses") {
      if (isStream) {
        const upstream = await provider.sendStreamRequest({ ...body, model: targetModel }, {}, signal)
        if (!upstream.ok) {
          const errBody = await upstream.text()
          return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
        }
        if (!upstream.body) {
          return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
        }
        reply.hijack()
        await streamPassthroughResponses(upstream.body, reply.raw, onText, onStreamError)
        return { ok: true, statusCode: 200, errorMsg: null, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null, streamHijacked: true }
      }
      const upstream = await provider.sendRequest({ ...body, model: targetModel }, {}, signal)
      if (!upstream.ok) {
        const errBody = await upstream.text()
        return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      const respText = await upstream.text()
      if (!respText) {
        return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      let resp: Record<string, unknown>
      try {
        resp = JSON.parse(respText) as Record<string, unknown>
      } catch {
        return { ok: false, statusCode: 502, errorMsg: `Invalid JSON response from upstream: ${respText.slice(0, 200)}`, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      const usage = (resp as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }).usage
      const oText = extractResponsesOutputText(resp)
      reply.send(restoreObjectDeep(resp, secrets))
      return { ok: true, statusCode: 200, errorMsg: null, inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, cacheCreationTokens: 0, cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0, outputText: oText }
    }

    /** 其他协议端点：Responses → Chat Completions → 现有链路（openai 直通 / anthropic 转换）→ 转回 Responses */
    const chatBody = convertResponsesToChat({ ...body, model: targetModel })
    const { handleOpenAIUpstreamForResponses } = await import("./openai-internal.ts")
    return handleOpenAIUpstreamForResponses(provider, providerConfig, targetModel, chatBody, body, isStream, reply, onText, onStreamError, signal, secrets)
  } catch (err) {
    const msg = (err as Error).message ?? "Failed to parse upstream response"
    return { ok: false, statusCode: 502, errorMsg: msg, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
}

/** openai-responses SSE 直通：转发原始事件，同时提取文本与 usage */
function streamPassthroughResponses(
  upstream: ReadableStream<Uint8Array>,
  raw: import("node:http").ServerResponse,
  onText?: (text: string) => void,
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

  const reader = upstream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let hasReceivedEvent = false

  function pump(): Promise<void> {
    return reader.read().then(({ done, value }) => {
      if (done) {
        if (!hasReceivedEvent) {
          const errMsg = "Empty response body from upstream"
          console.error(`[responses] ${errMsg}`)
          onStreamError?.(errMsg)
          if (raw.writable) {
            raw.write(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: errMsg } } })}\n\n`)
          }
        }
        raw.end()
        return
      }
      if (!raw.writable) {
        reader.cancel().catch(() => {})
        return
      }
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      const lines = buffer.split("\n")
      buffer = lines.pop()!
      for (const line of lines) {
        raw.write(line + "\n")
        if (line === "") raw.flushHeaders()
        const dataLine = line.startsWith("data:") ? line.slice(5).trim() : ""
        if (!dataLine) continue
        try {
          const obj = JSON.parse(dataLine) as { type?: string; delta?: string; response?: { usage?: { input_tokens?: number; output_tokens?: number } } }
          hasReceivedEvent = true
          if (obj.type === "response.output_text.delta" && obj.delta) onText?.(obj.delta)
          if (obj.type === "response.reasoning_text.delta" && obj.delta) onText?.(obj.delta)
        } catch { /* skip */ }
      }
      return pump()
    }).catch((err) => {
      const errMsg = "Stream interrupted: " + (err as Error).message
      console.error(`[responses] ${errMsg}`)
      onStreamError?.(errMsg)
      if (raw.writable) {
        raw.write(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { message: errMsg } } })}\n\n`)
      }
      raw.end()
      reader.cancel().catch(() => {})
    })
  }

  return pump()
}

/** 提取 Responses 响应的输出文本（日志用） */
function extractResponsesOutputText(resp: Record<string, unknown>): string {
  const output = resp.output as { type?: string; content?: { type?: string; text?: string }[] }[] | undefined
  if (!Array.isArray(output)) return ""
  const parts: string[] = []
  for (const item of output) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) parts.push(c.text)
      }
    } else if (item.type === "reasoning") {
      const summary = (item as unknown as { summary?: { type?: string; text?: string }[] }).summary
      for (const s of summary ?? []) {
        if (s.type === "summary_text" && s.text) parts.push(`[thinking] ${s.text} [/thinking]`)
      }
    } else if (item.type === "function_call") {
      const fc = item as unknown as { name?: string; arguments?: string }
      parts.push(`[tool_call: ${fc.name}(${fc.arguments})]`)
    }
  }
  return parts.join("\n")
}
