import { describe, expect, it } from 'bun:test'
import { createParticleSystem } from '../src/index.ts'
import type { SpawnRecord, ForceFields } from '../src/index.ts'

/**
 * Task 174 — Part B: the advance-pass micro-surgery's pins.
 *
 * THE GRAVITY HOIST (gx·dt multiplied once per frame instead of per
 * particle): bit-identical by construction — the same operands, the same
 * IEEE multiply, once instead of N times. The pin walks a real system
 * against a hand-rolled twin that keeps the PER-FRAME multiply (the
 * pre-174 expression tree) and demands f64 BIT equality (Object.is —
 * sign-of-zero included) across a gravity+drag walk.
 *
 * THE EMISSION SENTINEL (one isFinite over the grand sum + two sign
 * compares, the granular checks deferred to the throw path): the throws
 * must stay IDENTICAL — same messages, same precedence — and the
 * sentinel's known false-positive class (individually finite fields
 * whose grand sum overflows while the 9-term vector sum does not) must
 * pass CLEANLY, exactly as the pre-174 form did.
 *
 * THE REJECTED MAYKILL SELECT (the death check reading the hoisted life
 * local when no kill site is armed): REGRESSED the bare walk +34% on V8
 * (the re-load it removed was already free — V8's load elimination; the
 * select broke the optimization instead). Rejected with numbers, kept
 * OUT of the source; this suite pins the death-check semantics it would
 * have touched stay exact (a kill site still retires THIS frame).
 */

function fixedSpawner(over: Partial<SpawnRecord>): (index: number, out: SpawnRecord) => void {
  return (index, out) => {
    out.x = 0; out.y = 0; out.z = 0
    out.vx = 0; out.vy = 0; out.vz = 0
    out.life = 1; out.size = 1
    out.r = 1; out.g = 1; out.b = 1; out.a = 1
    out.seed = 0
    Object.assign(out, over)
  }
}

describe('Task 174 — the advance micro-pass', () => {
  it('THE GRAVITY HOIST is bit-identical to the per-particle multiply (f64, sign-of-zero included)', () => {
    const G = [0.35, -4.2, 1.1]
    const DRAG = 0.6
    const DT = 1 / 60
    const N = 64
    const FORCES: ForceFields = { gravity: G, drag: DRAG, turbulence: 0 }
    const ps = createParticleSystem(N)
    // seed with a deterministic spread (no spawner math in this pin)
    const seeds: Partial<SpawnRecord>[] = []
    for (let i = 0; i < N; i++) {
      seeds.push({
        x: i * 0.37 - 11, y: (i % 7) * 0.9, z: (i * i % 13) * 0.21,
        vx: Math.sin(i) * 2, vy: Math.cos(i * 0.5) * 3, vz: i * 0.05,
        life: 1e9, // effectively immortal — the walk is the subject
      })
    }
    for (const over of seeds) ps.emit(1, fixedSpawner(over))
    // the twin: the pre-174 expression tree (gx*dt INSIDE the per-particle
    // step) over the SAME f32 storage discipline — the SoA fields are
    // Float32Array, so every frame's results round through f32 on store
    // and the next frame reads them back (the task131/142 parity rule).
    const fr = Math.fround
    let twin = seeds.map(r => [fr(r.x ?? 0), fr(r.y ?? 0), fr(r.z ?? 0), fr(r.vx ?? 0), fr(r.vy ?? 0), fr(r.vz ?? 0)] as const)
    const dragFactor = Math.exp(-DRAG * DT)
    const FRAMES = 60
    for (let k = 0; k < FRAMES; k++) {
      ps.advance(DT, FORCES)
      twin = twin.map(([px, py, pz, vx, vy, vz]) => {
        // per-particle multiply — the OLD form, verbatim (f64 math on the
        // f32-loaded values), the results fround on store
        const nvx = vx * dragFactor + G[0] * DT
        const nvy = vy * dragFactor + G[1] * DT
        const nvz = vz * dragFactor + G[2] * DT
        return [fr(px + nvx * DT), fr(py + nvy * DT), fr(pz + nvz * DT), fr(nvx), fr(nvy), fr(nvz)] as const
      })
    }
    const f = ps.fields
    let mismatches = 0
    for (let i = 0; i < N; i++) {
      const [px, py, pz, vx, vy, vz] = twin[i]
      if (!Object.is(f.px[i], px) || !Object.is(f.py[i], py) || !Object.is(f.pz[i], pz)
        || !Object.is(f.vx[i], vx) || !Object.is(f.vy[i], vy) || !Object.is(f.vz[i], vz)) {
        mismatches++
      }
    }
    expect(mismatches).toBe(0)
  })

  it('THE SENTINEL keeps the throws identical — precedence included (life before size before vectors)', () => {
    const ps = createParticleSystem(16)
    // life broken + size broken → the LIFE message wins (the original order)
    expect(() => ps.emit(1, fixedSpawner({ life: NaN, size: -1 }))).toThrow('life <= 0')
    expect(() => ps.emit(1, fixedSpawner({ life: 0, size: -1 }))).toThrow('life <= 0')
    // size broken alone
    expect(() => ps.emit(1, fixedSpawner({ size: -1 }))).toThrow('size < 0')
    expect(() => ps.emit(1, fixedSpawner({ size: NaN }))).toThrow('size < 0')
    // vectors broken alone — the message is the NaN-in-vectors one
    expect(() => ps.emit(1, fixedSpawner({ vx: NaN }))).toThrow('NaN in its vectors')
    expect(() => ps.emit(1, fixedSpawner({ g: Infinity }))).toThrow('NaN in its vectors')
    // life=+Inf: finite fields otherwise — the LIFE check catches it
    expect(() => ps.emit(1, fixedSpawner({ life: Infinity }))).toThrow('life <= 0')
  })

  it('THE SENTINEL false-positive class passes cleanly (finite fields, overflowing grand sum)', () => {
    // life and the vector sum are each ~1.5e308 (finite), but life + the
    // 9-term sum overflows: the pre-174 form threw NOTHING (each check
    // passes individually), the sentinel falls through to the granular
    // re-check and also passes. Identical behavior — pinned.
    const ps = createParticleSystem(4)
    const huge = 1.5e308
    expect(() => ps.emit(1, fixedSpawner({ x: huge, life: huge }))).not.toThrow()
    expect(ps.count).toBe(1)
    // and the classic overflow-only case still throws (the 9-term sum
    // alone overflows): both forms throw the vectors message
    expect(() => ps.emit(1, fixedSpawner({ x: huge, y: huge, z: huge, vx: huge, vy: huge, vz: huge, r: huge, g: huge, b: huge, a: huge }))).toThrow('NaN in its vectors')
  })

  it('the death check semantics are untouched: a kill site still retires THIS frame (the rejected select would have touched this)', () => {
    // a kill plane retires the particle the frame it penetrates — the
    // mid-walk f.life write must reach the death check exactly as before
    let retired = 0
    const ps = createParticleSystem(8, { onRetire: () => { retired++ } })
    const FORCES: ForceFields = {
      gravity: [0, -10, 0], drag: 0, turbulence: 0,
      collide: { planes: [{ normal: [0, 1, 0], point: [0, -0.05, 0], restitution: 0, kill: true }] },
    }
    ps.emit(1, fixedSpawner({ y: 1, vy: 0, life: 1e9 }))
    for (let k = 0; k < 30; k++) ps.advance(1 / 60, FORCES)
    expect(retired).toBe(1)
    expect(ps.count).toBe(0)
  })
})
