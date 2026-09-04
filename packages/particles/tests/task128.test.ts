/**
 * Task 128 — the collision SHAPES (spheres + boxes, the trail demo's
 * request) and the grass DENSITY MASK + the wave wind. The sphere/box
 * response mirrors the planes: only when penetrating AND moving into the
 * surface; push out, reflect with restitution, damp the tangent, fire
 * the contact event with the EXCLUSIVE shape index.
 */

import { describe, expect, it } from 'bun:test'
import { createParticles, createGrassField } from '../src/index.ts'
import type { SpawnerDesc, CollideRecord } from '../src/index.ts'

/** A minimal rest spawner: a point at a given origin, velocity explicit. */
const drop = (y: number, vy: number, x = 0, vx = 0): SpawnerDesc => ({
  shape: { kind: 'point', origin: [x, y, 0] },
  velocity: { mode: 'fixed', dir: vx === 0 && vy === 0 ? [0, 1, 0] : [vx, vy, 0] },
  speed: [Math.hypot(vx, vy) || 1, Math.hypot(vx, vy) || 1],
  life: [10, 10], size: [0.1, 0.1],
  color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 9,
})

// ─── the collision spheres ──────────────────────────────────────────────────

describe('Task 128: collision spheres', () => {
  it('a direct hit bounces off RADIALLY: pushed outside, velocity reflected', () => {
    // the drop ENTERS from above (y 1.5 → 0.9 over the step — a shallow
    // penetration of the top; the step is sized so it cannot tunnel
    // past the center in one integration)
    const ps = createParticles({
      capacity: 4,
      forces: { gravity: [0, 0, 0], collide: { spheres: [{ center: [0, 0, 0], radius: 1, restitution: 0.5, friction: 0 }] } },
      spawner: drop(1.5, -10),
    })
    ps.burst(1)
    ps.advance(0.06) // y: 1.5 → 0.9 — inside, above the center
    expect(ps.count).toBe(1)
    // outside the sphere (y snapped back to ~+1)
    expect(ps.fields.py[0]).toBeGreaterThanOrEqual(1)
    expect(ps.fields.py[0]).toBeLessThan(1.001)
    // the velocity reflected: |v·n| scaled by restitution, pointing OUT
    expect(ps.fields.vy[0]).toBeCloseTo(5, 1) // 10 × 0.5
  })

  it('a GLANCING hit deflects along the local radial normal, not world up', () => {
    // the drop lands at x≈0.78 on the unit sphere: the normal there is
    // ~(0.8, 0.6, 0) — the reflection must carry a big X component and
    // keep sliding DOWN along the surface (the tangential part survives)
    const ps = createParticles({
      capacity: 4,
      forces: { gravity: [0, 0, 0], collide: { spheres: [{ center: [0, 0, 0], radius: 1, restitution: 0.5, friction: 0 }] } },
      spawner: drop(0.65, -4, 0.75, 0),
    })
    ps.burst(1)
    ps.advance(0.01) // (0.75, 0.61) — inside, r ≈ 0.97
    expect(ps.count).toBe(1)
    const { px, py, vx, vy } = ps.fields
    const r = Math.hypot(px[0], py[0])
    expect(r).toBeGreaterThanOrEqual(1) // pushed out
    expect(r).toBeLessThan(1.01)
    // the post-bounce velocity: reflected about the radial normal — a
    // big TANGENTIAL (x) part appears, the y part stays downward-ish
    // (sliding along the surface)
    expect(vx[0]).toBeGreaterThan(1.5)
    expect(vy[0]).toBeGreaterThan(-4) // damped from the entry speed
    // the NORMAL component flipped sign (in → out)
    const nx = px[0] / r, ny = py[0] / r
    expect(vx[0] * nx + vy[0] * ny).toBeGreaterThan(0)
  })

  it('a direct hit on the sphere fires the event with the surface position', () => {
    const hits: CollideRecord[] = []
    const seen: { sphere: number, plane: number, box: number }[] = []
    const ps = createParticles({
      capacity: 4,
      forces: {
        collide: {
          spheres: [{ center: [0, 0, 0], radius: 1, restitution: 0.5 }],
          onCollide: (r) => { seen.push({ sphere: r.sphere, plane: r.plane, box: r.box }); hits.push({ ...r }) },
        },
      },
      spawner: drop(1.5, -10),
    })
    ps.burst(1)
    ps.advance(0.06)
    expect(seen.length).toBe(1)
    expect(seen[0].sphere).toBe(0)
    expect(seen[0].plane).toBe(-1)
    expect(seen[0].box).toBe(-1)
    // the event reports the POST-response position: on the surface
    expect(hits[0].y).toBeGreaterThanOrEqual(1)
  })

  it('kill: the sphere consumes on contact', () => {
    const ps = createParticles({
      capacity: 4,
      forces: { collide: { spheres: [{ center: [0, 0, 0], radius: 1, restitution: 0.5, kill: true }] } },
      spawner: drop(1.5, -10),
    })
    ps.burst(1)
    ps.advance(0.06)
    expect(ps.count).toBe(0)
  })

  it('a set with NO planes (spheres only) is valid — planes are optional now', () => {
    const ps = createParticles({
      capacity: 4,
      forces: { collide: { spheres: [{ center: [0, 3, 0], radius: 1, restitution: 0.5 }] } },
      spawner: drop(1.5, -10),
    })
    ps.burst(1)
    ps.advance(0.01)
    expect(ps.count).toBe(1) // runs clean, no validation error
  })

  it('the sphere fields validate loudly', () => {
    expect(() => createParticles({
      capacity: 4,
      forces: { collide: { spheres: [{ center: [0, 0, 0], radius: -1, restitution: 0 }] } },
    })).toThrow('radius')
    expect(() => createParticles({
      capacity: 4,
      forces: { collide: { spheres: [{ center: [0, 0], radius: 1, restitution: 0 }] } },
    })).toThrow('center')
    expect(() => createParticles({
      capacity: 4,
      forces: { collide: { spheres: [{ center: [0, 0, 0], radius: 1, restitution: 2 }] } },
    })).toThrow('restitution')
    expect(() => createParticles({
      capacity: 4,
      forces: { collide: {} },
    })).toThrow('at least one')
  })
})

// ─── the collision boxes ────────────────────────────────────────────────────

describe('Task 128: collision boxes', () => {
  it('a top-face hit bounces straight up (the min-penetration axis is Y)', () => {
    // the drop ENTERS the top face shallowly: y 1.5 → 0.95 over the step
    // (a deep start would put the min-pen axis past the box's center
    // plane and read as the bottom face — the response is skipped)
    const ps = createParticles({
      capacity: 4,
      forces: { gravity: [0, 0, 0], collide: { boxes: [{ center: [0, 0, 0], half: [1, 1, 1], restitution: 0.6, friction: 0 }] } },
      spawner: drop(1.5, -10),
    })
    ps.burst(1)
    ps.advance(0.055) // y: 1.5 → 0.95 — a shallow top penetration
    expect(ps.count).toBe(1)
    expect(ps.fields.py[0]).toBeGreaterThanOrEqual(1)
    expect(ps.fields.py[0]).toBeLessThan(1.001)
    expect(ps.fields.vy[0]).toBeCloseTo(6, 1)
  })

  it('a SIDE hit deflects horizontally (the nearest face wins)', () => {
    // the drop enters the +X face from outside: x 1.5 → 0.86 over the
    // step — the min-pen axis is X, it bounces back in -X
    const ps = createParticles({
      capacity: 4,
      forces: { gravity: [0, 0, 0], collide: { boxes: [{ center: [0, 0, 0], half: [1, 1, 1], restitution: 0.5, friction: 0 }] } },
      spawner: drop(0, 0, 1.5, -8),
    })
    ps.burst(1)
    ps.advance(0.08) // x: 1.5 → 0.86 — inside through the +X face
    expect(ps.count).toBe(1)
    expect(ps.fields.px[0]).toBeGreaterThanOrEqual(1) // pushed out the +X face
    expect(ps.fields.px[0]).toBeLessThan(1.001)
    expect(ps.fields.vx[0]).toBeCloseTo(4, 1) // −8 reflected × 0.5
  })

  it('a corner-region hit picks whichever face is NEAREST', () => {
    // near the top corner: entering at (0.95, 1.5) falling — the Y
    // penetration is the thinnest → the TOP face resolves and the bounce
    // is upward (the X face is a full 0.95 deep)
    const ps = createParticles({
      capacity: 4,
      forces: { gravity: [0, 0, 0], collide: { boxes: [{ center: [0, 0, 0], half: [1, 1, 1], restitution: 0.5, friction: 0 }] } },
      spawner: drop(1.5, -6, 0.95, 0),
    })
    ps.burst(1)
    ps.advance(0.09) // y: 1.5 → 0.96 at x = 0.95 — the Y face wins
    expect(ps.count).toBe(1)
    expect(ps.fields.py[0]).toBeGreaterThanOrEqual(1) // out the top
    expect(ps.fields.py[0]).toBeLessThan(1.001)
    expect(ps.fields.vy[0]).toBeCloseTo(3, 1) // −6 reflected × 0.5
    expect(ps.fields.px[0]).toBeCloseTo(0.95, 5) // the x untouched
  })

  it('the event record names the BOX (plane and sphere read -1)', () => {
    const seen: { box: number, plane: number, sphere: number }[] = []
    const ps = createParticles({
      capacity: 4,
      forces: {
        collide: {
          boxes: [{ center: [0, 0, 0], half: [1, 1, 1], restitution: 0.5 }],
          onCollide: (r) => seen.push({ box: r.box, plane: r.plane, sphere: r.sphere }),
        },
      },
      spawner: drop(1.5, -10),
    })
    ps.burst(1)
    ps.advance(0.055)
    expect(seen.length).toBe(1)
    expect(seen[0].box).toBe(0)
    expect(seen[0].plane).toBe(-1)
    expect(seen[0].sphere).toBe(-1)
  })

  it('planes + spheres + boxes TOGETHER (the trail demo layout)', () => {
    // a firework drop: bounces off the box, then the floor plane, and a
    // sphere standing nearby catches later drops — everything coexists.
    const ps = createParticles({
      capacity: 8,
      forces: {
        gravity: [0, -10, 0],
        collide: {
          planes: [{ normal: [0, 1, 0], point: [0, -2, 0], restitution: 0.5 }],
          spheres: [{ center: [3, -1, 0], radius: 1, restitution: 0.5 }],
          boxes: [{ center: [0, -1, 0], half: [1, 1, 1], restitution: 0.5 }],
        },
      },
      spawner: drop(1.4, -8),
    })
    ps.burst(1)
    ps.advance(0.2)
    expect(ps.count).toBe(1) // alive through the contacts
    expect(ps.fields.py[0]).toBeGreaterThan(-2.1) // never under the floor
  })

  it('the box fields validate loudly', () => {
    expect(() => createParticles({
      capacity: 4,
      forces: { collide: { boxes: [{ center: [0, 0, 0], half: [1, 0, 1], restitution: 0 }] } },
    })).toThrow('half')
    expect(() => createParticles({
      capacity: 4,
      forces: { collide: { boxes: [{ center: [0, 0, 0], half: [1, 1, 1], restitution: -0.5 }] } },
    })).toThrow('restitution')
    expect(() => createParticles({
      capacity: 4,
      forces: { collide: { boxes: [{ center: [0, 0], half: [1, 1, 1], restitution: 0 }] } },
    })).toThrow('center')
  })
})

// ─── the grass density mask ─────────────────────────────────────────────────

describe('Task 128: the grass density mask', () => {
  it('rejection sampling THINS a sparse field below the ceiling', () => {
    const full = createGrassField({ count: 2000, radius: 10, height: [0.3, 0.8], seed: 5 })
    // an 8%-acceptance mask: 5×count tries → ~800 accepted — the ceiling
    // is NOT reached, the field is genuinely sparser
    const sparse = createGrassField({ count: 2000, radius: 10, height: [0.3, 0.8], seed: 5, mask: () => 0.08 })
    expect(full.count).toBe(2000)
    expect(sparse.count).toBeLessThan(1500)
    expect(sparse.count).toBeGreaterThan(300)
  })

  it('a HALF-PLANE mask grows grass only on its side (the density redistributes)', () => {
    // w=1 for x>0, w=0 for x<=0: the accept budget still fills 2000 — but
    // every blade lives on the +X half (the SPACING doubled on that half
    // is what "lower frequency" reads as)
    const f = createGrassField({ count: 2000, radius: 12, height: [0.3, 0.8], seed: 5, mask: (x) => (x > 0 ? 1 : 0) })
    expect(f.count).toBe(2000)
    for (let i = 0; i < f.count; i++) {
      expect(f.pos[i * 3]).toBeGreaterThan(0)
    }
  })

  it('a ZERO mask grows nothing (count 0, no NaNs in the buffers)', () => {
    const f = createGrassField({ count: 500, radius: 10, height: [0.3, 0.8], seed: 5, mask: () => 0 })
    expect(f.count).toBe(0)
  })

  it('the mask is deterministic (same desc → bit-identical bake)', () => {
    const mask = (x: number, z: number) => Math.min(1, Math.max(0, 0.3 + 0.4 * Math.sin(x * 0.3) * Math.cos(z * 0.2)))
    const a = createGrassField({ count: 800, radius: 12, height: [0.3, 0.8], seed: 9, mask })
    const b = createGrassField({ count: 800, radius: 12, height: [0.3, 0.8], seed: 9, mask })
    expect(a.count).toBe(b.count)
    expect([...a.pos]).toEqual([...b.pos])
    expect([...a.par]).toEqual([...b.par])
  })

  it('the blade heights and brightness scale with the mask value', () => {
    // a mask that is 1.0 inside r<5 and 0.35 outside: the inner blades
    // (height × 1.0) are on average TALLER than the outer (× 0.71)
    const f = createGrassField({ count: 4000, radius: 12, height: [1, 1], seed: 9, mask: (x, z) => (Math.hypot(x, z) < 5 ? 1 : 0.35) })
    let innerSum = 0, innerN = 0, outerSum = 0, outerN = 0
    for (let i = 0; i < f.count; i++) {
      const r = Math.hypot(f.pos[i * 3], f.pos[i * 3 + 2])
      if (r < 4) { innerSum += f.par[i * 4]; innerN++ }
      else if (r > 6) { outerSum += f.par[i * 4]; outerN++ }
    }
    expect(innerN).toBeGreaterThan(100)
    expect(outerN).toBeGreaterThan(100)
    expect(innerSum / innerN).toBeGreaterThan(outerSum / outerN * 1.2)
  })

  it('the wave wind ships in BOTH shader twins (the swing term)', () => {
    const f = createGrassField({ count: 8, radius: 10, height: [0.3, 0.8], seed: 5 })
    expect(f.glsl.vertex).toContain('bendDir')
    expect(f.glsl.vertex).toContain('swing')
    expect(f.wgsl).toContain('bendDir')
    expect(f.wgsl).toContain('swing')
  })

  it('the mask validates loudly (a function or absent)', () => {
    expect(() => createGrassField({ count: 8, radius: 5, height: [0.3, 0.8], mask: 'nope' as never })).toThrow('mask')
  })
})
