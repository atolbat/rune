// Signal cell: value + version (for dirty checks) + subscribers.
// Notifications go through schedule() from batch.ts: outside a batch —
// immediately, inside batch/epoch.frame — once on exit (§9.11.2: a push
// in signal within a frame → reactive derives get consistent state).

import { reportRead } from './tracking.ts'
import { schedule } from './batch.ts'

export interface SignalOptions {
  /** Name for diagnostics. */
  readonly name?: string
}

export interface SignalCell<T> {
  get value(): T
  set value(next: T)
  peek(): T
  subscribe(fn: (value: T) => void): () => void
  /** Monotonic write counter — the basis of dirty checks for live commands. */
  readonly version: number
}

export function signal<T>(initial: T, _options: SignalOptions = {}): SignalCell<T> {
  let current = initial
  let version = 0
  const subscribers = new Set<(value: T) => void>()

  function subscribe(fn: (value: T) => void): () => void {
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }

  const cell: SignalCell<T> = {
    get value() {
      reportRead(cell)
      return current
    },
    set value(next: T) {
      if (next === current) return
      current = next
      version++
      // The value is fixed at the moment of the write: a subscriber sees
      // what was written, even if the cell is overwritten again during the
      // batch (each write schedules its own notification — effects are
      // deduplicated at their own level, see EffectCell.queueRerun).
      const snapshot = current
      schedule(() => {
        // Snapshot: a subscriber may unsubscribe/resubscribe (effect rebind,
        // derive rebind) right in the callback — mutating a live Set during
        // iteration combined with synchronous schedule gives a livelock.
        for (const fn of [...subscribers]) fn(snapshot)
      })
    },
    peek: () => current,
    subscribe,
    get version() { return version },
  }
  return cell
}
