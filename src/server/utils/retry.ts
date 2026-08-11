/**
 * 上游 429 重试工具：当路由规则开启 retryQpmLimit 时，
 * 上游返回 429 不透传给客户端，而是在网关层等待（指数退避）后重试同一 provider。
 */
import { emitEvent } from "./event-bus.ts"
import { waitDelay } from "../quota.ts"

/** 重试判断所需的最小结果结构（两个协议的 handler 返回类型都满足） */
export interface RetryableResult {
  ok: boolean
  statusCode: number
}

/** 上游 429 重试上限（指数退避：1s → 2s → 4s → 8s → … → 512s） */
const MAX_UPSTREAM_429_RETRIES = 10

/**
 * 包装一次上游请求，若返回 429 且 retryEnabled 则自动等待后重试。
 *
 * 每次重试前发送 upstream_end / upstream_start 事件，
 * 让前端面板能看到重试过程。返回最终结果（成功或耗尽重试次数后的失败）。
 *
 * @param requestFn 执行实际上游请求的回调，返回含 ok/statusCode 的结果
 * @param retryEnabled 是否启用 429 重试（来自路由规则 retryQpmLimit）
 * @param signal 客户端断连信号，abort 时立即停止重试
 * @param providerName 服务商名称（日志用）
 * @param requestId 请求 ID（事件用）
 * @param providerId 服务商 ID（事件用）
 * @param logPrefix 日志前缀，如 "[openai]" 或 "[anthropic]"
 */
export async function withUpstream429Retry<T extends RetryableResult>(
  requestFn: () => Promise<T>,
  retryEnabled: boolean,
  signal: AbortSignal,
  providerName: string,
  requestId: string,
  providerId: string,
  logPrefix: string,
): Promise<T> {
  let result = await requestFn()

  /** 当前 provider 的 429 重试计数 */
  let retries = 0
  while (!result.ok && result.statusCode === 429 && retryEnabled && retries < MAX_UPSTREAM_429_RETRIES && !signal.aborted) {
    const waitMs = 1000 * Math.pow(2, retries)
    console.log(`${logPrefix} Upstream 429 from "${providerName}", retrying in ${waitMs}ms (attempt ${retries + 1}/${MAX_UPSTREAM_429_RETRIES})`)
    await waitDelay(waitMs, signal)
    retries++
    emitEvent({ type: "upstream_end", requestId, providerId })
    emitEvent({ type: "upstream_start", requestId, providerId, providerName })
    result = await requestFn()
  }

  return result
}
