const BASE = ""

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body != null
  const headers: Record<string, string> = {}
  if (hasBody) headers["Content-Type"] = "application/json"
  const resp = await fetch(`${BASE}${path}`, { ...options, headers })
  if (resp.status === 204) return null as T
  return resp.json()
}

export interface ProviderInfo {
  id: string
  name: string
  type: "openai" | "anthropic" | "azure-openai" | "custom"
  baseUrl: string
  apiKey: string
  models: string[]
  enabled: boolean
  customHeaders?: Record<string, string>
  maxConcurrency?: number
}

/** 内容匹配条件 */
export interface ContentMatchCondition {
  /** 匹配类型：keyword 纯文本包含，regex 正则匹配，content_type 多模态内容存在性检测 */
  type: "keyword" | "regex" | "content_type"
  /** keyword 时为纯文本，regex 时为正则表达式，content_type 时为模态名称 (image/file/tool_use) */
  pattern: string
  /** 多条件间的逻辑关系，默认 and */
  operator?: "and" | "or"
  /** 正则标志位，如 i */
  flags?: string
}

export interface RouteRuleInfo {
  id: string
  pattern: string
  providerId: string
  /** 转发给上游的目标模型名 */
  targetModel?: string
  modelMapping?: Record<string, string>
  priority: number
  /** 内容匹配条件组，不存在则仅按模型名匹配 */
  contentMatch?: ContentMatchCondition[]
}

export interface LogEntry {
  id: number
  timestamp: string
  method: string
  path: string
  model: string
  providerId: string
  targetModel: string
  stream: boolean
  statusCode: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  error: string | null
}

export interface HealthInfo {
  status: string
  uptime: number
  port: number
  providers: { total: number; enabled: number }
  routeRules: number
  requests: { total: number; today: number }
  requestsByProvider: { providerId: string; providerName: string; total: number; today: number }[]
  requestsByModel: { model: string; targetModel: string; total: number; today: number }[]
}

export interface ProviderTestResult {
  success: boolean
  statusCode: number
  duration: number
  error?: string
}

export const providerApi = {
  list: () => api<ProviderInfo[]>("/admin/providers"),
  create: (data: Omit<ProviderInfo, "id">) => api<ProviderInfo>("/admin/providers", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<ProviderInfo>) => api<ProviderInfo>(`/admin/providers/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id: string) => api<void>(`/admin/providers/${id}`, { method: "DELETE" }),
  test: (data: { baseUrl: string; apiKey: string; type: string; customHeaders?: Record<string, string> }) =>
    api<ProviderTestResult>("/admin/providers/test", { method: "POST", body: JSON.stringify(data) }),
}

export const routeApi = {
  list: () => api<RouteRuleInfo[]>("/admin/routes"),
  create: (data: Omit<RouteRuleInfo, "id">) => api<RouteRuleInfo>("/admin/routes", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<RouteRuleInfo>) => api<RouteRuleInfo>(`/admin/routes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id: string) => api<void>(`/admin/routes/${id}`, { method: "DELETE" }),
}

export const logApi = {
  list: (options?: { limit?: number; offset?: number; model?: string }) => {
    const params = new URLSearchParams()
    if (options?.limit) params.set("limit", String(options.limit))
    if (options?.offset) params.set("offset", String(options.offset))
    if (options?.model) params.set("model", options.model)
    return api<LogEntry[]>(`/admin/logs?${params}`)
  },
  stats: () => api<{ total: number; today: number }>("/admin/stats"),
}

export const healthApi = {
  get: () => api<HealthInfo>("/health"),
}
