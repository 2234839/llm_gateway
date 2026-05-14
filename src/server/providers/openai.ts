import type { Provider, ProviderType } from "../types.ts"

/** OpenAI 兼容提供商适配器 */
export class OpenAIProvider implements Provider {
  readonly id: string
  readonly type: ProviderType
  readonly baseUrl: string
  readonly apiKey: string
  readonly customHeaders: Record<string, string>

  constructor(
    id: string,
    type: ProviderType,
    baseUrl: string,
    apiKey: string,
    customHeaders?: Record<string, string>,
  ) {
    this.id = id
    this.type = type
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.apiKey = apiKey
    this.customHeaders = customHeaders ?? {}
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

    return { ...headers, ...this.customHeaders }
  }

  async sendRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this.buildHeaders(), ...headers },
      body: JSON.stringify(body),
    })
    return resp
  }

  async sendStreamRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this.buildHeaders(), ...headers },
      body: JSON.stringify({ ...body, stream: true }),
    })
    return resp
  }
}
