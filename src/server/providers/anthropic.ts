import type { Provider } from "../types.ts"
import { DEFAULT_TIMEOUT, wrapNetworkError } from "./provider-utils.ts"

/** Anthropic 直连适配器 — 透传，不转换 */
export class AnthropicProvider implements Provider {
  readonly id: string
  readonly type = "anthropic" as const
  readonly baseUrl: string
  readonly apiKey: string
  readonly customHeaders: Record<string, string>
  /** 请求超时毫秒数 */
  readonly timeout: number

  constructor(
    id: string,
    baseUrl: string,
    apiKey: string,
    customHeaders?: Record<string, string>,
    timeout?: number,
  ) {
    this.id = id
    this.baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")
    this.apiKey = apiKey
    this.customHeaders = customHeaders ?? {}
    this.timeout = timeout && timeout > 0 ? timeout : DEFAULT_TIMEOUT
  }

  private buildHeaders(extraHeaders: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": extraHeaders["anthropic-version"] || "2023-06-01",
    }

    /** 透传 beta header */
    if (extraHeaders["anthropic-beta"]) {
      headers["anthropic-beta"] = extraHeaders["anthropic-beta"]
    }

    /** 合并顺序：内置 < customHeaders < per-request（除 Content-Type 和认证 key 不被覆盖） */
    const merged = { ...headers, ...this.customHeaders, ...extraHeaders }
    merged["Content-Type"] = "application/json"
    merged["x-api-key"] = this.apiKey
    return merged
  }

  async sendRequest(body: Record<string, unknown>, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`
    const signals: AbortSignal[] = [AbortSignal.timeout(this.timeout)]
    if (signal) signals.push(signal)
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(headers),
        body: JSON.stringify(body),
        signal: AbortSignal.any(signals),
      })
      return resp
    } catch (err) {
      wrapNetworkError(err, this.id)
    }
  }

  async sendStreamRequest(body: Record<string, unknown>, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`
    /** 流式请求：timeout 仅应用于获取初始响应（headers），不覆盖整个流生命周期 */
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)
    /** 外部 signal（客户端断连）同时中断 fetch */
    const onSignalAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
      }
      signal.addEventListener("abort", onSignalAbort, { once: true })
    }
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...this.buildHeaders(headers), "Accept-Encoding": "identity" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: controller.signal,
        /** Bun 默认自动解压 gzip 响应，会缓冲 SSE chunk 导致流式输出"一次性出来" */
        decompress: false,
      } as RequestInit & { decompress: boolean })
      clearTimeout(timer)
      signal?.removeEventListener("abort", onSignalAbort)
      return resp
    } catch (err) {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onSignalAbort)
      wrapNetworkError(err, this.id)
    }
  }
}
