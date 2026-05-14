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
  source: { type: "base64"; media_type: string; data: string }
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
  content: string | AnthropicTextBlock[]
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
  | { type: "message_delta"; delta: { stop_reason: AnthropicStopReason; stop_sequence: string | null }; usage: { output_tokens: number } }
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
  stream?: boolean
  stop?: string | string[]
  tools?: OpenAITool[]
  tool_choice?: OpenAIToolChoice
  n?: number
  stream_options?: { include_usage: boolean }
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
  content: string
}

export interface OpenAIContentPart {
  type: "text" | "image_url"
  text?: string
  image_url?: { url: string }
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
}

export interface GatewayConfig {
  port: number
  logLevel: "debug" | "info" | "warn" | "error"
  enableRequestLog: boolean
  /** 保留带内容的日志条数（提示词+响应），超出后清理旧记录的 content 字段，默认 1000 */
  logContentRetention: number
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
  error: string | null
  inputContent: string | null
  outputContent: string | null
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

  sendRequest(body: Record<string, unknown>, headers: Record<string, string>): Promise<Response>

  sendStreamRequest(body: Record<string, unknown>, headers: Record<string, string>): Promise<Response>
}

export interface RouteResult {
  provider: Provider
  targetModel: string
  providerConfig: ProviderConfig
}

// ========== Anthropic 错误响应格式 ==========

export interface AnthropicErrorResponse {
  type: "error"
  error: {
    type: "invalid_request_error" | "authentication_error" | "permission_error" | "not_found_error" | "request_too_large" | "rate_limit_error" | "api_error" | "overloaded_error"
    message: string
  }
}
