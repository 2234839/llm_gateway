import type { FastifyInstance } from "fastify"
import type { AnthropicMessagesRequest, AnthropicErrorResponse, Provider, ProviderConfig } from "../types.ts"
import { convertRequestToOpenAI } from "../converters/to-openai.ts"
import { convertResponseToAnthropic } from "../converters/resp-to-anthropic.ts"
import { streamOpenAIToAnthropic } from "../converters/stream-to-anthropic.ts"
import { extractAnthropicText, extractAnthropicResponseSummary, extractAnthropicContentTypes } from "../utils/extract-text.ts"
import { logRequestSummary, nextReqId } from "../utils/log-summary.ts"
import { emitEvent } from "../utils/event-bus.ts"
import { checkQuota, recordRpmRequest, recordUsage } from "../quota.ts"
import { createDisconnectSignal } from "../utils/disconnect.ts"

export async function anthropicRoutes(fastify: FastifyInstance) {
  /** POST /v1/messages — Anthropic Messages API 入口 */
  fastify.post("/v1/messages", async (request, reply) => {
    const body = request.body as AnthropicMessagesRequest
    const model = body.model
    if (!model) {
      return reply.status(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: "model is required" },
      } satisfies AnthropicErrorResponse)
    }
    if (!body.max_tokens || body.max_tokens < 1) {
      return reply.status(400).send({
        type: "error",
        error: { type: "invalid_request_error", message: "max_tokens: must be ≥ 1" },
      } satisfies AnthropicErrorResponse)
    }
    const startTime = Date.now()
    console.log(`[anthropic] Received request for model: ${model}`)

    /** 生成网关级别的 request-id，附加到响应 header */
    const gatewayRequestId = `gw_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`
    reply.header("request-id", gatewayRequestId)
    reply.header("x-gateway-request-id", gatewayRequestId)

    /** 提取上游 headers（需要透传的） */
    const upstreamHeaders = extractClientHeaders(request.headers)

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
    let fullMessageText = ""
    /** fallback 中间尝试记录 */
    const fallbackAttempts: { providerId: string; providerName: string; targetModel: string; statusCode: number; error: string }[] = []
    const isStream = body.stream ?? false
    const reqId = nextReqId()
    const auth = request.authContext

    /** 提取输入摘要：最后一条 user 消息 */
    const inputSummary = extractLastAnthropicUserMessage(body) ?? model

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
    const collectStreamToolCall = (name: string, input: string) => { outputText += (outputText ? "\n" : "") + `[tool_call: ${name}(${input})]` }

    /** 流式传输中途出错时设置错误信息用于日志记录 */
    const setStreamError = (err: string) => {
      errorMsg = err
      statusCode = 502
    }

    /** 配额检查 */
    if (auth) {
      const quotaResult = checkQuota(fastify.db, auth)
      if (!quotaResult.allowed) {
        if (quotaResult.retryAfterMs) reply.header("Retry-After", Math.ceil(quotaResult.retryAfterMs / 1000))
        return reply.status(429).send({
          type: "error",
          error: { type: "rate_limit_error", message: quotaResult.reason! },
        } satisfies AnthropicErrorResponse)
      }
      recordRpmRequest(auth.keyId, auth.keyLimits.rpmLimit, auth.groupLimits.rpmLimit)
    }

    try {
      const messageText = extractAnthropicText(body)
      fullMessageText = messageText
      const contentTypes = extractAnthropicContentTypes(body)
      const { provider, targetModel: tm, providerConfig, rulePattern, fallbacks } = fastify.registry.resolve(model, { messageText, contentTypes, groupId: auth?.groupId, charCount: messageText.length })

      /** 内容改写管道 */
      {
        const rewriteRules = fastify.db.getRewriteRules()
        if (rewriteRules.length > 0) {
          const { rewriteAnthropic } = await import("../utils/rewrite-engine")
          const rr = rewriteAnthropic(body, rewriteRules, { path: "/v1/messages", model })
          if (rr.matched) fullMessageText = extractAnthropicText(body)
        }
      }

      /** 附加路由调试 header（RFC 7230 要求 header 值为可见 ASCII 字符） */
      reply.header("x-gateway-provider", encodeURIComponent(providerConfig.name))
      reply.header("x-gateway-model", encodeURIComponent(tm))

      /** 构建尝试列表：主 provider + fallbacks */
      const candidates: { provider: Provider; providerConfig: ProviderConfig; targetModel: string }[] = [
        { provider, providerConfig, targetModel: tm },
      ]
      for (const fb of fallbacks) {
        const fbProvider = fastify.registry.getProvider(fb.providerId)
        const fbConfig = fastify.registry.getProviderConfig(fb.providerId)
        if (fbProvider && fbConfig) {
          candidates.push({ provider: fbProvider, providerConfig: fbConfig, targetModel: fb.targetModel || tm })
        }
      }

      emitEvent({ type: "request_start", requestId: reqId, model, targetModel: tm, provider: providerConfig.name, providerId: providerConfig.id, input: inputSummary, rulePattern, keyName: auth?.keyName, groupName: auth?.groupName })

      /** 依次尝试每个候选 provider，直到成功 */
      let lastError: string | null = null
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const { provider: currentProvider, providerConfig: currentConfig, targetModel: currentTarget } = candidates[attempt]!

        providerId = currentConfig.id
        targetModel = currentTarget
        providerName = currentConfig.name

        if (attempt > 0) {
          console.log(`[anthropic] Fallback #${attempt} → ${providerName} / ${targetModel}`)
        }

        const semaphore = fastify.registry.getSemaphore(currentConfig.id)
        /** 基于 TCP socket close 的断连信号，比 request.signal 可靠（Bun 下 request.signal 在请求体消费后会误 abort） */
        const clientSignal = createDisconnectSignal(request)
        try {
          await semaphore?.acquire(clientSignal)
        } catch {
          return
        }
        emitEvent({ type: "upstream_start", requestId: reqId, providerId, providerName: currentConfig.name })
        try {
          
          const result = await handleAnthropicUpstream(currentProvider, currentTarget, body, isStream, upstreamHeaders, reply, collectStreamText, collectStreamToolCall, setStreamError, clientSignal)
          emitEvent({ type: "upstream_end", requestId: reqId, providerId })
          if (result.ok) {
            /** 流式 hijack 成功时 statusCode 为 200；失败时 setStreamError 已设置 statusCode */
            if (result.streamHijacked) {
              if (statusCode === 0) statusCode = 200
            } else {
              statusCode = result.statusCode
            }
            inputTokens = result.inputTokens
            outputTokens = result.outputTokens
            cacheCreationTokens = result.cacheCreationTokens
            cacheReadTokens = result.cacheReadTokens
            outputText = result.outputText ?? outputText
            /** 上游已接受请求，释放信号量（不延迟到流结束，避免 Bun 下 close 事件不可靠导致信号量泄漏） */
            semaphore?.release()
            return
          }
          /** 请求失败，释放信号量 */
          semaphore?.release()
          /** 请求失败，记录错误，尝试下一个 fallback */
          lastError = result.errorMsg
          statusCode = result.statusCode
          errorMsg = result.errorMsg
          fallbackAttempts.push({ providerId, providerName, targetModel, statusCode, error: result.errorMsg ?? "" })
          console.warn(`[anthropic] Provider "${providerName}" failed (${statusCode}): ${result.errorMsg}`)

          /** 429/408 允许 fallback 尝试其他 provider，其余 4xx 直接返回 */
          if (statusCode >= 400 && statusCode < 500 && statusCode !== 429 && statusCode !== 408) {
            reply.status(statusCode)
            return reply.send(convertErrorToAnthropic(result.errorMsg!, statusCode))
          }
        } catch (err) {
          /** handleAnthropicUpstream 抛出异常（如网络错误），释放信号量 */
          emitEvent({ type: "upstream_end", requestId: reqId, providerId })
          semaphore?.release()
          throw err
        }
      }

      /** 所有候选都失败了 */
      reply.status(statusCode || 502)
      return reply.send(convertErrorToAnthropic(lastError ?? "All providers failed", statusCode || 502))
    } catch (err) {
      const msg = (err as Error).message
      const isNetworkError = msg.startsWith("Provider ") && (msg.includes("timed out") || msg.includes("connection failed") || msg.includes("aborted"))
      statusCode = isNetworkError ? 502 : 400
      errorMsg = msg
      return reply.status(statusCode).send({
        type: "error",
        error: { type: isNetworkError ? "api_error" : "invalid_request_error", message: errorMsg },
      } satisfies AnthropicErrorResponse)
    } finally {
      /** 刷新流式文本缓冲区 */
      if (streamTimer) { clearTimeout(streamTimer); flushStreamBuffer() }
      const durationMs = Date.now() - startTime
      emitEvent({ type: "request_end", requestId: reqId, durationMs, statusCode, error: errorMsg, tokenUsage: { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } })
      /** 附加 fallback 尝试 header */
      if (fallbackAttempts.length > 0) {
        reply.header("x-gateway-fallback-attempts", fallbackAttempts.length)
      }
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
        cacheCreationTokens,
        cacheReadTokens,
        apiKeyId: auth?.keyId ?? null,
        groupId: auth?.groupId ?? null,
        error: errorMsg,
        inputContent: fullMessageText,
        outputContent: outputText || null,
        fallbackAttempts: fallbackAttempts.length > 0 ? JSON.stringify(fallbackAttempts) : null,
      })
      recordUsage(auth?.keyId ?? null, inputTokens + outputTokens)
      logRequestSummary({
        reqId, model, targetModel, provider: providerName, input: inputSummary,
        output: outputText, durationMs, stream: isStream, statusCode, error: errorMsg,
      })
    }
  })

  /** POST /v1/messages/count_tokens — 透传 token 计数 */
  fastify.post("/v1/messages/count_tokens", async (request, reply) => {
    return reply.send({
      input_tokens: estimateInputTokens(request.body as AnthropicMessagesRequest),
    })
  })
}

/** 处理单个 Anthropic 上游请求，返回统一的结果对象 */
async function handleAnthropicUpstream(
  provider: Provider,
  targetModel: string,
  body: AnthropicMessagesRequest,
  isStream: boolean,
  upstreamHeaders: Record<string, string>,
  reply: import("fastify").FastifyReply,
  onText: (text: string) => void,
  onToolCall: (name: string, input: string) => void,
  onStreamError?: (err: string) => void,
  signal?: AbortSignal,
): Promise<{
  ok: boolean
  statusCode: number
  errorMsg: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  outputText: string | null
  /** 流式传输已 hijack，即使发生流中断也算 ok（响应已发给客户端） */
  streamHijacked?: boolean
}> {
  try {
  if (provider.type === "anthropic") {
    /** Anthropic 直连 — 透传 */
    if (isStream) {
      const upstream = await provider.sendStreamRequest({ ...body, model: targetModel }, upstreamHeaders, signal)
      console.log(`[anthropic] anthropic direct stream status: ${upstream.status}, body: ${upstream.body ? "present" : "null"}, content-type: ${upstream.headers.get("content-type")}`)
      if (!upstream.ok) {
        const errBody = await upstream.text()
        console.error(`[anthropic] anthropic direct stream error (${upstream.status}): ${errBody.slice(0, 500)}`)
        return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }

      let iTokens = 0, oTokens = 0, ccTokens = 0, crTokens = 0
      if (!upstream.body) {
        console.error(`[anthropic] anthropic direct stream has no body (status: ${upstream.status})`)
        return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      reply.hijack()
      await streamPassthrough(upstream.body, reply.raw, onText, onToolCall, (tu) => {
        iTokens = tu.inputTokens
        oTokens = tu.outputTokens
        ccTokens = tu.cacheCreationTokens
        crTokens = tu.cacheReadTokens
      }, onStreamError)
      return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iTokens, outputTokens: oTokens, cacheCreationTokens: ccTokens, cacheReadTokens: crTokens, outputText: null, streamHijacked: true }
    }

    const upstream = await provider.sendRequest({ ...body, model: targetModel }, upstreamHeaders, signal)
    if (!upstream.ok) {
      const errBody = await upstream.text()
      return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }

    /** 检查空响应体，避免 JSON 解析失败 */
    const respText = await upstream.text()
    if (!respText) {
      return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    let respBody: unknown
    try {
      respBody = JSON.parse(respText)
    } catch {
      return { ok: false, statusCode: 502, errorMsg: `Invalid JSON response from upstream: ${respText.slice(0, 200)}`, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    const respUsage = (respBody as { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }).usage
    const iT = respUsage?.input_tokens ?? 0
    const oT = respUsage?.output_tokens ?? 0
    const ccT = respUsage?.cache_creation_input_tokens ?? 0
    const crT = respUsage?.cache_read_input_tokens ?? 0
    const oText = extractAnthropicResponseSummary(respBody as import("../types.ts").AnthropicMessagesResponse)
    reply.send(respBody)
    return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iT, outputTokens: oT, cacheCreationTokens: ccT, cacheReadTokens: crT, outputText: oText }
  }

  /** 非 Anthropic 提供商 — 转换格式 */
  const openaiBody = convertRequestToOpenAI(body, targetModel)

  if (isStream) {
    const upstream = await provider.sendStreamRequest(openaiBody as unknown as Record<string, unknown>, {}, signal)
    console.log(`[anthropic] upstream stream response status: ${upstream.status}, content-type: ${upstream.headers.get("content-type")}`)
    if (!upstream.ok) {
      const errBody = await upstream.text()
      console.error(`[anthropic] upstream stream error (${upstream.status}): ${errBody.slice(0, 500)}`)
      return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }

    let iTokens = estimateInputTokens(body)
    let oTokens = 0
    let crTokens = 0
    if (!upstream.body) {
      console.error(`[anthropic] upstream stream has no body (status: ${upstream.status})`)
      return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    reply.hijack()
    await streamOpenAIToAnthropic(upstream.body, reply.raw, body.model, iTokens, onText, onToolCall, (finalInput, finalOutput, finalCr) => {
      iTokens = finalInput
      oTokens = finalOutput
      crTokens = finalCr
    }, onStreamError)
    return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iTokens, outputTokens: oTokens, cacheCreationTokens: 0, cacheReadTokens: crTokens, outputText: null, streamHijacked: true }
  }

  const upstream = await provider.sendRequest(openaiBody as unknown as Record<string, unknown>, {}, signal)
  if (!upstream.ok) {
    const errBody = await upstream.text()
    return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }

  const respText = await upstream.text()
  if (!respText) {
    return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
  let openaiResp: Record<string, unknown>
  try {
    openaiResp = JSON.parse(respText) as Record<string, unknown>
  } catch {
    return { ok: false, statusCode: 502, errorMsg: `Invalid JSON response from upstream: ${respText.slice(0, 200)}`, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
  const converted = convertResponseToAnthropic(
    openaiResp as unknown as import("../types.ts").OpenAIChatCompletionResponse,
    body.model,
  )
  const iT = converted.usage.input_tokens
  const oT = converted.usage.output_tokens
  const oText = converted.content
    ?.map(b => {
      if (b.type === "text") return b.text
      if (b.type === "tool_use") return `[tool_call: ${b.name}(${JSON.stringify(b.input)})]`
      return ""
    })
    .filter(Boolean)
    .join("\n") ?? ""
  reply.send(converted)
  const crT = converted.usage.cache_read_input_tokens ?? 0
  return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iT, outputTokens: oT, cacheCreationTokens: 0, cacheReadTokens: crT, outputText: oText }
  } catch (err) {
    /** 上游响应解析失败（如非 JSON 响应体），返回 502 */
    const msg = (err as Error).message ?? "Failed to parse upstream response"
    return { ok: false, statusCode: 502, errorMsg: msg, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
}

/** SSE 透传（Anthropic 直连时使用），同时收集文本摘要和 token 用量 */
function streamPassthrough(
  upstream: ReadableStream<Uint8Array>,
  raw: import("node:http").ServerResponse,
  onText?: (text: string) => void,
  onToolCall?: (name: string, input: string) => void,
  onTokenUsage?: (usage: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }) => void,
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
  /** 工具调用累积状态 */
  let currentToolName = ""
  let currentToolArgs = ""
  /** SSE 行缓冲区，处理跨 chunk 的行分割 */
  let sseBuffer = ""
  /** token 用量累积：message_start 提供 input+cache，message_delta 覆盖为最终值 */
  let collectedUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
  /** 是否收到过有效 SSE 事件（用于检测空流） */
  let hasReceivedEvent = false

  let chunkCount = 0
  function pump(): Promise<void> {
    return reader.read().then(({ done, value }) => {
      if (done) {
        /** 空流检测：从未收到有效 SSE 事件，向上游报错 */
        if (!hasReceivedEvent) {
          const errMsg = "Empty response body from upstream"
          console.error(`[anthropic] ${errMsg} after ${chunkCount} chunks. buffer: ${JSON.stringify(sseBuffer.slice(0, 300))}`)
          onStreamError?.(errMsg)
          if (raw.writable) {
            const errorEvent = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } })}\n\n`
            raw.write(errorEvent)
          }
        }
        onTokenUsage?.(collectedUsage)
        raw.end()
        return
      }
      /** 客户端已断连，取消上游读取 */
      if (!raw.writable) {
        reader.cancel().catch(() => {})
        return
      }
      const decodedChunk = decoder.decode(value, { stream: true })
      chunkCount++
      if (chunkCount <= 3) {
        console.log(`[anthropic] chunk #${chunkCount}: ${JSON.stringify(decodedChunk.slice(0, 300))}`)
      }
      /**
       * 逐事件写入而非整个 chunk 透传。
       * 上游 fetch 返回的 chunk 可能包含多个 SSE 事件，
       * 整个 chunk 一次性 write 会导致客户端 reader.read() 批量返回。
       * 逐事件 write + flushHeaders 保证每个事件独立到达客户端。
       */
      sseBuffer += decodedChunk.replace(/\r\n/g, "\n")
      const lines = sseBuffer.split("\n")
      sseBuffer = lines.pop()!
      for (const line of lines) {
        raw.write(line + "\n")
        /** 空行 = SSE 事件结束边界，立即 flush */
        if (line === "") raw.flushHeaders()
        if (!line.startsWith("data:")) continue
        try {
          const obj = JSON.parse(line.slice(5).trim())
          if (!obj.type) continue
          hasReceivedEvent = true
          if (obj.type === "message_start") {
            const usage = obj.message?.usage
            if (usage) {
              collectedUsage.inputTokens = usage.input_tokens ?? 0
              collectedUsage.cacheCreationTokens = usage.cache_creation_input_tokens ?? 0
              collectedUsage.cacheReadTokens = usage.cache_read_input_tokens ?? 0
            }
          } else if (obj.type === "message_delta" && obj.usage) {
            /** message_delta 包含最终的完整 usage，覆盖所有字段 */
            collectedUsage.inputTokens = obj.usage.input_tokens ?? collectedUsage.inputTokens
            collectedUsage.outputTokens = obj.usage.output_tokens ?? 0
            collectedUsage.cacheCreationTokens = obj.usage.cache_creation_input_tokens ?? collectedUsage.cacheCreationTokens
            collectedUsage.cacheReadTokens = obj.usage.cache_read_input_tokens ?? collectedUsage.cacheReadTokens
          } else if (obj.type === "content_block_start" && obj.content_block?.type === "tool_use") {
            currentToolName = obj.content_block.name
            currentToolArgs = ""
          } else if (obj.type === "content_block_delta" && obj.delta?.type === "text_delta") {
            onText?.(obj.delta.text)
          } else if (obj.type === "content_block_delta" && obj.delta?.type === "thinking_delta") {
            onText?.(obj.delta.thinking)
          } else if (obj.type === "content_block_delta" && obj.delta?.type === "input_json_delta") {
            currentToolArgs += obj.delta.partial_json
          } else if (obj.type === "content_block_stop" && currentToolName) {
            onToolCall?.(currentToolName, currentToolArgs)
            currentToolName = ""
            currentToolArgs = ""
          }
        } catch { /* skip */ }
      }
      return pump()
    }).catch((err) => {
      /** 上游流式传输中断，发送 SSE error 事件并关闭连接 */
      const errMsg = "Stream interrupted: " + (err as Error).message
      console.error(`[anthropic] Stream interrupted: ${(err as Error).message}`)
      onStreamError?.(errMsg)
      if (raw.writable) {
        const errorEvent = `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } })}\n\n`
        raw.write(errorEvent)
      }
      onTokenUsage?.(collectedUsage)
      if (raw.writable) raw.end()
      reader.cancel().catch(() => {})
    })
  }

  return pump()
}

function convertErrorToAnthropic(errorBody: string, status: number): AnthropicErrorResponse {
  let message = errorBody
  try {
    const parsed = JSON.parse(errorBody)
    /** 已经是 Anthropic 格式 */
    if (parsed.type === "error" && parsed.error?.message) return parsed
    /** OpenAI 格式：尝试透传原始错误类型 */
    if (parsed.error?.message) {
      message = parsed.error.message
    } else if (typeof parsed.error === "string") {
      message = parsed.error
    } else if (parsed.message) {
      message = parsed.message
    }
  } catch { /* keep original */ }

  if (status === 401) return { type: "error", error: { type: "authentication_error", message } }
  if (status === 429) return { type: "error", error: { type: "rate_limit_error", message } }
  if (status === 404) return { type: "error", error: { type: "not_found_error", message } }
  if (status >= 500) return { type: "error", error: { type: "api_error", message } }
  return { type: "error", error: { type: "invalid_request_error", message } }
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


/** 从客户端请求头中提取需要透传给上游的 headers
 * 排除网关自己管理的字段（host、content-length、authorization 等）
 */
function extractClientHeaders(headers: import("fastify").FastifyRequest["headers"]): Record<string, string> {
  const result: Record<string, string> = {}
  const skipHeaders = new Set([
    "host",
    "connection",
    "content-length",
    "content-type",
    "authorization",
    "x-api-key",
    "api-key",
    "accept-encoding",
    "accept",
  ])
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue
    if (skipHeaders.has(key.toLowerCase())) continue
    if (typeof value === "string") {
      result[key] = value
    } else if (Array.isArray(value)) {
      result[key] = value.join(", ")
    }
  }
  return result
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
