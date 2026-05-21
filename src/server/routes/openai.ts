import type { FastifyInstance } from "fastify"
import type { OpenAIChatCompletionRequest, Provider, ProviderConfig } from "../types.ts"
import { convertRequestToAnthropic } from "../converters/to-anthropic.ts"
import { convertResponseToOpenAI } from "../converters/resp-to-openai.ts"
import { streamAnthropicToOpenAI } from "../converters/stream-to-openai.ts"
import { extractOpenAIText, extractOpenAIResponseSummary, extractOpenAIContentTypes } from "../utils/extract-text.ts"
import { logRequestSummary, nextReqId } from "../utils/log-summary.ts"
import { emitEvent } from "../utils/event-bus.ts"
import { checkQuota, recordRpmRequest, recordUsage } from "../quota.ts"
import { createDisconnectSignal } from "../utils/disconnect.ts"

export async function openaiRoutes(fastify: FastifyInstance) {
  /** POST /v1/chat/completions — OpenAI Chat Completions API 入口 */
  fastify.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as OpenAIChatCompletionRequest
    const model = body.model
    if (!model) {
      return reply.status(400).send({
        error: { message: "model is required", type: "invalid_request_error" },
      })
    }
    if (!body.messages?.length) {
      return reply.status(400).send({
        error: { message: "messages is required and must be non-empty", type: "invalid_request_error" },
      })
    }
    const startTime = Date.now()
    console.log(`[openai] Received request for model: ${model}`)

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
    let fullMessageText = ""
    /** fallback 中间尝试记录 */
    const fallbackAttempts: { providerId: string; providerName: string; targetModel: string; statusCode: number; error: string }[] = []
    const isStream = body.stream ?? false
    const reqId = nextReqId()
    const auth = request.authContext

    /** 提取输入摘要：最后一条 user 消息 */
    const inputSummary = extractLastUserMessage(body) ?? model

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
    /** Anthropic→OpenAI 路径的工具调用回调（签名不同于 OpenAI 直传路径） */
    const collectAnthropicToolCall = (name: string, input: string) => {
      outputText += (outputText ? "\n" : "") + `[tool_call: ${name}(${input})]`
    }

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
          error: { message: quotaResult.reason!, type: "rate_limit_error", code: "rate_limit_exceeded" },
        })
      }
      recordRpmRequest(auth.keyId, auth.keyLimits.rpmLimit, auth.groupLimits.rpmLimit)
    }

    try {
      const messageText = extractOpenAIText(body)
      fullMessageText = messageText
      const contentTypes = extractOpenAIContentTypes(body)
      const { provider, targetModel: tm, providerConfig, rulePattern, fallbacks } = fastify.registry.resolve(model, { messageText, contentTypes, groupId: auth?.groupId })

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
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const { provider: currentProvider, providerConfig: currentConfig, targetModel: currentTarget } = candidates[attempt]!

        providerId = currentConfig.id
        targetModel = currentTarget
        providerName = currentConfig.name

        if (attempt > 0) {
          console.log(`[openai] Fallback #${attempt} → ${providerName} / ${targetModel}`)
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
          const result = await handleOpenAIUpstream(currentProvider, currentTarget, body, isStream, reply, collectStreamText, collectStreamToolCall, flushToolCalls, setStreamError, collectAnthropicToolCall, clientSignal)
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
          /** 请求失败，尝试下一个 fallback */
          statusCode = result.statusCode
          errorMsg = result.errorMsg
          fallbackAttempts.push({ providerId, providerName, targetModel, statusCode, error: result.errorMsg ?? "" })
          console.warn(`[openai] Provider "${providerName}" failed (${statusCode}): ${result.errorMsg}`)

          /** 429/408 允许 fallback 尝试其他 provider，其余 4xx 直接返回 */
          if (statusCode >= 400 && statusCode < 500 && statusCode !== 429 && statusCode !== 408) {
            reply.status(statusCode)
            return reply.send(convertErrorToOpenAI(result.errorMsg ?? "Upstream error", statusCode))
          }
        } catch (err) {
          /** handleOpenAIUpstream 抛出异常（如网络错误），释放信号量 */
          emitEvent({ type: "upstream_end", requestId: reqId, providerId })
          semaphore?.release()
          throw err
        }
      }

      /** 所有候选都失败了 */
      reply.status(statusCode || 502)
      return reply.send(convertErrorToOpenAI(errorMsg ?? "All providers failed", statusCode || 502))
    } catch (err) {
      const msg = (err as Error).message
      /** 网络级错误（超时、连接失败）返回 502 */
      const isNetworkError = msg.startsWith("Provider ") && (msg.includes("timed out") || msg.includes("connection failed") || msg.includes("aborted"))
      statusCode = isNetworkError ? 502 : 400
      errorMsg = msg
      return reply.status(statusCode).send({
        error: {
          message: errorMsg,
          type: isNetworkError ? "server_error" : "invalid_request_error",
        },
      })
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
        fallbackAttempts: fallbackAttempts.length > 0 ? JSON.stringify(fallbackAttempts) : null,
      })
      recordUsage(auth?.keyId ?? null, inputTokens + outputTokens)
      logRequestSummary({
        reqId, model, targetModel, provider: providerName, input: inputSummary,
        output: outputText, durationMs, stream: isStream, statusCode, error: errorMsg,
      })
    }
  })
}

/** 处理单个 OpenAI 上游请求，返回统一的结果对象 */
async function handleOpenAIUpstream(
  provider: Provider,
  targetModel: string,
  body: OpenAIChatCompletionRequest,
  isStream: boolean,
  reply: import("fastify").FastifyReply,
  onText: (text: string) => void,
  onToolCall: (idx: number, name: string | undefined, args: string | undefined) => void,
  flushToolCalls: () => void,
  onStreamError?: (err: string) => void,
  onAnthropicToolCall?: (name: string, input: string) => void,
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
  if (provider.type === "openai" || provider.type === "azure-openai" || provider.type === "custom") {
    /** OpenAI 兼容提供商 — 透传 */
    if (isStream) {
      const upstream = await provider.sendStreamRequest({ ...body, model: targetModel, stream_options: { include_usage: true } }, {}, signal)
      if (!upstream.ok) {
        const errBody = await upstream.text()
        return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      let iTokens = 0, oTokens = 0, crTokens = 0
      if (!upstream.body) {
        return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      reply.hijack()
      await streamPassthroughOpenAI(upstream.body, reply.raw, onText, onToolCall, flushToolCalls, (i, o, cr) => {
        iTokens = i
        oTokens = o
        crTokens = cr
      }, onStreamError, estimateOpenAIInputTokens(body))
      return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iTokens, outputTokens: oTokens, cacheCreationTokens: 0, cacheReadTokens: crTokens, outputText: null, streamHijacked: true }
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
    const respUsage = (resp as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage
    const iT = respUsage?.prompt_tokens ?? 0
    const oT = respUsage?.completion_tokens ?? 0
    /** OpenAI 兼容服务商的 prompt_tokens_details.cached_tokens 对应 cache read */
    const crT = respUsage?.prompt_tokens_details?.cached_tokens ?? 0
    const oText = extractOpenAIResponseSummary(resp)
    reply.send(resp)
    return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iT, outputTokens: oT, cacheCreationTokens: 0, cacheReadTokens: crT, outputText: oText }
  }

  /** Anthropic 提供商 — 转换格式 */
  const anthropicBody = convertRequestToAnthropic(body, targetModel)
  const upstreamHeaders: Record<string, string> = { "anthropic-version": "2023-06-01" }

  if (isStream) {
    const upstream = await provider.sendStreamRequest(anthropicBody as unknown as Record<string, unknown>, upstreamHeaders, signal)
    if (!upstream.ok) {
      const errBody = await upstream.text()
      return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    let iTokens = 0, oTokens = 0, ccTokens = 0, crTokens = 0
    if (!upstream.body) {
      return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    reply.hijack()
    await streamAnthropicToOpenAI(upstream.body, reply.raw, body.model, onText, onAnthropicToolCall ?? (() => {}), (i, o, cc, cr) => {
      iTokens = i
      oTokens = o
      ccTokens = cc
      crTokens = cr
    }, onStreamError)
    return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iTokens, outputTokens: oTokens, cacheCreationTokens: ccTokens, cacheReadTokens: crTokens, outputText: null, streamHijacked: true }
  }

  const upstream = await provider.sendRequest(anthropicBody as unknown as Record<string, unknown>, upstreamHeaders, signal)
  if (!upstream.ok) {
    const errBody = await upstream.text()
    return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }

  const respText = await upstream.text()
  if (!respText) {
    return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
  let anthropicResp: Record<string, unknown>
  try {
    anthropicResp = JSON.parse(respText) as Record<string, unknown>
  } catch {
    return { ok: false, statusCode: 502, errorMsg: `Invalid JSON response from upstream: ${respText.slice(0, 200)}`, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
  const anthroUsage = (anthropicResp as { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }).usage
  const iT = anthroUsage?.input_tokens ?? 0
  const oT = anthroUsage?.output_tokens ?? 0
  const ccT = anthroUsage?.cache_creation_input_tokens ?? 0
  const crT = anthroUsage?.cache_read_input_tokens ?? 0
  const converted = convertResponseToOpenAI(anthropicResp as unknown as import("../types.ts").AnthropicMessagesResponse)
  const oText = converted.choices?.[0]?.message?.content ?? ""
  reply.send(converted)
  return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iT, outputTokens: oT, cacheCreationTokens: ccT, cacheReadTokens: crT, outputText: oText }
  } catch (err) {
    /** 上游响应解析失败（如非 JSON 响应体），返回 502 */
    const msg = (err as Error).message ?? "Failed to parse upstream response"
    return { ok: false, statusCode: 502, errorMsg: msg, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
}

function streamPassthroughOpenAI(
  upstream: ReadableStream<Uint8Array>,
  raw: import("node:http").ServerResponse,
  onText?: (text: string) => void,
  onToolCall?: (idx: number, name: string | undefined, args: string | undefined) => void,
  onEnd?: () => void,
  onTokenUsage?: (inputTokens: number, outputTokens: number, cacheReadTokens: number) => void,
  onStreamError?: (err: string) => void,
  estimatedInputTokens?: number,
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
  /** SSE 行缓冲区，处理跨 chunk 的行分割 */
  let sseBuffer = ""
  /** 跟踪是否收到过 usage 报告（部分 provider 不支持 stream_options） */
  let hasUsageReport = false
  /** 手动计数 output delta 块数，作为无 usage 报告时的 fallback */
  let outputChunks = 0
  /** 是否收到过有效 SSE 事件（用于检测空流） */
  let hasReceivedEvent = false

  function pump(): Promise<void> {
    return reader.read().then(({ done, value }) => {
      if (done) {
        /** 空流检测：从未收到有效 SSE 事件，向上游报错 */
        if (!hasReceivedEvent) {
          const errMsg = "Empty response body from upstream"
          console.error(`[openai] ${errMsg}`)
          onStreamError?.(errMsg)
          if (raw.writable) {
            const errorData = JSON.stringify({ error: { message: errMsg, type: "server_error" } })
            raw.write(`data: ${errorData}\n\n`)
            raw.write("data: [DONE]\n\n")
          }
        } else if (!hasUsageReport && outputChunks > 0) {
          /** 如果上游未返回 usage（不支持 stream_options），用 delta 块计数作为近似 output token */
          onTokenUsage?.(estimatedInputTokens ?? 0, outputChunks, 0)
        }
        onEnd?.()
        raw.end()
        return
      }
      /** 客户端已断连，取消上游读取 */
      if (!raw.writable) {
        reader.cancel().catch(() => {})
        return
      }
      /**
       * 逐事件写入而非整个 chunk 透传（与 anthropic streamPassthrough 同理）。
       */
      sseBuffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      const lines = sseBuffer.split("\n")
      sseBuffer = lines.pop()!
      for (const line of lines) {
        raw.write(line + "\n")
        /** 空行 = SSE 事件结束边界，立即 flush */
        if (line === "") raw.flushHeaders()
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue
        try {
          const obj = JSON.parse(line.slice(6))
          if (!obj.id && !obj.choices?.length && !obj.usage) continue
          hasReceivedEvent = true
          const delta = obj.choices?.[0]?.delta
          if (delta?.content) { onText?.(delta.content); outputChunks++ }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              onToolCall?.(tc.index, tc.function?.name, tc.function?.arguments)
            }
          }
          if (obj.usage) {
            hasUsageReport = true
            onTokenUsage?.(obj.usage.prompt_tokens ?? 0, obj.usage.completion_tokens ?? 0, obj.usage.prompt_tokens_details?.cached_tokens ?? 0)
          }
        } catch { /* skip */ }
      }
      return pump()
    }).catch((err) => {
      /** 上游流式传输中断 */
      const errMsg = "Stream interrupted: " + (err as Error).message
      console.error(`[openai] Stream interrupted: ${(err as Error).message}`)
      onStreamError?.(errMsg)
      if (raw.writable) {
        const errorData = JSON.stringify({ error: { message: errMsg, type: "server_error" } })
        raw.write(`data: ${errorData}\n\n`)
        raw.write("data: [DONE]\n\n")
      }
      onEnd?.()
      if (raw.writable) raw.end()
      reader.cancel().catch(() => {})
    })
  }

  return pump()
}

/** 粗略估算 OpenAI 请求的 input token 数（chars / 4） */
function estimateOpenAIInputTokens(body: OpenAIChatCompletionRequest): number {
  let chars = 0
  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ("text" in part) chars += (part as { text: string }).text.length
      }
    }
  }
  return Math.ceil(chars / 4)
}

/** 提取最后一条 user 消息的文本 */
function extractLastUserMessage(body: OpenAIChatCompletionRequest): string | null {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const msg = body.messages[i]!
    if (msg.role !== "user") continue
    if (typeof msg.content === "string") return msg.content
    return msg.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && !!p.text)
      .map(p => p.text)
      .join(" ")
  }
  return null
}

/** 将上游错误转换为 OpenAI 格式的错误响应 */
function convertErrorToOpenAI(errorBody: string, status: number): { error: { message: string; type: string; code?: string } } {
  let message = errorBody
  try {
    const parsed = JSON.parse(errorBody)
    /** 已经是 OpenAI 格式 */
    if (parsed.error?.message) {
      message = parsed.error.message
    } else if (typeof parsed.error === "string") {
      message = parsed.error
    } else if (parsed.message) {
      message = parsed.message
    }
  } catch { /* keep original */ }

  if (status === 401) return { error: { message, type: "authentication_error", code: "invalid_api_key" } }
  if (status === 429) return { error: { message, type: "rate_limit_error", code: "rate_limit_exceeded" } }
  if (status === 404) return { error: { message, type: "invalid_request_error", code: "model_not_found" } }
  if (status >= 400 && status < 500) return { error: { message, type: "invalid_request_error" } }
  return { error: { message, type: "server_error", code: "upstream_error" } }
}