/** 基于 Promise 的计数信号量，用于控制并发 */
export class Semaphore {
  private _current = 0
  private queue: (() => void)[] = []

  constructor(private readonly _max: number) {}

  get current(): number {
    return this._current
  }

  get max(): number {
    return this._max
  }

  /**
   * 获取一个许可。支持 AbortSignal 以便在客户端断连时取消等待。
   * 被取消时不占用信号量槽位。
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.max <= 0) return
    /** 客户端已断连，不应发起请求 */
    if (signal?.aborted) throw new Error("Aborted")
    if (this._current < this.max) {
      this._current++
      return
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        /** 从队列中移除此 waiter */
        const idx = this.queue.indexOf(resolve)
        if (idx !== -1) this.queue.splice(idx, 1)
        reject(new Error("Aborted"))
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.queue.push(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      })
    })
  }

  release(): void {
    if (this.max <= 0) return
    if (this._current <= 0) return
    if (this.queue.length > 0) {
      this.queue.shift()!()
    } else {
      this._current--
    }
  }
}
