// ========== Anthropic 请求类型 ==========

/** Anthropic Messages API 请求体 */
export interface AnthropicMessagesRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string | AnthropicSystemBlock[]
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  thinking?: AnthropicThinkingConfig
  metadata?: { user_id?: string }
}

/** Anthropic 消息 */
export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export interface AnthropicSystemBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral" }
}

/** Anthropic 内容块联合类型 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock

export interface AnthropicTextBlock {
  type: "text"
  text: string
  cache_control?: { type: "ephemeral" }
}

export interface AnthropicImageBlock {
  type: "image"
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string }
}

export interface AnthropicToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: "tool_result"
  tool_use_id: string
  content: string | (AnthropicTextBlock | AnthropicImageBlock)[]
  is_error?: boolean
}

export interface AnthropicThinkingBlock {
  type: "thinking"
  thinking: string
  signature?: string
}

export interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking"
  data: string
}

/** Anthropic 工具定义 */
export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  type?: "custom"
  cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" }
}

/** Anthropic tool_choice */
export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" }

export interface AnthropicThinkingConfig {
  type: "enabled"
  budget_tokens: number
}

// ========== Anthropic 响应类型 ==========

/** Anthropic 非流式响应体 */
export interface AnthropicMessagesResponse {
  id: string
  type: "message"
  role: "assistant"
  content: AnthropicResponseContentBlock[]
  model: string
  stop_reason: AnthropicStopReason
  stop_sequence: string | null
  usage: AnthropicUsage
}

export type AnthropicStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | null

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export type AnthropicResponseContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }

// ========== Anthropic SSE 流式事件类型 ==========

export type AnthropicSSEEvent =
  | { type: "message_start"; message: AnthropicMessagesResponse }
  | { type: "content_block_start"; index: number; content_block: { type: string; [key: string]: unknown } }
  | { type: "content_block_delta"; index: number; delta: AnthropicContentDelta }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: AnthropicStopReason; stop_sequence: string | null }; usage: { output_tokens: number; input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } }

export type AnthropicContentDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }

// ========== OpenAI 请求类型 ==========

/** OpenAI Chat Completions API 请求体 */
export interface OpenAIChatCompletionRequest {
  model: string
  messages: OpenAIChatMessage[]
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  /** OpenAI: presence_penalty */
  presence_penalty?: number
  /** OpenAI: frequency_penalty */
  frequency_penalty?: number
  seed?: number
  stream?: boolean
  stop?: string | string[]
  tools?: OpenAITool[]
  tool_choice?: OpenAIToolChoice
  n?: number
  stream_options?: { include_usage: boolean }
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown }
  logprobs?: boolean
  top_logprobs?: number
  user?: string
}

export type OpenAIChatMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage

export interface OpenAISystemMessage {
  role: "system"
  content: string
}

export interface OpenAIUserMessage {
  role: "user"
  content: string | OpenAIContentPart[]
}

export interface OpenAIAssistantMessage {
  role: "assistant"
  content?: string | null
  tool_calls?: OpenAIToolCall[]
}

export interface OpenAIToolMessage {
  role: "tool"
  tool_call_id: string
  content?: string
}

export interface OpenAIContentPart {
  type: "text" | "image_url" | "input_audio"
  text?: string
  image_url?: { url: string }
  input_audio?: { data: string; format: string }
}

export interface OpenAIToolCall {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

export interface OpenAITool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }

// ========== OpenAI 响应类型 ==========

export interface OpenAIChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: {
    index: number
    message: {
      role: "assistant"
      content: string | null
      tool_calls?: OpenAIToolCall[]
      refusal?: string | null
    }
    finish_reason: OpenAIFinishReason
  }[]
  usage: OpenAIUsage
  system_fingerprint?: string
}

export type OpenAIFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | null

export interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    /** 已缓存命中的 token 数 */
    cached_tokens?: number
  }
  /** Anthropic 扩展：cache 写入 token 数 */
  cache_creation_input_tokens?: number
  /** Anthropic 扩展：cache 读取 token 数 */
  cache_read_input_tokens?: number
}

// ========== OpenAI SSE 流式事件类型 ==========

export interface OpenAIStreamChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: {
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: {
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason: OpenAIFinishReason
  }[]
  usage?: OpenAIUsage
}

// ========== 配置类型 ==========

export type ProviderType = "openai" | "anthropic" | "azure-openai" | "custom"

export interface ProviderConfig {
  id: string
  name: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  models: string[]
  enabled: boolean
  customHeaders?: Record<string, string>
  /** 最大并发请求数，0 或不设置表示不限制 */
  maxConcurrency?: number
  /** 请求超时毫秒数，0 或不设置使用默认 300000 (5分钟) */
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

export interface RouteRule {
  id: string
  pattern: string
  providerId: string
  /** 转发给上游的目标模型名，不填则用请求中的原始模型名 */
  targetModel?: string
  modelMapping?: Record<string, string>
  priority: number
  /** 内容匹配条件组，不存在则仅按模型名匹配 */
  contentMatch?: ContentMatchCondition[]
  /** 排除条件组，匹配成功时跳过此规则，优先级高于匹配条件 */
  excludeMatch?: ContentMatchCondition[]
  /** 是否启用，默认 true */
  enabled?: boolean
  /** 限定匹配的密钥分组 ID 列表，空/缺省=匹配所有 */
  keyGroups?: string[]
  /** 故障转移备选提供商列表，主 Provider 失败时按顺序尝试 */
  fallbacks?: RouteFallback[]
}

/** 路由规则的故障转移备选 */
export interface RouteFallback {
  providerId: string
  /** 转发目标模型名，不填则用主规则的 targetModel 或原始模型名 */
  targetModel?: string
}

export interface GatewayConfig {
  port: number
  logLevel: "debug" | "info" | "warn" | "error"
  enableRequestLog: boolean
  /** 保留带内容的日志条数（提示词+响应），超出后清理旧记录的 content 字段，默认 1000 */
  logContentRetention: number
  /** 日志行数上限，超出后删除最旧的记录，默认 100000 */
  maxLogRows: number
  /** 是否要求 API 请求必须携带有效 Key */
  authRequired: boolean
}

// ========== 请求日志类型 ==========

export interface RequestLogEntry {
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
  cacheCreationTokens: number
  cacheReadTokens: number
  /** 发起请求的 API Key ID */
  apiKeyId: string | null
  /** API Key 所属分组 ID */
  groupId: string | null
  error: string | null
  inputContent: string | null
  outputContent: string | null
  /** fallback 尝试记录，JSON 数组：[{ providerId, providerName, targetModel, statusCode, error }] */
  fallbackAttempts: string | null
}

/** Token 用量统计快照 */
export interface TokenStats {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

// ========== Provider 接口 ==========

export interface Provider {
  readonly id: string
  readonly type: ProviderType
  readonly baseUrl: string
  readonly apiKey: string

  sendRequest(body: Record<string, unknown>, headers: Record<string, string>, signal?: AbortSignal): Promise<Response>

  sendStreamRequest(body: Record<string, unknown>, headers: Record<string, string>, signal?: AbortSignal): Promise<Response>
}

export interface RouteResult {
  provider: Provider
  targetModel: string
  providerConfig: ProviderConfig
  /** 命中的路由规则 pattern，兜底规则时为 null */
  rulePattern: string | null
  /** 故障转移备选列表 */
  fallbacks: RouteFallback[]
}

// ========== Anthropic 错误响应格式 ==========

export interface AnthropicErrorResponse {
  type: "error"
  error: {
    type: "invalid_request_error" | "authentication_error" | "permission_error" | "not_found_error" | "request_too_large" | "rate_limit_error" | "api_error" | "overloaded_error"
    message: string
  }
}

// ========== API Key 分组与密钥管理 ==========

/** 密钥分组 */
export interface KeyGroup {
  id: string
  name: string
  description: string
  /** 每日 Token 限额，0 = 不限 */
  dailyTokenLimit: number
  /** 每月 Token 限额，0 = 不限 */
  monthlyTokenLimit: number
  /** 每分钟请求数限额，0 = 不限 */
  rpmLimit: number
  createdAt: string
}

/** 网关级 API Key */
export interface ApiKey {
  id: string
  name: string
  /** SHA-256(rawKey)，用于查找 */
  keyHash: string
  /** 前 8 字符，用于展示：sk-a1b2c... */
  keyPrefix: string
  groupId: string
  enabled: boolean
  /** 每日 Token 限额，0 = 不限 */
  dailyTokenLimit: number
  /** 每月 Token 限额，0 = 不限 */
  monthlyTokenLimit: number
  /** 每分钟请求数限额，0 = 不限 */
  rpmLimit: number
  createdAt: string
  lastUsedAt: string | null
  description: string
}

/** 创建 Key 时一次性返回完整密钥 */
export interface ApiKeyWithSecret extends ApiKey {
  /** 完整原始密钥，仅在创建时返回一次 */
  rawKey: string
}

/** 请求上的认证上下文 */
export interface AuthContext {
  keyId: string
  groupId: string
  groupName: string
  keyName: string
  /** 密钥级限额 */
  keyLimits: { dailyTokenLimit: number; monthlyTokenLimit: number; rpmLimit: number }
  /** 分组级限额 */
  groupLimits: { dailyTokenLimit: number; monthlyTokenLimit: number; rpmLimit: number }
}

/** 扩展 FastifyRequest 类型，避免 (request as any).authContext */
declare module "fastify" {
  interface FastifyRequest {
    authContext: AuthContext | null
  }
}
