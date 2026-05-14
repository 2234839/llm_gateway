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

  async acquire(): Promise<void> {
    if (this.max <= 0) return
    if (this._current < this.max) {
      this._current++
      return
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
  }

  release(): void {
    if (this.max <= 0) return
    if (this.queue.length > 0) {
      this.queue.shift()!()
    } else {
      this._current--
    }
  }
}
