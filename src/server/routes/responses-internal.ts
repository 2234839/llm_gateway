import type { OpenAIChatCompletionRequest, Provider, ProviderConfig, SecretEntry, AnthropicMessagesRequest, ThinkingOverride } from "../types.ts"
import { convertChatToResponsesRequest } from "../converters/chat-to-responses-req.ts"
import { convertResponsesToChatResponse } from "../converters/responses-to-chat-resp.ts"
import { streamResponsesToChat } from "../converters/stream-responses-to-chat.ts"
import { convertRequestToOpenAI } from "../converters/to-openai.ts"
import { convertResponseToAnthropic } from "../converters/resp-to-anthropic.ts"
import { streamResponsesToAnthropic } from "../converters/stream-responses-to-anthropic.ts"
import { restoreObjectDeep } from "../utils/secret-vault.ts"
import { applyThinkingOverride } from "../utils/thinking-override.ts"

/** 上游处理结果（与 handleOpenAIUpstream 返回结构一致） */
type UpstreamResult = {
  ok: boolean
  statusCode: number
  errorMsg: string | null
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  outputText: string | null
  streamHijacked?: boolean
}

/**
 * Chat Completions 入口的 openai-responses 上游处理：
 * CC 请求先转 Responses 发送，响应再转回 CC 格式
 */
export async function handleResponsesUpstreamFromChat(
  provider: Provider,
  _providerConfig: ProviderConfig,
  targetModel: string,
  body: OpenAIChatCompletionRequest,
  isStream: boolean,
  reply: import("fastify").FastifyReply,
  onText: (text: string) => void,
  onToolCall?: (idx: number, name: string | undefined, args: string | undefined) => void,
  flushToolCalls?: () => void,
  onStreamError?: (err: string) => void,
  signal?: AbortSignal,
  secrets: SecretEntry[] = [],
): Promise<UpstreamResult> {
  try {
    const responsesBody = convertChatToResponsesRequest(body, targetModel)
    if (isStream) {
      const upstream = await provider.sendStreamRequest(responsesBody, {}, signal)
      if (!upstream.ok) {
        const errBody = await upstream.text()
        return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      if (!upstream.body) {
        return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      reply.hijack()
      let iTokens = 0
      let oTokens = 0
      let crTokens = 0
      await streamResponsesToChat(upstream.body, reply.raw, secrets, body.model ?? targetModel, onText, (name, args) => onToolCall?.(-1, name, args), (i, o, cr) => { iTokens = i; oTokens = o; crTokens = cr }, onStreamError)
      flushToolCalls?.()
      return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iTokens, outputTokens: oTokens, cacheCreationTokens: 0, cacheReadTokens: crTokens, outputText: null, streamHijacked: true }
    }
    const upstream = await provider.sendRequest(responsesBody, {}, signal)
    if (!upstream.ok) {
      const errBody = await upstream.text()
      forwardUpstreamHeaders(upstream.headers, reply)
      return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    const respText = await upstream.text()
    if (!respText) {
      return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    let responsesResp: Record<string, unknown>
    try {
      responsesResp = JSON.parse(respText) as Record<string, unknown>
    } catch {
      return { ok: false, statusCode: 502, errorMsg: "Invalid JSON response from upstream: " + respText.slice(0, 200), inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    const usage = (responsesResp as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }).usage
    const ccResp = convertResponsesToChatResponse(restoreObjectDeep(responsesResp, secrets) as unknown as import("../types.ts").OpenAIResponsesResponse, body.model ?? targetModel)
    const oText = extractCCSummary(ccResp)
    reply.send(ccResp)
    return { ok: true, statusCode: 200, errorMsg: null, outputText: oText, inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, cacheCreationTokens: 0, cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0 }
  } catch (err) {
    const msg = (err as Error).message ?? "Failed to parse upstream response"
    return { ok: false, statusCode: 502, errorMsg: msg, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
}

/** 转发上游响应 headers（限流信息等） */
function forwardUpstreamHeaders(headers: Headers, reply: import("fastify").FastifyReply) {
  const passthrough = ["x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]
  for (const key of passthrough) {
    const val = headers.get(key)
    if (val) reply.header(key, val)
  }
}

/**
 * Anthropic 入口的 openai-responses 上游处理：
 * Anthropic 请求 → CC → Responses 发送，响应/SSE 转回 Anthropic 格式
 */
export async function handleResponsesUpstreamFromAnthropic(
  provider: Provider,
  targetModel: string,
  providerConfig: ProviderConfig,
  body: AnthropicMessagesRequest,
  isStream: boolean,
  reply: import("fastify").FastifyReply,
  onText: (text: string) => void,
  onToolCall: (name: string, input: string) => void,
  onStreamError?: (err: string) => void,
  signal?: AbortSignal,
  secrets: SecretEntry[] = [],
  thinkingOverride?: ThinkingOverride,
  onThinkingRewrite?: (summary: string, outbound: Record<string, unknown> | null) => void,
): Promise<UpstreamResult> {
  try {
    /** Anthropic → CC → Responses 两段转换 */
    const ccBody = convertRequestToOpenAI(body, targetModel, { flattenMidSystem: providerConfig.flattenMidSystem })
    const thinkingResult = applyThinkingOverride(ccBody as unknown as Record<string, unknown>, thinkingOverride, "openai")
    if (thinkingResult?.applied) {
      onThinkingRewrite?.(thinkingResult.summary, null)
    }
    const responsesBody = convertChatToResponsesRequest(ccBody, targetModel)

    if (isStream) {
      const upstream = await provider.sendStreamRequest(responsesBody, {}, signal)
      if (!upstream.ok) {
        const errBody = await upstream.text()
        return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      if (!upstream.body) {
        return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
      }
      reply.hijack()
      const iTokens = estimateInputTokensOf(body)
      let oTokens = 0
      let crTokens = 0
      await streamResponsesToAnthropic(upstream.body, reply.raw, body.model, iTokens, onText, onToolCall, (i, o, cr) => { oTokens = o; crTokens = cr }, onStreamError, secrets)
      return { ok: true, statusCode: 200, errorMsg: null, inputTokens: iTokens, outputTokens: oTokens, cacheCreationTokens: 0, cacheReadTokens: crTokens, outputText: null, streamHijacked: true }
    }

    const upstream = await provider.sendRequest(responsesBody, {}, signal)
    if (!upstream.ok) {
      const errBody = await upstream.text()
      forwardUpstreamHeaders(upstream.headers, reply)
      return { ok: false, statusCode: upstream.status, errorMsg: errBody, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    const respText = await upstream.text()
    if (!respText) {
      return { ok: false, statusCode: 502, errorMsg: "Empty response body from upstream", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    let responsesResp: Record<string, unknown>
    try {
      responsesResp = JSON.parse(respText) as Record<string, unknown>
    } catch {
      return { ok: false, statusCode: 502, errorMsg: "Invalid JSON response from upstream: " + respText.slice(0, 200), inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
    }
    const usage = (responsesResp as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }).usage
    const ccResp = convertResponsesToChatResponse(restoreObjectDeep(responsesResp, secrets) as unknown as import("../types.ts").OpenAIResponsesResponse, body.model)
    const anthropicResp = convertResponseToAnthropic(ccResp, body.model)
    const oText = anthropicResp.content
      ?.map(b => {
        if (b.type === "text") return b.text
        if (b.type === "tool_use") return "[tool_call: " + b.name + "(" + JSON.stringify(b.input) + ")]"
        return ""
      })
      .filter(Boolean)
      .join("\n") ?? ""
    reply.send(anthropicResp)
    return { ok: true, statusCode: 200, errorMsg: null, inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0, cacheCreationTokens: 0, cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0, outputText: oText }
  } catch (err) {
    const msg = (err as Error).message ?? "Failed to parse upstream response"
    return { ok: false, statusCode: 502, errorMsg: msg, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputText: null }
  }
}

/** 估算 Anthropic 请求的输入 token 数（与 anthropic.ts 的 estimateInputTokens 一致逻辑） */
function estimateInputTokensOf(body: AnthropicMessagesRequest): number {
  let total = 0
  for (const msg of body.messages ?? []) {
    if (typeof msg.content === "string") {
      total += Math.ceil(msg.content.length / 4)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") total += Math.ceil((block.text?.length ?? 0) / 4)
      }
    }
  }
  if (typeof body.system === "string") total += Math.ceil(body.system.length / 4)
  else if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block.type === "text") total += Math.ceil((block.text?.length ?? 0) / 4)
    }
  }
  return total
}

/** 提取 CC 响应文本（日志用） */
function extractCCSummary(ccResp: import("../types.ts").OpenAIChatCompletionResponse): string {
  const parts: string[] = []
  for (const choice of ccResp.choices ?? []) {
    if (choice.message?.content) parts.push(String(choice.message.content))
    for (const tc of choice.message?.tool_calls ?? []) {
      parts.push("[tool_call: " + tc.function.name + "(" + tc.function.arguments + ")]")
    }
  }
  return parts.join("\n")
}
