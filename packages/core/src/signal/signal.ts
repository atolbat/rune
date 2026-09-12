// Signal cell: value + version (for dirty checks) + subscribers.
// Notifications go through schedule() from batch.ts: outside a batch —
// immediately, inside batch/epoch.frame — once on exit (§9.11.2: a push
// in signal within a frame → reactive derives get consistent state).

import { reportRead } from './tracking.ts'
import { inBatch, schedule } from './batch.ts'

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

  /** Deliver a snapshot to the current subscribers. ONE subscriber — no
   * array copy: the loop breaks right after the first callback, so a fn
   * subscribed DURING that callback is not visited (the same guarantee the
   * copy gives below). More — copy: iterating a live Set visits mid-callback
   * additions, and combined with resubscribing callbacks that is a livelock. */
  function notify(snapshot: T): void {
    if (subscribers.size === 1) {
      for (const fn of subscribers) {
        fn(snapshot)
        break
      }
      return
    }
    for (const fn of [...subscribers]) fn(snapshot)
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
      // No subscribers → nothing to notify: skip the closure + the batch
      // queue entry entirely (polled cells — the version/dirty-check path —
      // pay zero allocations per write).
      if (subscribers.size === 0) return
      if (inBatch()) {
        // Inside a batch each write schedules its own notification with its
        // own snapshot — the value is fixed at the moment of the write: a
        // subscriber sees what was written, even if the cell is overwritten
        // again during the batch (effects are deduplicated at their own
        // level, see EffectCell.queueRerun).
        const snapshot = current
        schedule(() => notify(snapshot))
      } else {
        // Outside a batch schedule() would run the job synchronously —
        // notify directly, without allocating the per-write closure (the
        // audit's "signal.set closure per write": count/transport cells
        // are written per frame; the immediate path was paying a closure +
        // a batch entry for every single one).
        notify(next)
      }
    },
    peek: () => current,
    subscribe,
    get version() { return version },
  }
  return cell
}
