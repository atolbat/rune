/**
 * Task 102 (§8-5/§8-6): present.ts — unit tests of the present-path machine.
 *
 * Decay/PathRegistry/PathState — pure logic: sample windows, percentiles,
 * ratio transitions, the selection cascade, the pressure gate, filters. The
 * canonical path registry (§9.7) is tested on fake-caps (createCaps with a
 * paths map). The execution of runs — browser (e2e smoke-present);
 * here — the state machine and registration.
 */

import { describe, expect, it } from 'bun:test'
import { createCaps } from '@rune/core'
import type { Caps, PathSupport } from '@rune/core'
import {
  createDecayWindow,
  createPathRegistry,
  createPresentRegistry,
  DEGRADATION_RATIO,
  DEGRADE_WARN_RATIO,
  DEGRADATION_NOISE_FLOOR_MS,
  DEGRADATION_RECOVERY_MS,
  DEGRADATION_RECOVERY_BACKOFF,
  DEGRADATION_RECOVERY_MAX_MS,
  PRESSURE_HYSTERESIS,
  DEGRADATION_ABSOLUTE_MS,
} from '../src/present.ts'

/** Caps with a given present-path map (everything else — empty). */
function fakeCaps(paths: Record<string, PathSupport>): Caps {
  return createCaps({
    features: new Set(),
    formatMatrix: new Map(),
    paths: new Map(Object.entries(paths)),
    extensions: new Map(),
    limits: {},
    backend: 'test',
  })
}

/** The full set of keys needed by the canonical paths (all supported). */
function richCaps(): Caps {
  return fakeCaps({
    'canvas-direct': 'supported',
    'blit': 'supported',
    'preserve': 'supported',
    'OffscreenCanvas': 'supported',
    'transferToImageBitmap': 'supported',
    'bitmaprenderer': 'supported',
    'createImageBitmap': 'supported',
    'createImageBitmap.resize': 'supported',
    'Canvas2D': 'supported',
    'WebGPU': 'supported',
    'WebGPU.copyExternalImage': 'supported',
  })
}

/** A small registry with fast thresholds (no waiting for 30 samples). */
function smallRegistry() {
  return createPathRegistry({ window: 30, minSamples: 10, warnRatio: 1.2, disableRatio: 1.5 })
}

// ─── DecayWindow ─────────────────────────────────────────────────────────────

describe('createDecayWindow', () => {
  it('uniform samples → p50 = p95, ratio 1', () => {
    const w = createDecayWindow(120)
    for (let i = 0; i < 50; i++) w.push(2)
    const s = w.stats()
    expect(s.count).toBe(50)
    expect(s.p50).toBe(2)
    expect(s.p95).toBe(2)
    expect(s.ratio).toBe(1)
  })

  it('noise floor: sub-millisecond fluctuations — NOT degradation', () => {
    // Task 102 measurement (SwiftShader): draw2d p50 0.1 / p95 0.5 ms — "ratio 5"
    // on negligible absolutes. p95 below the threshold → ratio honestly 1.
    const w = createDecayWindow(120)
    for (let i = 0; i < 100; i++) w.push(0.1)
    for (let i = 0; i < 20; i++) w.push(0.5)
    const s = w.stats()
    expect(s.p95).toBe(0.5)
    expect(s.ratio).toBe(1)
    // a configurable threshold: an application looking for degradation at 120 Hz lowers it
    const hi = createDecayWindow(120, 0.2)
    for (let i = 0; i < 100; i++) hi.push(0.1)
    for (let i = 0; i < 20; i++) hi.push(0.5)
    expect(hi.stats().ratio).toBe(5)
  })

  it('spikes give ratio ≥ 1.5 (p95/p50 = 30)', () => {
    const w = createDecayWindow(120)
    for (let i = 0; i < 100; i++) w.push(1)
    for (let i = 0; i < 20; i++) w.push(30)
    const s = w.stats()
    expect(s.p50).toBe(1)
    expect(s.p95).toBe(30)
    expect(s.ratio).toBe(30)
  })

  it('the window evicts old spikes (statistics recovery)', () => {
    const w = createDecayWindow(10)
    for (let i = 0; i < 10; i++) w.push(100)
    for (let i = 0; i < 10; i++) w.push(1)
    const s = w.stats()
    expect(s.count).toBe(10)
    expect(s.p50).toBe(1)
    expect(s.p95).toBe(1)
    expect(s.ratio).toBe(1)
  })

  it('delta guard (Task 104): a p95 − p50 spike below the threshold — scheduler noise, not degradation', () => {
    // Mali measurement: a live path p50 6 / p95 7.4 ms — "ratio 1.23" on the
    // async scheduler jitter; the 1.4 ms delta does not eat the frame budget at
    // 60 or 120 Hz → ratio 1, the path is alive.
    const w = createDecayWindow(120)
    for (let i = 0; i < 100; i++) w.push(6)
    for (let i = 0; i < 20; i++) w.push(7.4)
    const s = w.stats()
    expect(s.p50).toBe(6)
    expect(s.p95).toBe(7.4)
    expect(s.ratio).toBe(1)
    // a real spike (delta 9 ms ≥ 2) — an honest ratio 2.5
    const real = createDecayWindow(120)
    for (let i = 0; i < 100; i++) real.push(6)
    for (let i = 0; i < 20; i++) real.push(15)
    expect(real.stats().ratio).toBe(2.5)
    // the threshold is configurable: an app with a 120 Hz budget catches small deltas too
    const fine = createDecayWindow(120, 0.5)
    for (let i = 0; i < 100; i++) fine.push(6)
    for (let i = 0; i < 20; i++) fine.push(7.4)
    expect(fine.stats().ratio).toBeCloseTo(7.4 / 6, 5)
  })

  it('p50 = 0 (timer quantization): the denominator — 1 ms', () => {
    const w = createDecayWindow(120)
    for (let i = 0; i < 100; i++) w.push(0)
    for (let i = 0; i < 10; i++) w.push(8)
    expect(w.stats().ratio).toBe(8) // a spike over the zero floor — a signal
    const q = createDecayWindow(120)
    for (let i = 0; i < 100; i++) q.push(0)
    for (let i = 0; i < 10; i++) q.push(1)
    expect(q.stats().ratio).toBe(1) // quantization noise — not degradation
  })
})

// ─── PathRegistry: selection ──────────────────────────────────────────────────

describe('PathRegistry.select', () => {
  it('an empty registry → null', () => {
    expect(createPathRegistry().select(richCaps())).toBeNull()
  })

  it('rank decides: the smaller rank is chosen first', () => {
    const r = createPathRegistry()
    r.add('a', { rank: 20, run: () => {} })
    r.add('b', { rank: 10, run: () => {} })
    expect(r.select(richCaps())?.name).toBe('b')
  })

  it('without an explicit rank — insertion order', () => {
    const r = createPathRegistry()
    r.add('first', { run: () => {} })
    r.add('second', { run: () => {} })
    expect(r.select(richCaps())?.name).toBe('first')
  })

  it('requires as a string: a key not supported → unavailable, the cascade moves on', () => {
    const caps = richCaps()
    const r = createPathRegistry()
    r.add('gated', { requires: 'Canvas2D', rank: 10, run: () => {} })
    r.add('fallback', { rank: 20, run: () => {} })
    const gated = fakeCaps({ 'Canvas2D': 'unsupported' })
    expect(r.select(gated)?.name).toBe('fallback')
    expect(r.status('gated').status).toBe('unavailable')
    expect(r.status('gated').reason).toContain('requirements')
    expect(r.status('gated').reason).toContain('Canvas2D')
    expect(r.select(caps)?.name).toBe('gated') // predicate not needed: same caps object family
  })

  it('requires as a list: one dead key → unavailable', () => {
    const r = createPathRegistry()
    r.add('bitmap-like', { requires: ['OffscreenCanvas', 'transferToImageBitmap', 'bitmaprenderer'], rank: 10, run: () => {} })
    const caps = fakeCaps({ 'OffscreenCanvas': 'supported', 'transferToImageBitmap': 'unsupported', 'bitmaprenderer': 'supported' })
    expect(r.select(caps)).toBeNull()
    expect(r.status('bitmap-like').reason).toContain('transferToImageBitmap')
  })

  it('requires as a predicate: full control', () => {
    const r = createPathRegistry()
    const calls: string[] = []
    r.add('pred', { requires: caps => { calls.push(caps.backend); return caps.path('blit') === 'supported' }, rank: 10, run: () => {} })
    expect(r.select(fakeCaps({ 'blit': 'unsupported' }))).toBeNull()
    expect(r.select(fakeCaps({ 'blit': 'supported' }))?.name).toBe('pred')
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })

  it('a path without run is not chosen; includeRunless allows it', () => {
    const r = createPathRegistry()
    r.add('runless', { rank: 1, note: 'registry knowledge' })
    r.add('runner', { rank: 2, run: () => {} })
    expect(r.select(richCaps())?.name).toBe('runner')
    expect(r.select(richCaps(), 0, { includeRunless: true })?.name).toBe('runless')
  })

  it('pressureMax: the path drops out under pressure, returns without it', () => {
    const r = createPathRegistry()
    r.add('cheap-under-pressure', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('always', { rank: 20, run: () => {} })
    expect(r.select(richCaps(), 0.7)?.name).toBe('always')
    expect(r.select(richCaps(), 0)?.name).toBe('cheap-under-pressure')
    expect(r.select(richCaps(), 0.6)?.name).toBe('cheap-under-pressure') // the boundary inclusive
  })

  it('filter — a structural exclusion (an application scenario)', () => {
    const r = createPathRegistry()
    r.add('direct', { rank: 10, run: () => {} })
    r.add('bitmap', { rank: 50, run: () => {} })
    const offscreenScenario = (name: string): boolean => name !== 'direct'
    expect(r.select(richCaps(), 0, { filter: offscreenScenario })?.name).toBe('bitmap')
  })

  it('unavailable comes alive when caps improve (invalidate → re-probe)', () => {
    const r = createPathRegistry()
    r.add('draw2d', { requires: 'Canvas2D', rank: 10, run: () => {} })
    r.add('any', { rank: 20, run: () => {} })
    expect(r.select(fakeCaps({ 'Canvas2D': 'unsupported' }))?.name).toBe('any')
    expect(r.status('draw2d').status).toBe('unavailable')
    expect(r.select(fakeCaps({ 'Canvas2D': 'supported' }))?.name).toBe('draw2d')
    expect(r.status('draw2d').status).toBe('healthy')
  })

  it('remove takes the path out of selection', () => {
    const r = createPathRegistry()
    r.add('a', { rank: 10, run: () => {} })
    r.add('b', { rank: 20, run: () => {} })
    r.remove('a')
    expect(r.select(richCaps())?.name).toBe('b')
    expect(r.names).toEqual(['b'])
  })

  it('an add-replacement resets the state and rank', () => {
    const r = createPathRegistry()
    r.add('x', { rank: 1, run: () => {} })
    r.disable('x')
    expect(r.status('x').status).toBe('disabled')
    r.add('x', { rank: 5, run: () => {} })
    expect(r.status('x').status).toBe('healthy')
    expect(r.status('x').rank).toBe(5)
  })
})

// ─── PathRegistry.select: the last resort (Task 104) ──────────────────────

describe('PathRegistry.select — lastResort', () => {
  function allDead(): ReturnType<typeof createPathRegistry> {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('best', { rank: 10, run: () => {} })
    r.add('middle', { rank: 20, run: () => {} })
    for (const name of ['best', 'middle']) {
      for (let i = 0; i < 10; i++) r.report(name, 1)
      for (let i = 0; i < 10; i++) r.report(name, 30) // ratio 30 → disabled
    }
    return r
  }

  it('by default all disabled → null (the previous semantics)', () => {
    expect(allDead().select(richCaps())).toBeNull()
  })

  it('lastResort: the best disabled instead of null — showing matters more than quality', () => {
    const sel = allDead().select(richCaps(), 0, { lastResort: true })
    expect(sel?.name).toBe('best') // the smaller rank even among the disabled
    expect(sel?.state.status).toBe('disabled') // the status is honest — the consumer decides
  })

  it('unavailable does not sneak past lastResort', () => {
    const r = allDead()
    r.add('unavail', { rank: 5, requires: 'Canvas2D', run: () => {} })
    const caps = fakeCaps({ 'Canvas2D': 'unsupported' })
    const sel = r.select(caps, 0, { lastResort: true })
    expect(sel?.name).toBe('best') // an unavailable rank 5 is not chosen even by the last resort
  })

  it('lastResort respects the filter and the pressure gate (with the Task 106 hysteresis)', () => {
    const r = allDead()
    expect(r.select(richCaps(), 0, { lastResort: true, filter: n => n !== 'best' })?.name).toBe('middle')
    expect(r.select(richCaps(), 0, { lastResort: true, filter: () => false })).toBeNull()
    const gated = createPathRegistry({ window: 30, minSamples: 10 })
    gated.add('pressured', { rank: 10, pressureMax: 0.6, run: () => {} })
    gated.disable('pressured', 'operator')
    expect(gated.select(richCaps(), 0.7, { lastResort: true })).toBeNull() // pressure — the application's policy
    expect(gated.select(richCaps(), 0.5, { lastResort: true })).toBeNull() // the hysteresis band: the decision holds
    expect(gated.select(richCaps(), 0.4, { lastResort: true })?.name).toBe('pressured') // 0.4 ≤ 0.6 − 0.15 — return
  })

  it('lastResort does not return a path without run', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('runless', { rank: 1 })
    r.disable('runless')
    expect(r.select(richCaps(), 0, { lastResort: true })).toBeNull()
  })

  it('a live path is preferable to the last resort (does not "turn off" the healthy one)', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('dead', { rank: 5, run: () => {} })
    r.disable('dead')
    r.add('alive', { rank: 50, run: () => {} })
    expect(r.select(richCaps(), 0, { lastResort: true })?.name).toBe('alive')
  })
})

// ─── PathState: degradation ───────────────────────────────────────────────────

describe('PathRegistry.report — the degradation machine', () => {
  it('ratio spikes ≥ 1.5 → disabled, the selection cascades on', () => {
    const r = smallRegistry()
    r.add('best', { rank: 10, run: () => {} })
    r.add('next', { rank: 20, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('best', 1)
    expect(r.select(richCaps())?.name).toBe('best')
    for (let i = 0; i < 10; i++) r.report('best', 30) // p50=1, p95=30 → ratio 30
    const st = r.status('best')
    expect(st.status).toBe('disabled')
    expect(st.reason).toContain('degradation')
    expect(st.ratio).toBe(30)
    expect(r.select(richCaps())?.name).toBe('next')
  })

  it('degraded zone (1.2 ≤ ratio < 1.5): a healthy path is preferable', () => {
    const r = smallRegistry()
    r.add('wobbly', { rank: 10, run: () => {} })
    r.add('stable', { rank: 20, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('wobbly', 10)
    for (let i = 0; i < 10; i++) r.report('wobbly', 13) // p50=10, p95=13 → 1.3
    expect(r.status('wobbly').status).toBe('degraded')
    expect(r.select(richCaps())?.name).toBe('stable') // healthy preferred
  })

  it('degraded is chosen when there is no healthy one (last chance)', () => {
    const r = smallRegistry()
    r.add('only', { rank: 10, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('only', 10)
    for (let i = 0; i < 10; i++) r.report('only', 13)
    expect(r.status('only').status).toBe('degraded')
    expect(r.select(richCaps())?.name).toBe('only')
  })

  it('no transitions before minSamples (early statistics are noisy)', () => {
    const r = smallRegistry() // minSamples 10
    r.add('early', { rank: 10, run: () => {} })
    for (let i = 0; i < 9; i++) r.report('early', 50)
    expect(r.status('early').status).toBe('healthy')
  })

  it('sub-noise-floor reports do not disable the path, even if the "ratio" is large', () => {
    const r = smallRegistry()
    r.add('cheap', { rank: 10, run: () => {} })
    for (let i = 0; i < 40; i++) r.report('cheap', 0.1)
    for (let i = 0; i < 20; i++) r.report('cheap', 0.9) // p95 0.9 < 2 ms
    expect(r.status('cheap').status).toBe('healthy')
  })

  it('disabled is sticky at the report() level: clean frames do not cure — the probation period/reset does', () => {
    const r = smallRegistry()
    r.add('a', { rank: 10, run: () => {} })
    r.add('b', { rank: 20, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('a', 1)
    for (let i = 0; i < 10; i++) r.report('a', 30)
    expect(r.status('a').status).toBe('disabled')
    for (let i = 0; i < 30; i++) r.report('a', 1) // clean frames
    expect(r.status('a').status).toBe('disabled') // sticky: only the probation period (select + time) and reset() change the verdict
    r.reset('a')
    expect(r.status('a').status).toBe('healthy')
    expect(r.status('a').samples).toBe(0)
    expect(r.select(richCaps())?.name).toBe('a')
  })

  it('manual disable with a reason + a full reset()', () => {
    const r = smallRegistry()
    r.add('a', { rank: 10, run: () => {} })
    r.add('b', { rank: 20, run: () => {} })
    r.disable('a', 'operator: compositor artifacts')
    expect(r.status('a').status).toBe('disabled')
    expect(r.status('a').reason).toContain('operator')
    expect(r.select(richCaps())?.name).toBe('b')
    r.reset()
    expect(r.status('a').status).toBe('healthy')
    expect(r.select(richCaps())?.name).toBe('a')
  })

  it('report/status/disable on an unregistered path — throw', () => {
    const r = createPathRegistry()
    expect(() => r.report('ghost', 1)).toThrow()
    expect(() => r.status('ghost')).toThrow()
    expect(() => r.disable('ghost')).toThrow()
  })

  it('snapshot: all paths by rank with full statistics', () => {
    const r = smallRegistry()
    r.add('b', { rank: 20, run: () => {}, group: 'G2', note: 'n2' })
    r.add('a', { rank: 10, run: () => {}, group: 'G1', pressureMax: 0.6 })
    for (let i = 0; i < 12; i++) r.report('a', 1)
    const snap = r.snapshot()
    expect(snap.map(s => s.name)).toEqual(['a', 'b'])
    expect(snap[0]!.samples).toBe(12)
    expect(snap[0]!.pressureMax).toBe(0.6)
    expect(snap[1]!.group).toBe('G2')
    expect(snap[1]!.note).toBe('n2')
    expect(r.names).toEqual(['a', 'b'])
  })
})

// ─── onTransition: transition telemetry (Task 104) ─────────────────────

describe('PathRegistry — onTransition', () => {
  interface Mark { readonly name: string; readonly from: string; readonly to: string }

  it('report: healthy → degraded → disabled with full transition statistics', () => {
    const marks: Mark[] = []
    const r = createPathRegistry({
      window: 30,
      minSamples: 10,
      onTransition: t => { marks.push({ name: t.name, from: t.from, to: t.to }) },
    })
    r.add('p', { rank: 1, run: () => {} })
    for (let i = 0; i < 10; i++) r.report('p', 10)
    for (let i = 0; i < 10; i++) r.report('p', 13) // ratio 1.3 → degraded
    for (let i = 0; i < 10; i++) r.report('p', 30) // ratio → disabled
    // The machine is honest about the window transient: at frame 21 p95 "has
    // not yet reached" the single new spike (13/13 → ratio 1 → healthy),
    // at 22 the spike enters p95 (30/13 = 2.31 ≥ 1.5) — disabled at once.
    // The transition journal shows this moment too — telemetry without embellishment.
    expect(marks).toEqual([
      { name: 'p', from: 'healthy', to: 'degraded' },
      { name: 'p', from: 'degraded', to: 'healthy' },
      { name: 'p', from: 'healthy', to: 'disabled' },
    ])
    // the state in the transition — as of the moment AFTER (disabled is already visible)
    const r2 = createPathRegistry({
      window: 30,
      minSamples: 10,
      onTransition: t => {
        if (t.to === 'disabled') {
          expect(t.state.status).toBe('disabled')
          expect(t.state.ratio).toBeGreaterThanOrEqual(1.5)
          expect(t.state.reason).toContain('degradation')
        }
      },
    })
    r2.add('q', { rank: 1, run: () => {} })
    for (let i = 0; i < 10; i++) r2.report('q', 1)
    for (let i = 0; i < 10; i++) r2.report('q', 30)
  })

  it('a repeated report without a status change — NOT an event (only the reason refreshes)', () => {
    let fired = 0
    const r = createPathRegistry({ window: 30, minSamples: 10, onTransition: () => { fired++ } })
    r.add('p', { rank: 1, run: () => {} })
    for (let i = 0; i < 40; i++) r.report('p', 5) // healthy frames — zero transitions
    expect(fired).toBe(0)
  })

  it('disable/reset/select-availability also produce transitions', () => {
    const marks: Mark[] = []
    const r = createPathRegistry({ onTransition: t => { marks.push({ name: t.name, from: t.from, to: t.to }) } })
    r.add('a', { requires: 'Canvas2D', rank: 1, run: () => {} })
    const capsOff = fakeCaps({ 'Canvas2D': 'unsupported' })
    const capsOn = fakeCaps({ 'Canvas2D': 'supported' })
    r.select(capsOff) // → unavailable
    r.select(capsOn) // → healthy (revived)
    r.disable('a', 'operator')
    r.reset('a') // → healthy
    expect(marks).toEqual([
      { name: 'a', from: 'healthy', to: 'unavailable' },
      { name: 'a', from: 'unavailable', to: 'healthy' },
      { name: 'a', from: 'healthy', to: 'disabled' },
      { name: 'a', from: 'disabled', to: 'healthy' },
    ])
  })
})

// ─── The probation period (Task 105: field feedback "cut off forever") ─────

describe('PathRegistry — the probation period (auto-recovery)', () => {
  interface Mark { readonly name: string; readonly from: string; readonly to: string; readonly reason: string | null }

  /** A registry with fake clocks: disable → time passes → select(). */
  function rig(opts?: { recoveryMs?: number; recoveryMaxMs?: number; recoveryBackoff?: number }) {
    let t = 0
    const marks: Mark[] = []
    const r = createPathRegistry({
      window: 30,
      minSamples: 10,
      recoveryMs: opts?.recoveryMs,
      recoveryMaxMs: opts?.recoveryMaxMs,
      recoveryBackoff: opts?.recoveryBackoff,
      now: () => t,
      onTransition: tr => { marks.push({ name: tr.name, from: tr.from, to: tr.to, reason: tr.state.reason }) },
    })
    return {
      r,
      marks,
      advance: (ms: number) => { t += ms },
      /** ratio 30 (10×1 + 10×30) → disabled at the current fake clock. */
      kill: (name: string) => {
        for (let i = 0; i < 10; i++) r.report(name, 1)
        for (let i = 0; i < 10; i++) r.report(name, 30)
        if (r.status(name).status !== 'disabled') throw new Error(`rig: ${name} did not get disabled`)
      },
    }
  }

  it('a degradation-disable is cured by time: after the cooldown select() re-arms the path', () => {
    const { r, advance, kill, marks } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(4999) // ms — a second before the deadline
    expect(r.select(richCaps())).toBeNull() // still disabled, no live ones
    advance(2) // 5001 ≥ 5000
    const sel = r.select(richCaps())
    expect(sel?.name).toBe('a')
    expect(sel?.state.status).toBe('healthy')
    expect(sel?.state.samples).toBe(0) // the window is fresh — the old jank does not carry over
    expect(sel?.state.reason).toContain('probation')
    const last = marks[marks.length - 1]!
    expect(`${last.from} → ${last.to}`).toBe('disabled → healthy')
    expect(last.reason).toContain('re-probe after 5 s')
  })

  it('the waiting ladder: a relapse doubles the cooldown (anti-flapper)', () => {
    const { r, advance, kill } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a') // cooldown 5 s
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // probation period #1
    kill('a') // relapse → cooldown 10 s
    advance(5000)
    expect(r.select(richCaps())).toBeNull() // too early: waited 5 of 10 s
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // probation period #2
  })

  it('the ladder ceiling: the wait does not grow indefinitely', () => {
    const { r, advance, kill } = rig({ recoveryMs: 40000 }) // relapse: 80 s → ceiling 60 s
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(40000)
    expect(r.select(richCaps())?.name).toBe('a')
    kill('a') // 40000 × 2 = 80000, but the ceiling is 60000
    advance(59999)
    expect(r.select(richCaps())).toBeNull()
    advance(1) // exactly 60000
    expect(r.select(richCaps())?.name).toBe('a')
  })

  it('a clean full window after the period — the ladder starts over', () => {
    const { r, advance, kill } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // probations = 1
    for (let i = 0; i < 30; i++) r.report('a', 1) // a full clean window → the reputation is clean
    kill('a') // if the ladder remembered the relapse — cooldown 10 s
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // but it is 5 s again
  })

  it('manual disable() — forever: time does not cure the operator decision', () => {
    const { r, advance, marks } = rig()
    r.add('a', { rank: 10, run: () => {} })
    r.disable('a') // without a reason = manual
    advance(10_000_000) // even three months
    expect(r.select(richCaps())).toBeNull()
    expect(r.status('a').status).toBe('disabled')
    expect(marks.filter(m => m.to === 'healthy')).toHaveLength(0) // not a single probation period
    expect(r.select(richCaps(), 0, { lastResort: true })?.name).toBe('a') // but the last resort gives it
  })

  it('disable with a reason (an execution error) — a temporary verdict: the period will revive it', () => {
    const { r, advance } = rig()
    r.add('a', { rank: 10, run: () => {} })
    r.disable('a', 'execution error: createImageBitmap failed under memory pressure')
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a') // a transient error could have passed
  })

  it('recoveryMs: Infinity — the previous sticky semantics (disabled forever until reset)', () => {
    const { r, advance, kill } = rig({ recoveryMs: Number.POSITIVE_INFINITY })
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(10_000_000)
    expect(r.select(richCaps())).toBeNull()
    expect(r.status('a').status).toBe('disabled')
    r.reset()
    expect(r.select(richCaps())?.name).toBe('a')
  })

  it('the last resort statistics stay live: samples are written even to the disabled one', () => {
    const { r, kill } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a') // the window has 10×1 + 10×30
    for (let i = 0; i < 30; i++) r.report('a', 1) // the jank ended long ago — the path is fast
    const st = r.status('a')
    expect(st.status).toBe('disabled') // the verdict is sticky…
    expect(st.samples).toBe(30) // …but the statistics are live: the window is already clean
    expect(st.p50).toBe(1)
    expect(st.p95).toBe(1)
  })

  it('the probation period does not bypass the filter/pressure: the path is healthy but not chosen', () => {
    const { r, advance, kill } = rig()
    r.add('a', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('b', { rank: 20, run: () => {} })
    kill('a')
    advance(5000)
    const sel = r.select(richCaps(), 0.7) // pressure cuts even the healthy one
    expect(sel?.name).toBe('b')
    expect(r.status('a').status).toBe('healthy') // the period has served — the path is ready to return
    expect(r.select(richCaps(), 0.5)?.name).toBe('b') // the hysteresis band — the decision holds (Task 106)
    expect(r.select(richCaps(), 0.4)?.name).toBe('a') // 0.4 ≤ 0.45 — the best rank is back in the game
  })

  it('reset() cleans the ladder too: after the reset the first disable waits for the base again', () => {
    const { r, advance, kill } = rig()
    r.add('a', { rank: 10, run: () => {} })
    kill('a')
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a')
    kill('a') // relapse: 10 s
    r.reset()
    expect(r.status('a').status).toBe('healthy')
    kill('a') // after reset — the base 5 s again
    advance(5000)
    expect(r.select(richCaps())?.name).toBe('a')
  })
})

// ─── The canonical registry (§9.7) ──────────────────────────────────────────────

describe('createPresentRegistry', () => {
  const CANONICAL = [
    'direct', 'wgpu-direct', 'blit', 'wgpu-copy', 'quadcopy', 'quadpass',
    'uvremap', 'bitmap', 'asyncbmp', 'multibmp4', 'draw2d', 'multi4',
    'preserve', 'draw2d-half', 'scaled-half',
  ] as const

  it('all 15 §9.7 paths by rank; GL-internal without run', () => {
    const r = createPresentRegistry()
    expect(r.names).toEqual([...CANONICAL])
    const runless = r.snapshot().filter(s => !s.hasRun).map(s => s.name)
    expect(runless).toEqual(['blit', 'quadcopy', 'quadpass', 'uvremap'])
  })

  it('full caps → direct (rank 10, zero copies)', () => {
    const r = createPresentRegistry()
    expect(r.select(richCaps())?.name).toBe('direct')
  })

  it('the "offscreen source → viewers" scenario: GL-internal filtered out → bitmap', () => {
    const r = createPresentRegistry()
    const offscreenOnly = (name: string): boolean =>
      !['direct', 'wgpu-direct', 'blit', 'wgpu-copy', 'quadcopy', 'quadpass', 'uvremap'].includes(name)
    expect(r.select(richCaps(), 0, { filter: offscreenOnly })?.name).toBe('bitmap')
  })

  it('an environment without OffscreenCanvas: bitmap/asyncbmp/scaled-half unavailable → draw2d', () => {
    const r = createPresentRegistry()
    const caps = fakeCaps({
      'canvas-direct': 'supported',
      'blit': 'supported',
      'preserve': 'supported',
      'Canvas2D': 'supported',
      'createImageBitmap': 'unsupported',
      'OffscreenCanvas': 'unsupported',
      'transferToImageBitmap': 'unsupported',
      'bitmaprenderer': 'unsupported',
      'WebGPU': 'unsupported',
      'WebGPU.copyExternalImage': 'unsupported',
    })
    const offscreenOnly = (name: string): boolean => !['direct', 'blit', 'quadcopy', 'quadpass', 'uvremap'].includes(name)
    const sel = r.select(caps, 0, { filter: offscreenOnly })
    expect(sel?.name).toBe('draw2d')
    expect(r.status('bitmap').status).toBe('unavailable')
    expect(r.status('asyncbmp').status).toBe('unavailable')
    expect(r.status('scaled-half').status).toBe('unavailable')
  })

  it('pressure 0.7 cuts off multibmp4/multi4 (pressureMax 0.6) — the choice goes lower by rank', () => {
    const r = createPresentRegistry()
    const onlyMulti = (name: string): boolean => name === 'multibmp4' || name === 'multi4' || name === 'draw2d'
    expect(r.select(richCaps(), 0, { filter: onlyMulti })?.name).toBe('multibmp4')
    expect(r.select(richCaps(), 0.7, { filter: onlyMulti })?.name).toBe('draw2d')
  })

  it('the §9.7 example (Mali): preserve with p95/p50 = 3.0 → disabled, the choice goes to draw2d', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10, warnRatio: 1.2, disableRatio: 1.5 })
    // reproduce two competing canonical paths: preserve (rank 80) vs draw2d (rank 70)
    r.add('draw2d', { requires: 'Canvas2D', rank: 70, run: () => {} })
    r.add('preserve', { requires: ['preserve', 'Canvas2D'], rank: 80, run: () => {} })
    for (let i = 0; i < 20; i++) r.report('preserve', 1)
    for (let i = 0; i < 10; i++) r.report('preserve', 3) // p50=1, p95=3 → ratio 3.0
    expect(r.status('preserve').status).toBe('disabled')
    expect(r.status('preserve').ratio).toBe(3)
    const caps = fakeCaps({ 'Canvas2D': 'supported', 'preserve': 'supported' })
    expect(r.select(caps)?.name).toBe('draw2d')
  })

  it('the Contract 1 constants are in place (§7-clarification 1 + the probation period + Task 106)', () => {
    expect(DEGRADATION_RATIO).toBe(1.5)
    expect(DEGRADE_WARN_RATIO).toBe(1.2)
    expect(DEGRADATION_NOISE_FLOOR_MS).toBe(2)
    expect(DEGRADATION_RECOVERY_MS).toBe(5000)
    expect(DEGRADATION_RECOVERY_BACKOFF).toBe(2)
    expect(DEGRADATION_RECOVERY_MAX_MS).toBe(60000)
    expect(PRESSURE_HYSTERESIS).toBe(0.15)
    expect(DEGRADATION_ABSOLUTE_MS).toBe(50)
  })
})

// ─── Pressure hysteresis (Task 106: the Mali field journal — boundary chatter at 0.6) ─

describe('PathRegistry — pressure hysteresis (Task 106)', () => {
  it('cut above max, in the band [max−hyst, max] the decision holds, return at ≤ max−hyst', () => {
    const r = createPathRegistry()
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('cheap', { rank: 20, run: () => {} })
    expect(r.select(richCaps(), 0.7)?.name).toBe('cheap') // cut off
    expect(r.select(richCaps(), 0.6)?.name).toBe('cheap') // band: hold (before — an instant return)
    expect(r.select(richCaps(), 0.5)?.name).toBe('cheap') // band: hold
    expect(r.select(richCaps(), 0.44)?.name).toBe('dear') // below the return boundary 0.6 − 0.15 ≈ 0.45
    expect(r.select(richCaps(), 0.55)?.name).toBe('dear') // do not cut again until > 0.6
  })

  it('boundary chatter 0.6↔0.7 no longer jitters the selection (the Mali complaint verbatim)', () => {
    const r = createPathRegistry()
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('cheap', { rank: 20, run: () => {} })
    const picks: string[] = []
    for (const p of [0.7, 0.6, 0.7, 0.6, 0.7, 0.6]) {
      picks.push(r.select(richCaps(), p)?.name ?? 'null')
    }
    expect(picks).toEqual(['cheap', 'cheap', 'cheap', 'cheap', 'cheap', 'cheap'])
  })

  it('applyPressure — authoritative cut/returned transitions (idempotent)', () => {
    const r = createPathRegistry()
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('mid', { rank: 15, pressureMax: 0.8, run: () => {} })
    expect(r.applyPressure(0.7).map(t => `${t.name}:${t.to}`)).toEqual(['dear:cut'])
    expect(r.applyPressure(0.7)).toEqual([]) // the same pressure — no events
    expect(r.applyPressure(0.85).map(t => `${t.name}:${t.to}`)).toEqual(['mid:cut'])
    // 0.6: dear in the band [0.45, 0.6] — holds the cut; mid is already below its
    // own return boundary 0.8 − 0.15 = 0.65 — returns (each path has ITS OWN band)
    expect(r.applyPressure(0.6).map(t => `${t.name}:${t.to}`)).toEqual(['mid:returned'])
    expect(r.applyPressure(0.4).map(t => `${t.name}:${t.to}`)).toEqual(['dear:returned'])
    expect(r.status('dear').pressureCut).toBe(false)
    expect(r.status('mid').pressureCut).toBe(false)
  })

  it('ignorePressure (an operator force): the gate is not applied to the choice, the flags live on', () => {
    const r = createPathRegistry()
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.select(richCaps(), 0.7) // cut off
    expect(r.status('dear').pressureCut).toBe(true)
    const sel = r.select(richCaps(), 0.7, { filter: n => n === 'dear', ignorePressure: true })
    expect(sel?.name).toBe('dear') // the operator outweighs the gate
    expect(r.status('dear').pressureCut).toBe(true) // the flag keeps living by the real pressure
    expect(r.select(richCaps(), 0.7, { filter: n => n === 'dear' })).toBeNull() // without ignore — the gate acts again
  })

  it('pressureHysteresis: 0 — the previous instant-return semantics', () => {
    const r = createPathRegistry({ pressureHysteresis: 0 })
    r.add('dear', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.add('cheap', { rank: 20, run: () => {} })
    expect(r.select(richCaps(), 0.7)?.name).toBe('cheap')
    expect(r.select(richCaps(), 0.6)?.name).toBe('dear') // instant return (0.6 ≤ 0.6 − 0)
  })

  it('lastResort + ignorePressure: forcing a disabled path under pressure — showing matters more', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('forced', { rank: 10, pressureMax: 0.6, run: () => {} })
    r.disable('forced', 'operator')
    expect(r.select(richCaps(), 0.9, { filter: n => n === 'forced', lastResort: true, ignorePressure: true })?.name).toBe('forced')
  })
})

// ─── Absolute slowness (Task 106: ratio is blind to the uniformly slow) ────

describe('PathRegistry — absolute slowness (Task 106)', () => {
  it('uniformly slow p50 ≥ 50 ms → disabled, even though ratio 1.00 (a multi4 field frame)', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('slowborn', { rank: 10, run: () => {} })
    r.add('fast', { rank: 20, run: () => {} })
    for (let i = 0; i < 30; i++) r.report('slowborn', 70) // the path was born in jank — no clean baseline
    const st = r.status('slowborn')
    expect(st.status).toBe('disabled')
    expect(st.reason).toContain('absolute slowness')
    expect(st.ratio).toBe(1)
    expect(st.p50).toBe(70)
    expect(r.select(richCaps())?.name).toBe('fast') // the cascade moved to the fast ones
  })

  it('uniformly slow, but within the ceiling (40 ms) — tolerated', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('ok', { rank: 10, run: () => {} })
    for (let i = 0; i < 30; i++) r.report('ok', 40)
    expect(r.status('ok').status).toBe('healthy') // below the ceiling; a transition (if any) is caught by ratio
  })

  it('a mixed window (clean p50 + janky p95) — ratio leads, not the absolute', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10 })
    r.add('drain', { rank: 10, run: () => {} })
    for (let i = 0; i < 25; i++) r.report('drain', 0.2)
    for (let i = 0; i < 5; i++) r.report('drain', 200)
    const st = r.status('drain')
    expect(st.status).toBe('disabled')
    expect(st.reason).toContain('degradation') // p50 is clean — the absolute stays silent, ratio leads
  })

  it('absoluteMaxMs: Infinity — the verdict is off', () => {
    const r = createPathRegistry({ window: 30, minSamples: 10, absoluteMaxMs: Number.POSITIVE_INFINITY })
    r.add('slow', { rank: 10, run: () => {} })
    for (let i = 0; i < 30; i++) r.report('slow', 70)
    expect(r.status('slow').status).toBe('healthy')
  })

  it('the absolute verdict is cured by the probation period: the environment normalized — the path returned', () => {
    let t = 0
    const r = createPathRegistry({ window: 30, minSamples: 10, recoveryMs: 5000, now: () => t })
    r.add('slow', { rank: 10, run: () => {} })
    r.add('fast', { rank: 20, run: () => {} })
    for (let i = 0; i < 30; i++) r.report('slow', 70)
    expect(r.status('slow').status).toBe('disabled')
    t = 5000
    const sel = r.select(richCaps())
    expect(sel?.name).toBe('slow') // the probation period — a fresh window
    expect(sel?.state.reason).toContain('probation')
    for (let i = 0; i < 10; i++) r.report('slow', 1) // the environment normalized
    expect(r.status('slow').status).toBe('healthy')
    expect(r.status('slow').reason).toBeNull()
  })
})
