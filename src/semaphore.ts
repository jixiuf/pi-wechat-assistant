// ============================================================================
// 简单信号量：并发控制（图片预取等）
// 从 queue.ts 抽出（纯逻辑，无依赖）
// ============================================================================

export class Semaphore {
  private _permits: number
  private readonly _waiters: Array<() => void> = []

  constructor(permits: number) {
    this._permits = permits
  }

  async acquire(): Promise<void> {
    if (this._permits > 0) { this._permits--; return }
    return new Promise<void>(resolve => this._waiters.push(resolve))
  }

  release(): void {
    const waiter = this._waiters.shift()
    if (waiter) { waiter() } else { this._permits++ }
  }
}
