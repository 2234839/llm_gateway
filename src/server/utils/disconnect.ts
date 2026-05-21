import type { FastifyRequest } from "fastify"

/**
 * 创建基于底层 TCP socket close 事件的断连信号。
 * 比 request.signal 可靠：Bun + Fastify 下 request.signal 在请求体消费后就会被 abort（非真正断连），
 * 而 socket.close 只在内核级传输断开时触发。
 */
export function createDisconnectSignal(request: FastifyRequest): AbortSignal {
  const controller = new AbortController()
  const socket = request.raw.socket
  if (socket) {
    socket.once("close", () => controller.abort())
  }
  return controller.signal
}
