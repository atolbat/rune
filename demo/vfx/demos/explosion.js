// explosion.js — THE COMPOSED EXPLOSION (the game-VFX archetype): one
// detonation every ~2.4 s, built from FIVE hand-tuned systems on OUR
// procedural sprite set (the flash star, the spark streak, the 2×2 smoke
// sheet — all generated in main.js):
//
//     impact — ONE additive flash card, the star with its random Z-spin,
//              white → gold → deep orange
//     sparks — the stretched ember streaks, sphere-scattered, LIMIT-SPEED
//              damped (the launch flash then the coast), gravity, the
//              white → yellow → orange → ember ramp
//     lines  — the fast tracer darts (10, near-instant — the crack)
//     flash  — the big hot core card, additive, a quarter second
//     smoke  — the billboard clouds: born FIRE-COLORED (the first ~17%
//              of life is the fireball) then cooling to grey, the
//              frame-animated 2×2 sheet, a random tile per particle
//
//   The blending: sparks/lines NORMAL (black adds nothing, hides
//   nothing — the streak textures carry the falloff in rgb), impact and
//   flash ADDITIVE, smoke NORMAL with real alpha. The scene: a dark far
//   floor the smoke silhouette reads against, the effect at the origin,
//   the camera three-quarter overhead.
const REFRESH = 2.4 // s between detonations

export default {
  title: 'Explosion (composed)',
  sub: 'five systems, one detonation · flash + embers + tracers + fireball smoke',
  // the camera: three-quarter overhead, static
  camera: { yaw: 0.16, pitch: Math.PI / 4.6, dist: 13.4, orbit: 0, target: [0, 0.6, 0] },

  make(env) {
    // ── the scene: the dark far floor at y = −10 ──
    const floorModel = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -10, 0, 1])
    env.addMesh({
      id: 'ex-floor',
      geometry: env.geometry.plane({ width: 500, height: 500 }),
      material: env.materials.lambert,
      model: floorModel,
      // the dark plane the smoke silhouette reads against
      uniforms: { u_albedo: [0.13, 0.13, 0.14, 1] },
    })

    // ── the spawners (the full descs — burst() REPLACES the spawner, so
    //    every instance passes the whole desc; the seed re-rolls per
    //    instance) ──
    const SPARKS_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 1.7] },
      velocity: { mode: 'radial' },
      speed: [4, 16], life: [0.35, 0.7], size: [0.032, 0.032],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 61,
    }
    const LINES_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 1.7] },
      velocity: { mode: 'radial' },
      speed: [44, 44], life: [0.09, 0.18], size: [0.05, 0.05],
      color: [[1, 1, 1, 0.7], [1, 1, 1, 0.7]], seed: 67,
    }
    const IMPACT_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.25, 0.25], size: [3, 3],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 71,
    }
    const FLASH6_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.2, 0.2], size: [5, 5],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 73,
    }
    const SMOKE_S = {
      shape: { kind: 'point', origin: [0, 0.3, 0] },
      velocity: { mode: 'radial' },
      // lives 1.8–3.2 s on a 2.4 s cadence: the previous blast's smoke
      // LINGERS under the next one (no dead gap in the cycle — the pill
      // never reads zero between detonations)
      speed: [4, 12], life: [1.8, 3.2], size: [1.8, 3.6],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 79,
    }

    // ── the layers, in the compositing order (the alpha smoke LAST — the
    //    additive cards/streaks in between are order-free) ──

    // impact: the additive flash card, the random Z-spun star.
    const impact = env.addLayer({
      id: 'ex-impact',
      facade: env.createParticles({
        capacity: 8,
        ramp: env.createRamp([
          // the SizeOverLife arc + the hot cool-off
          { t: 0, size: 0.5, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.15, size: 0.76, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.3, size: 0.911, r: 1, g: 0.808, b: 0, a: 1 },
          { t: 0.5, size: 0.982, r: 1, g: 0.379, b: 0.133, a: 1 },
          { t: 1, size: 1, r: 0.519, g: 0.008, b: 0, a: 0.519 },
        ]),
        spawner: IMPACT_S,
        render: { kind: 'billboard', mode: 'oriented', axis: [0, 0, 1] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.flashTexture,
    })

    // sparks: the stretched ember streaks, NORMAL-blended (not additive —
    // the falloff lives in the streak's rgb)
    const sparks = env.addLayer({
      id: 'ex-sparks',
      facade: env.createParticles({
        capacity: 128,
        // the ember ramp: white → yellow → orange → deep red, alpha held
        // (the streak's rgb falloff IS the fade)
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.1, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.3, size: 1, r: 1, g: 0.808, b: 0, a: 1 },
          { t: 0.5, size: 1, r: 1, g: 0.379, b: 0.133, a: 1 },
          { t: 0.7, size: 1, r: 1, g: 0.018, b: 0, a: 1 },
          { t: 1, size: 1, r: 1, g: 0.018, b: 0, a: 1 },
        ]),
        forces: { gravity: [0, -1, 0], limitSpeed: { limit: 0, dampen: 0.3 } },
        spawner: SPARKS_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.1, lengthFactor: 0 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.sparkTexture,
    })

    // lines: the 8 speed-44 tracers (life 0.09–0.18 — gone in a blink)
    const lines = env.addLayer({
      id: 'ex-lines',
      facade: env.createParticles({
        capacity: 32,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 1, r: 1, g: 1, b: 1, a: 1 },
        ]),
        forces: { limitSpeed: { limit: 0, dampen: 0.4 } },
        spawner: LINES_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.05, lengthFactor: 0 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.sparkTexture,
    })

    // flash6: the big additive core card, t=0.05, life 0.2 — the piecewise
    // size arc (a fast swell, then the long settle).
    const flash6 = env.addLayer({
      id: 'ex-flash6',
      facade: env.createParticles({
        capacity: 8,
        ramp: env.createRamp([
          { t: 0, size: 0.6, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.05, size: 0.65, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.15, size: 0.75, r: 1, g: 0.903, b: 0.4, a: 1 },
          { t: 0.2, size: 0.783, r: 1, g: 0.808, b: 0, a: 1 },
          { t: 0.3, size: 0.85, r: 1, g: 0.379, b: 0.118, a: 1 },
          { t: 0.65, size: 0.969, r: 1, g: 0.207, b: 0.059, a: 1 },
          { t: 1, size: 1, r: 1, g: 0.034, b: 0, a: 1 },
        ]),
        spawner: FLASH6_S,
        render: { kind: 'billboard', mode: 'oriented', axis: [0, 0, 1] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.flashTexture,
    })

    // smoke: the real-alpha clouds over the fire — drawn LAST (the
    // compositing order). frameJitter picks a random sheet tile per
    // particle at spawn; the seed's full-phase spin covers the slight
    // per-particle tilt (the sheet's tiles are near-isotropic).
    const smoke = env.addLayer({
      id: 'ex-smoke',
      facade: env.createParticles({
        capacity: 64,
        ramp: env.createRamp([
          // the size arc: born small, swelled by a third of life
          { t: 0, size: 0.1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.03, size: 0.128, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.1, size: 0.2, r: 1, g: 0.808, b: 0, a: 1 },
          { t: 0.17, size: 0.275, r: 1, g: 0.379, b: 0.133, a: 1 },
          { t: 0.25, size: 0.367, r: 0.764, g: 0.454, b: 0.331, a: 1 },
          { t: 0.33, size: 0.47, r: 0.528, g: 0.528, b: 0.528, a: 1 },
          { t: 0.5, size: 0.664, r: 0.528, g: 0.528, b: 0.528, a: 1 },
          { t: 0.6, size: 0.77, r: 0.528, g: 0.528, b: 0.528, a: 1 },
          { t: 0.75, size: 0.904, r: 0.528, g: 0.528, b: 0.528, a: 0.667 },
          { t: 1, size: 1, r: 0.528, g: 0.528, b: 0.528, a: 0 },
        ]),
        forces: { limitSpeed: { limit: 0.5, dampen: 0.15 } },
        spawner: SMOKE_S,
        render: { kind: 'billboard', tiles: [2, 2], frameJitter: 4 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.smokeAtlas,
    })

    // ── the instance schedule: the burst times on one clock ──
    //   t=0.05: sparks ×38 + lines ×8 + flash6 ×1
    //   t=0.1 : impact ×1 + smoke ×22
    const layers = [impact, sparks, lines, flash6, smoke]
    let next = 0.05 // the first instance fires as good as immediately
    let count = 0
    let clock = -1 // the current instance's age; −1 = between instances
    let seed = 0
    const events = [
      {
        t: 0.05,
        fired: false,
        fire() {
          sparks.facade.burst(38, { ...SPARKS_S, seed })
          lines.facade.burst(8, { ...LINES_S, seed: seed + 1 })
          flash6.facade.burst(1, { ...FLASH6_S, seed: seed + 2 })
        },
      },
      {
        t: 0.1,
        fired: false,
        fire() {
          impact.facade.burst(1, { ...IMPACT_S, seed: seed + 3 })
          smoke.facade.burst(22, { ...SMOKE_S, seed: seed + 4 })
        },
      },
    ]

    return {
      frame(ctx) {
        next -= ctx.dt
        if (next <= 0) {
          // a new instance at the ORIGIN — the effect sits at the
          // identity transform, every REFRESH seconds
          next += REFRESH
          count++
          seed = 3000 + count * 13
          clock = 0
          for (const ev of events) ev.fired = false
          // every instance (the shots/probe tools time the phases off
          // this log line)
          env.log.event(`explosion #${count} at (0.0, 0.0, 0.0)`)
        }
        if (clock >= 0) {
          clock += ctx.dt
          for (const ev of events) {
            if (!ev.fired && clock >= ev.t) {
              ev.fired = true
              ev.fire()
            }
          }
        }
        for (const l of layers) l.facade.advance(ctx.dt)
      },
    }
  },
}
