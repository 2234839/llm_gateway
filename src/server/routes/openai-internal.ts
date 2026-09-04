import type { OpenAIChatCompletionRequest, OpenAIResponsesRequest, Provider, ProviderConfig, SecretEntry } from "../types.ts"
import { convertResponseToOpenAI } from "../converters/resp-to-openai.ts"
import { convertChatToResponses } from "../converters/chat-to-responses.ts"
import { streamChatToResponses } from "../converters/stream-chat-to-responses.ts"
import { convertRequestToAnthropic } from "../converters/to-anthropic.ts"
import { restoreObjectDeep } from "../utils/secret-vault.ts"

/**
 * Responses 入口的跨协议上游处理：
 * Chat Completions 中间格式 → openai 兼容端点（直通）/ anthropic 端点（转换）→ 转回 Responses 输出给客户端
 */
export async function handleOpenAIUpstreamForResponses(
  provider: Provider,
  providerConfig: ProviderConfig,
  targetModel: string,
  chatBody: OpenAIChatCompletionRequest,
  originalBody: OpenAIResponsesRequest,
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
    if (provider.type === "openai" || provider.type === "azure-openai" || provider.type === "custom") {
      /** OpenAI 兼容端点 — CC 直通请求，响应转回 Responses */
      if (isStream) {
        const upstream = await provider.sendStreamRequest({ ...chatBody, model: targetModel, stream_options: { include_usage: true } }, {}, signal)
        if (!upstream.ok) {
          const errBody = await upstream.text()
          return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
        }
        if (!upstream.body) {
          return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
        }
        reply.hijack()
        let iTokens = 0, oTokens = 0, crTokens = 0
        await streamChatToResponses(upstream.body, reply.raw, originalBody.model, onText, undefined, (i, o, cr) => { iTokens = i; oTokens = o; crTokens = cr }, onStreamError, secrets)
        return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iTokens, outputTokens: oTokens, cacheCreationTokens: 0, cacheReadTokens: crTokens, outputText: null, streamHijacked: true }
      }

      const upstream = await provider.sendRequest({ ...chatBody, model: targetModel }, {}, signal)
      if (!upstream.ok) {
        const errBody = await upstream.text()
        return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      const respText = await upstream.text()
      if (!respText) {
        return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      let ccResp: Record<string, unknown>
      try {
        ccResp = JSON.parse(respText) as Record<string, unknown>
      } catch {
        return { ok: false, statusCode: 502, errorMsg: `Invalid JSON response from upstream: ${respText.slice(0, 200)}`, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      const usage = (ccResp as { usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }).usage
      const converted = convertChatToResponses(restoreObjectDeep(ccResp, secrets) as unknown as import("../types.ts").OpenAIChatCompletionResponse, originalBody.model)
      const oText = extractResponsesTextFromResponse(converted)
      reply.send(converted)
      return { ok: true, statusCode: 200, errorMsg: null, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0, cacheCreationTokens: 0, cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0, outputText: oText }
    }

    /** Anthropic 端点 — CC → Anthropic 转换，响应转回 Responses */
    const anthropicBody = convertRequestToAnthropic(chatBody, targetModel)
    const upstreamHeaders: Record<string, string> = { "anthropic-version": "2023-06-01" }
    const reqHeaders = reply.request.headers
    if (reqHeaders["user-agent"]) upstreamHeaders["User-Agent"] = reqHeaders["user-agent"] as string

    if (isStream) {
      const upstream = await provider.sendStreamRequest(anthropicBody as unknown as Record<string, unknown>, upstreamHeaders, signal)
      if (!upstream.ok) {
        const errBody = await upstream.text()
        return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      if (!upstream.body) {
        return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      reply.hijack()
      /** Anthropic SSE → 先转 CC SSE 再转 Responses SSE 的两段转换成本高；
       *  直接复用 streamAnthropicToOpenAI 的回调提取文本，再以 Responses 事件序列输出 */
      const { streamAnthropicToResponsesDirect } = await import("../converters/stream-anthropic-to-responses.ts")
      let iTokens = 0, oTokens = 0, ccTokens = 0, crTokens = 0
      await streamAnthropicToResponsesDirect(upstream.body, reply.raw, originalBody.model, onText, (i, o, cc, cr) => { iTokens = i; oTokens = o; ccTokens = cc; crTokens = cr }, onStreamError, secrets)
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
    const ccConverted = convertResponseToOpenAI(restoreObjectDeep(anthropicResp, secrets) as unknown as import("../types.ts").AnthropicMessagesResponse)
    const converted = convertChatToResponses(ccConverted, originalBody.model)
    const oText = extractResponsesTextFromResponse(converted)
    reply.send(converted)
    return { ok: true, statusCode: 200, errorMsg: null, inputTokens: anthroUsage?.input_tokens ?? 0, outputTokens: anthroUsage?.output_tokens ?? 0, cacheCreationTokens: anthroUsage?.cache_creation_input_tokens ?? 0, cacheReadTokens: anthroUsage?.cache_read_input_tokens ?? 0, outputText: oText }
  } catch (err) {
    const msg = (err as Error).message ?? "Failed to parse upstream response"
    return { ok: false, statusCode: 502, errorMsg: msg, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
}

/** 从 Responses 响应对象提取输出文本（日志用） */
function extractResponsesTextFromResponse(resp: import("../types.ts").OpenAIResponsesResponse): string {
  const parts: string[] = []
  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text" && c.text) parts.push(c.text)
      }
    } else if (item.type === "reasoning") {
      for (const s of item.summary ?? []) {
        if (s.type === "summary_text" && s.text) parts.push(`[thinking] ${s.text} [/thinking]`)
      }
    } else if (item.type === "function_call") {
      parts.push(`[tool_call: ${item.name}(${item.arguments})]`)
    }
  }
  return parts.join("\n")
}
