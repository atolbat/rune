// explosion.js — three.quarks' ExplosionDemo ("explosion (Unity Exported)"):
// a faithful port of their ps.json (the CFXR Explosion 1 Unity export) —
// every number below is THEIRS, read off the export; the textures are their
// exact assets, decoded to RGBA with the CFXR luminance-alpha baked in.
//
//   Their effect = SIX systems (their renderOrder):
//     impact (−0.5) — "Impact small": ONE additive flash CARD, their
//                     "cfxr spikes impact" star (a 108-vertex star mesh in
//                     their export — the star shape only trims transparent
//                     pixels; with luminance alpha the full quad composites
//                     identically), random Z-spin, life 0.25, size 3,
//                     SizeOverLife Bezier(.5,.93,1,1) ×3
//     sparks (0)    — 50 stretched streaks, "cfxr stretch trait" (512×128,
//                     bright head at u≈0 fading to black at u=1 — built for
//                     their one-sided stretched quad), sphere r=2, speed
//                     5–20, size 0.03, sf 0.1, life 0.3–0.6, LimitSpeed
//                     (0, dampen .3), gravity −1, white→yellow→orange→red
//                     (their USE_COLOR_AS_ALPHA: the gradient's alpha keys
//                     are IGNORED, alpha = r — which stays 1: they pop out)
//     lines  (0)    — 10 stretched darts, same texture, speed 50 (const),
//                     size 0.05, sf 0.05, life 0.1–0.2, dampen .4
//     flash6 (0)    — the big flash card: spikes star, additive, size 5,
//                     life 0.2, piecewise SizeOverLife 0.6→0.75→0.85→1,
//                     white→yellow→orange→deep red, t=0.05
//     smoke  (1)    — 30 billboard clouds, "cfxr smoke cloud x4" (a REAL
//                     alpha 2×2 atlas; their startTileIndex Interval(0,4)
//                     = a random tile per particle — our frameJitter),
//                     point burst, speed 5–15 dampened to 0.5, life
//                     0.8–1.5, size 2–4 growing ×0.1→1, born FIRE-COLORED
//                     (white→yellow→orange in the first 17% of life —
//                     THE fireball) then grey, alpha 1→0 (0.6→1), t=0.1
//     ring   (1.5)  — NOT PORTED, HONESTLY: their ring geometry is
//                     degenerate (26 vertices, every pair on the unit
//                     circle — zero-area triangles; it renders nothing in
//                     their demo). We reproduce that: nothing.
//
//   The blending is theirs: sparks/lines NORMAL-blend (their MeshBasic
//   NormalBlending + USE_COLOR_AS_ALPHA — black adds nothing, hides
//   nothing), impact/flash6 ADDITIVE, smoke NORMAL with real alpha.
//
//   The scene is theirs: the effect at the ORIGIN (no random walk — their
//   newInstance() clones at the group's identity transform), a new instance
//   every refreshTime = 2 s (auto-destroy: the longest life + 0.1 burst
//   offset = 1.6 s < 2 s, no overlap), camera at (0, 10, 10) fov 60, their
//   dark floor at y = −10.
const REFRESH = 2.0 // their refreshTime

export default {
  title: 'Explosion (composed)',
  sub: 'the ps.json systems · real cfxr textures · luminance alpha · every 2 s',
  // their camera: position (0, 10, 10), fov 60, target origin, static
  camera: { yaw: 0, pitch: Math.PI / 4, dist: Math.SQRT2 * 10, orbit: 0, target: [0, 0, 0] },

  make(env) {
    // ── the scene: their dark floor at y = −10 (their 0x222222 plane) ──
    const floorModel = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -10, 0, 1])
    env.addMesh({
      id: 'ex-floor',
      geometry: env.geometry.plane({ width: 500, height: 500 }),
      material: env.materials.lambert,
      model: floorModel,
      // their 0x222222 floor (their far field reads 20-36/255 in a capture —
      // a dark plane the smoke silhouette reads against)
      uniforms: { u_albedo: [0.13, 0.13, 0.14, 1] },
    })

    // ── the spawners (the full descs — burst() REPLACES the spawner, so
    //    every instance passes the whole desc; the seed re-rolls per
    //    instance). All numbers are their ps.json. ──
    const SPARKS_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 2] },
      velocity: { mode: 'radial' },
      speed: [5, 20], life: [0.3, 0.6], size: [0.03, 0.03],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 61,
    }
    const LINES_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 2] },
      velocity: { mode: 'radial' },
      speed: [50, 50], life: [0.1, 0.2], size: [0.05, 0.05],
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
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [5, 15], life: [0.8, 1.5], size: [2, 4],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 79,
    }

    // ── the layers, in THEIR renderOrder (impact −0.5 first, smoke 1
    //    last; the additive cards/streaks in between are order-free) ──

    // impact (−0.5): the additive flash card, the random Z-spun star.
    // Their SizeOverLife Bezier(0.5, 0.929, 1, 1) sampled at t 0/.25/.5/.75/1.
    const impact = env.addLayer({
      id: 'ex-impact',
      facade: env.createParticles({
        capacity: 8,
        ramp: env.createRamp([
          // their ColorOverLife gradient ×0.784→0 alpha IGNORED (their
          // USE_COLOR_AS_ALPHA reads r: 1,1,1,0.5189) — a := r here
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
      texture: () => env.cfxrTextures.spikes,
    })

    // sparks (0): 50 stretched streaks, NORMAL-blended (their blending:
    // MeshBasic NormalBlending + USE_COLOR_AS_ALPHA — not additive!)
    const sparks = env.addLayer({
      id: 'ex-sparks',
      facade: env.createParticles({
        capacity: 128,
        // their ColorOverLife: white→yellow→orange→red, r ≡ 1 → no fade
        // (their alpha keys are dead under USE_COLOR_AS_ALPHA)
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
      texture: () => env.cfxrTextures.trait,
    })

    // lines (0): the 10 speed-50 darts (life 0.1–0.2 — gone in a blink)
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
      texture: () => env.cfxrTextures.trait,
    })

    // flash6 (0): the big additive card, t=0.05, life 0.2. Their piecewise
    // SizeOverLife: 0.6→0.75 (0..0.15, linear), 0.75→0.85 (0.15..0.3,
    // linear), 0.85→1 (0.3..1, Bezier(0.85, 0.985, 0.983, 1)).
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
      texture: () => env.cfxrTextures.spikes,
    })

    // smoke (1): 30 real-alpha clouds over the fire — drawn LAST (their
    // renderOrder 1). Their startTileIndex Interval(0, 4) = a random tile
    // per particle (our frameJitter 4); their FrameOverLife(IntervalValue)
    // is a no-op in their engine (it only animates PiecewiseBezier) — the
    // tile is picked at spawn and held. Their startRotation ±0.349 (a
    // slight tilt) we approximate with the seed's full-phase spin (the
    // cloud tiles are near-isotropic).
    const smoke = env.addLayer({
      id: 'ex-smoke',
      facade: env.createParticles({
        capacity: 64,
        ramp: env.createRamp([
          // their SizeOverLife Bezier(0.1, 0.399, 1.006, 1) at t 0/.25/.5/.75/1
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
      texture: () => env.cfxrTextures.smoke,
    })

    // ── the instance schedule: THEIR burst times on one clock ──
    //   t=0.05: sparks ×50 + lines ×10 + flash6 ×1
    //   t=0.1 : impact ×1 + smoke ×30
    // (their Ring burst is t=0 — skipped, see the header)
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
          sparks.facade.burst(50, { ...SPARKS_S, seed })
          lines.facade.burst(10, { ...LINES_S, seed: seed + 1 })
          flash6.facade.burst(1, { ...FLASH6_S, seed: seed + 2 })
        },
      },
      {
        t: 0.1,
        fired: false,
        fire() {
          impact.facade.burst(1, { ...IMPACT_S, seed: seed + 3 })
          smoke.facade.burst(30, { ...SMOKE_S, seed: seed + 4 })
        },
      },
    ]

    return {
      frame(ctx) {
        next -= ctx.dt
        if (next <= 0) {
          // a new instance at the ORIGIN — their newInstance(): the effect
          // sits at the group's identity transform, every 2 s
          next += REFRESH
          count++
          seed = 3000 + count * 13
          clock = 0
          for (const ev of events) ev.fired = false
          // every instance (their emitEnd console log per system — we log the
          // start; the shots/probe tools time their phases off this line)
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
