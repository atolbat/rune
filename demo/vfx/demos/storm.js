// storm.js — a RUNE ORIGINAL (the Task 124 showcase): a night rainstorm —
// the game-designer's "weather that interacts with the world" problem:
//
//   · wrap (Task 126) — THE ENDLESS RAIN: the drops live in a box that is
//     WRAPPED around the walking camera target (a drop leaving through one
//     wall re-enters through the opposite one) and the spawn SHEET rides
//     the same origin — the storm reads as infinite wherever you walk,
//     with a FIXED particle budget (the optimization: the volume follows
//     the viewer, the count never grows with distance);
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
// The camera WALKS through the storm (a slow curving path with periodic
// speed-ups — the wrap does the rest); the floor is a MANUAL mesh that
// rides the walk, so the ground never runs out either.
const RAIN_RATE = 400
const FLOOR_Y = 0

export default {
  title: 'Rainstorm',
  sub: 'rune original · ENDLESS wrapped rain · splashes · lightning',
  camera: { yaw: 0.35, pitch: 0.14, dist: 10, orbit: 0.03, target: [0, 1.4, 0] },

  make(env) {
    // ── the scene: a dark wet field that RIDES the walk (manual) ──
    const floor = env.addMesh({
      id: 'st-floor',
      geometry: env.geometry.plane({ width: 140, height: 140 }),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.08, 0.09, 0.115, 1] },
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, FLOOR_Y, 0, 1]),
      manual: true, // this demo records it with the walking model matrix
    })
    const floorModel = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, FLOOR_Y, 0, 1])

    // the rain's own splash bookkeeping (per-frame drain queue)
    const splashQueue = []

    // ── the rain: stretched streaks, killed on the floor, WRAPPED ──
    const RAIN_S = {
      shape: { kind: 'rectangle', origin: [0, 10.5, 0], axis: [0, 1, 0], width: 54, height: 54 },
      velocity: { mode: 'fixed', dir: [0.045, -1, 0.03] },
      speed: [21, 25], life: [1.5, 1.8], size: [0.06, 0.13],
      color: [[0.85, 0.95, 1.15, 0.62], [0.7, 0.85, 1.1, 0.5]], seed: 11,
    }
    const rain = env.addLayer({
      id: 'st-rain',
      facade: env.createParticles({
        capacity: 1000, rate: RAIN_RATE,
        // THE ENDLESS VOLUME: x/z wrap into a 56×56 box around the at()
        // origin (the walking camera target) — the sheet and the live
        // drops always surround the viewer; y is OFF (drops die on the
        // floor, they must not cycle).
        wrap: { size: [56, 0, 56] },
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
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.42, lengthFactor: 0.6 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.sparkTexture,
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
        render: { kind: 'billboard', draw: 'instance', mode: 'horizontal', tiles: [4, 4] },
      }),
      material: env.materials.bbSprite,
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
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.1 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
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
        render: { kind: 'billboard', draw: 'instance', mode: 'camera' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      // the single-glow sprite (the ribbon texture): one clean gaussian,
      // not the 4×4 atlas grid
      texture: () => env.glowTexture,
    })

    const layers = [rain, splashRing, splashDrop, bolt]
    let t = 0
    let nextBolt = 3.2
    let surge = 0

    // ── the walk: a slow curving path with periodic speed-ups (the wrap
    //    keeps the storm around the walker; the floor rides along) ──
    let walkT = 0
    let speedBoost = 0
    const camX = [0], camZ = [0]

    return {
      frame(ctx) {
        t += ctx.dt
        walkT += ctx.dt

        // the speed profile: mostly a stroll, every ~7 s a 2.5 s dash
        // (rain streaks lean into the speed — the fly-through feel)
        if (walkT % 9.5 > 7) speedBoost = Math.min(1, speedBoost + ctx.dt * 2)
        else speedBoost = Math.max(0, speedBoost - ctx.dt * 1.2)
        const walkSpeed = 0.9 + speedBoost * 5.2
        const heading = 0.35 + Math.sin(walkT * 0.11) * 0.8
        camX[0] += Math.cos(heading) * walkSpeed * ctx.dt
        camZ[0] += Math.sin(heading) * walkSpeed * ctx.dt
        ctx.camTarget[0] = camX[0]
        ctx.camTarget[1] = 1.4
        ctx.camTarget[2] = camZ[0]

        // the floor rides the walk (a flat color — no seams, no snapping)
        floorModel[12] = camX[0]
        floorModel[14] = camZ[0]
        ctx.record(floor.command, { mvp: ctx.modelMvp(floorModel), model: floorModel, camPos: ctx.camEye })

        // the endless storm: the spawn sheet + the wrap box ride the walk
        rain.facade.at(camX[0], 0, camZ[0])
        bolt.facade.at(camX[0] - 6 + Math.sin(walkT * 3.1) * 12, 13, camZ[0] - 18 - Math.sin(walkT * 2.3) * 6)

        // ── the rain advance (its onCollide fills the queue mid-advance) ──
        rain.facade.advance(ctx.dt)

        // ── drain the splash queue: one ring + a 3-droplet crown per hit ──
        while (splashQueue.length >= 3) {
          const x = splashQueue.shift(), y = splashQueue.shift(), z = splashQueue.shift()
          // THE optimization with the wrap: only the hits NEAR the walker
          // splash (the far wall of the box is off-screen anyway — skipping
          // them halves the splash budget at zero visual cost)
          if (Math.abs(x - camX[0]) > 26 || Math.abs(z - camZ[0]) > 26) continue
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
          bolt.facade.burst(1, { ...BOLT_S, seed: (t * 100) | 0 })
          env.log.event('lightning — rain surge')
        }
        if (surge > 0) {
          surge -= ctx.dt
          rain.facade.rate(RAIN_RATE * 1.5)
        } else {
          rain.facade.rate(RAIN_RATE)
        }

        for (const l of layers) if (l !== rain) l.facade.advance(ctx.dt)
      },
    }
  },
}
