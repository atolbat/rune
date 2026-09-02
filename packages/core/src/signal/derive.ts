// Derived signal: recomputes when dependency versions have moved forward.
// Subscription semantics are PUSH: when a dependency changes, a derived with
// subscribers recomputes immediately (outside a batch — right away, inside —
// at the frame boundary via schedule). Without subscribers recomputation is
// LAZY: the first read of .value sees the new stamp and recomputes (the
// dossier chapter "reactivity without an eager storm").
//
// Cleanliness is checked by ELEMENT-WISE comparison of dependency versions,
// not a sum: a sum collides when a derived is itself a dependency of another
// derived (the version-sum may DECREASE when the dependency set changes and
// compensate a neighbor's growth — a false "clean"). The public version is a
// monotonic revision of recomputes: an external observer (live command,
// nested derive) sees a strictly increasing counter.

import { popCollector, pushCollector, reportRead } from './tracking.ts'
import type { SignalCell } from './signal.ts'
import type { Unsubscribe } from './types.ts'

export interface DerivedSignal<T> {
  get value(): T
  peek(): T
  subscribe(fn: (value: T) => void): () => void
  readonly version: number
}

export function derive<T>(compute: () => T): DerivedSignal<T> {
  let deps: SignalCell<unknown>[] = []
  let depVersions: number[] = []
  let cached = collect()
  snapshotVersions()
  let revision = 0
  const subscribers = new Set<(value: T) => void>()
  let unsubscribes: Unsubscribe[] = []

  /** Recompute, collecting dependencies via the tracking stack. */
  function collect(): T {
    deps = []
    pushCollector(deps)
    const next = compute()
    popCollector()
    return next
  }

  /** Snapshot of dependency versions — the element-wise dirty-check base. */
  function snapshotVersions(): void {
    depVersions = []
    for (const dep of deps) depVersions.push((dep as SignalCell<unknown>).version)
  }

  /** Any dependency moved forward — recompute (no sums: no collisions). */
  function dirty(): boolean {
    for (let at = 0; at < deps.length; at++) {
      if ((deps[at] as SignalCell<unknown>).version !== depVersions[at]) return true
    }
    return false
  }

  /** Subscribe to each current dependency (after collect). */
  function rebind(): void {
    for (const unsubscribe of unsubscribes) unsubscribe()
    unsubscribes = deps.map(dep =>
      dep.subscribe(() => {
        // The push path is only enabled when subscribers exist; otherwise lazy.
        if (subscribers.size > 0) revalidate()
      }),
    )
  }

  function revalidate(): boolean {
    if (!dirty()) return false
    const previous = cached
    cached = collect()
    snapshotVersions()
    revision++
    rebind()
    if (cached !== previous && subscribers.size > 0) {
      // Subscriber snapshot: a callback may unsubscribe or (through a derive
      // chain) rebind dependencies — iterate over a copy (see signal.ts).
      for (const fn of [...subscribers]) fn(cached)
    }
    return true
  }

  const derived: DerivedSignal<T> = {
    get value() {
      revalidate()
      reportRead(derived)
      return cached
    },
    peek: () => {
      revalidate()
      return cached
    },
    subscribe(fn: (value: T) => void): (() => void) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    get version() {
      revalidate()
      return revision
    },
  }
  rebind()
  return derived
}
