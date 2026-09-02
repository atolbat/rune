import type { ReadableSignal, Unsubscribe } from './types.ts'
import { pushCollector, popCollector } from './tracking.ts'
import { schedule } from './batch.ts'
import { detachAll } from './shared.ts'

/** Runs an effect; returns the stop function. Inside a batch — one rerun. */
export function effect(run: () => void): Unsubscribe {
  const cell = new EffectCell(run)
  return () => cell.dispose()
}

/** Effect: recomputes when dependencies change. */
class EffectCell {
  private readonly run: () => void
  private subscriptions: Unsubscribe[] = []
  /** The dependency list of the LAST bind — rebind compares against it. */
  private boundDeps: ReadableSignal<any>[] = []
  private disposed = false
  private rerunQueued = false

  /** ONE hoisted callback for every dependency (the derive.ts pattern):
 *  a rerun rebinds N deps without allocating N closures per rerun. */
  private readonly onDepChange = (): void => {
    this.queueRerun()
  }

  constructor(run: () => void) {
    this.run = run
    this.rerun()
  }

  dispose(): void {
    this.disposed = true
    detachAll(this.subscriptions)
    this.subscriptions = []
    this.boundDeps = []
  }

  private rerun(): void {
    if (this.disposed) return
    const collected: ReadableSignal<any>[] = []
    this.trackRun(collected)
    this.rebind(collected)
  }

  private trackRun(collected: ReadableSignal<any>[]): void {
    // The same tracking stack as in derive: signal.value on read
    // registers the cell in the active collector (reportRead → push).
    pushCollector(collected as unknown[])
    try {
      this.run()
    } finally {
      popCollector()
    }
  }

  private rebind(next: ReadableSignal<any>[]): void {
    // An unchanged dependency list (the common case — a rerun reads the same
    // cells in the same order) keeps the existing subscriptions instead of
    // churning N closures + an array per rerun.
    if (next.length === this.boundDeps.length) {
      let same = true
      for (let at = 0; at < next.length; at++) {
        if (next[at] !== this.boundDeps[at]) { same = false; break }
      }
      if (same) return
    }
    detachAll(this.subscriptions)
    this.subscriptions = next.map(dep => dep.subscribe(this.onDepChange))
    this.boundDeps = next
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
