/** 基于 Promise 的计数信号量，用于控制并发 */
export class Semaphore {
  private current = 0
  private queue: (() => void)[] = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.max <= 0) return
    if (this.current < this.max) {
      this.current++
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
      this.current--
    }
  }
}
