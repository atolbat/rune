// lightning.js — a RUNE ORIGINAL (Task 126): the STORM STRIKE — procedural
// LIGHTNING, the combat-VFX classic (skill bolts, tesla arcs, ion cannons):
//
//   · the PATH spawner (Task 126) — each bolt is ONE BURST of stretched
//     billboards laid along a jagged POLYLINE (midpoint-displaced from the
//     sky to the ground, 'lattice' mode: index → segment — the whole bolt
//     exists INSTANTLY, in a single emission, the way lightning works);
//   · the segments streak ALONG their own direction (velocity 'axis' =
//     the local segment dir) — the jagged silhouette of the path itself
//     becomes the bolt's shape;
//   · THE CONNECTIVITY (the "disconnected bright segments" report): the
//     old jitter displaced each path point INDEPENDENTLY in X and Z — at a
//     1.2-unit step and a ±1.5-unit scatter, consecutive segments could
//     bend nearly 180°, and each stretched quad then trailed AWAY from the
//     path — a porcupine of bars with dark wedges at every joint. The new
//     generator WALKS the path: every step deviates from the CURRENT
//     BEARING TO THE TARGET by a bounded cone angle, so the polyline always
//     progresses (a real leader does not double back), the quads overlap
//     tail-over-shoulder (~2.3× the step), and the bolt reads as ONE
//     continuous channel. The last point lands exactly on the target;
//   · branches fork off the main channel at random joints;
//   · the double-STROBE ramp (1 → 0.15 → 0.95 → 0 over 0.16 s — the
//     re-strike every real bolt does), then a dim purple AFTERGLOW path
//     that lingers and fades (the ionized channel);
//   · the impact: a flash card at the strike point + a ground shock ring
//     + embers scattered with the speed brake (LimitSpeed);
//   · the sky flash — a huge dim double-blink card lighting the horizon
//     behind the bolt.
const SEGS = 12 // the main channel's segments

/** A jagged polyline from (x0,y0,z0) down to (x1,y1,z1): a CONE-WALK — each
 * step deviates from the current bearing-to-target by a bounded random
 * angle (the jaggedness shrinks toward the ground: the channel straightens
 * as it lands), the path never doubles back, and the final point lands
 * EXACTLY on the target. Deterministic in `seed` (the bolt replays
 * identically). `jagged` is the max deviation angle per step in radians
 * (~0.5 reads as a proper bolt). */
function boltPath(x0, y0, z0, x1, y1, z1, seed, segs, jagged) {
  const pts = new Float64Array((segs + 1) * 3)
  pts[0] = x0; pts[1] = y0; pts[2] = z0
  const rnd = (n) => {
    const s = Math.sin(seed * 127.1 + n * 311.7 + 13.37) * 43758.5453
    return s - Math.floor(s)
  }
  let px = x0, py = y0, pz = z0
  for (let i = 1; i < segs; i++) {
    const t = i / segs
    // the bearing to the target (the walk's compass)
    let bx = x1 - px, by = y1 - py, bz = z1 - pz
    const bl = Math.hypot(bx, by, bz) || 1
    bx /= bl; by /= bl; bz /= bl
    // the step: a touch over the proportional share, floored so the walk
    // always advances visibly (no stutter segments)
    const step = Math.max(0.8, bl / (segs - i + 0.6))
    // the deviation: a uniform direction in the cone around the bearing.
    // The tilt cap shrinks with t (straightens as it lands); sqrt() biases
    // toward small tilts so the channel stays mostly downward.
    const maxTilt = jagged * (1 - t * 0.6)
    const tilt = maxTilt * Math.sqrt(rnd(i * 2))
    const az = rnd(i * 2 + 1) * 6.2831853
    // the bearing's perpendicular frame: p1 = cross(b, worldUp)
    let p1x = bz, p1y = 0, p1z = -bx
    let pl = Math.hypot(p1x, p1y, p1z)
    if (pl < 1e-6) { p1x = 1; p1y = 0; p1z = 0; pl = 1 }
    p1x /= pl; p1y /= pl; p1z /= pl
    const p2x = by * p1z - bz * p1y, p2y = bz * p1x - bx * p1z, p2z = bx * p1y - by * p1x
    const ct = Math.cos(tilt), st = Math.sin(tilt), ca = Math.cos(az), sa = Math.sin(az)
    px += (bx * ct + (p1x * ca + p2x * sa) * st) * step
    py += (by * ct + (p1y * ca + p2y * sa) * st) * step
    pz += (bz * ct + (p1z * ca + p2z * sa) * st) * step
    pts[i * 3] = px; pts[i * 3 + 1] = py; pts[i * 3 + 2] = pz
  }
  // the final leg: guarantee a healthy closing segment — if the walk
  // drifted too near the target, pull the second-to-last point out along
  // the incoming direction (a zero-length segment would throw in the
  // spawner).
  const li = (segs - 1) * 3
  const lx = pts[li] - x1, ly = pts[li + 1] - y1, lz = pts[li + 2] - z1
  if (Math.hypot(lx, ly, lz) < 0.7 && segs >= 2) {
    let ax = pts[li] - pts[li - 3], ay = pts[li + 1] - pts[li - 2], az = pts[li + 2] - pts[li - 1]
    const al = Math.hypot(ax, ay, az) || 1
    pts[li] = x1 + (ax / al) * 1.1
    pts[li + 1] = y1 + (ay / al) * 1.1
    pts[li + 2] = z1 + (az / al) * 1.1
  }
  pts[segs * 3] = x1; pts[segs * 3 + 1] = y1; pts[segs * 3 + 2] = z1
  return pts
}

export default {
  title: 'Lightning Storm',
  sub: 'rune original · procedural BOLTS on the path spawner · branches · afterglow',
  camera: { yaw: 0.5, pitch: 0.14, dist: 15, orbit: 0.03, target: [-2, 4.5, -4] },

  make(env) {
    // ── the scene: a dark plain under a black sky ──
    env.addMesh({
      id: 'lt-floor',
      geometry: env.geometry.plane({ width: 120, height: 120 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      uniforms: { u_albedo: [0.055, 0.06, 0.08, 1] },
    })

    // ── the main channel: ONE burst along the jagged path ──
    // (stretched billboards, velocity ALONG the local segment, mostly at
    // rest — the path itself is the bolt's shape; scatter hugs the line.
    // THE TEXTURE is the STREAK (bright along u, gaussian across v —
    // env.ribbonTexture): a bolt is a LINE, and the streak reads each
    // segment as a thin bright channel — a blobby sprite here reads as
    // stacked cones. THE WIDTH/TAIL SPLIT: a stretched quad's width =
    // size·½ while its tail = (|v|·sf + lf)·size — the tail is tuned to
    // ≈2.3× the average segment step (steps ~1.15: the quads overlap
    // tail-over-shoulder and the channel stays CONNECTED at the joints,
    // with the cone-walk keeping consecutive directions within ~30°).
    const BOLT_BASE = {
      shape: { kind: 'path', points: [0, 13, 0, 0, 0, 0], mode: 'lattice', scatter: 0.03 },
      velocity: { mode: 'axis' },
      speed: [1.2, 1.2], life: [0.16, 0.16], size: [0.7, 0.7],
      color: [[1, 1, 1, 1], [0.8, 0.9, 1, 1]], seed: 5,
    }
    const bolt = env.addLayer({
      id: 'lt-bolt',
      facade: env.createParticles({
        capacity: 96,
        ramp: env.createRamp([
          // THE DOUBLE STROBE (every real bolt re-strikes)
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 0 },
          { t: 0.07, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.3, size: 1, r: 0.9, g: 0.95, b: 1, a: 0.12 },
          { t: 0.45, size: 1, r: 1, g: 1, b: 1, a: 0.95 },
          { t: 0.75, size: 1, r: 0.9, g: 0.95, b: 1, a: 0.5 },
          { t: 1, size: 0.7, r: 0.85, g: 0.9, b: 1, a: 0 },
        ]),
        spawner: BOLT_BASE,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.04, lengthFactor: 3.4 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.ribbonTexture,
    })

    // ── the afterglow: the SAME path, dim violet, lingering (the
    //    ionized channel cooling) — wider than the channel ──
    const GLOW_BASE = {
      shape: { kind: 'path', points: [0, 13, 0, 0, 0, 0], mode: 'lattice', scatter: 0.12 },
      velocity: { mode: 'axis' },
      speed: [0.1, 0.1], life: [0.55, 0.7], size: [1.0, 1.0],
      color: [[0.55, 0.45, 0.95, 0.4], [0.4, 0.35, 0.8, 0.25]], seed: 5,
    }
    const afterglow = env.addLayer({
      id: 'lt-glow',
      facade: env.createParticles({
        capacity: 96,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 0.9 },
          { t: 0.5, size: 1.25, r: 1, g: 1, b: 1, a: 0.35 },
          { t: 1, size: 1.5, r: 1, g: 1, b: 1, a: 0 },
        ]),
        spawner: GLOW_BASE,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.02, lengthFactor: 2.2 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      // a soft glow, not a line — the channel's halo (a streak here would
        // read as a second bolt)
      texture: () => env.glowTexture,
    })

    // ── the branches: short forks off a random joint of the channel ──
    const BRANCH_BASE = {
      shape: { kind: 'path', points: [0, 6, 0, 2, 3, 1], mode: 'lattice', scatter: 0.02 },
      velocity: { mode: 'axis' },
      speed: [0.8, 0.8], life: [0.13, 0.13], size: [0.45, 0.45],
      color: [[0.95, 0.97, 1, 1], [0.75, 0.85, 1, 0.9]], seed: 5,
    }
    const branches = env.addLayer({
      id: 'lt-branches',
      facade: env.createParticles({
        capacity: 40,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.5, size: 1, r: 1, g: 1, b: 1, a: 0.4 },
          { t: 1, size: 0.6, r: 0.9, g: 0.95, b: 1, a: 0 },
        ]),
        spawner: BRANCH_BASE,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.04, lengthFactor: 2.6 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.ribbonTexture,
    })

    // ── the strike's ground package: flash + shock ring + embers ──
    const FLASH_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.2, 0.2], size: [4.5, 4.5],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 11,
    }
    const flash = env.addLayer({
      id: 'lt-flash',
      facade: env.createParticles({
        capacity: 4,
        ramp: env.createRamp([
          // frame 4 — the atlas flash star (a gaussian + an anamorphic cross)
          { t: 0, size: 0.6, r: 1, g: 1, b: 1, a: 1, frame: 4 },
          { t: 0.4, size: 0.85, r: 1, g: 0.9, b: 0.7, a: 0.9, frame: 4 },
          { t: 1, size: 1, r: 0.9, g: 0.8, b: 1, a: 0, frame: 4 },
        ]),
        spawner: FLASH_S,
        render: { kind: 'billboard', mode: 'oriented', axis: [0, 0, 1], tiles: [4, 4] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })
    const RING_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0.3, 0.5], life: [0.6, 0.8], size: [0.4, 0.6],
      color: [[0.8, 0.9, 1, 1], [0.6, 0.8, 1, 1]], seed: 13,
    }
    const ring = env.addLayer({
      id: 'lt-ring',
      facade: env.createParticles({
        capacity: 4,
        ramp: env.createRamp([
          { t: 0, size: 0.4, r: 0.9, g: 1, b: 1, a: 0.9, frame: 5 },
          { t: 0.6, size: 4.2, r: 0.65, g: 0.85, b: 1, a: 0.4, frame: 5 },
          { t: 1, size: 6.5, r: 0.5, g: 0.75, b: 1, a: 0, frame: 5 },
        ]),
        spawner: RING_S,
        render: { kind: 'billboard', mode: 'horizontal', tiles: [4, 4] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })
    const EMBER_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 1.4] },
      velocity: { mode: 'radial' },
      speed: [3, 11], life: [0.5, 0.9], size: [0.03, 0.03],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 17,
    }
    const embers = env.addLayer({
      id: 'lt-embers',
      facade: env.createParticles({
        capacity: 80,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.5, size: 1, r: 1, g: 0.8, b: 0.45, a: 0.9 },
          { t: 1, size: 0.4, r: 0.9, g: 0.5, b: 0.2, a: 0 },
        ]),
        forces: { gravity: [0, -10, 0], limitSpeed: { limit: 0, dampen: 0.35 } },
        spawner: EMBER_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.09 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      // a proper streak spark (a blob would read as dots dragging)
      texture: () => env.ribbonTexture,
    })

    // ── the sky flash: a huge dim double-blink behind the bolt ──
    const SKY_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.34, 0.34], size: [22, 22],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 19,
    }
    const sky = env.addLayer({
      id: 'lt-sky',
      facade: env.createParticles({
        capacity: 3,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.8, g: 0.9, b: 1, a: 0 },
          { t: 0.08, size: 1, r: 0.85, g: 0.92, b: 1, a: 0.3 },
          { t: 0.2, size: 1, r: 0.8, g: 0.9, b: 1, a: 0.06 },
          { t: 0.32, size: 1, r: 0.85, g: 0.92, b: 1, a: 0.22 },
          { t: 1, size: 1, r: 0.7, g: 0.85, b: 1, a: 0 },
        ]),
        spawner: SKY_S,
        render: { kind: 'billboard', mode: 'camera' },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the charged mist: a slow ambient layer over the plain (the
    //    storm's breath — also keeps the demo alive between strikes) ──
    const MIST_S = {
      shape: { kind: 'disc', origin: [0, 0.5, 0], axis: [0, 1, 0], radius: [3, 16] },
      velocity: { mode: 'radial' },
      speed: [0.1, 0.4], life: [5, 8], size: [0.12, 0.3],
      color: [[0.5, 0.6, 0.95, 0.5], [0.35, 0.45, 0.75, 0.32]], seed: 23,
    }
    const mist = env.addLayer({
      id: 'lt-mist',
      facade: env.createParticles({
        capacity: 120, rate: 16, prewarm: 6,
        wrap: { size: [40, 0, 40] },
        ramp: env.createRamp([
          { t: 0, size: 0.6, r: 1, g: 1, b: 1, a: 0 },
          { t: 0.25, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 1.6, r: 1, g: 1, b: 1, a: 0 },
        ]),
        forces: { gravity: [0, 0.06, 0], drag: 0.5, noise: { strength: 0.8, scale: 0.18, speed: 0.09 } },
        spawner: MIST_S,
        render: { kind: 'billboard', mode: 'camera' },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the horizon glow: the storm's back light — a permanent faint rim
    //    behind the plain (mood between strikes; the scene never goes
    //    fully black) ──
    const HORIZON_S = {
      shape: { kind: 'disc', origin: [0, 3.5, -22], axis: [0, 1, 0], radius: [0, 4] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [1000, 1000], size: [16, 16],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 27,
    }
    const horizon = env.addLayer({
      id: 'lt-horizon',
      facade: env.createParticles({
        capacity: 2,
        bursts: [{ time: 0.01, count: 2, cycle: 0, interval: 1000, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.55, g: 0.68, b: 1, a: 0.16, frame: 14 },
          { t: 1, size: 1, r: 0.5, g: 0.62, b: 0.95, a: 0.16, frame: 14 },
        ]),
        spawner: HORIZON_S,
        render: { kind: 'billboard', mode: 'camera', tiles: [4, 4] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })

    const layers = [bolt, afterglow, branches, flash, ring, embers, sky, mist, horizon]
    let t = 1.2
    let next = 1.4
    let strikeN = 0
    // the probe counter (scripts/task128-probe.mjs reads it)
    const C = (typeof window !== 'undefined' ? (window.__vfxCounters ??= {}) : {})

    return {
      frame(ctx) {
        t += ctx.dt
        if (t >= next) {
          next = t + 2.1 + Math.random() * 1.6
          strikeN++
          C.strikes = strikeN
          const seed = 900 + strikeN * 37

          // the strike geometry: a target on the plain, a start in the sky.
          // THE ZONE rides the camera's view (centered near the orbit
          // target — a bolt 30 units off-frame reads as a speck, not a
          // strike; the old static-path bug put every bolt dead-center
          // by accident, which is why it LOOKED right)
          const tx = -3.5 + Math.sin(strikeN * 2.3) * 4.5
          const tz = -6.5 + Math.cos(strikeN * 1.7) * 3
          const sx = tx + (Math.sin(strikeN * 5.1) * 2.5)
          const sz = tz + (Math.cos(strikeN * 4.3) * 2.5)
          // the cone-walk channel: bounded deviation, always progressing
          // (jaggedness 0.55 rad ≈ 31° per step — a proper leader look)
          const path = boltPath(sx, 14, sz, tx, 0, tz, seed, SEGS, 0.55)

          // the channel + the afterglow: the SAME jagged path, two lives.
          // THE OVERRIDE GOES INSIDE `shape` — a top-level `points` field
          // sits NEXT to shape and the spawner never reads it (the exact
          // bug behind "cones over the origin, a splash off to the side":
          // every strike replayed the STATIC demo path while the ground
          // package followed the real target).
          const points = Array.from(path)
          bolt.facade.burst(SEGS, { ...BOLT_BASE, shape: { ...BOLT_BASE.shape, points }, seed })
          afterglow.facade.burst(SEGS, { ...GLOW_BASE, shape: { ...GLOW_BASE.shape, points }, seed })

          // 1–2 branches: forks off random joints, walking out-and-down
          // (the same cone-walk generator, from a joint of the channel)
          const nb = 1 + (strikeN % 2)
          for (let b = 0; b < nb; b++) {
            const j = 2 + ((strikeN * 7 + b * 5) % (SEGS - 3))
            const bx = path[j * 3], by = path[j * 3 + 1], bz = path[j * 3 + 2]
            const dirx = Math.sin(strikeN * 3.3 + b * 2.4)
            const dirz = Math.cos(strikeN * 2.9 + b * 1.7)
            const bpts = boltPath(bx, by, bz, bx + dirx * 3.4, Math.max(0.3, by - 2.6), bz + dirz * 3.4, seed + b * 13, 5, 0.5)
            branches.facade.burst(5, { ...BRANCH_BASE, shape: { ...BRANCH_BASE.shape, points: Array.from(bpts) }, seed: seed + b * 13 })
          }

          // the ground package at the strike point
          flash.facade.at(tx, 0.5, tz)
          flash.facade.burst(1, { ...FLASH_S, seed })
          ring.facade.at(tx, 0.06, tz)
          ring.facade.burst(1, { ...RING_S, seed })
          embers.facade.at(tx, 0.4, tz)
          embers.facade.burst(30, { ...EMBER_S, seed })

          // the sky flash behind the bolt
          sky.facade.at(sx, 11, sz - 6)
          sky.facade.burst(1, { ...SKY_S, seed })

          env.log.event(`strike #${strikeN} at (${tx.toFixed(1)}, ${tz.toFixed(1)})`)
        }

        for (const l of layers) l.facade.advance(ctx.dt)
      },
    }
  },
}
