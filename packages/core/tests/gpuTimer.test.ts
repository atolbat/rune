/**
 * GpuTimer tests — the interface + StatsCollector integration.
 *
 * Covers:
 *  - GpuTimer: mock begin/end/result — the result is shifted by one frame
 *  - StatsCollector.setGpuTimer(null) → gpuMs = null
 *  - StatsCollector.setGpuTimer(timer) → gpuMs appears after 2 frames
 *  - Snapshot reflects the current gpuMs
 *  - Disjoint (timer.result=null) → gpuMs resets to null
 */

import { test } from 'bun:test'
import { expect } from 'bun:test'
import { createStatsCollector } from '@rune/core'
import type { GpuTimer } from '@rune/core'

// ─── Mock GpuTimer — fixed results for tests ─────────────────────

function createMockGpuTimer(results: (number | null)[]): GpuTimer {
  let idx = 0
  let active = false
  return {
    begin() {
      active = true
    },
    end() {
      active = false
    },
    result() {
      // Returns the next result from the array (or the last one)
      if (idx < results.length) {
        return results[idx++]!
      }
      return results[results.length - 1] ?? null
    },
  }
}

// ─── StatsCollector without a timer → gpuMs=null ───────────────────────────────────

test('StatsCollector without a timer → gpuMs = null in the snapshot', () => {
  let t = 0
  const sc = createStatsCollector(() => t)
  sc.beginFrame()
  t = 5
  sc.addDrawCall()
  sc.endFrame()
  const s = sc.snapshot()
  expect(s.cpuMs).toBe(5)
  expect(s.gpuMs).toBeNull()
})

// ─── StatsCollector.setGpuTimer(null) → gpuMs stays null ──────────────────

test('StatsCollector.setGpuTimer(null) → gpuMs = null', () => {
  let t = 0
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(null)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()
})

// ─── GpuTimer: frame 1 → result=null (no previous), frame 2 → a number ────

test('GpuTimer mock: frame 1 result() returns null, frame 2 — a number', () => {
  let t = 0
  // Sequence: frame 1 begin/end → result=null (no past)
  //                       frame 2 begin/end → result=12.3 (the previous frame)
  const timer = createMockGpuTimer([null, 12.3])
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(timer)

  // Frame 1
  sc.beginFrame() // timer.begin() — the query is open
  t = 5
  sc.endFrame() // timer.end() — the query is closed

  // At snapshot time after frame 1 — gpuMs=null (no past query)
  // (begin read null from timer.result() — that is the gpuMs)
  expect(sc.snapshot().gpuMs).toBeNull()

  // Frame 2
  sc.beginFrame() // timer.begin() → timer.result() returns 12.3 (the previous one)
  t = 10
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBe(12.3)
})

// ─── GpuTimer: disjoint → result=null → gpuMs resets ──────────────────

test('GpuTimer mock: disjoint (result=null in the middle) → gpuMs=null', () => {
  let t = 0
  // Sequence: frame 1 → result=null (no past)
  //                       frame 2 → result=15.5 (the previous frame)
  //                       frame 3 → result=null (disjoint, reset)
  const timer = createMockGpuTimer([null, 15.5, null])
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(timer)

  // Frame 1 — gpuMs = null (no past)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()

  // Frame 2 — gpuMs = 15.5 (the previous frame)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBe(15.5)

  // Frame 3 — gpuMs = null (disjoint reset)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()
})

// ─── setGpuTimer after frame 1 — the next frame reads null ───────────────

test('setGpuTimer(t) after frame 1 → next frame gpuMs=null (no past)', () => {
  let t = 0
  const sc = createStatsCollector(() => t)
  // Frame 1 without a timer
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()

  // Attach the timer after frame 1
  const timer = createMockGpuTimer([null, 42.0])
  sc.setGpuTimer(timer)

  // Frame 2 — timer.begin pulls result() → null (no past)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()

  // Frame 3 — timer.begin pulls result() → 42.0 (frame 2 is closed)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBe(42.0)
})

// ─── setGpuTimer(null) after the timer has run → gpuMs is null again ─────────────────

test('setGpuTimer(null) after running → gpuMs is null again', () => {
  let t = 0
  const timer = createMockGpuTimer([null, 99.9])
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(timer)

  // Frame 1
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()

  // Frame 2
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBe(99.9)

  // Detach the timer
  sc.setGpuTimer(null)

  // Frame 3 — gpuMs is null again (no timer)
  sc.beginFrame()
  sc.endFrame()
  expect(sc.snapshot().gpuMs).toBeNull()
})

// ─── drawCalls and memory do not depend on the timer ─────────────────────────────────

test('StatsCollector with a timer: drawCalls and memoryEstimate work independently', () => {
  let t = 0
  const timer = createMockGpuTimer([null, 7.7])
  const sc = createStatsCollector(() => t)
  sc.setGpuTimer(timer)

  sc.beginFrame()
  t = 3
  sc.addDrawCall()
  sc.addDrawCall()
  sc.addMemory(1024)
  sc.endFrame()
  const s = sc.snapshot()
  expect(s.cpuMs).toBe(3)
  expect(s.drawCalls).toBe(2)
  expect(s.memoryEstimate).toBe(1024)
  expect(s.gpuMs).toBeNull() // first frame, no past

  // Frame 2
  sc.beginFrame()
  sc.addDrawCall()
  sc.endFrame()
  const s2 = sc.snapshot()
  expect(s2.gpuMs).toBe(7.7)
  expect(s2.drawCalls).toBe(1) // a new frame, reset to zero
  expect(s2.memoryEstimate).toBe(1024) // an accumulator
  expect(s2.frameCount).toBe(2)
})

// ─── GpuTimer idempotent: begin twice = no-op ───────────────────────────────

test('GpuTimer mock: begin twice in a row = no-op (does not throw)', () => {
  const timer = createMockGpuTimer([5.0])
  // begin twice with no end in between
  expect(() => {
    timer.begin()
    timer.begin()
  }).not.toThrow()
  timer.end()
  expect(timer.result()).toBe(5.0)
})

// ─── GpuTimer end without begin = no-op ──────────────────────────────────────────

test('GpuTimer mock: end without begin = no-op', () => {
  const timer = createMockGpuTimer([3.3])
  expect(() => timer.end()).not.toThrow()
  expect(timer.result()).toBe(3.3)
})
