/** SSE 事件总线：向所有已连接的客户端广播事件 */
import type { TokenStats } from "../types.ts"

export interface RequestStartEvent {
  type: "request_start"
  requestId: string
  model: string
  targetModel: string
  provider: string
  /** 服务商 ID，用于并发统计 */
  providerId?: string
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
  /** 总请求数 / 今日请求数 / 错误 / 平均耗时 / 百分位延迟 */
  requests: { total: number; today: number; todayErrors: number; todayAvgMs: number; todayP50Ms: number; todayP95Ms: number; todayP99Ms: number }
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
  /** 服务商名称，用于前端实时面板显示 fallback 切换 */
  providerName?: string
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

/** SSE 专用 listener：接收预序列化的 JSON 字符串，避免每个连接重复序列化 */
type SerializedListener = (data: string) => void
const serializedListeners = new Set<SerializedListener>()

export function emitEvent(event: BusEvent) {
  for (const fn of listeners) {
    try {
      fn(event)
    } catch (err) {
      console.error("[event-bus] Listener error:", err)
    }
  }
  /** 预序列化一次，分发给所有 SSE listener */
  if (serializedListeners.size > 0) {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const fn of serializedListeners) {
      try {
        fn(data)
      } catch (err) {
        console.error("[event-bus] SerializedListener error:", err)
      }
    }
  }
}

export function onEvent(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 注册 SSE 专用 listener，接收预序列化的 SSE data 行 */
export function onSerializedEvent(fn: SerializedListener): () => void {
  serializedListeners.add(fn)
  return () => { serializedListeners.delete(fn) }
}
