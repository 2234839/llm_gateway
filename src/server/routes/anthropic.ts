import type { FastifyInstance } from "fastify"
import type { AnthropicMessagesRequest, AnthropicErrorResponse, Provider, ProviderConfig, PendingLogImage } from "../types.ts"
import { convertRequestToOpenAI } from "../converters/to-openai.ts"
import { convertResponseToAnthropic } from "../converters/resp-to-anthropic.ts"
import { streamOpenAIToAnthropic } from "../converters/stream-to-anthropic.ts"
import { extractAnthropicText, extractAnthropicResponseSummary, extractAnthropicContentTypes } from "../utils/extract-text.ts"
import { estimateTokenCount } from "../providers/registry.ts"
import { logRequestSummary, nextReqId } from "../utils/log-summary.ts"
import { emitEvent } from "../utils/event-bus.ts"
import { acquireRpmSlot, checkQuota, recordRpmRequest, recordUsage } from "../quota.ts"
import { createDisconnectSignal } from "../utils/disconnect.ts"
import { withUpstreamRetry } from "../utils/retry.ts"
import { maskAnthropicBody, restoreObjectDeep, StreamRestorer, maskText } from "../utils/secret-vault.ts"
import { persistLogImages } from "../utils/log-images.ts"
import { applyThinkingOverride, extractThinkingSnapshot } from "../utils/thinking-override.ts"
import type { SecretEntry, ThinkingOverride, ThinkingLogEntry } from "../types.ts"

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

    /** 提取需要透传给上游的 headers（默认仅 User-Agent，provider 额外放行在 handleAnthropicUpstream 内合并） */
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
    /** 命中的内容改写规则名（JSON 数组），写入请求日志 */
    let matchedRewriteRules: string | null = null
    /** 内容改写产生的消息级差异（JSON RewriteDiff[]） */
    let rewriteDiffs: string | null = null
    /** 密钥保护条目（try 内加载，供出站脱敏与日志兜底脱敏） */
    let secretEntries: SecretEntry[] = []
    /** 命中路由规则的思考选项改写配置（转发给上游前应用于出站体） */
    let thinkingOverride: ThinkingOverride | undefined
    /** 思考参数快照：入站原始值 + 出站最终值，写入请求日志 */
    const thinkingLog: ThinkingLogEntry = { inbound: null, outbound: null, summary: null }
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

    try {
      const messageText = extractAnthropicText(body)
      const contentTypes = extractAnthropicContentTypes(body)
      const routeResult = fastify.registry.resolve(model, { messageText, contentTypes, groupId: auth?.groupId, clientProtocol: "anthropic", tokenCount: estimateTokenCount(messageText) + body.max_tokens })

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
                type: "error",
                error: { type: "rate_limit_error", message: quotaResult.reason! },
              } satisfies AnthropicErrorResponse)
            }
          } else {
            if (quotaResult.retryAfterMs) reply.header("Retry-After", Math.ceil(quotaResult.retryAfterMs / 1000))
            return reply.status(429).send({
              type: "error",
                error: { type: "rate_limit_error", message: quotaResult.reason! },
              } satisfies AnthropicErrorResponse)
          }
        } else {
          recordRpmRequest(auth.keyId, auth.keyLimits.rpmLimit, auth.groupLimits.rpmLimit)
        }
      }

      const { provider, targetModel: tm, providerConfig, rulePattern, fallbacks, fallbackOnClientError } = routeResult
      thinkingOverride = routeResult.routeRule?.thinkingOverride
      /** 记录客户端原始思考参数（协议转换前的入站体） */
      thinkingLog.inbound = extractThinkingSnapshot(body as unknown as Record<string, unknown>)

      /** 内容改写管道：改写前先留一份消息快照，改写后对比生成差异供日志展示 */
      {
        const rewriteRules = fastify.db.getRewriteRules()
        if (rewriteRules.length > 0) {
          const { rewriteAnthropic } = await import("../utils/rewrite-engine")
          const beforeMsgs = extractAnthropicMessages(body)
          const rr = rewriteAnthropic(body, rewriteRules, { path: "/v1/messages", model })
          if (rr.matched) {
            matchedRewriteRules = rr.matchedRules.length > 0 ? JSON.stringify(rr.matchedRules) : null
            const afterMsgs = extractAnthropicMessages(body)
            const diffs = beforeMsgs
              .map((m, i) => afterMsgs[i]?.content !== m.content ? { idx: i, role: m.role, before: m.content, after: afterMsgs[i]?.content ?? "" } : null)
              .filter(d => d !== null)
            rewriteDiffs = diffs.length > 0 ? JSON.stringify(diffs) : null
          }
        }
      }

      /** 密钥保护出站脱敏：真实密钥替换为占位符后再发给上游（日志记录的同样是脱敏后的 body） */
      secretEntries = fastify.db.getSecrets()
      if (secretEntries.some(sc => sc.enabled && sc.value)) {
        maskAnthropicBody(body, secretEntries)
      }

      /** 构建尝试列表：主 provider + fallbacks */
      const candidates: { provider: Provider; providerConfig: ProviderConfig; targetModel: string }[] = [
        { provider, providerConfig, targetModel: tm },
      ]
      for (const fb of fallbacks) {
        const fbProvider = fastify.registry.getProvider(fb.providerId, "anthropic")
        const fbConfig = fastify.registry.getProviderConfig(fb.providerId)
        if (fbProvider && fbConfig) {
          candidates.push({ provider: fbProvider, providerConfig: fbConfig, targetModel: fb.targetModel || tm })
        }
      }

      emitEvent({ type: "request_start", requestId: reqId, model, targetModel: tm, provider: providerConfig.name, providerId: providerConfig.id, input: inputSummary, rulePattern, keyName: auth?.keyName, groupName: auth?.groupName })

      /** 重试策略：429（retryQpmLimit）/ 529（retryOn529）/ 任意失败（retryAllFailures）时，不透传，在网关层等待后重试同一 provider */
      const retryOptions = {
        retryOn429: routeResult.routeRule?.retryQpmLimit === true,
        retryOn529: routeResult.routeRule?.retryOn529 === true,
        retryAllFailures: routeResult.routeRule?.retryAllFailures === true,
      }

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
        const { signal: clientSignal, cleanup: cleanupDisconnect } = createDisconnectSignal(request)
        try {
          await semaphore?.acquire(clientSignal)
        } catch {
          cleanupDisconnect()
          return
        }
        emitEvent({ type: "upstream_start", requestId: reqId, providerId, providerName: currentConfig.name })
        try {

          const result = await withUpstreamRetry(
            () => handleAnthropicUpstream(currentProvider, currentTarget, currentConfig, body, isStream, upstreamHeaders, reply, collectStreamText, collectStreamToolCall, setStreamError, clientSignal, secretEntries, thinkingOverride, (summary, outbound) => {
              thinkingLog.summary = summary
              thinkingLog.outbound = outbound
            }),
            retryOptions,
            clientSignal,
            providerName,
            reqId,
            providerId,
            "[anthropic]",
          )

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
            /** signal 已完成使命（fetch response 已返回），移除 socket close 监听器避免 keep-alive 复用下的泄漏 */
            cleanupDisconnect()
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

          /** 429/408 允许 fallback 尝试其他 provider，其余 4xx 直接返回（除非 fallbackOnClientError 启用） */
          if (!fallbackOnClientError && statusCode >= 400 && statusCode < 500 && statusCode !== 429 && statusCode !== 408) {
            cleanupDisconnect()
            reply.status(statusCode)
            return reply.send(convertErrorToAnthropic(result.errorMsg!, statusCode))
          }
        } catch (err) {
          /** handleAnthropicUpstream 抛出异常（如网络错误），释放信号量 */
          emitEvent({ type: "upstream_end", requestId: reqId, providerId })
          semaphore?.release()
          cleanupDisconnect()
          throw err
        }
        /** 本轮 fallback 结束（将进入下一个候选），清理本轮的断连监听器 */
        cleanupDisconnect()
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
      /** 消息块提取 + 图片附件收集（写日志时一次性完成） */
      const pendingImages: PendingLogImage[] = []
      const extractedMessages = extractAnthropicMessages(body, pendingImages)
      const logId = fastify.db.addLog({
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
        inputContent: null,
        inputMessagesForWrite: extractedMessages,
        /** 输出兜底脱敏：非流式转换路径的摘要提取自还原后对象，这里统一再脱敏一次，确保真实密钥不落日志 */
        outputContent: outputText ? maskText(outputText, secretEntries) || null : null,
        fallbackAttempts: fallbackAttempts.length > 0 ? JSON.stringify(fallbackAttempts) : null,
        matchedRewriteRules,
        rewriteDiffs,
        /** 思考参数快照：有入站值或发生了改写才记录 */
        thinkingLog: (thinkingLog.inbound !== null || thinkingLog.outbound !== null) ? JSON.stringify(thinkingLog) : null,
      })
      /** 图片压缩+落库为异步旁路：不阻塞响应返回；失败让它抛出（let it crash） */
      if (logId !== null && pendingImages.length > 0) void persistLogImages(fastify.db, logId, pendingImages)
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

/** 提取结构化消息数组（system 顶层字段 + messages + tools + 图片附件），供日志消息块去重存储与改写 diff 对比 */
function extractAnthropicMessages(body: AnthropicMessagesRequest, imagesOut?: PendingLogImage[]): { role: string; content: string }[] {
  const result: { role: string; content: string }[] = []
  const system = body.system
  if (typeof system === "string" && system) {
    result.push({ role: "system", content: system })
  } else if (Array.isArray(system)) {
    const text = system.filter(b => b.type === "text").map(b => b.text).join("\n")
    if (text) result.push({ role: "system", content: text })
  }
  /** 工具声明在协议中位于 system 之后、对话消息之前，展示保持同样顺序 */
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (tool.description) result.push({ role: `tool:${tool.name}`, content: tool.description })
    }
  }
  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content })
    } else if (Array.isArray(msg.content)) {
      /** 逐块提取：text/thinking/tool_use/tool_result/image 都记录，忠实还原对话内容 */
      const parts: string[] = []
      let hasImage = false
      for (const block of msg.content as { type: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean; source?: { type: string; media_type?: string; data?: string; url?: string } }[]) {
        if (block.type === "text" && block.text) {
          parts.push(block.text)
        } else if (block.type === "image" && block.source) {
          hasImage = true
          if (block.source.type === "base64" && block.source.media_type && block.source.data) {
            imagesOut?.push({ seq: result.length, mediaType: block.source.media_type, base64: block.source.data })
          } else if (block.source.type !== "base64" && block.source.url) {
            parts.push(`[image_url] ${block.source.url}`)
          }
        } else if (block.type === "thinking" && block.thinking) {
          parts.push(`[thinking] ${block.thinking} [/thinking]`)
        } else if (block.type === "tool_use") {
          parts.push(`[tool_call: ${block.name}(${JSON.stringify(block.input ?? {})})]`)
        } else if (block.type === "tool_result") {
          const inner = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? (block.content as { type: string; text?: string }[]).filter(b => b.type === "text" && b.text).map(b => b.text!).join("\n")
              : ""
          parts.push(`[tool_result${block.is_error ? " (error)" : ""}: ${inner}]`)
        }
      }
      if (parts.length || hasImage) result.push({ role: msg.role, content: parts.join("\n") })
    }
  }
  return result
}

/** 处理单个 Anthropic 上游请求，返回统一的结果对象 */
async function handleAnthropicUpstream(
  provider: Provider,
  targetModel: string,
  providerConfig: ProviderConfig,
  body: AnthropicMessagesRequest,
  isStream: boolean,
  upstreamHeaders: Record<string, string>,
  reply: import("fastify").FastifyReply,
  onText: (text: string) => void,
  onToolCall: (name: string, input: string) => void,
  onStreamError?: (err: string) => void,
  signal?: AbortSignal,
  /** 密钥保护条目：入站还原占位符 → 真实密钥（空数组 = 无保护，直通零开销） */
  secrets: SecretEntry[] = [],
  /** 命中路由规则的思考选项改写配置（应用于出站体） */
  thinkingOverride?: ThinkingOverride,
  /** 思考改写生效时的回调（携带摘要与出站快照，用于日志标记） */
  onThinkingRewrite?: (summary: string, outbound: Record<string, unknown> | null) => void,
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
    /** 合并 provider 额外放行的客户端 header */
    const finalUpstreamHeaders = mergeAllowedClientHeaders(upstreamHeaders, providerConfig.allowedClientHeaders, reply.request.headers)
    /** 兼容 Claude Code mid_conversation_system beta：
     *  若 provider 开启了 flattenMidSystem，将 messages 中的 system 消息转为 user
     *  注意：始终过滤掉 content 为空的 system 消息，避免 Anthropic API 拒绝 */
    const messages = body.messages.filter(m => {
      if (m.role !== "system") return true
      if (typeof m.content === "string") return m.content.trim().length > 0
      if (!Array.isArray(m.content) || m.content.length === 0) return false
      return m.content.some(b => b.type === "text" && b.text && b.text.trim().length > 0)
    })
    const sendBody: Record<string, unknown> = {
      ...body,
      model: targetModel,
      messages: providerConfig.flattenMidSystem && messages.some(m => m.role === "system")
        ? messages.map(m => m.role === "system" ? { ...m, role: "user" as const } : m)
        : messages,
    }
    /** 过滤掉空的顶层 system 字段 */
    if (body.system !== undefined) {
      const hasContent = typeof body.system === "string"
        ? body.system.trim().length > 0
        : Array.isArray(body.system) && body.system.some(b => b.type === "text" && b.text && b.text.trim().length > 0)
      if (!hasContent) {
        delete sendBody.system
      }
    }

    /** 思考选项改写：协议转换后的出站体统一覆盖/移除思考参数 */
    const thinkingResult = applyThinkingOverride(sendBody, thinkingOverride, "anthropic")
    if (thinkingResult?.applied) {
      onThinkingRewrite?.(thinkingResult.summary, extractThinkingSnapshot(sendBody))
    }

    /** Anthropic 直连 — 透传 */
    if (isStream) {
      const upstream = await provider.sendStreamRequest(sendBody, finalUpstreamHeaders, signal)
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
      await streamPassthrough(upstream.body, reply.raw, secrets, onText, onToolCall, (tu) => {
        iTokens = tu.inputTokens
        oTokens = tu.outputTokens
        ccTokens = tu.cacheCreationTokens
        crTokens = tu.cacheReadTokens
      }, onStreamError)
      return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iTokens, outputTokens: oTokens, cacheCreationTokens: ccTokens, cacheReadTokens: crTokens, outputText: null, streamHijacked: true }
    }

    const upstream = await provider.sendRequest(sendBody, finalUpstreamHeaders, signal)
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
    reply.send(restoreObjectDeep(respBody, secrets))
    return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iT, outputTokens: oT, cacheCreationTokens: ccT, cacheReadTokens: crT, outputText: oText }
  }

  /** openai-responses 端点：Anthropic 入口 → CC 中间格式 → Responses 发送，响应转回 Anthropic */
  if (provider.type === "openai-responses") {
    const { handleResponsesUpstreamFromAnthropic } = await import("./responses-internal.ts")
    return handleResponsesUpstreamFromAnthropic(provider, targetModel, providerConfig, body, isStream, reply, onText, onToolCall, onStreamError, signal, secrets, thinkingOverride, onThinkingRewrite)
  }

  /** 非 Anthropic 提供商 — 转换格式 */
  const openaiBody = convertRequestToOpenAI(body, targetModel, { flattenMidSystem: providerConfig.flattenMidSystem })
  /** 思考选项改写：协议转换后的出站体统一覆盖/移除思考参数 */
  const thinkingResult = applyThinkingOverride(openaiBody as unknown as Record<string, unknown>, thinkingOverride, "openai")
  if (thinkingResult?.applied) {
    onThinkingRewrite?.(thinkingResult.summary, extractThinkingSnapshot(openaiBody as unknown as Record<string, unknown>))
  }

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
    }, onStreamError, secrets)
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
    restoreObjectDeep(openaiResp, secrets) as unknown as import("../types.ts").OpenAIChatCompletionResponse,
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
  secrets: SecretEntry[],
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
  /** 密钥还原器：文本/thinking 共用一个，每个工具调用独立一个（写往客户端的内容还原，日志回调仍是占位符版） */
  const textRestorer = new StreamRestorer(secrets)
  let argsRestorer = new StreamRestorer(secrets)
  /** 当前内容块类型（content_block_stop 时按块类型刷对应还原器的尾巴） */
  const blockState: { type: string | null } = { type: null }
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
        /** 密钥还原：data 行中的 delta 文本字段做占位符 → 真实密钥替换（有保护时才解析重写） */
        const outLines = rewriteAnthropicSSELine(line, textRestorer, argsRestorer, () => { argsRestorer = new StreamRestorer(secrets) }, blockState)
        for (const ol of outLines) raw.write(ol + "\n")
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

/**
 * 密钥还原：对 Anthropic SSE data 行做事件级改写。
 * - text_delta / thinking_delta：过文本还原器后重写
 * - input_json_delta：过当前工具参数还原器后重写
 * - content_block_start(tool_use)：重置工具参数还原器
 * - content_block_stop：还原器尾巴以补发的 delta 事件形式刷出
 * 返回实际要写出的行（无修改时返回原行）。
 */
function rewriteAnthropicSSELine(line: string, textRestorer: StreamRestorer, argsRestorer: StreamRestorer, resetArgsRestorer: () => void, blockState: { type: string | null }): string[] {
  if (!line.startsWith("data:")) return [line]
  if (!textRestorer.enabled) return [line]
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line.slice(5).trim()) as Record<string, unknown>
  } catch {
    return [line]
  }
  const type = obj.type
  if (type === "content_block_start") {
    const cb = obj.content_block as { type?: string } | undefined
    blockState.type = cb?.type ?? null
    if (cb?.type === "tool_use") resetArgsRestorer()
    return [line]
  }
  if (type === "content_block_delta") {
    const delta = obj.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined
    if (!delta) return [line]
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      const restored = textRestorer.feed(delta.text)
      if (restored === delta.text) return [line]
      delta.text = restored
      return [`data: ${JSON.stringify(obj)}`]
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      const restored = textRestorer.feed(delta.thinking)
      if (restored === delta.thinking) return [line]
      delta.thinking = restored
      return [`data: ${JSON.stringify(obj)}`]
    }
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      const restored = argsRestorer.feed(delta.partial_json)
      if (restored === delta.partial_json) return [line]
      delta.partial_json = restored
      return [`data: ${JSON.stringify(obj)}`]
    }
    return [line]
  }
  if (type === "content_block_stop") {
    /** 关块前刷出还原器中可能滞留的尾部（占位符被切断但最终未匹配的场景），按块类型发对应 delta */
    const out: string[] = []
    if (blockState.type === "tool_use") {
      const argsTail = argsRestorer.flush()
      if (argsTail) {
        out.push(`data: ${JSON.stringify({ type: "content_block_delta", index: obj.index, delta: { type: "input_json_delta", partial_json: argsTail } })}`)
      }
    } else {
      const textTail = textRestorer.flush()
      if (textTail) {
        out.push(`data: ${JSON.stringify({ type: "content_block_delta", index: obj.index, delta: blockState.type === "thinking" ? { type: "thinking_delta", thinking: textTail } : { type: "text_delta", text: textTail } })}`)
      }
    }
    blockState.type = null
    out.push(line)
    return out
  }
  return [line]
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


/** 从客户端请求头中提取兼容的 headers，避免把网关/代理头转发给上游。 */
function extractClientHeaders(headers: import("fastify").FastifyRequest["headers"]): Record<string, string> {
  const result: Record<string, string> = {}
  const allowedHeaders = new Set(["user-agent"])
  for (const [key, value] of Object.entries(headers)) {
    if (!allowedHeaders.has(key.toLowerCase())) continue
    if (!value) continue
    if (typeof value === "string") {
      result[key] = value
    } else if (Array.isArray(value)) {
      result[key] = value.join(", ")
    }
  }
  return result
}

/** 将 provider 额外放行的客户端 header 补进已提取的透传列表 */
function mergeAllowedClientHeaders(base: Record<string, string>, allowed: string[] | undefined, requestHeaders: import("fastify").FastifyRequest["headers"]): Record<string, string> {
  if (!allowed || allowed.length === 0) return base
  const merged = { ...base }
  for (const name of allowed) {
    const value = requestHeaders[name.toLowerCase() as keyof typeof requestHeaders]
    if (typeof value === "string") merged[name] = value
    else if (Array.isArray(value)) merged[name] = value.join(", ")
  }
  return merged
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
