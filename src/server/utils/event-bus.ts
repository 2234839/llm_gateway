/** SSE 事件总线：向所有已连接的客户端广播事件 */
import type { TokenStats } from "../types.ts"

export interface RequestStartEvent {
  type: "request_start"
  requestId: string
  model: string
  targetModel: string
  provider: string
  input: string
  /** 命中的路由规则 pattern */
  rulePattern: string | null
  /** 认证 key 名称 */
  keyName?: string | null
  /** 认证分组名称 */
  groupName?: string | null
}

export interface RequestStreamEvent {
  type: "request_stream"
  requestId: string
  text: string
}

export interface RequestEndEvent {
  type: "request_end"
  requestId: string
  durationMs: number
  statusCode: number
  error: string | null
  tokenUsage?: TokenStats
}

export interface RequestStatsEvent {
  type: "request_stats"
  /** 总请求数 / 今日请求数 */
  requests: { total: number; today: number }
  /** 按服务商统计 */
  byProvider: { providerId: string; providerName: string; total: number; today: number }[]
  /** 按模型统计 */
  byModel: { model: string; targetModel: string; total: number; today: number }[]
  /** Token 用量统计 */
  tokenStats?: { total: TokenStats; today: TokenStats }
}

/** 上游 API 调用开始（信号量 acquire 之后） */
export interface UpstreamStartEvent {
  type: "upstream_start"
  requestId: string
  providerId: string
}

/** 上游 API 调用结束（信号量 release 之前） */
export interface UpstreamEndEvent {
  type: "upstream_end"
  requestId: string
  providerId: string
}

export type BusEvent = RequestStartEvent | RequestStreamEvent | RequestEndEvent | RequestStatsEvent | UpstreamStartEvent | UpstreamEndEvent

type Listener = (event: BusEvent) => void

const listeners = new Set<Listener>()

export function emitEvent(event: BusEvent) {
  for (const fn of listeners) {
    fn(event)
  }
}

export function onEvent(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
