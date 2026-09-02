import { describe, expect, it } from 'bun:test'
import { signal, derive } from '../src/index.ts'

describe('derive', () => {
  it('computes once and caches until invalidated', () => {
    const base = signal(2)
    let computations = 0
    const doubled = derive(() => {
      computations++
      return base.value * 2
    })

    expect(doubled.value).toBe(4)
    expect(doubled.value).toBe(4)
    expect(computations).toBe(1)

    base.value = 5
    expect(doubled.value).toBe(10)
    expect(computations).toBe(2)
  })

  it('does not recompute eagerly without subscribers', () => {
    const base = signal(1)
    let computations = 0
    derive(() => {
      computations++
      return base.value + 1
    })

    base.value = 2
    base.value = 3
    expect(computations).toBe(1) // constructor only
  })

  it('builds chains of derivations', () => {
    const a = signal(1)
    const b = derive(() => a.value + 1)
    const c = derive(() => b.value * 10)

    expect(c.value).toBe(20)
    a.value = 2
    expect(c.value).toBe(30)
  })

  it('a derivation subscriber receives a fresh value', () => {
    const base = signal(1)
    const doubled = derive(() => base.value * 2)
    const observed: number[] = []
    doubled.subscribe(value => observed.push(value))

    base.value = 4
    expect(observed).toEqual([8])
  })

  it('version grows on every real recomputation', () => {
    const base = signal(1)
    const derived = derive(() => base.value + 1)
    const initial = derived.version
    base.value = 2
    expect(derived.value).toBe(3)
    expect(derived.version).toBeGreaterThan(initial)
  })

  it('version-sum regression: a decrease in the inner version does not "mask" the outer one', () => {
    // The sum of dependency versions could DECREASE when the set of
    // dependencies changed (b left, useB grew) — the outer derive saw "clean"
    // and returned a stale value. Element-wise comparison prevents this.
    const a = signal(1)
    const b = signal(100)
    const c = signal(1000)
    const useB = signal(true)
    const inner = derive(() => a.value + (useB.value ? b.value : 0))
    const outer = derive(() => inner.value + c.value)
    expect(outer.value).toBe(1101) // 1 + 100 + 1000

    b.value = 200
    expect(outer.value).toBe(1201) // 1 + 200 + 1000

    useB.value = false // inner loses b: its old version-sum returned to the previous value
    expect(inner.value).toBe(1)
    expect(outer.value).toBe(1001) // the old code's stale answer: 1201
  })

  it('version — a monotonic revision: does not decrease when the dependency set changes', () => {
    const a = signal(1)
    const b = signal(100)
    const useB = signal(true)
    const inner = derive(() => (useB.value ? a.value + b.value : a.value))
    const v1 = inner.version
    b.value = 200
    const v2 = inner.version
    useB.value = false // b leaves the dependency set — the revision still grows
    const v3 = inner.version
    expect(v2).toBeGreaterThan(v1)
    expect(v3).toBeGreaterThan(v2)
  })
})
