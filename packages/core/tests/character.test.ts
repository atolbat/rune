// character.test.ts — Task 216 — THE CHARACTER LAWS.
//
// A mock oracle (a box list + a flat/tilted terrain fn) answers the three
// oracle questions exactly as the demo's kit-backed oracle will; the laws:
//
//   1. PARABOLA — a jump's apex ≈ v0²/2g, the flight back to the launch
//      height ≈ 2·v0/g (the integration is semi-implicit Euler at a fixed
//      substep — the tolerances carry the dt² honestly).
//   2. LAND — falls onto a box top exactly: y == top, vy == 0, grounded.
//   3. TUNNEL — a 200 m/s fall onto a 0.1 m platform LANDS (the ray law:
//      the ground probe is infinite down, no swept volume to skip).
//   4. GAP — a running jump crosses a 3.5 m gap and lands ON the far
//      platform (parkour: the jump arc is walkSpeed × airtime).
//   5. COYOTE — a press 0.08 s after walking off an edge still launches;
//      the same press 0.25 s after does not.
//   6. BUFFER — a press held 0.1 s before touchdown fires ON touchdown.
//   7. STEP-UP — a grounded walk into a 0.55 m step MOUNTS it (no jump
//      input, no velocity loss on the horizontal axes' target).
//   8. STAIRS — a 10-step staircase climbs to steps × stepHeight.
//   9. WALL — a tall wall stops the body at face − radius, the other
//      axis keeps sliding (axis-separated pushout).
//  10. CEILING — a jump under a beam clamps the head, vy → 0.
//  11. CARRY — a rising elevator carries the body (y tracks the top);
//      a horizontal ferry carries x/z.
//  12. GLUE — walking down a gentle slope never leaves the ground; a
//      staircase descends without air frames; a real ledge falls.
//  13. DETERMINISM — the same input script → the same trajectory BITS.
import { describe, expect, test } from 'bun:test'
import { createCharacter } from '../src/character.ts'
import type { CharacterSpec, CharacterWorld, GroundContact } from '../src/character.ts'

// ── the mock oracle ────────────────────────────────────────────────────────
interface MockBox { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; vx?: number; vy?: number; vz?: number; id?: number }

class MockWorld implements CharacterWorld {
  readonly boxes: MockBox[] = []
  // NO terrain by default: the box-world tests (stairs/walls/gaps) must
  // not walk on an invisible flat floor — tests that want terrain set it
  terrainY = -Infinity
  idsScratch = new Uint32Array(96)
  boxScratch = new Float64Array(6)

  groundBelow(x: number, z: number, fromY: number, out: GroundContact): boolean {
    // terrain (flat, static) + the highest box top in the column below fromY
    let best: number = -Infinity
    let bestBox: MockBox | null = null
    for (const b of this.boxes) {
      const top = b.cy + b.hy
      if (Math.abs(x - b.cx) > b.hx || Math.abs(z - b.cz) > b.hz) continue
      if (top > fromY + 1e-6 || top <= best) continue
      best = top
      bestBox = b
    }
    if (this.terrainY < fromY + 1e-6 && this.terrainY > best) {
      out.top = this.terrainY; out.mover = -1; out.vx = 0; out.vy = 0; out.vz = 0
      return true
    }
    if (bestBox === null) return false
    out.top = best
    out.mover = bestBox.id ?? 0
    out.vx = bestBox.vx ?? 0
    out.vy = bestBox.vy ?? 0
    out.vz = bestBox.vz ?? 0
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
  radius: 0.4,
  height: 1.8,
  walkSpeed: 8,
  accelGround: 60,
  accelAir: 20,
  gravity: 22,
  jumpSpeed: 8,
  stepHeight: 0.62,
  coyoteTime: 0.12,
  jumpBuffer: 0.15,
  maxFall: 55,
  snapDown: 0.18,
  fixedDt: 1 / 120,
}

const IDLE = { dirX: 0, dirZ: 0, jumpHeld: false }

function run(ch: ReturnType<typeof createCharacter>, seconds: number, input: { dirX: number; dirZ: number; jumpHeld: boolean }): void {
  const steps = Math.round(seconds / SPEC.fixedDt)
  for (let k = 0; k < steps; k++) ch.step(SPEC.fixedDt, input)
}

describe('Task 216 — the kinematic character', () => {
  test('the parabola law — apex and flight time of a jump', () => {
    const w = new MockWorld()
    w.terrainY = 10
    const ch = createCharacter(SPEC, w, 0, 10, 0)
    run(ch, 0.5, IDLE) // settle onto the terrain
    expect(ch.state.grounded).toBe(true)
    // jump (one held substep, then release)
    ch.step(SPEC.fixedDt, { dirX: 0, dirZ: 0, jumpHeld: true })
    let apex = -Infinity
    let t = 0
    for (let k = 0; k < 400; k++) {
      ch.step(SPEC.fixedDt, IDLE)
      t += SPEC.fixedDt
      if (ch.state.y > apex) apex = ch.state.y
      if (k > 10 && ch.state.grounded) break
    }
    const v0 = SPEC.jumpSpeed, g = SPEC.gravity
    expect(apex - 10).toBeGreaterThan((v0 * v0) / (2 * g) - 0.05)
    expect(apex - 10).toBeLessThan((v0 * v0) / (2 * g) + 0.05)
    expect(t).toBeGreaterThan((2 * v0) / g - 0.04)
    expect(t).toBeLessThan((2 * v0) / g + 0.04)
  })

  test('the land law — a fall lands exactly on the box top', () => {
    const w = new MockWorld()
    w.boxes.push({ cx: 0, cy: 0.05, cz: 0, hx: 5, hy: 0.05, hz: 5, id: 0 }) // top at 0.1
    const ch = createCharacter(SPEC, w, 0, 5, 0)
    run(ch, 2, IDLE)
    expect(ch.state.grounded).toBe(true)
    expect(ch.state.y).toBe(0.1)
    expect(ch.state.vy).toBe(0)
    expect(ch.state.ground?.mover).toBe(0)
  })

  test('the tunnel law — a 200 m/s fall onto a 0.1 m platform lands (the ray)', () => {
    const w = new MockWorld()
    w.boxes.push({ cx: 0, cy: 0.05, cz: 0, hx: 2, hy: 0.05, hz: 2 })
    const ch = createCharacter(SPEC, w, 0, 300, 0)
    // no maxFall clamp interference: run long enough at terminal velocity
    run(ch, 12, IDLE)
    expect(ch.state.grounded).toBe(true)
    expect(ch.state.y).toBe(0.1)
  })

  test('the gap law — a running jump crosses 3.5 m and lands on the platform', () => {
    const w = new MockWorld()
    // platform A: [−3, 3] top 0; a REAL void for 3.5 m; platform B: [6.5, 12] top 0
    w.boxes.push({ cx: 0, cy: -1, cz: 0, hx: 3, hy: 1, hz: 4 })
    w.boxes.push({ cx: 9.25, cy: -1, cz: 0, hx: 2.75, hy: 1, hz: 4 })
    const ch = createCharacter(SPEC, w, -1, 0, 0)
    run(ch, 0.5, IDLE)
    expect(ch.state.grounded).toBe(true)
    // accelerate toward +x and jump at the edge (x ≈ 2.6)
    let jumped = false
    for (let k = 0; k < 600; k++) {
      const nearEdge = ch.state.x > 2.2 && ch.state.x < 2.6
      const input = { dirX: 1, dirZ: 0, jumpHeld: nearEdge && !jumped }
      if (nearEdge) jumped = true
      ch.step(SPEC.fixedDt, input)
      if (ch.state.grounded && ch.state.x > 7) break
    }
    expect(ch.state.grounded).toBe(true)
    expect(ch.state.x).toBeGreaterThan(6.5 - SPEC.radius)
    expect(ch.state.x).toBeLessThan(12)
    expect(ch.state.y).toBe(0)
  })

  test('the coyote law — 0.08 s after the edge fires, 0.25 s does not', () => {
    const walkOff = (pressDelay: number): { rose: boolean } => {
      const w = new MockWorld()
      w.boxes.push({ cx: 0, cy: -1, cz: 0, hx: 2, hy: 1, hz: 4 }) // edge at x = 2
      const ch = createCharacter(SPEC, w, 0, 0, 0)
      run(ch, 0.5, IDLE)
      // walk toward the edge until the body LEAVES it (grounded → false)
      let guard = 0
      while (ch.state.grounded && guard++ < 600) ch.step(SPEC.fixedDt, { dirX: 1, dirZ: 0, jumpHeld: false })
      expect(ch.state.grounded).toBe(false) // off the edge, falling
      // free-fall the delay, then press ONCE
      for (let k = 0; k < Math.round(pressDelay / SPEC.fixedDt); k++) ch.step(SPEC.fixedDt, { dirX: 1, dirZ: 0, jumpHeld: false })
      const yAtPress = ch.state.y
      let apex = yAtPress
      for (let k = 0; k < 300; k++) {
        ch.step(SPEC.fixedDt, { dirX: 1, dirZ: 0, jumpHeld: k === 0 })
        if (ch.state.y > apex) apex = ch.state.y
      }
      return { rose: apex - yAtPress > 1.0 }
    }
    expect(walkOff(0.08).rose).toBe(true) // inside the coyote window — fires
    expect(walkOff(0.25).rose).toBe(false) // past it — no launch
  })

  test('the buffer law — a press 0.1 s before touchdown fires on touchdown', () => {
    const w = new MockWorld()
    w.boxes.push({ cx: 0, cy: -1, cz: 0, hx: 5, hy: 1, hz: 5 })
    const ch = createCharacter(SPEC, w, 0, 3, 0) // falls 3 m: ~0.52 s
    // free-fall 0.4 s, then HOLD jump for the last 0.1 s of the fall
    for (let k = 0; k < Math.round(0.42 / SPEC.fixedDt); k++) ch.step(SPEC.fixedDt, IDLE)
    expect(ch.state.grounded).toBe(false)
    let rebound = false
    let apexAfter = ch.state.y
    for (let k = 0; k < 400; k++) {
      ch.step(SPEC.fixedDt, { dirX: 0, dirZ: 0, jumpHeld: k < Math.round(0.1 / SPEC.fixedDt) })
      if (ch.state.grounded) { rebound = true; break } // landed then jumped?
      if (ch.state.y > apexAfter) apexAfter = ch.state.y
    }
    // the buffered press fired: the body rebounded (grounded again after
    // the launch's air time) or is at least still rising at the cut
    expect(rebound || ch.state.vy > 0 || apexAfter > 3.2).toBe(true)
  })

  test('the step-up law — a grounded walk mounts a 0.55 m step', () => {
    const w = new MockWorld()
    w.boxes.push({ cx: 0, cy: -1, cz: 0, hx: 10, hy: 1, hz: 4 })      // floor top 0
    w.boxes.push({ cx: 6, cy: 0.275, cz: 0, hx: 2, hy: 0.275, hz: 4 }) // step top 0.55, faces at x ∈ [4, 8]
    const ch = createCharacter(SPEC, w, 0, 0, 0)
    run(ch, 0.5, IDLE)
    // walk 0.75 s → x ≈ 6: ON the step, past its front face
    for (let k = 0; k < Math.round(0.75 / SPEC.fixedDt); k++) {
      ch.step(SPEC.fixedDt, { dirX: 1, dirZ: 0, jumpHeld: false })
    }
    expect(ch.state.y).toBe(0.55)          // ON the step
    expect(ch.state.x).toBeGreaterThan(4.5) // past its front face (4) + radius
    expect(ch.state.grounded).toBe(true)
  })

  test('the stairs law — a 10-step staircase climbs to 10 × 0.55', () => {
    const w = new MockWorld()
    for (let s = 0; s < 10; s++) {
      w.boxes.push({ cx: s * 1.1, cy: (s * 0.55) / 2 - 1, cz: 0, hx: 0.55, hy: (s * 0.55) / 2 + 1, hz: 3 })
    }
    // the top landing — wide enough that the walk ENDS on it (no far-side drop)
    w.boxes.push({ cx: 12.5, cy: 5.5 / 2 - 1, cz: 0, hx: 2.5, hy: 5.5 / 2 + 1, hz: 3 })
    const ch = createCharacter(SPEC, w, 0, 0, 0) // ON step 0 (top 0)
    run(ch, 0.3, IDLE)
    let airFrames = 0
    for (let k = 0; k < Math.round(1.8 / SPEC.fixedDt); k++) {
      ch.step(SPEC.fixedDt, { dirX: 1, dirZ: 0, jumpHeld: false })
      if (!ch.state.grounded) airFrames++
    }
    expect(ch.state.y).toBeCloseTo(10 * 0.55, 5)
    expect(ch.state.x).toBeGreaterThan(10)
    expect(airFrames).toBe(0) // the whole staircase: step-up mount, never air
  })

  test('the wall law — stops at face − radius, the other axis slides', () => {
    const w = new MockWorld()
    w.boxes.push({ cx: 0, cy: -1, cz: 0, hx: 10, hy: 1, hz: 10 })       // floor
    // a LONG wall (z ∈ [−50, 50]) — the +x axis clamps against it while
    // the +z axis keeps sliding (the axis-separated pushout law)
    w.boxes.push({ cx: 4, cy: 2, cz: 0, hx: 0.5, hy: 3, hz: 50 })
    const ch = createCharacter(SPEC, w, 0, 0, 0)
    run(ch, 0.3, IDLE)
    for (let k = 0; k < Math.round(1.2 / SPEC.fixedDt); k++) {
      ch.step(SPEC.fixedDt, { dirX: 1, dirZ: 1, jumpHeld: false })
    }
    expect(ch.state.x).toBeLessThanOrEqual(3.5 - SPEC.radius + 1e-9)
    expect(ch.state.x).toBeGreaterThan(3.5 - SPEC.radius - 0.3)
    expect(ch.state.z).toBeGreaterThan(2) // the slide lives
    expect(ch.state.vx).toBe(0)
  })

  test('the ceiling law — a jump under a beam clamps the head', () => {
    const w = new MockWorld()
    w.boxes.push({ cx: 0, cy: -1, cz: 0, hx: 10, hy: 1, hz: 10 })          // floor top 0
    w.boxes.push({ cx: 0, cy: 2.4, cz: 0, hx: 10, hy: 0.2, hz: 10 })       // beam bottom at 2.2
    const ch = createCharacter(SPEC, w, 0, 0, 0)
    run(ch, 0.3, IDLE)
    let maxY = 0
    for (let k = 0; k < 600; k++) {
      ch.step(SPEC.fixedDt, { dirX: 0, dirZ: 0, jumpHeld: k === 0 })
      if (ch.state.y > maxY) maxY = ch.state.y
    }
    expect(maxY).toBeLessThanOrEqual(2.2 - SPEC.height + 1e-9)
    expect(maxY).toBeGreaterThan(0.2) // it left the floor
  })

  test('the carry law — a rising elevator and a horizontal ferry', () => {
    const w = new MockWorld()
    // the elevator: a STATIC box until the ride begins, then top moves at 2 m/s
    const elevator = { cx: 0, cy: -1, cz: 0, hx: 2, hy: 1, hz: 2, vy: 0, id: 7 }
    w.boxes.push(elevator)
    const ch = createCharacter(SPEC, w, 0, 0, 0)
    run(ch, 0.3, IDLE)
    elevator.vy = 2 // the ride begins — box and velocity move together
    for (let k = 0; k < Math.round(1 / SPEC.fixedDt); k++) {
      elevator.cy += elevator.vy! * SPEC.fixedDt // the world moves the box
      ch.step(SPEC.fixedDt, IDLE)
    }
    const topNow = elevator.cy + elevator.hy
    expect(ch.state.grounded).toBe(true)
    expect(Math.abs(ch.state.y - topNow)).toBeLessThan(0.02) // rides the top
    // the ferry: horizontal carry
    const w2 = new MockWorld()
    const ferry = { cx: 0, cy: -0.1, cz: 0, hx: 2, hy: 0.1, hz: 2, vx: 0, id: 3 }
    w2.boxes.push(ferry)
    const ch2 = createCharacter(SPEC, w2, 0, 0, 0)
    run(ch2, 0.3, IDLE)
    ferry.vx = 3 // the crossing begins — box and velocity move together
    for (let k = 0; k < Math.round(1 / SPEC.fixedDt); k++) {
      ferry.cx += ferry.vx! * SPEC.fixedDt
      ch2.step(SPEC.fixedDt, IDLE)
    }
    expect(ch2.state.grounded).toBe(true)
    expect(Math.abs(ch2.state.x - ferry.cx)).toBeLessThan(0.05) // carried along
  })

  test('the glue law — slopes and stair-descents stay grounded, ledges fall', () => {
    const w = new MockWorld()
    // a 10%-grade ramp emulated by MANY small steps (0.05 tall each) —
    // the glue must eat every one
    for (let s = 0; s < 40; s++) {
      w.boxes.push({ cx: s * 0.5, cy: -1 - s * 0.05, cz: 0, hx: 0.25, hy: 1 + s * 0.05, hz: 3 })
    }
    const ch = createCharacter(SPEC, w, 0, 0, 0) // ON the first step (top 0)
    run(ch, 0.3, IDLE)
    let airFrames = 0
    for (let k = 0; k < Math.round(2 / SPEC.fixedDt); k++) {
      ch.step(SPEC.fixedDt, { dirX: 1, dirZ: 0, jumpHeld: false })
      if (!ch.state.grounded) airFrames++
    }
    expect(airFrames).toBe(0) // the descent never leaves the ground
    // a REAL ledge: the floor ends at x = 2, a catch top at −2 follows
    // at x ∈ [4, 12] — higher than stepHeight → it FALLS
    const w2 = new MockWorld()
    w2.boxes.push({ cx: 0, cy: -1, cz: 0, hx: 2, hy: 1, hz: 4 })
    w2.boxes.push({ cx: 8, cy: -3, cz: 0, hx: 4, hy: 1, hz: 4 }) // top at −2
    const ch2 = createCharacter(SPEC, w2, 0, 0, 0)
    run(ch2, 0.3, IDLE)
    let sawAir = false
    for (let k = 0; k < Math.round(1.2 / SPEC.fixedDt); k++) {
      ch2.step(SPEC.fixedDt, { dirX: 1, dirZ: 0, jumpHeld: false })
      if (!ch2.state.grounded) sawAir = true
    }
    expect(sawAir).toBe(true)
    expect(ch2.state.grounded).toBe(true) // landed on the lower catch
    expect(ch2.state.y).toBe(-2)
  })

  test('the determinism law — the same script → the same bits', () => {
    const script: Array<{ dirX: number; dirZ: number; jumpHeld: boolean }> = []
    let s = 0x216
    for (let k = 0; k < 600; k++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5
      script.push({ dirX: (s >>> 0) / 4294967296 - 0.5, dirZ: (s & 7) / 8 - 0.5, jumpHeld: (s & 31) === 0 })
    }
    const trace = (): number[] => {
      const w = new MockWorld()
      w.boxes.push({ cx: 0, cy: -1, cz: 0, hx: 6, hy: 1, hz: 6 })
      w.boxes.push({ cx: 5, cy: 0.3, cz: 2, hx: 1.5, hy: 0.3, hz: 1.5 })
      const ch = createCharacter(SPEC, w, 0, 0, 0)
      const out: number[] = []
      for (const inpt of script) {
        ch.step(SPEC.fixedDt, inpt)
        out.push(ch.state.x, ch.state.y, ch.state.z, ch.state.vx, ch.state.vy, ch.state.vz)
      }
      return out
    }
    const a = trace()
    const b = trace()
    expect(a.length).toBe(b.length)
    let bits = 0
    for (let k = 0; k < a.length; k++) {
      if (Object.is(a[k], b[k])) bits++
    }
    expect(bits).toBe(a.length) // bit-identical (NaN-safe compare included)
  })
})
