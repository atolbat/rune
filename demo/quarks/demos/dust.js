// dust.js — a RUNE ORIGINAL (Task 126): the ambient ATMOSPHERE — floating
// dust motes in an ENDLESS volume, exactly the game-designer's "the air
// itself is alive" problem:
//
//   · wrap (Task 126) — the motes live in a box WRAPPED around the
//     camera: wherever the eye moves the dust is already there (the
//     particles re-enter through the opposite wall — the volume reads as
//     infinite, NOT an isolated cloud in a box);
//   · LONG lives (7–14 s — "not a small time") with a MULTI-HUMP alpha
//     ramp — each mote drifts through light and shadow, brightening and
//     dimming as it goes (the lit/unlit dust illusion);
//   · THE CAMERA WALKS THROUGH IT: a cycle of stand → accelerate →
//     cruise → stop (the motes streak past on the speed-ups, the parallax
//     layers sell the depth);
//   · HAZE — a handful of very transparent textured cards (the atlas
//     puff) the camera passes THROUGH with the dust — the fog of the
//   · scene, at ~3% alpha.
const WALK = { stand: 2.4, accel: 1.7, cruise: 2.4, decel: 1.5 }
const WALK_SPEED = 7.5
const BOX = [34, 16, 34] // the wrap volume (the "everywhere")

export default {
  title: 'Dust & Haze',
  sub: 'rune original · ENDLESS wrapped motes · lit/unlit drift · camera fly-through',
  camera: { yaw: 2.72, pitch: 0.04, dist: 1.8, orbit: 0, target: [0, 2.2, 0] },

  make(env) {
    // ── the motes: a wrapped, wandering, long-lived swarm ──
    const MOTE_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 16] },
      velocity: { mode: 'radial' },
      speed: [0.05, 0.35], life: [7, 14], size: [0.035, 0.11],
      color: [[0.85, 0.92, 1, 0.85], [0.7, 0.78, 0.95, 0.6]], seed: 311,
    }
    const motes = env.addLayer({
      id: 'du-motes',
      facade: env.createParticles({
        capacity: 1500, rate: 130, prewarm: 12,
        wrap: { size: BOX },
        ramp: env.createRamp([
          // THE LIT/UNLIT DRIFT: multiple brightness humps over a long
          // life — the mote passes through light and shadow
          { t: 0, size: 1, r: 0.9, g: 0.95, b: 1, a: 0 },
          { t: 0.18, size: 1, r: 0.95, g: 1, b: 1, a: 0.8 },
          { t: 0.34, size: 1, r: 0.85, g: 0.9, b: 1, a: 0.12 },
          { t: 0.52, size: 1, r: 0.97, g: 1, b: 1, a: 0.9 },
          { t: 0.71, size: 1, r: 0.88, g: 0.93, b: 1, a: 0.16 },
          { t: 0.86, size: 1, r: 0.95, g: 1, b: 1, a: 0.7 },
          { t: 1, size: 1, r: 0.9, g: 0.95, b: 1, a: 0 },
        ]),
        forces: {
          gravity: [0, -0.05, 0], drag: 0.15,
          noise: { strength: 0.55, scale: 0.22, speed: 0.07 },
        },
        spawner: MOTE_S,
        render: { kind: 'billboard', mode: 'camera', spin: 0.3 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the haze: huge, VERY transparent cards the camera passes through ──
    const HAZE_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 15] },
      velocity: { mode: 'radial' },
      speed: [0.02, 0.1], life: [18, 30], size: [10, 16],
      color: [[0.72, 0.8, 0.95, 0.075], [0.6, 0.7, 0.9, 0.05]], seed: 317,
    }
    const haze = env.addLayer({
      id: 'du-haze',
      facade: env.createParticles({
        capacity: 22, rate: 0.7, prewarm: 24,
        wrap: { size: BOX },
        ramp: env.createRamp([
          { t: 0, size: 0.75, r: 1, g: 1, b: 1, a: 0, frame: 3 },
          { t: 0.25, size: 1, r: 1, g: 1, b: 1, a: 1, frame: 3 },
          { t: 0.75, size: 1.15, r: 1, g: 1, b: 1, a: 1, frame: 3 },
          { t: 1, size: 1.3, r: 1, g: 1, b: 1, a: 0, frame: 3 },
        ]),
        forces: { gravity: [0, 0.015, 0], drag: 0.3 },
        spawner: HAZE_S,
        render: { kind: 'billboard', tiles: env.atlasTiles, spin: 0.05 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.atlasTexture,
    })

    // ── the walk: stand → accelerate → cruise → decel → stand (looped);
    //    the wrap keeps the dust around the eye through all of it ──
    const cycle = WALK.stand + WALK.accel + WALK.cruise + WALK.decel
    let t = 0
    const pos = [0, 2.2, 0]
    const HEADING = 2.9 // the walk direction (radians, XZ)

    return {
      frame(ctx) {
        t += ctx.dt
        // the speed profile: a smooth accelerate/cruise/decelerate wave
        let speed = 0
        const u = t % cycle
        if (u < WALK.stand) speed = 0
        else if (u < WALK.stand + WALK.accel) speed = WALK_SPEED * Math.sin(((u - WALK.stand) / WALK.accel) * Math.PI / 2)
        else if (u < WALK.stand + WALK.accel + WALK.cruise) speed = WALK_SPEED
        else speed = WALK_SPEED * Math.cos(((u - WALK.stand - WALK.accel - WALK.cruise) / WALK.decel) * Math.PI / 2)
        pos[0] += Math.cos(HEADING) * speed * ctx.dt
        pos[2] += Math.sin(HEADING) * speed * ctx.dt
        // the camera rides the walk (the eye trails the target by dist —
        // looking FORWARD through the dust along the heading)
        ctx.camTarget[0] = pos[0]
        ctx.camTarget[1] = 2.2
        ctx.camTarget[2] = pos[2]

        // the endless volume rides the walk too: both facades wrap + spawn
        // around THEIR origin — keep it at the walker
        motes.facade.at(pos[0], 2.2, pos[2])
        haze.facade.at(pos[0], 2.4, pos[2])
        motes.facade.advance(ctx.dt)
        haze.facade.advance(ctx.dt)
      },
    }
  },
}
