const BASE = ""

/** 管理端 API 请求超时 30 秒 */
const API_TIMEOUT = 30_000

/** 全局 401 回调：session 过期时由 App.vue 注册跳转逻辑 */
let onAuthError: (() => void) | null = null

export function setOnAuthError(cb: (() => void) | null) {
  onAuthError = cb
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const hasBody = options?.body != null
  const headers: Record<string, string> = {}
  if (hasBody) headers["Content-Type"] = "application/json"
  const resp = await fetch(`${BASE}${path}`, { ...options, headers, signal: options?.signal ?? AbortSignal.timeout(API_TIMEOUT) })
  if (resp.status === 204) return null as T
  if (resp.status === 401) {
    onAuthError?.()
    throw new ApiAuthError()
  }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({ error: "Request failed" }))
    throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`)
  }
  return resp.json()
}

/** 认证失效错误，前端据此跳转登录页 */
export class ApiAuthError extends Error {
  constructor() {
    super("Authentication required")
    this.name = "ApiAuthError"
  }
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
  requestTimeout?: number
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

/** 路由规则的故障转移备选 */
export interface RouteFallback {
  providerId: string
  /** 转发目标模型名，不填则用主规则的 targetModel 或原始模型名 */
  targetModel?: string
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
  /** 排除条件组，匹配成功时跳过此规则 */
  excludeMatch?: ContentMatchCondition[]
  /** 是否启用，默认 true */
  enabled?: boolean
  /** 匹配的密钥分组 ID 列表 */
  keyGroups?: string[]
  /** 故障转移备选提供商列表，主 Provider 失败时按顺序尝试 */
  fallbacks?: RouteFallback[]
}

/** Token 用量统计 */
export interface TokenStats {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface LogEntry {
  id: number
  timestamp: string
  method: string
  path: string
  model: string
  providerId: string
  providerName: string
  targetModel: string
  stream: boolean
  statusCode: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  error: string | null
  inputContent: string | null
  outputContent: string | null
  apiKeyId: string | null
  groupId: string | null
  keyName: string | null
  groupName: string | null
  fallbackAttempts: string | null
}

export interface HealthInfo {
  status: string
  version: string
  uptime: number
  port: number
  providers: { total: number; enabled: number }
  routeRules: number
  requests: { total: number; today: number; todayErrors: number; todayAvgMs: number; todayP50Ms: number; todayP95Ms: number; todayP99Ms: number }
  requestsByProvider: { providerId: string; providerName: string; total: number; today: number }[]
  requestsByModel: { model: string; targetModel: string; total: number; today: number }[]
  tokenStats?: { total: TokenStats; today: TokenStats }
  tokensByProvider?: { providerId: string; providerName: string; total: TokenStats; today: TokenStats }[]
  tokensByModel?: { model: string; targetModel: string; total: TokenStats; today: TokenStats }[]
}

export interface ProviderTestResult {
  success: boolean
  statusCode: number
  duration: number
  error?: string
}

export interface KeyGroupInfo {
  id: string
  name: string
  description: string
  dailyTokenLimit: number
  monthlyTokenLimit: number
  rpmLimit: number
  createdAt: string
  keyCount?: number
}

export interface ApiKeyInfo {
  id: string
  name: string
  keyPrefix: string
  groupId: string
  enabled: boolean
  dailyTokenLimit: number
  monthlyTokenLimit: number
  rpmLimit: number
  createdAt: string
  lastUsedAt: string | null
  description: string
}

export interface InitCheckResult {
  initialized: boolean
}

export interface GatewayConfigInfo {
  authRequired: boolean
  adminInitialized: boolean
  adminUsername: string | null
}

export const providerApi = {
  list: () => api<ProviderInfo[]>("/admin/providers"),
  create: (data: Omit<ProviderInfo, "id">) => api<ProviderInfo>("/admin/providers", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<ProviderInfo>) => api<ProviderInfo>(`/admin/providers/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id: string) => api<void>(`/admin/providers/${id}`, { method: "DELETE" }),
  /** 创建前测试（需传入 apiKey） */
  test: (data: { baseUrl: string; apiKey: string; type: string; model?: string; customHeaders?: Record<string, string> }) =>
    api<ProviderTestResult>("/admin/providers/test", { method: "POST", body: JSON.stringify(data) }),
  /** 按 provider ID 测试连通性（使用后端存储的真实 apiKey） */
  testById: (id: string) =>
    api<ProviderTestResult>(`/admin/providers/${id}/test`, { method: "POST" }),
}

export const routeApi = {
  list: () => api<RouteRuleInfo[]>("/admin/routes"),
  create: (data: Omit<RouteRuleInfo, "id">) => api<RouteRuleInfo>("/admin/routes", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<RouteRuleInfo>) => api<RouteRuleInfo>(`/admin/routes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  reorder: (items: { id: string; priority: number }[]) => api<{ success: boolean }>("/admin/routes/reorder", { method: "PUT", body: JSON.stringify(items) }),
  delete: (id: string) => api<void>(`/admin/routes/${id}`, { method: "DELETE" }),
}

export const logApi = {
  list: (options?: { limit?: number; offset?: number; model?: string; providerId?: string; apiKeyId?: string; groupId?: string; status?: string; sort?: string; startTime?: string; endTime?: string }) => {
    const params = new URLSearchParams()
    if (options?.limit) params.set("limit", String(options.limit))
    if (options?.offset) params.set("offset", String(options.offset))
    if (options?.model) params.set("model", options.model)
    if (options?.providerId) params.set("providerId", options.providerId)
    if (options?.apiKeyId) params.set("apiKeyId", options.apiKeyId)
    if (options?.groupId) params.set("groupId", options.groupId)
    if (options?.status) params.set("status", options.status)
    if (options?.sort) params.set("sort", options.sort)
    if (options?.startTime) params.set("startTime", options.startTime)
    if (options?.endTime) params.set("endTime", options.endTime)
    return api<LogEntry[]>(`/admin/logs?${params}`)
  },
  detail: (id: number) => api<LogEntry>(`/admin/logs/${id}`),
  stats: (filters?: { apiKeyId?: string; groupId?: string }) => {
    const params = new URLSearchParams()
    if (filters?.apiKeyId) params.set("apiKeyId", filters.apiKeyId)
    if (filters?.groupId) params.set("groupId", filters.groupId)
    const qs = params.toString()
    return api<{ total: number; today: number }>(`/admin/stats${qs ? '?' + qs : ''}`)
  },
}

export const healthApi = {
  get: () => api<HealthInfo>("/health"),
}

export const tokenApi = {
  stats: () => api<{
    summary: { total: TokenStats; today: TokenStats }
    byProvider: { providerId: string; providerName: string; total: TokenStats; today: TokenStats }[]
    byModel: { model: string; targetModel: string; total: TokenStats; today: TokenStats }[]
  }>("/admin/token-stats"),
  hourly: (hours: number = 24) => api<({ hour: string } & TokenStats)[]>(`/admin/token-stats/hourly?hours=${hours}`),
  byGroup: () => api<{ groupId: string; groupName: string; total: TokenStats; today: TokenStats }[]>("/admin/token-stats/by-group"),
  byKey: () => api<{ keyId: string; keyName: string; groupId: string; groupName: string; total: TokenStats; today: TokenStats }[]>("/admin/token-stats/by-key"),
}

export const keyGroupApi = {
  list: () => api<KeyGroupInfo[]>("/admin/key-groups"),
  create: (data: Omit<KeyGroupInfo, "id" | "createdAt" | "keyCount">) => api<KeyGroupInfo>("/admin/key-groups", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<KeyGroupInfo>) => api<KeyGroupInfo>(`/admin/key-groups/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id: string) => api<void>(`/admin/key-groups/${id}`, { method: "DELETE" }),
}

export const apiKeyApi = {
  list: () => api<ApiKeyInfo[]>("/admin/keys"),
  create: (data: { name: string; groupId: string; dailyTokenLimit?: number; monthlyTokenLimit?: number; rpmLimit?: number; description?: string }) =>
    api<ApiKeyInfo & { rawKey: string }>("/admin/keys", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<ApiKeyInfo>) => api<ApiKeyInfo>(`/admin/keys/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  delete: (id: string) => api<void>(`/admin/keys/${id}`, { method: "DELETE" }),
}

export const initApi = {
  check: () => api<InitCheckResult>("/admin/init-check"),
  init: (data: { username: string; password: string }) => api<{ success: boolean }>("/admin/init", { method: "POST", body: JSON.stringify(data) }),
}

export const authApi = {
  login: (data: { username: string; password: string }) => api<{ success: boolean }>("/admin/login", { method: "POST", body: JSON.stringify(data) }),
  logout: () => api<{ success: boolean }>("/admin/logout", { method: "POST" }),
}

export const configApi = {
  get: () => api<GatewayConfigInfo>("/admin/config"),
  update: (data: { authRequired?: boolean; newPassword?: string }) => api<{ success: boolean }>("/admin/config", { method: "PUT", body: JSON.stringify(data) }),
}

// ========== SSE 事件类型 ==========

export interface SseConnectedEvent { type: "connected" }

export interface SseConcurrencyHistoryEvent {
  type: "concurrency_history"
  snapshots: { time: string; providers: { id: string; name: string; gateway: number; upstream: number }[] }[]
}

export interface SseConcurrencyEvent {
  type: "concurrency"
  providers: { id: string; name: string; max: number; gateway: number; upstream: number; models: { model: string; targetModel: string; count: number }[] }[]
}

export interface SseRequestStartEvent {
  type: "request_start"
  requestId: string
  model: string
  targetModel: string
  provider: string
  providerId?: string
  input: string
  rulePattern: string | null
  keyName?: string | null
  groupName?: string | null
}

export interface SseRequestStreamEvent {
  type: "request_stream"
  requestId: string
  text: string
}

export interface SseUpstreamStartEvent {
  type: "upstream_start"
  requestId: string
  providerId: string
  providerName?: string
}

export interface SseUpstreamEndEvent {
  type: "upstream_end"
  requestId: string
  providerId: string
}

export interface SseRequestEndEvent {
  type: "request_end"
  requestId: string
  durationMs: number
  statusCode: number
  error: string | null
  tokenUsage?: TokenStats
}

export interface SseRequestStatsEvent {
  type: "request_stats"
  requests: { total: number; today: number; todayErrors: number; todayAvgMs: number; todayP50Ms: number; todayP95Ms: number; todayP99Ms: number }
  byProvider: { providerId: string; providerName: string; total: number; today: number }[]
  byModel: { model: string; targetModel: string; total: number; today: number }[]
  tokenStats?: { total: TokenStats; today: TokenStats }
}

export type SseEvent =
  | SseConnectedEvent
  | SseConcurrencyHistoryEvent
  | SseConcurrencyEvent
  | SseRequestStartEvent
  | SseRequestStreamEvent
  | SseUpstreamStartEvent
  | SseUpstreamEndEvent
  | SseRequestEndEvent
  | SseRequestStatsEvent
