import type { SseEvent } from "./api"

type SseListener = (event: SseEvent) => void

/** 全局 SSE 连接管理器：多个组件共享同一个 EventSource 连接 */
let eventSource: EventSource | null = null
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
const HEARTBEAT_TIMEOUT = 15_000
const listeners = new Set<SseListener>()

/** 指数退避重连 */
let retryDelay = 1000
const MAX_RETRY_DELAY = 30_000

function resetRetryDelay() {
  retryDelay = 1000
}

function resetHeartbeat() {
  if (heartbeatTimer) clearTimeout(heartbeatTimer)
  heartbeatTimer = setTimeout(() => {
    reconnect()
  }, HEARTBEAT_TIMEOUT)
}

function connect() {
  eventSource?.close()
  eventSource = new EventSource("/admin/events")
  resetHeartbeat()

  eventSource.onmessage = (e) => {
    resetHeartbeat()
    resetRetryDelay()
    let event: SseEvent
    try { event = JSON.parse(e.data) } catch { return }
    for (const fn of listeners) {
      try { fn(event) } catch { /* skip */ }
    }
  }

  eventSource.onerror = () => {
    /** EventSource 内置重连机制，超时时 heartbeat timer 会强制重建连接 */
  }

  eventSource.onopen = () => {
    resetHeartbeat()
    resetRetryDelay()
  }
}

/** 带指数退避的重连 */
function reconnect() {
  eventSource?.close()
  eventSource = null
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null }
  if (listeners.size === 0) return
  setTimeout(() => {
    if (listeners.size > 0) connect()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY)
}

/** 订阅 SSE 事件，返回取消订阅函数 */
export function subscribeSSE(fn: SseListener): () => void {
  listeners.add(fn)
  /** 首个订阅者建立连接 */
  if (listeners.size === 1) connect()
  return () => {
    listeners.delete(fn)
    /** 无订阅者时断开连接 */
    if (listeners.size === 0) {
      /** 先清 timer 再关 connection，避免 timer 在 close 和 clear 之间触发 */
      if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null }
      eventSource?.close()
      eventSource = null
    }
  }
}
