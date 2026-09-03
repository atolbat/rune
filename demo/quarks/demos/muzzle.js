// muzzle.js — three.quarks' MuzzleFlashDemo ("Muzzle Flash Performance"):
// a 10×10 firing range of concurrent muzzle flashes. Each flash is the
// COMPOSED EFFECT of the original's systems, on THEIR texture atlas
// (assets/texture1.png, 10×10 tiles, decoded to exact RGBA bytes):
//
//   beam     — a long horizontal streak quad, tile 1, additive
//   planes   — the LocalSpace crossed flash fins through the barrel axis
//              (our oriented mode, axis = the barrel; the per-particle
//              seed angles cross the pair), tiles 91→100, additive
//   flash    — the billboards, tiles 81→91 (their FrameOverLife
//              Bezier(81, 84.3, 87.7, 91)), additive
//   smoke    — the ANIMATED SMOKE, tiles 28→37 (their FrameOverLife
//              Bezier(28, 31, 34, 37)), alpha-blended, drawn FIRST
//              (their renderOrder −2)
//   sparks   — the stretched streaks, tile 0, speedFactor 0.4 (theirs)
//
// Parameters are the original's (lives 0.1–0.2 / 0.6–0.8, speeds 0–3 /
// 1–15, sizes 4 / 1–5 / 1–2.5 / 0.75–1.5 / 0.1–0.3, the ColorOverLife
// palettes); no gravity on any system — their sparks fly straight out.
// The staggered firing loop walks the 100 muzzles at ~1 Hz each.
export default {
  title: 'Muzzle Flash ×100',
  sub: 'the original atlas · frame-animated smoke · crossed fins · stretched sparks',
  camera: { yaw: -1.15, pitch: 0.34, dist: 16, orbit: 0.02, target: [0, 0.7, 0] },

  make(env) {
    const GRID = 10
    const SPACING = 2.6
    const RANGE = 1.2 // s between shots per muzzle (their ~1 Hz refresh walk)
    // the original's 10×10 atlas — or the procedural fallback
    const TILES = env.quarksAtlas ? [10, 10] : env.atlasTiles
    // the muzzle height: the emitters sit just above the grid plane
    const Y = 0.55

    const muzzles = []
    for (let i = 0; i < GRID * GRID; i++) {
      muzzles.push({
        x: Math.floor(i / GRID) * SPACING - (GRID - 1) * SPACING / 2,
        z: (i % GRID) * SPACING - (GRID - 1) * SPACING / 2,
        timer: (i / (GRID * GRID)) * RANGE, // the staggered first shot
        seed: 1000 + i * 7,
      })
    }

    // ── the spawners (the full descs — burst() REPLACES the spawner, so
    //    every shot passes the whole desc; the seed re-rolls per muzzle) ──
    // THEIR numbers: beam/muzzle/flash life 0.1–0.2, size 4 / 1–5 / 1–2.5;
    // smoke cone 20° r 0.3, life 0.6–0.8, speed 0.1–3, size 0.75–1.5;
    // sparks cone 20° r 0.3, life 0.2–0.6, speed 1–15, size 0.1–0.3.
    const SMOKE_S = {
      shape: { kind: 'cone', origin: [0.9, 0, 0], axis: [1, 0.28, 0], halfAngle: 0.35, baseRadius: 0.3, length: [0, 0.1] },
      velocity: { mode: 'lobe' },
      speed: [0.1, 3], life: [0.6, 0.8], size: [0.75, 1.5],
      color: [[0.63, 0.63, 0.63, 0.31], [1, 1, 1, 0.54]], seed: 53,
    }
    const BEAM_S = {
      shape: { kind: 'point', origin: [0.95, 0, 0] },
      velocity: { mode: 'fixed', dir: [1, 0, 0] },
      speed: [0, 0], life: [0.1, 0.2], size: [4, 4],
      color: [[1, 0.586, 0.169, 1], [1, 0.586, 0.169, 1]], seed: 41,
    }
    const SPARKS_S = {
      shape: { kind: 'cone', origin: [0.9, 0, 0], axis: [1, 0.06, 0], halfAngle: 0.35, baseRadius: 0.3, length: [0, 0.05] },
      velocity: { mode: 'lobe' },
      speed: [1, 15], life: [0.2, 0.6], size: [0.1, 0.3],
      color: [[1, 0.91, 0.51, 1], [1, 0.44, 0.16, 1]], seed: 47,
    }
    const PLANES_S = {
      shape: { kind: 'point', origin: [0.9, 0, 0] },
      velocity: { mode: 'fixed', dir: [1, 0, 0] },
      speed: [0, 0], life: [0.1, 0.2], size: [1, 5],
      color: [[1, 0.9, 0.6, 1], [1, 0.9, 0.6, 1]], seed: 43,
    }
    const FLASH_S = {
      shape: { kind: 'point', origin: [0.7, 0, 0] },
      velocity: { mode: 'fixed', dir: [1, 0, 0] },
      speed: [0, 0], life: [0.1, 0.2], size: [1, 2.5],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 45,
    }

    // ── the layers, registered in THEIR renderOrder (the alpha smoke
    //    first so the additive systems composite on top of it) ──
    const smoke = env.addLayer({
      id: 'muzzle-smoke',
      facade: env.createParticles({
        capacity: 512,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1, frame: 28 },
          { t: 1, size: 1.25, r: 1, g: 1, b: 1, a: 0, frame: 37 },
        ]),
        // their RotationOverLife ±π/4 over 0.6–0.8 s ≈ ±1 rad/s
        spin: 1.0,
        spawner: SMOKE_S,
        render: { kind: 'billboard', tiles: TILES },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.quarksAtlas?.texture,
    })

    const beam = env.addLayer({
      id: 'muzzle-beam',
      facade: env.createParticles({
        capacity: 64,
        // their SizeOverLife Bezier(1, 0.95, 0.75, 0) + ColorOverLife
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.39, b: 0.125, a: 1, frame: 1 },
          { t: 1, size: 0.05, r: 1, g: 0.827, b: 0.301, a: 0, frame: 1 },
        ]),
        spawner: BEAM_S,
        render: { kind: 'billboard', tiles: TILES },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.quarksAtlas?.texture,
    })

    const sparks = env.addLayer({
      id: 'muzzle-sparks',
      facade: env.createParticles({
        capacity: 768,
        // their SizeOverLife Bezier(1, 0.95, 0.75, 0) — the streaks shrink out
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0, r: 1, g: 1, b: 1, a: 1, frame: 0 },
        ]),
        spawner: SPARKS_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.4, tiles: TILES },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.quarksAtlas?.texture,
    })

    const planes = env.addLayer({
      id: 'muzzle-planes',
      facade: env.createParticles({
        capacity: 128,
        // the crossed fins: the base quad contains the barrel axis; every
        // particle's seed angle spins it around the barrel — 2 particles
        // = a crossed pair at a random orientation (their two LocalSpace
        // planes with rotation.x = π/2)
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.39, b: 0.125, a: 1, frame: 91 },
          { t: 1, size: 0.05, r: 1, g: 0.827, b: 0.301, a: 0, frame: 100 },
        ]),
        spawner: PLANES_S,
        render: { kind: 'billboard', mode: 'oriented', axis: [1, 0, 0], tiles: TILES },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.quarksAtlas?.texture,
    })

    const flash = env.addLayer({
      id: 'muzzle-flash',
      facade: env.createParticles({
        capacity: 128,
        // their ColorOverLife (1, 0.95, 0.82) → (1, 0.38, 0.12) + SizeOverLife
        // 1→0; the seed phases the in-plane rotation (their startRotation ±π)
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.95, b: 0.82, a: 1, frame: 81 },
          { t: 1, size: 0.05, r: 1, g: 0.38, b: 0.12, a: 0, frame: 91 },
        ]),
        spin: 0,
        spawner: FLASH_S,
        render: { kind: 'billboard', tiles: TILES },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.quarksAtlas?.texture,
    })

    const fire = (m) => {
      // one muzzle shot: the five systems burst at the muzzle's position
      // (facade.at — the live origin), each with the muzzle's seed roll
      const s = m.seed
      smoke.facade.at(m.x, Y, m.z).burst(5, { ...SMOKE_S, seed: s })
      beam.facade.at(m.x, Y, m.z).burst(1, { ...BEAM_S, seed: s + 1 })
      sparks.facade.at(m.x, Y, m.z).burst(8, { ...SPARKS_S, seed: s + 2 })
      planes.facade.at(m.x, Y, m.z).burst(2, { ...PLANES_S, seed: s + 3 })
      flash.facade.at(m.x, Y, m.z).burst(2, { ...FLASH_S, seed: s + 4 })
    }

    return {
      frame(ctx, rt) {
        // the staggered firing loop: ~100 shots per 1.2 s ≈ 83 shots/s
        for (const m of muzzles) {
          m.timer -= ctx.dt
          if (m.timer > 0) continue
          m.timer += RANGE
          fire(m)
        }
        smoke.facade.advance(ctx.dt)
        beam.facade.advance(ctx.dt)
        sparks.facade.advance(ctx.dt)
        planes.facade.advance(ctx.dt)
        flash.facade.advance(ctx.dt)
      },
    }
  },
}
