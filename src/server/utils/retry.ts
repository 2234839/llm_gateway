/**
 * 上游失败重试工具：根据路由规则的重试配置，
 * 上游返回 429 / 529 / 任意失败时不透传给客户端，
 * 而是在网关层等待（指数退避）后重试同一 provider。
 */
import { emitEvent } from "./event-bus.ts"
import { waitDelay } from "../quota.ts"

/** 重试判断所需的最小结果结构（两个协议的 handler 返回类型都满足） */
export interface RetryableResult {
  ok: boolean
  statusCode: number
}

/** 上游失败重试策略（来自路由规则） */
export interface UpstreamRetryOptions {
  /** 上游 429 时等待重试（来自路由规则 retryQpmLimit） */
  retryOn429?: boolean
  /** 上游 529（服务过载）时等待重试（来自路由规则 retryOn529） */
  retryOn529?: boolean
  /** 任意失败都等待重试（来自路由规则 retryAllFailures，涵盖 429/529） */
  retryAllFailures?: boolean
}

/** 上游失败重试上限（指数退避：1s → 2s → 4s → 8s → … → 512s） */
const MAX_UPSTREAM_RETRIES = 10

/** 判断失败结果是否命中重试策略 */
function shouldRetry(result: RetryableResult, options: UpstreamRetryOptions): boolean {
  if (options.retryAllFailures) return true
  if (result.statusCode === 429 && options.retryOn429) return true
  if (result.statusCode === 529 && options.retryOn529) return true
  return false
}

/**
 * 包装一次上游请求，若失败且命中重试策略则自动等待后重试。
 *
 * 每次重试前发送 upstream_end / upstream_start 事件，
 * 让前端面板能看到重试过程。返回最终结果（成功或耗尽重试次数后的失败）。
 */
export async function withUpstreamRetry<T extends RetryableResult>(
  /** 执行实际上游请求的回调，返回含 ok/statusCode 的结果 */
  requestFn: () => Promise<T>,
  /** 重试策略（来自路由规则 retryQpmLimit / retryOn529 / retryAllFailures） */
  options: UpstreamRetryOptions,
  /** 客户端断连信号，abort 时立即停止重试 */
  signal: AbortSignal,
  /** 服务商名称（日志用） */
  providerName: string,
  /** 请求 ID（事件用） */
  requestId: string,
  /** 服务商 ID（事件用） */
  providerId: string,
  /** 日志前缀，如 "[openai]" 或 "[anthropic]" */
  logPrefix: string,
): Promise<T> {
  let result = await requestFn()

  /** 当前 provider 的失败重试计数 */
  let retries = 0
  while (!result.ok && shouldRetry(result, options) && retries < MAX_UPSTREAM_RETRIES && !signal.aborted) {
    const waitMs = 1000 * Math.pow(2, retries)
    console.log(`${logPrefix} Upstream ${result.statusCode} from "${providerName}", retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_UPSTREAM_RETRIES})`)
    await waitDelay(waitMs, signal)
    retries++
    emitEvent({ type: "upstream_end", requestId, providerId })
    emitEvent({ type: "upstream_start", requestId, providerId, providerName })
    result = await requestFn()
  }

  return result
}
