// task217.test.ts — Task 217 — THE STEP-UP LADDER LAWS.
//
// The field report's own physics complaint («физика с боксами
// несовершенна, особенно у лестниц»): a DIAGONAL approach to the
// staircase — the analog stick's natural path — put the body's AABB
// across TWO consecutive steps at once, and the one-shot resolver read
// the upper step (rise 2×0.55 > stepHeight at the current feet) as a
// WALL: the body was shoved sideways off the stairs instead of climbing.
// The ladder raises rung by rung and re-reads the world — the upper
// step's nose becomes steppable at the raised feet.
//
//   1. DIAGONAL — the analog stick's natural drift (12° off straight)
//      climbs the 10-step staircase to the landing pad: zero air frames,
//      no sideways ejection (the x drift stays inside the stair's span).
//   2. CORNER — a steeper diagonal aimed INSIDE the stair's edge climbs
//      with monotone forward progress (no backward shoves — the
//      regression's own signature).
//   3. FLANK — brushing the staircase's side mid-height (the local
//      steps are 2+ m walls there) with a slight away-drift slides
//      along free — never mounted, never penetrating, never stopped.
//   4. STEP+WALL — a step in front of a tall wall: the ladder mounts the
//      step, the wall stays a wall — the body stands ON the step against
//      the wall's face (the raise happens, the clamp follows).
//   5. DETERMINISM — the diagonal run twice is bit-identical.
import { describe, expect, test } from 'bun:test'
import { createCharacter } from '../src/character.ts'
import type { CharacterSpec, CharacterWorld, GroundContact } from '../src/character.ts'

interface MockBox { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number }

class MockWorld implements CharacterWorld {
  readonly boxes: MockBox[] = []
  terrainY = -Infinity
  idsScratch = new Uint32Array(96)
  boxScratch = new Float64Array(6)

  groundBelow(x: number, z: number, fromY: number, out: GroundContact): boolean {
    let best: number = -Infinity
    let found = false
    for (const b of this.boxes) {
      const top = b.cy + b.hy
      if (Math.abs(x - b.cx) > b.hx || Math.abs(z - b.cz) > b.hz) continue
      if (top > fromY + 1e-6 || top <= best) continue
      best = top
      found = true
    }
    if (this.terrainY < fromY + 1e-6 && this.terrainY > best) {
      out.top = this.terrainY; out.mover = -1; out.vx = 0; out.vy = 0; out.vz = 0
      return true
    }
    if (!found) return false
    out.top = best; out.mover = 0; out.vx = 0; out.vy = 0; out.vz = 0
    return true
  }

  boxesIn(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, out: Uint32Array): number {
    let n = 0
    for (let k = 0; k < this.boxes.length && n < out.length; k++) {
      const b = this.boxes[k]!
      if (x1 < b.cx - b.hx || x0 > b.cx + b.hx) continue
      if (y1 < b.cy - b.hy || y0 > b.cy + b.hy) continue
      if (z1 < b.cz - b.hz || z0 > b.cz + b.hz) continue
      out[n++] = k
    }
    return n
  }

  boxAt(id: number, out: Float64Array): boolean {
    const b = this.boxes[id]
    if (b === undefined) return false
    out[0] = b.cx; out[1] = b.cy; out[2] = b.cz; out[3] = b.hx; out[4] = b.hy; out[5] = b.hz
    return true
  }
}

const SPEC: CharacterSpec = {
  radius: 0.38, height: 1.7, walkSpeed: 7.5, accelGround: 55, accelAir: 16,
  gravity: 22, jumpSpeed: 8.2, stepHeight: 0.62, coyoteTime: 0.12,
  jumpBuffer: 0.15, maxFall: 55, snapDown: 0.2, fixedDt: 1 / 120,
}

const IDLE = { dirX: 0, dirZ: 0, jumpHeld: false }

/** The demo's own staircase: 10 steps, 0.55 rise, 1.1 run, climbing −z,
 *  the flanks at ±hx (the Task-217 world widened them — the law holds
 *  for both widths), plus the landing pad at the top (the course's own
 *  shape: one more 0.55 step-up from the last step). */
function buildStairs(w: MockWorld, hx = 2.2, steps = 10): number {
  const base = 0
  for (let s = 0; s < steps; s++) {
    const top = base + 0.55 + s * 0.55
    const depth = top - (base - 2)
    w.boxes.push({ cx: 0, cy: top - depth / 2, cz: -s * 1.1, hx, hy: depth / 2, hz: 0.55 })
  }
  const stairTop = base + steps * 0.55 + 0.55
  w.boxes.push({ cx: 0, cy: stairTop - 0.25, cz: -steps * 1.1 - 2.2, hx: 2.2, hy: 0.25, hz: 2.6 })
  return stairTop
}

describe('Task 217 — the step-up ladder', () => {
  test('the diagonal law — the analog drift (12°) climbs to the pad, no ejection', () => {
    const w = new MockWorld()
    w.terrainY = 0
    const top = buildStairs(w)
    const ch = createCharacter(SPEC, w, -1.5, 0, 2.4)
    // settle onto the terrain before the stairs
    for (let k = 0; k < 120; k++) ch.step(SPEC.fixedDt, IDLE)
    expect(ch.state.grounded).toBe(true)
    // the phone's natural path: mostly forward, a 12° drift toward +x
    const a = (12 * Math.PI) / 180
    const dir = { dirX: Math.sin(a), dirZ: -Math.cos(a), jumpHeld: false }
    let air = 0
    let minY = ch.state.y
    for (let k = 0; k < 1500 && ch.state.z > -10.8; k++) {
      ch.step(SPEC.fixedDt, dir)
      if (!ch.state.grounded) air++
      minY = Math.min(minY, ch.state.y)
    }
    // reached the landing pad at the top (stopped just onto it — a longer
    // walk drifts off the pad's own edge, which is geometry, not physics)
    expect(ch.state.z).toBeLessThanOrEqual(-10.8)
    expect(ch.state.y).toBeGreaterThan(top - 0.2)
    // the climb never left the ground (step-up mounts, no falls) and
    // never fell below the approach level (no sideways ejection off a
    // flank — the shove would drop the body to the terrain)
    expect(air).toBe(0)
    expect(minY).toBeGreaterThan(-0.01)
    // the x drift stayed inside the stair span + the body radius
    expect(Math.abs(ch.state.x)).toBeLessThan(2.2 + 0.5)
  })

  test('the corner law — a steep diagonal (16°) climbs with monotone progress', () => {
    const w = new MockWorld()
    w.terrainY = 0
    const top = buildStairs(w)
    // aimed across the stair's width: 16° off straight, started near the
    // left flank — the body straddles step corners the whole way up (any
    // steeper exits the flank mid-climb — geometry, not physics)
    const ch = createCharacter(SPEC, w, -1.9, 0, 2.6)
    for (let k = 0; k < 120; k++) ch.step(SPEC.fixedDt, IDLE)
    expect(ch.state.grounded).toBe(true)
    const a = (16 * Math.PI) / 180
    const dir = { dirX: Math.sin(a), dirZ: -Math.cos(a), jumpHeld: false }
    // the forward progress along the approach dir, sampled every 0.25 s
    // — the old resolver's shove read as BACKWARD jumps
    const fx = Math.cos(a), fz = -Math.sin(a) // the approach's forward basis
    let last = ch.state.x * fx + ch.state.z * fz
    let monotone = true
    for (let k = 0; k < 1500 && ch.state.z > -9.6; k++) {
      ch.step(SPEC.fixedDt, dir)
      if (k % 30 === 29) {
        const proj = ch.state.x * fx + ch.state.z * fz
        if (proj < last - 0.01) monotone = false
        last = proj
      }
    }
    // on the last steps (top 5.5) with zero backward shoves
    expect(ch.state.y).toBeGreaterThan(top - 0.75)
    expect(monotone).toBe(true)
    expect(ch.state.grounded).toBe(true)
  })

  test('the flank law — a mid-height side brush slides, never mounts nor stops', () => {
    const w = new MockWorld()
    w.terrainY = 0
    buildStairs(w)
    // walking −z ALONG the flank (x inside the stair's x-range by a
    // hair) at a height where the local steps are 2+ m walls — with the
    // analog stick's slight away-drift the body must slide free
    const ch = createCharacter(SPEC, w, -2.35, 0, 1.0)
    for (let k = 0; k < 120; k++) ch.step(SPEC.fixedDt, IDLE)
    expect(ch.state.grounded).toBe(true)
    const len = Math.hypot(0.18, 0.99)
    const dir = { dirX: -0.18 / len, dirZ: -0.99 / len, jumpHeld: false }
    for (let k = 0; k < 720; k++) ch.step(SPEC.fixedDt, dir)
    // slid the whole way past the staircase (never stopped by the flank)
    expect(ch.state.z).toBeLessThan(-11.5)
    // stayed at the terrain level (no mid-stair mount) and out of the
    // stair's x-span (the drift + the pushout carried it free)
    expect(ch.state.y).toBeLessThan(0.7)
    expect(ch.state.x).toBeLessThan(-2.2)
    expect(ch.state.grounded).toBe(true)
  })

  test('the step+wall law — mount the step, the wall clamps at the raised y', () => {
    const w = new MockWorld()
    w.terrainY = 0
    // a 0.5 m step, then a 3 m wall behind it
    w.boxes.push({ cx: 0, cy: 0.25, cz: -2, hx: 3, hy: 0.25, hz: 0.6 })
    w.boxes.push({ cx: 0, cy: 1.5, cz: -3.4, hx: 3, hy: 1.5, hz: 0.5 })
    const ch = createCharacter(SPEC, w, 0, 0, 1)
    for (let k = 0; k < 120; k++) ch.step(SPEC.fixedDt, IDLE)
    expect(ch.state.grounded).toBe(true)
    const dir = { dirX: 0, dirZ: -1, jumpHeld: false }
    for (let k = 0; k < 480; k++) ch.step(SPEC.fixedDt, dir)
    // ON the step (the ladder raised), against the wall's face (the clamp)
    expect(ch.state.y).toBeCloseTo(0.5, 1)
    expect(ch.state.z).toBeCloseTo(-3.4 + 0.5 + SPEC.radius, 1)
    expect(ch.state.grounded).toBe(true)
    expect(Math.abs(ch.state.vz)).toBeLessThan(0.01)
  })

  test('the ledge save law — a jump clipping the face pops ONTO the platform', () => {
    const w = new MockWorld()
    w.terrainY = 0
    // a 1.2 m platform: a running jump that would clip the front face
    // with the feet ~0.2 BELOW the top must pop onto the top, not bounce
    w.boxes.push({ cx: 0, cy: 0.6, cz: -4, hx: 2, hy: 0.6, hz: 2 })
    const ch = createCharacter(SPEC, w, 0, 0, 1.5)
    for (let k = 0; k < 120; k++) ch.step(SPEC.fixedDt, IDLE)
    expect(ch.state.grounded).toBe(true)
    // run at the platform and jump late — the arc's feet cross the face
    // just below the top (the near-miss every player knows)
    const dir = { dirX: 0, dirZ: -1, jumpHeld: false }
    for (let k = 0; k < 30; k++) ch.step(SPEC.fixedDt, dir) // approach
    ch.step(SPEC.fixedDt, { dirX: 0, dirZ: -1, jumpHeld: true })
    for (let k = 0; k < 90; k++) ch.step(SPEC.fixedDt, dir)
    // either the ray landed it (a clean arc) or the ledge save mounted it
    // — the law: NEVER bounced off the face back to the terrain far side
    expect(ch.state.y).toBeGreaterThan(1.0)
    expect(ch.state.grounded).toBe(true)
    expect(ch.state.z).toBeGreaterThan(-6.5) // never teleported through
  })

  test('the seam law — the stair→pad gap crossing never airs nor teleports', () => {
    const w = new MockWorld()
    w.terrainY = 0
    const top = buildStairs(w) // the mock keeps the demo's 0.15 m seam
    const ch = createCharacter(SPEC, w, -1.5, 0, 2.4)
    for (let k = 0; k < 120; k++) ch.step(SPEC.fixedDt, IDLE)
    const a = (12 * Math.PI) / 180
    const dir = { dirX: Math.sin(a), dirZ: -Math.cos(a), jumpHeld: false }
    let air = 0
    let maxX = ch.state.x
    for (let k = 0; k < 1500 && ch.state.z > -11.4; k++) {
      ch.step(SPEC.fixedDt, dir)
      if (!ch.state.grounded) air++
      maxX = Math.max(maxX, ch.state.x)
    }
    // crossed the seam onto the pad, grounded the whole way
    expect(ch.state.y).toBeGreaterThan(top - 0.2)
    expect(air).toBe(0)
    // no sideways teleport past the pad's edge (the old bug: +1.3 m in
    // two substeps, ejected off the face it should have mounted)
    expect(maxX).toBeLessThan(2.2 + 0.4)
  })

  test('the determinism law — the diagonal run twice is bit-identical', () => {
    const runOnce = () => {
      const w = new MockWorld()
      w.terrainY = 0
      buildStairs(w)
      const ch = createCharacter(SPEC, w, -1.5, 0, 2.4)
      const traj: number[] = []
      const a = (12 * Math.PI) / 180
      const dir = { dirX: Math.sin(a), dirZ: -Math.cos(a), jumpHeld: false }
      for (let k = 0; k < 900; k++) {
        ch.step(SPEC.fixedDt, dir)
        traj.push(ch.state.x, ch.state.y, ch.state.z, ch.state.vx, ch.state.vy, ch.state.vz)
      }
      return traj
    }
    const a = runOnce()
    const b = runOnce()
    expect(a.length).toBe(b.length)
    for (let k = 0; k < a.length; k++) expect(a[k]).toBe(b[k])
  })
})
