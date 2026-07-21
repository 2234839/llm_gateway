import type { FastifyRequest } from "fastify"

/**
 * 基于底层 TCP socket close 事件的断连信号 + 清理函数。
 *
 * 比 request.signal 可靠：Bun + Fastify 下 request.signal 在请求体消费后就会被 abort（非真正断连），
 * 而 socket.close 只在内核级传输断开时触发。
 *
 * 返回的 cleanup 必须在请求结束时调用：HTTP keep-alive 下 socket 会被复用处理多个请求，
 * 若不移除 close 监听器，每个请求都会在同一个 socket 上累积监听器，最终触发
 * MaxListenersExceededWarning 并泄漏 controller 及其闭包。
 */
export function createDisconnectSignal(request: FastifyRequest): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const socket = request.raw.socket
  /** socket 不一定可用（如测试环境），此时退化为永不 abort 的信号 */
  if (!socket) {
    return { signal: controller.signal, cleanup: () => {} }
  }

  const onSocketClose = () => controller.abort()
  socket.once("close", onSocketClose)

  /** 标记是否已清理，避免重复 removeEventListener */
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    socket.removeListener("close", onSocketClose)
  }

  return { signal: controller.signal, cleanup }
}
