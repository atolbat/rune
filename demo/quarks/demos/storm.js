// storm.js — a RUNE ORIGINAL (the Task 124 showcase): a night rainstorm —
// the game-designer's "weather that interacts with the world" problem:
//
//   · collide KILL — every raindrop DIES on the floor (no lying streaks,
//     no underwater soup — the Task 124 plane.kill knob);
//   · collide.onCollide — every contact SPLASHES at the exact hit point:
//     a rising ring card + a crown of 3 droplets, spawned from the event
//     record (flushed after the integration walk — safe sub-emission);
//   · stretched billboards × speed — the rain reads as STREAKS, the classic
//     game-rain look;
//   · lightning — a schedule-rolled double flash in the sky + a rain surge
//     (a soft "gust" via a temporary rate boost).
//
// The scene: a dark wet field, the rain sheet falling from a 26×26
// rectangle at y = 9 with a wind tilt, ~260 drops/s. The camera sits low.
const RAIN_RATE = 260
const FLOOR_Y = 0

export default {
  title: 'Rainstorm',
  sub: 'rune original · rain dies on impact · every drop splashes · lightning',
  camera: { yaw: 0.35, pitch: 0.13, dist: 11, orbit: 0.03, target: [0, 1.4, 0] },

  make(env) {
    // ── the scene: a dark wet field ──
    env.addMesh({
      id: 'st-floor',
      geometry: env.geometry.plane({ width: 90, height: 90 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, FLOOR_Y, 0, 1]),
      uniforms: { u_albedo: [0.08, 0.09, 0.115, 1] },
    })

    // the rain's own splash bookkeeping (per-frame drain queue)
    const splashQueue = []

    // ── the rain: stretched streaks, killed on the floor ──
    const RAIN_S = {
      shape: { kind: 'rectangle', origin: [0, 9, 0], axis: [0, 1, 0], width: 26, height: 26 },
      velocity: { mode: 'fixed', dir: [0.045, -1, 0.03] },
      speed: [21, 25], life: [1.4, 1.7], size: [0.06, 0.13],
      color: [[0.85, 0.95, 1.15, 0.62], [0.7, 0.85, 1.1, 0.5]], seed: 11,
    }
    const rain = env.addLayer({
      id: 'st-rain',
      facade: env.createParticles({
        capacity: 560, rate: RAIN_RATE,
        ramp: env.createRamp([
          { t: 0, size: 0.7, r: 0.85, g: 0.95, b: 1.15, a: 0 },
          { t: 0.15, size: 1, r: 0.9, g: 0.98, b: 1.18, a: 0.68 },
          { t: 1, size: 1, r: 0.82, g: 0.92, b: 1.12, a: 0.68 },
        ]),
        forces: {
          collide: {
            planes: [{ normal: [0, 1, 0], point: [0, FLOOR_Y, 0], restitution: 0, friction: 1, kill: true }],
            // THE rain story: every landing becomes a splash. The record is
            // REUSED — copy the contact point into the queue (drained after
            // advance, in this frame's loop).
            onCollide: (rec) => { splashQueue.push(rec.x, FLOOR_Y, rec.z) },
          },
        },
        spawner: RAIN_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.42, lengthFactor: 0.6 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.cfxrTextures.trait,
    })

    // ── the splash: a rising ring card (the puddle ripple) ──
    const RING_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0.1, 0.25], life: [0.4, 0.55], size: [0.12, 0.2],
      color: [[0.85, 0.95, 1.1, 1], [0.7, 0.88, 1.1, 0.8]], seed: 21,
    }
    const splashRing = env.addLayer({
      id: 'st-ring',
      facade: env.createParticles({
        capacity: 700,
        ramp: env.createRamp([
          // frame 5 — the procedural atlas's RING tile (an annulus), held
          // over the life (the ripple IS the ring); size grows + fades
          { t: 0, size: 0.25, r: 0.9, g: 0.98, b: 1.15, a: 0.95, frame: 5 },
          { t: 0.6, size: 1.6, r: 0.78, g: 0.9, b: 1.1, a: 0.5, frame: 5 },
          { t: 1, size: 2.6, r: 0.66, g: 0.82, b: 1.05, a: 0, frame: 5 },
        ]),
        spawner: RING_S,
        // HORIZONTAL billboards: the ripple lies flat on the wet floor
        render: { kind: 'billboard', mode: 'horizontal', tiles: [4, 4] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })

    // ── the splash crown: 3 droplets hopping up ──
    const DROP_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [1.2, 2.6], life: [0.3, 0.5], size: [0.04, 0.09],
      color: [[0.85, 0.95, 1.15, 1], [0.7, 0.85, 1.1, 0.85]], seed: 23,
    }
    const splashDrop = env.addLayer({
      id: 'st-drop',
      facade: env.createParticles({
        capacity: 900,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.9, g: 0.98, b: 1.15, a: 1 },
          { t: 1, size: 0.4, r: 0.75, g: 0.88, b: 1.1, a: 0 },
        ]),
        forces: { gravity: [0, -14, 0] },
        spawner: DROP_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.1 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.cfxrTextures.trait,
    })

    // ── the lightning: a double flash card in the sky ──
    const BOLT_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.5, 0.5], size: [30, 30],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 29,
    }
    const bolt = env.addLayer({
      id: 'st-bolt',
      facade: env.createParticles({
        capacity: 3,
        ramp: env.createRamp([
          // the double blink: up-down-up-down
          { t: 0, size: 1, r: 0.85, g: 0.9, b: 1, a: 0 },
          { t: 0.06, size: 1, r: 0.9, g: 0.93, b: 1, a: 0.5 },
          { t: 0.12, size: 1, r: 0.85, g: 0.9, b: 1, a: 0.12 },
          { t: 0.2, size: 1, r: 0.92, g: 0.95, b: 1, a: 0.62 },
          { t: 0.32, size: 1, r: 0.8, g: 0.88, b: 1, a: 0.25 },
          { t: 1, size: 1, r: 0.7, g: 0.85, b: 1, a: 0 },
        ]),
        spawner: BOLT_S,
        render: { kind: 'billboard', mode: 'camera' },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      // the single-glow sprite (the ribbon texture): one clean gaussian,
      // not the 4×4 atlas grid
      texture: () => env.glowTexture,
    })

    const layers = [rain, splashRing, splashDrop, bolt]
    let t = 0
    let nextBolt = 3.2
    let surge = 0

    return {
      frame(ctx) {
        t += ctx.dt

        // ── the rain advance (its onCollide fills the queue mid-advance) ──
        rain.facade.advance(ctx.dt)

        // ── drain the splash queue: one ring + a 3-droplet crown per hit ──
        while (splashQueue.length >= 3) {
          const x = splashQueue.shift(), y = splashQueue.shift(), z = splashQueue.shift()
          splashRing.facade.at(x, y + 0.02, z)
          splashRing.facade.burst(1, { ...RING_S, seed: (x * 977 + z * 311) | 0 })
          // the crown: only on the denser hits (hash the position — about
          // a third of the drops get the crown, the eye reads the rest in
          // the rings)
          if (((x * 7271 + z * 929) | 0) % 3 === 0) {
            splashDrop.facade.at(x, y + 0.03, z)
            splashDrop.facade.burst(3, { ...DROP_S, seed: (x * 517 + z * 769) | 0 })
          }
        }

        // ── the lightning schedule: every 4–9 s, a double flash + a surge ──
        if (t >= nextBolt) {
          nextBolt = t + 4 + Math.random() * 5
          surge = 1.6 // seconds of heavier rain
          bolt.facade.at(-6 + Math.random() * 12, 13, -18 - Math.random() * 6)
          bolt.facade.burst(1, { ...BOLT_S, seed: (t * 100) | 0 })
          env.log.event('lightning — rain surge')
        }
        if (surge > 0) {
          surge -= ctx.dt
          rain.facade.rate(RAIN_RATE * 1.55)
        } else {
          rain.facade.rate(RAIN_RATE)
        }

        for (const l of layers) if (l !== rain) l.facade.advance(ctx.dt)
      },
    }
  },
}
