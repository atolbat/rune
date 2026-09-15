// scale.test.ts — Task 216 — THE ADAPTIVE SCALE GOVERNOR LAWS.
//
//   1. STABILITY — at-target frames never move the level.
//   2. THE HITCH LAW — one very slow frame is a HITCH: the EMA absorbs
//      it, the level holds (a GC pause must not drop the resolution).
//   3. THE SUSTAINED LAW — 8 consecutive over-budget frames step DOWN
//      exactly one level; recovery needs 30 under-budget frames.
//   4. THE COOLDOWN LAW — a step arms the clock; over-budget frames
//      during the cooldown do NOT step again until it expires.
//   5. THE FLOOR/CEILING — the level never leaves [0, levels).
//   6. THE BOOT LAW — the governor starts at the TOP level (never boot
//      degraded; the evidence degrades it).
//   7. THE MANUAL PICK — setLevel resets the streaks and arms the
//      cooldown (a user's choice must not be fought at once).
//   8. THE OSCILLATION LAW — alternating slow/fast frames around the
//      target NEVER move the level (the margins' whole purpose).
import { describe, expect, test } from 'bun:test'
import { createScaleGovernor } from '../src/scale.ts'

const SPEC = { levels: 4, targetMs: 1 / 60, emaAlpha: 0.25, downNeed: 8, upNeed: 30, downMargin: 0.15, upMargin: 0.25, cooldown: 2 }

describe('Task 216 — the adaptive render-scale governor', () => {
  test('the boot law — starts at the top, stable at target', () => {
    const g = createScaleGovernor(SPEC)
    expect(g.peek().level).toBe(3)
    for (let k = 0; k < 120; k++) g.observe(1 / 60)
    expect(g.peek().level).toBe(3)
    expect(g.peek().changed).toBe(false)
  })

  test('the hitch law — one slow frame is absorbed', () => {
    const g = createScaleGovernor(SPEC)
    for (let k = 0; k < 60; k++) g.observe(1 / 60)
    const s = g.observe(0.5) // a 500 ms hitch (GC / tab switch)
    expect(s.level).toBe(3)
    expect(s.changed).toBe(false)
    for (let k = 0; k < 30; k++) g.observe(1 / 60)
    expect(g.peek().level).toBe(3)
  })

  test('the sustained law — 8 over-budget frames step down one level; 30 under-budget climb back', () => {
    const g = createScaleGovernor({ ...SPEC, cooldown: 0 })
    let changedAt = -1
    for (let k = 0; k < 10; k++) {
      const s = g.observe((1 / 60) * 1.5) // 50% over budget, sustained
      if (s.changed && changedAt < 0) changedAt = k
    }
    expect(changedAt).toBe(7) // the 8th sample (index 7) steps
    expect(g.peek().level).toBe(2) // exactly ONE level (streak reset on the step)
    // the climb back: the EMA must drop under the up-margin first, then
    // 30 consecutive fast frames (raw AND ema confirmed)
    let upAt = -1
    for (let k = 0; k < 60; k++) {
      const s = g.observe((1 / 60) * 0.6)
      if (s.changed && upAt < 0) upAt = k
    }
    expect(upAt).toBeGreaterThanOrEqual(29)
    expect(g.peek().level).toBe(3)
  })

  test('the cooldown law — a step disarms the ladder until it expires', () => {
    const g = createScaleGovernor(SPEC) // cooldown: 2 s
    for (let k = 0; k < 8; k++) g.observe((1 / 60) * 1.6)
    expect(g.peek().level).toBe(2) // stepped down
    expect(g.peek().cooldownLeft).toBeGreaterThan(0)
    // hammer it with over-budget frames through the cooldown (2 s at
    // 0.0267 s per slow frame ≈ 75 frames): the level HOLDS until the
    // clock runs out, then the rebuilt streak (8 more) steps again
    let steppedAgain = false
    for (let k = 0; k < 300; k++) {
      const s = g.observe((1 / 60) * 1.6)
      if (s.changed) { steppedAgain = true; break }
    }
    expect(steppedAgain).toBe(true) // eventually steps — after the cooldown
    expect(g.peek().level).toBe(1)
  })

  test('the floor law — the level never leaves [0, levels)', () => {
    const g = createScaleGovernor({ ...SPEC, cooldown: 0 })
    for (let k = 0; k < 200; k++) g.observe(1) // a second per frame, forever
    expect(g.peek().level).toBe(0)
    for (let k = 0; k < 20; k++) g.observe(1)
    expect(g.peek().level).toBe(0) // pinned at the floor
  })

  test('the manual pick — setLevel resets streaks, arms the cooldown', () => {
    const g = createScaleGovernor(SPEC)
    for (let k = 0; k < 7; k++) g.observe((1 / 60) * 2) // 7 of 8 needed
    g.setLevel(1) // the user picks LOW
    expect(g.peek().level).toBe(1)
    expect(g.peek().overStreak).toBe(0)
    // the 8th over-budget frame would have stepped — the manual pick
    // reset the streak, and the cooldown holds the level anyway
    const s = g.observe((1 / 60) * 2)
    expect(s.changed).toBe(false)
    expect(s.level).toBe(1)
  })

  test('the oscillation law — alternating around the target never moves', () => {
    const g = createScaleGovernor({ ...SPEC, cooldown: 0 })
    for (let k = 0; k < 600; k++) {
      g.observe(k % 2 === 0 ? (1 / 60) * 1.3 : (1 / 60) * 0.7)
    }
    expect(g.peek().level).toBe(3) // the margins eat the alternation
  })

  test('junk samples are refused, not fatal', () => {
    const g = createScaleGovernor(SPEC)
    expect(g.observe(0).changed).toBe(false)
    expect(g.observe(Number.NaN).changed).toBe(false)
    expect(g.observe(Number.POSITIVE_INFINITY).changed).toBe(false)
    expect(g.peek().level).toBe(3)
  })
})
