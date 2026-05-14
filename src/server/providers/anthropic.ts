import type { Provider } from "../types.ts"

/** Anthropic 直连适配器 — 透传，不转换 */
export class AnthropicProvider implements Provider {
  readonly id: string
  readonly type = "anthropic" as const
  readonly baseUrl: string
  readonly apiKey: string
  readonly customHeaders: Record<string, string>

  constructor(
    id: string,
    baseUrl: string,
    apiKey: string,
    customHeaders?: Record<string, string>,
  ) {
    this.id = id
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.apiKey = apiKey
    this.customHeaders = customHeaders ?? {}
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

    return { ...headers, ...this.customHeaders }
  }

  async sendRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`
    const resp = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(headers),
      body: JSON.stringify(body),
    })
    return resp
  }

  async sendStreamRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    const url = `${this.baseUrl}/v1/messages`
    const resp = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(headers),
      body: JSON.stringify({ ...body, stream: true }),
    })
    return resp
  }
}
