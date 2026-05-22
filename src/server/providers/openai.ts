import type { Provider, ProviderType } from "../types.ts"
import { DEFAULT_TIMEOUT, wrapNetworkError } from "./provider-utils.ts"

/** OpenAI 兼容提供商适配器 */
export class OpenAIProvider implements Provider {
  readonly id: string
  readonly type: ProviderType
  readonly baseUrl: string
  readonly apiKey: string
  readonly customHeaders: Record<string, string>
  /** 请求超时毫秒数 */
  readonly timeout: number

  constructor(
    id: string,
    type: ProviderType,
    baseUrl: string,
    apiKey: string,
    customHeaders?: Record<string, string>,
    timeout?: number,
  ) {
    this.id = id
    this.type = type
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.apiKey = apiKey
    this.customHeaders = customHeaders ?? {}
    this.timeout = timeout && timeout > 0 ? timeout : DEFAULT_TIMEOUT
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }

    if (this.type === "azure-openai") {
      headers["api-key"] = this.apiKey
    } else {
      headers["Authorization"] = `Bearer ${this.apiKey}`
    }

    /** 合并 customHeaders，但保护认证和 Content-Type 不被覆盖 */
    const merged = { ...headers, ...this.customHeaders }
    merged["Content-Type"] = "application/json"
    if (this.type === "azure-openai") {
      merged["api-key"] = this.apiKey
    } else {
      merged["Authorization"] = `Bearer ${this.apiKey}`
    }
    return merged
  }

  async sendRequest(body: Record<string, unknown>, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`
    /** 合并顺序：内置 < per-request < customHeaders（配置优先级最高）< 强制保护字段 */
    const finalHeaders = { ...this.buildHeaders(), ...headers, ...this.customHeaders }
    finalHeaders["Content-Type"] = "application/json"
    if (this.type === "azure-openai") {
      finalHeaders["api-key"] = this.apiKey
    } else {
      finalHeaders["Authorization"] = `Bearer ${this.apiKey}`
    }
    const timeoutSignal = AbortSignal.timeout(this.timeout)
    /** 组合超时 + 客户端断连信号（基于 socket.close，非 request.signal） */
    const fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: finalHeaders,
        body: JSON.stringify(body),
        signal: fetchSignal,
      })
      return resp
    } catch (err) {
      wrapNetworkError(err, this.id)
    }
  }

  async sendStreamRequest(body: Record<string, unknown>, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`
    /** 合并顺序：内置 < per-request < customHeaders（配置优先级最高）< 强制保护字段 */
    const finalHeaders = { ...this.buildHeaders(), ...headers, ...this.customHeaders }
    finalHeaders["Content-Type"] = "application/json"
    if (this.type === "azure-openai") {
      finalHeaders["api-key"] = this.apiKey
    } else {
      finalHeaders["Authorization"] = `Bearer ${this.apiKey}`
    }
    const timeoutSignal = AbortSignal.timeout(this.timeout)
    const fetchSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...finalHeaders, "Accept-Encoding": "identity" },
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
