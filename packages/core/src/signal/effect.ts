import type { ReadableSignal, Unsubscribe } from './types.ts'
import { pushCollector, popCollector } from './tracking.ts'
import { schedule } from './batch.ts'
import { detachAll, pushUnique } from './shared.ts'

/** Запускает эффект; возвращает остановку. Внутри batch — один перевыпуск. */
export function effect(run: () => void): Unsubscribe {
  const cell = new EffectCell(run)
  return () => cell.dispose()
}

/** Эффект: перевычисляется при изменении зависимостей. */
class EffectCell {
  private readonly run: () => void
  private subscriptions: Unsubscribe[] = []
  private disposed = false
  private rerunQueued = false

  constructor(run: () => void) {
    this.run = run
    this.rerun()
  }

  dispose(): void {
    this.disposed = true
    detachAll(this.subscriptions)
  }

  private rerun(): void {
    if (this.disposed) return
    const collected: ReadableSignal<any>[] = []
    this.trackRun(collected)
    this.rebind(collected)
  }

  private trackRun(collected: ReadableSignal<any>[]): void {
    // Тот же стек трекинга, что у derive: signal.value при чтении
    // регистрирует ячейку в активном сборщике (reportRead → push).
    pushCollector(collected as unknown[])
    try {
      this.run()
    } finally {
      popCollector()
    }
  }

  private rebind(next: ReadableSignal<any>[]): void {
    detachAll(this.subscriptions)
    this.subscriptions = next.map(dep => dep.subscribe(() => this.queueRerun()))
  }

  private queueRerun(): void {
    if (this.rerunQueued || this.disposed) return
    this.rerunQueued = true
    schedule(() => {
      this.rerunQueued = false
      this.rerun()
    })
  }
}
