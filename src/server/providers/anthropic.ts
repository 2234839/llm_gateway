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

    /** 合并顺序：内置 < per-request < customHeaders（配置优先级最高，除 Content-Type 和认证 key 外） */
    const merged = { ...headers, ...extraHeaders, ...this.customHeaders }
    merged["Content-Type"] = "application/json"
    merged["x-api-key"] = this.apiKey
    return merged
  }

  async sendRequest(body: Record<string, unknown>, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`
    const timeoutSignal = AbortSignal.timeout(this.timeout)
    /** 组合超时 + 客户端断连信号（基于 socket.close，非 request.signal） */
    const fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(headers),
        body: JSON.stringify(body),
        signal: fetchSignal,
      })
      return resp
    } catch (err) {
      wrapNetworkError(err, this.id)
    }
  }

  async sendStreamRequest(body: Record<string, unknown>, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`
    const timeoutSignal = AbortSignal.timeout(this.timeout)
    const fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...this.buildHeaders(headers), "Accept-Encoding": "identity" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: fetchSignal,
        /** Bun 默认自动解压 gzip 响应，会缓冲 SSE chunk 导致流式输出"一次性出来" */
        decompress: false,
      } as RequestInit & { decompress: boolean })
      return resp
    } catch (err) {
      wrapNetworkError(err, this.id)
    }
  }
}
