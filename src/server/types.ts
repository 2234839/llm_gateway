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
  /** 思考强度控制（DeepSeek Anthropic 格式: output_config.effort） */
  output_config?: { effort?: string }
  metadata?: { user_id?: string }
}

/** Anthropic 消息（system 来自 Claude Code mid_conversation_system beta） */
export interface AnthropicMessage {
  role: "user" | "assistant" | "system"
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
  type: "enabled" | "disabled"
  budget_tokens?: number
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
  /** 思考模式控制（DeepSeek / GLM 等模型支持） */
  thinking?: { type: "enabled" | "disabled" }
  /** 思考强度控制（DeepSeek / GLM 等模型支持） */
  reasoning_effort?: string
  /** Anthropic 格式的思考输出配置（GLM 等支持 Anthropic 格式的模型） */
  output_config?: { effort?: string }
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
  /** DeepSeek / OpenAI reasoning 扩展：思维链内容 */
  reasoning_content?: string | null
  /** DeepSeek AnthropicFB 要求回传的 thinking signature */
  reasoning_signature?: string
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
      /** DeepSeek / OpenAI reasoning 扩展：思维链内容 */
      reasoning_content?: string | null
      /** DeepSeek AnthropicFB 要求回传的 thinking signature */
      reasoning_signature?: string
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
  /** Responses 扩展：思维链 token 数 */
  output_tokens_details?: { reasoning_tokens?: number }
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
      /** DeepSeek / OpenAI reasoning 扩展：流式思维链内容 */
      reasoning_content?: string | null
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

// ========== OpenAI Responses API 类型 ==========

/** OpenAI Responses API 请求体（客户端入口 / provider 出站） */
export interface OpenAIResponsesRequest {
  model: string
  /** 输入：字符串快捷形式或输入 item 列表 */
  input: string | OpenAIResponseInputItem[]
  /** 系统指令（作为第一条 system/developer 消息） */
  instructions?: string
  stream?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  tools?: OpenAIResponsesTool[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string }
  /** 推理配置：effort 控制 */
  reasoning?: { effort?: string; summary?: unknown }
  /** 输出文本格式 */
  text?: { format?: { type?: string; [key: string]: unknown } }
  /** 是否存储响应（部分上游不支持，恒为 false） */
  store?: boolean
  metadata?: Record<string, unknown>
  /** 透传的用户标识 */
  user?: string
  parallel_tool_calls?: boolean
  /** 其他未映射字段原样保留 */
  [key: string]: unknown
}

/** Responses 输入 item（宽松结构：message / function_call / function_call_output / reasoning / 其他，运行时按 type 判别） */
export interface OpenAIResponseInputItem {
  /** item 类型：message（可缺省）/ function_call / function_call_output / reasoning / web_search_call 等 */
  type?: string
  /** message item 的角色 */
  role?: string
  /** message item 的内容 */
  content?: string | OpenAIResponseContentBlock[]
  /** function_call / function_call_output 的配对 id */
  call_id?: string
  /** function_call 的工具名 */
  name?: string
  /** function_call 的参数 JSON 字符串 */
  arguments?: string
  /** function_call_output 的输出 */
  output?: string | OpenAIResponseContentBlock[]
  /** reasoning item 的摘要 */
  summary?: unknown[]
  [key: string]: unknown
}

/** Responses 内容块 */
export interface OpenAIResponseContentBlock {
  type: string
  text?: string
  image_url?: string
  file_id?: string
  detail?: string
  [key: string]: unknown
}

/** Responses 工具定义 */
export interface OpenAIResponsesTool {
  type: "function" | string
  name?: string
  description?: string
  parameters?: Record<string, unknown>
  [key: string]: unknown
}

/** Responses 非流式响应体 */
export interface OpenAIResponsesResponse {
  id: string
  object: "response"
  created_at: number
  status: "completed" | "in_progress" | "incomplete" | "failed"
  model: string
  output: OpenAIResponseOutputItem[]
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
  [key: string]: unknown
}

/** Responses 输出 item（宽松结构：message / reasoning / function_call / 其他，运行时按 type 判别） */
export interface OpenAIResponseOutputItem {
  type: string
  id?: string
  /** message item 的角色 */
  role?: string
  status?: string
  /** message item 的内容块 */
  content?: { type: string; text?: string; annotations?: unknown[]; refusal?: string; [key: string]: unknown }[]
  /** reasoning item 的摘要 */
  summary?: { type: string; text?: string; [key: string]: unknown }[]
  /** function_call 的配对 id */
  call_id?: string
  /** function_call 的工具名 */
  name?: string
  /** function_call 的参数 JSON 字符串 */
  arguments?: string
  [key: string]: unknown
}

// ========== 配置类型 ==========

export type ProviderType = "openai" | "anthropic" | "azure-openai" | "custom" | "openai-responses"

/** 客户端请求使用的协议（决定同协议端点优先直通） */
export type ClientProtocol = "anthropic" | "openai" | "openai-responses"

export interface ProviderConfig {
  id: string
  name: string
  type: ProviderType
  baseUrl: string
  apiKey: string
  models: string[]
  enabled: boolean
  /** 额外协议端点：同一服务商支持的其他协议及其 Base URL。
   *  客户端协议与某端点匹配时直通该端点（零转换开销），否则走主端点 + 协议转换 */
  protocolEndpoints?: Partial<Record<ProviderType, string>>
  customHeaders?: Record<string, string>
  /** 额外放行透传给该 provider 的客户端请求头列表（大小写不敏感，默认仅 User-Agent） */
  allowedClientHeaders?: string[]
  /** 最大并发请求数，0 或不设置表示不限制 */
  maxConcurrency?: number
  /** 请求超时毫秒数，0 或不设置使用默认 300000 (5分钟) */
  requestTimeout?: number
  /** 图表显示颜色（HEX），不设置则自动生成 */
  color?: string
  /** 将 messages 中间的 system 消息转为 user（兼容 Claude Code mid_conversation_system beta） */
  flattenMidSystem?: boolean
}

/** 叶子条件：具体的匹配规则 */
export interface ConditionLeaf {
  /**
   * 匹配类型：
   * - model: 模型名 glob 匹配 (picomatch)
   * - keyword: 纯文本包含
   * - regex: 正则匹配
   * - content_type: 多模态内容存在性检测 (image/file/tool_use)
   * - char_count: 预估 token 数比较，如 "<100000"、">=5000"（按字符类别加权估算）
   */
  type: "model" | "keyword" | "regex" | "content_type" | "char_count"
  /**
   * 匹配值，语义依 type 而定：
   * - model: glob 模式，如 "gpt-*"
   * - keyword: 纯文本子串
   * - regex: 正则表达式
   * - content_type: 模态名称 (image/file/tool_use)
   * - char_count: 比较表达式，如 "<100000"、">=5000"（与预估 token 数比较）
   */
  pattern: string
  /** 正则标志位 (仅 type="regex")，如 "i" */
  flags?: string
}

/** 逻辑组：包含子节点 + 逻辑运算符 */
export interface ConditionGroup {
  /** 逻辑运算符 */
  type: "and" | "or"
  /** 子节点列表 */
  children: ConditionNode[]
}

/** 条件节点：叶子 or 逻辑组（递归） */
export type ConditionNode = ConditionLeaf | ConditionGroup

export interface RouteRule {
  id: string
  providerId: string
  /** 转发给上游的目标模型名，不填则用请求中的原始模型名 */
  targetModel?: string
  modelMapping?: Record<string, string>
  priority: number
  /** 匹配条件（递归嵌套树），不存在则匹配所有 */
  matchConditions?: ConditionNode
  /** 排除条件（同结构），匹配成功时跳过此规则 */
  excludeMatch?: ConditionNode
  /** 是否启用，默认 true */
  enabled?: boolean
  /** 限定匹配的密钥分组 ID 列表，空/缺省=匹配所有 */
  keyGroups?: string[]
  /** 是否在 QPM 限流时自动等待并重试，而不是直接返回 429 */
  retryQpmLimit?: boolean
  /** 是否在上游 529（服务过载）时自动等待并重试 */
  retryOn529?: boolean
  /** 是否对任意上游失败自动等待并重试（涵盖 429/529，耗尽次数后按原逻辑 fallback） */
  retryAllFailures?: boolean
  /** 故障转移备选提供商列表，主 Provider 失败时按顺序尝试 */
  fallbacks?: RouteFallback[]
  /** 客户端错误（4xx）也触发故障转移，默认仅 5xx/429/408 触发 */
  fallbackOnClientError?: boolean
  /** 思考选项改写：在协议转换后、发往上游前覆盖/移除请求中的思考相关参数 */
  thinkingOverride?: ThinkingOverride
}

/** 路由规则的故障转移备选 */
export interface RouteFallback {
  providerId: string
  /** 转发目标模型名，不填则用主规则的 targetModel 或原始模型名 */
  targetModel?: string
}

/**
 * 思考选项改写：在协议转换后、发往上游前，对出站请求体中的思考相关参数做统一改写
 * 涉及的协议字段：Anthropic 的 thinking / output_config.effort，OpenAI 的 thinking / reasoning_effort
 * 字段优先级：strip > enabled:false > 其余字段
 */
export interface ThinkingOverride {
  /**
   * 改写模式：
   * - override（默认）：网关配置永远覆盖客户端传入的思考参数
   * - default：仅当客户端未传任何思考参数（thinking/reasoning_effort/output_config 均不存在）时才注入
   */
  mode?: "override" | "default"
  /** 思考强度档位，覆盖 reasoning_effort / output_config.effort */
  effort?: "minimal" | "low" | "medium" | "high" | "max"
  /** 强制开启/关闭思考（thinking.type），false 时忽略 effort 与 budgetTokens */
  enabled?: boolean
  /** 覆盖 thinking.budget_tokens（仅 Anthropic 协议出站体生效），设置时会强制开启思考 */
  budgetTokens?: number
  /** 彻底移除出站体中所有思考相关字段，忽略其余配置 */
  strip?: boolean
}

/** 内容改写规则的消息作用范围 */
export type RewriteScope = "all" | "system" | "user" | "assistant"

/** 内容改写动作类型 */
export type RewriteActionType = "regex_replace" | "text_replace" | "prepend" | "append" | "remove_tool"

/** remove_tool 动作匹配的工具字段 */
export type ToolMatchField = "name" | "description" | "input_schema"

/** remove_tool 动作的匹配方式 */
export type ToolMatchMode = "exact" | "contains" | "regex"

/** 内容改写的匹配条件 */
export interface RewriteMatchCondition {
  /** 匹配类型 */
  type: "keyword" | "regex"
  /** keyword 时为纯文本，regex 时为正则表达式 */
  pattern: string
  /** 多条件间的逻辑关系，默认 and */
  operator?: "and" | "or"
  /** 正则标志位，如 i */
  flags?: string
  /** 匹配范围：限定匹配作用的消息角色，默认 all */
  scope?: RewriteScope
}

/** 内容改写的执行动作 */
export interface RewriteAction {
  /** 用户自定义的动作备注名，用于标注这个动作的用途，可选 */
  name?: string
  /** 动作类型 */
  type: RewriteActionType
  /** 替换/注入的文本内容 */
  replacement: string
  /** regex_replace 时的正则模式（必填）；text_replace 时的纯文本查找内容（必填） */
  pattern?: string
  /** regex_replace 时的正则标志位，如 i */
  flags?: string
  /** 动作作用范围：限定处理的消息角色，不填则使用 match 条件涉及的 scopes */
  scope?: RewriteScope
  /** remove_tool 时匹配的工具字段，默认 name */
  toolField?: ToolMatchField
  /** remove_tool 的匹配方式，默认 exact（精确匹配） */
  toolMatchMode?: ToolMatchMode
}

/** 内容改写规则 */
export interface RewriteRule {
  id: string
  /** 规则名称 */
  name: string
  /** 匹配条件组 */
  match: RewriteMatchCondition[]
  /** 执行动作组：命中后按顺序依次执行 */
  actions: RewriteAction[]
  /** 是否启用 */
  enabled: boolean
  /** 优先级，数值越大越先执行 */
  priority: number
  /** 限定模型名 (picomatch)，空 = 所有模型 */
  modelPattern?: string
  /** 限定请求路径 (picomatch)，空 = 所有路径 */
  pathPattern?: string
  /** 创建时间 */
  createdAt: string
}

/** 受保护密钥（Secret Vault）：请求出站时替换为占位符，响应入站时还原 */
export interface SecretEntry {
  id: string
  /** 密钥名称（便于辨认用途） */
  name: string
  /** 占位符，如 GWKEY_x7k2m9a2，发给上游 LLM 的就是它 */
  placeholder: string
  /** 真实密钥值，仅网关持有 */
  value: string
  /** 是否启用保护 */
  enabled: boolean
  /** 创建时间 */
  createdAt: string
}

/** CORS 跨域配置 */
export interface CorsConfig {  /** 允许的来源：true = 允许所有（反射请求来源），字符串数组 = 指定白名单 */
  origin: true | string[]
  /** 允许的 HTTP 方法 */
  methods: string[]
  /** 允许的请求头 */
  allowedHeaders: string[]
}

export interface GatewayConfig {
  port: number
  /** 监听地址，默认 0.0.0.0（所有网卡）；纯本机使用可设为 127.0.0.1。也可被 HOST 环境变量覆盖 */
  host?: string
  logLevel: "debug" | "info" | "warn" | "error"
  enableRequestLog: boolean
  /** 保留带内容的日志条数（提示词+响应），超出后清理旧记录的 content 字段，默认 1000 */
  logContentRetention: number
  /** 日志行数上限，超出后删除最旧的记录，默认 100000 */
  maxLogRows: number
  /** 慢 SQL 阈值（ms），超过则记录到 slow_query_log 并告警，默认 100 */
  slowSqlThresholdMs?: number
  /** 是否要求 API 请求必须携带有效 Key */
  authRequired: boolean
  /** CORS 跨域配置，undefined 时使用默认值（允许所有来源） */
  cors?: CorsConfig
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
  /** 结构化输入消息（内容寻址存储重组），旧日志为空 */
  inputMessages?: LogMessage[]
  /** 写入时提供的结构化消息，存入消息块表做哈希去重 */
  inputMessagesForWrite?: { role: string; content: string }[]
  /** fallback 尝试记录，JSON 数组：[{ providerId, providerName, targetModel, statusCode, error }] */
  fallbackAttempts: string | null
  /** 命中的内容改写规则名列表，JSON 字符串数组 */
  matchedRewriteRules?: string | null
  /** 内容改写实际产生的消息级差异，JSON 数组 RewriteDiff；未改写时为 null */
  rewriteDiffs?: string | null
  /** 思考参数快照（JSON ThinkingLogEntry）：记录改写前后的思考相关参数，未配置改写时仅记录入站值 */
  thinkingLog?: string | null
}

/** 日志中的思考参数快照：入站（客户端原始）与出站（发往上游最终）对照 */
export interface ThinkingLogEntry {
  /** 客户端原始请求中的思考参数（协议字段原样保留） */
  inbound: Record<string, unknown> | null
  /** 改写后实际发往上游的思考参数；未发生改写时为 null */
  outbound: Record<string, unknown> | null
  /** 改写摘要（如 "effort=low, thinking=disabled"）；未改写时为 null */
  summary: string | null
}

/** 单条消息的内容改写差异（改写前/后快照对比） */
export interface RewriteDiff {
  /** 快照中的序号：小于消息数时直接对位消息卡片，>= 消息数为工具描述 */
  idx: number
  /** 消息角色（工具描述为 tool:工具名） */
  role: string
  /** 改写前文本 */
  before: string
  /** 改写后文本 */
  after: string
}

/** 日志中的结构化消息（内容寻址存储重组结果） */
export interface LogMessage {
  /** 内容哈希（role + content） */
  hash: string
  /** 消息角色 */
  role: string
  /** 消息文本内容 */
  content: string
  /** 该消息块被多少条日志引用（高频度指标） */
  hitCount: number
  /** 挂在该消息块上的图片附件（内容寻址，通过 /admin/logs/:id/images/:hash 获取字节流） */
  images?: LogImage[]
  /** 该消息块在更早的日志中已出现过（多轮对话中的历史消息，本轮非新增） */
  seenBefore?: boolean
}

/** 日志消息块附带的图片元数据 */
export interface LogImage {
  /** 图片内容哈希（sha256 of bytes），同时是取图 URL 的一部分 */
  hash: string
  /** MIME 类型（如 image/png、image/jpeg） */
  mediaType: string
  /** 像素宽（压缩后） */
  width: number
  /** 像素高（压缩后） */
  height: number
  /** 存储字节数 */
  size: number
}

/** 写入侧的待处理图片附件（提取自请求中的 base64 图片，落库前可能需要压缩） */
export interface PendingLogImage {
  /** 所属消息在 inputMessagesForWrite 提取结果中的下标 */
  seq: number
  /** MIME 类型 */
  mediaType: string
  /** base64 编码的原始图片数据 */
  base64: string
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
  /** 命中的完整路由规则对象，方便访问额外配置 */
  routeRule?: RouteRule
  /** 故障转移备选列表 */
  fallbacks: RouteFallback[]
  /** 客户端错误（4xx）也触发故障转移 */
  fallbackOnClientError: boolean
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
  /** 完整原始密钥，前端可直接查看 */
  keySecret: string
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

// ========== 服务商余额查询类型 ==========

/** 服务商类型 */
export type ServiceProvider = "zhipu" | "deepseek" | "kimi" | "unknown"

/** 余额查询结果 */
export interface BalanceResult {
  /** 是否查询成功 */
  success: boolean
  /** 可用余额 */
  balance?: number
  /** 货币类型 */
  currency?: string
  /** 赠送余额 */
  grantedBalance?: number
  /** 充值余额 */
  toppedUpBalance?: number
  /** 错误信息 */
  error?: string
}

/** 用量限额查询结果（智谱专用） */
export interface QuotaResult {
  /** 是否查询成功 */
  success: boolean
  /** 限额明细 */
  limits?: {
    /** 限额类型: TIME_LIMIT / TOKENS_LIMIT */
    type: string
    /** 使用百分比 */
    percentage: number
    /** 已用量 */
    usage?: number
    /** 当前值 */
    currentValue?: number
    /** 剩余量 */
    remaining?: number
    /** 智谱: 时间单位编码 (5=小时, 3=天, 6=月) */
    unit?: number
    /** 智谱: 单位数量 */
    number?: number
  }[]
  /** 错误信息 */
  error?: string
}

/** cURL 查询结果 - 用量类型（如 Kimi Code） */
export interface CurlUsageResult {
  /** 查询是否成功 */
  success: boolean
  /** 服务商类型 */
  provider?: string
  /** 用量明细 */
  usages?: {
    /** 用量范围 */
    scope: string
    /** 限额 */
    limit: number
    /** 已用量 */
    used: number
    /** 剩余量 */
    remaining: number
    /** 重置时间 */
    resetTime?: string
    /** 子限额列表（如 300 分钟窗口） */
    subLimits?: {
      /** 时间窗口描述 */
      window: string
      limit: number
      used: number
      remaining: number
      resetTime?: string
    }[]
  }[]
  /** 总配额 */
  totalQuota?: {
    limit: number
    remaining: number
  }
  /** 错误信息 */
  error?: string
}

/** cURL 导入配置（Kimi 网页端用） */
export interface CurlQueryConfig {
  id: string
  /** 显示名称 */
  name: string
  /** 请求 URL */
  url: string
  /** HTTP 方法 */
  method: string
  /** 请求头 */
  headers: Record<string, string>
  /** 请求体 */
  body?: string
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
