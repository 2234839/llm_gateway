/** 默认请求超时 5 分钟 */
export const DEFAULT_TIMEOUT = 300_000

/** 网络级超时错误 */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "TimeoutError") return true
  /** undici 连接超时 */
  if (err instanceof Error && (err as Error & { code?: string }).code === "UND_ERR_CONNECT_TIMEOUT") return true
  return false
}

/** 网络级中止错误 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

/** 连接/网络级错误（非超时、非中止） */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: string }).code
  if (!code) return false
  return ["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ENETUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"].includes(code)
}

/** 将底层网络错误包装为用户友好的错误消息并重新抛出 */
export function wrapNetworkError(err: unknown, providerId: string): never {
  if (isTimeoutError(err)) {
    throw new Error(`Provider ${providerId}: request timed out`)
  }
  if (isAbortError(err)) {
    throw new Error(`Provider ${providerId}: request aborted`)
  }
  if (isConnectionError(err)) {
    const code = (err as Error & { code?: string }).code
    throw new Error(`Provider ${providerId}: connection failed (${code})`)
  }
  if (err instanceof TypeError) {
    throw new Error(`Provider ${providerId}: connection failed (${(err as Error).message})`)
  }
  /** 其他未知错误也包装为 Provider 前缀，确保路由层正确识别为网络错误 (502) */
  if (err instanceof Error) {
    throw new Error(`Provider ${providerId}: ${err.message}`)
  }
  throw err
}
