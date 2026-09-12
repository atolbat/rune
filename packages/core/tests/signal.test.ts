import { describe, expect, it } from 'bun:test'
import { signal } from '../src/signal/signal.ts'
import { derive } from '../src/signal/derive.ts'
import { batch } from '../src/signal/batch.ts'

describe('signals', () => {
  it('a write changes the value and bumps the version', () => {
    const cell = signal(1)
    expect(cell.value).toBe(1)
    expect(cell.version).toBe(0)
    cell.value = 2
    expect(cell.value).toBe(2)
    expect(cell.version).toBe(1)
  })

  it('a repeat write of the same value does not bump the version', () => {
    const cell = signal(5)
    cell.value = 5
    expect(cell.version).toBe(0)
  })

  it('a subscription receives values, unsubscribe stays silent', () => {
    const cell = signal(0)
    const seen: number[] = []
    const off = cell.subscribe(v => seen.push(v))
    cell.value = 1
    cell.value = 2
    off()
    cell.value = 3
    expect(seen).toEqual([1, 2])
  })

  it('derive recomputes on dependency change', () => {
    const width = signal(800)
    const height = signal(600)
    const aspect = derive(() => width.value / height.value)
    expect(aspect.peek()).toBeCloseTo(800 / 600)
    height.value = 400
    expect(aspect.peek()).toBeCloseTo(2)
  })

  it('peek of derive does not recompute on clean dependencies', () => {
    let computations = 0
    const base = signal(1)
    const derived = derive(() => { computations++; return base.value * 2 })
    expect(derived.peek()).toBe(2)
    expect(derived.peek()).toBe(2)
    expect(computations).toBeLessThanOrEqual(2)
  })
})

describe('signal.set — the notification path (Task 184: no per-write closure outside a batch)', () => {
  it('outside a batch the notification is synchronous', () => {
    const cell = signal(0)
    let delivered = false
    cell.subscribe(() => { delivered = true })
    cell.value = 1
    // schedule() would run the job synchronously too — the observable
    // contract is: by the time the write statement returns, the subscriber
    // has already seen the value.
    expect(delivered).toBe(true)
  })

  it('inside a batch each write delivers its own snapshot, in write order', () => {
    const cell = signal(0)
    const seen: number[] = []
    cell.subscribe(v => seen.push(v))
    batch(() => {
      cell.value = 1
      cell.value = 2 // a second write in the same batch — its own notification
    })
    // the subscriber sees WHAT WAS WRITTEN (v1 then v2), not the final value twice
    expect(seen).toEqual([1, 2])
  })

  it('ONE subscriber: a fn subscribed DURING the callback is not notified (the copy guarantee)', () => {
    const cell = signal(0)
    const seen: number[] = []
    cell.subscribe(v => {
      seen.push(v)
      // re-entrant subscribe mid-notification — must NOT receive this same
      // notification (the array-copy form guarantees it; the single-subscriber
      // fast path must not regress it)
      cell.subscribe(late => seen.push(-late))
    })
    cell.value = 7
    expect(seen).toEqual([7])
    // the late subscriber is live for the NEXT write only
    cell.value = 9
    expect(seen).toEqual([7, 9, -9])
  })

  it('MANY subscribers: mid-callback additions are not visited, the rest of the copy is', () => {
    const cell = signal(0)
    const seen: string[] = []
    cell.subscribe(v => {
      seen.push(`a:${v}`)
      cell.subscribe(lv => seen.push(`late:${lv}`))
    })
    cell.subscribe(v => seen.push(`b:${v}`))
    cell.value = 5
    // a sees it, its late addition is skipped, b still gets it
    expect(seen).toEqual(['a:5', 'b:5'])
    // the late subscriber is live for the NEXT write (set order: a, b, late)
    cell.value = 6
    expect(seen).toEqual(['a:5', 'b:5', 'a:6', 'b:6', 'late:6'])
  })

  it('ONE subscriber unsubscribing itself mid-callback still receives the current notification', () => {
    const cell = signal(0)
    const seen: number[] = []
    const off = cell.subscribe(v => {
      seen.push(v)
      off()
    })
    cell.value = 3
    cell.value = 4
    expect(seen).toEqual([3])
  })
})
