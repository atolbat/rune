// muzzle.js — three.quarks' MuzzleFlashDemo: a 10×10 firing range of
// concurrent muzzle flashes, each a COMPOSED EFFECT of four particle
// systems (beam, flash, smoke, sparks). Their BatchedRenderer batches by
// material; ours batches by LAYER — four facades, four draw calls for all
// one hundred muzzles.
//
// rune surface: the burst schedule machinery via the tick, facade.at()
// (the live emitter origin — each muzzle's bursts translate there), the
// ORIENTED billboard mode (the beam + the crossed flash planes), the
// STRETRETCHED mode (the sparks), the ATLAS frame ramp (flash + smoke
// animate through tiles), additive + alpha blending side by side.
export default {
  title: 'Muzzle Flash ×100',
  sub: 'four systems per effect · oriented/stretched · atlas frames',
  camera: { yaw: -1.15, pitch: 0.34, dist: 15, orbit: 0.02, target: [0, 1.2, 0] },

  make(env) {
    const GRID = 10
    const SPACING = 2.6
    const RANGE = 1.2 // s between shots per muzzle
    const muzzles = []
    for (let i = 0; i < GRID * GRID; i++) {
      muzzles.push({
        x: Math.floor(i / GRID) * SPACING - (GRID - 1) * SPACING / 2,
        z: (i % GRID) * SPACING - (GRID - 1) * SPACING / 2,
        timer: (i / (GRID * GRID)) * RANGE, // the staggered first shot
        seed: 1000 + i * 7,
      })
    }

    // ── the four systems of one muzzle flash (their beam/muzzle/flash/
    //    smoke/particles, consolidated by render mode + blend) ──
    // The full spawner descs (the seed re-rolls per shot — burst()
    // REPLACES the spawner, so the demos pass the whole desc each time).
    const FLASH_S = {
      shape: { kind: 'sphere', origin: [0, 0.9, 0], radius: [0.04, 0.22] },
      velocity: { mode: 'radial' },
      speed: [0.2, 1.2], life: [0.12, 0.28], size: [1.1, 2.4],
      color: [[1, 0.95, 0.8, 1], [1, 0.75, 0.4, 1]], seed: 41,
    }
    const PLANES_S = {
      shape: { kind: 'point', origin: [0, 0.9, 0] },
      velocity: { mode: 'fixed', dir: [1, 0, 0] },
      speed: [0, 0], life: [0.1, 0.2], size: [1.4, 2.6],
      color: [[1, 0.9, 0.65, 1], [1, 0.6, 0.3, 1]], seed: 43,
    }
    const SPARKS_S = {
      shape: { kind: 'cone', origin: [0, 0.9, 0], axis: [1, 0.12, 0], halfAngle: 0.16, baseRadius: 0.06, length: [0, 0.05] },
      velocity: { mode: 'lobe' },
      speed: [4, 14], life: [0.25, 0.7], size: [0.1, 0.3],
      color: [[1, 0.92, 0.55, 1], [1, 0.5, 0.2, 1]], seed: 47,
    }
    const SMOKE_S = {
      shape: { kind: 'cone', origin: [0, 0.9, 0], axis: [1, 0.3, 0], halfAngle: 0.3, baseRadius: 0.2, length: [0, 0.2] },
      velocity: { mode: 'lobe' },
      speed: [0.5, 2.5], life: [0.7, 1.4], size: [0.5, 1.1],
      color: [[0.6, 0.6, 0.62, 0.5], [0.75, 0.75, 0.78, 0.4]], seed: 53,
    }

    const flash = env.addLayer({
      id: 'muzzle-flash',
      facade: env.createParticles({
        capacity: 400,
        ramp: env.createRamp([
          { t: 0, size: 1.5, r: 1, g: 0.95, b: 0.8, a: 1, frame: 4 },
          { t: 0.5, size: 1.9, r: 1, g: 0.7, b: 0.35, a: 0.8, frame: 11 },
          { t: 1, size: 0.4, r: 1, g: 0.4, b: 0.15, a: 0, frame: 12 },
        ]),
        spawner: FLASH_S,
        render: { kind: 'billboard', tiles: env.atlasTiles },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    // the beam + the crossed muzzle planes: ORIENTED quads (the flash
    // geometry that does not billboard — it belongs to the gun)
    const planes = env.addLayer({
      id: 'muzzle-planes',
      facade: env.createParticles({
        capacity: 800,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.9, b: 0.7, a: 1, frame: 13 },
          { t: 1, size: 0.5, r: 1, g: 0.55, b: 0.25, a: 0, frame: 13 },
        ]),
        spawner: PLANES_S,
        render: { kind: 'billboard', mode: 'oriented', tiles: env.atlasTiles },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    const sparks = env.addLayer({
      id: 'muzzle-sparks',
      facade: env.createParticles({
        capacity: 1600,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 0.85, a: 1 },
          { t: 0.4, size: 0.7, r: 1, g: 0.75, b: 0.4, a: 0.9 },
          { t: 1, size: 0.1, r: 1, g: 0.35, b: 0.1, a: 0 },
        ]),
        forces: { gravity: [0, -9, 0], drag: 0.35, turbulence: 0.3 },
        spawner: SPARKS_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.35 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    const smoke = env.addLayer({
      id: 'muzzle-smoke',
      facade: env.createParticles({
        capacity: 600,
        ramp: env.createRamp([
          { t: 0, size: 0.5, r: 0.55, g: 0.55, b: 0.58, a: 0, frame: 6 },
          { t: 0.25, size: 1, r: 0.6, g: 0.6, b: 0.62, a: 0.4, frame: 14 },
          { t: 1, size: 2.2, r: 0.42, g: 0.42, b: 0.45, a: 0, frame: 3 },
        ]),
        forces: { gravity: [0, 0.6, 0], drag: 1.4, turbulence: 0.5 },
        spawner: SMOKE_S,
        render: { kind: 'billboard', tiles: env.atlasTiles, spin: 1.4 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
    })

    const fire = (m) => {
      // one muzzle shot: the four systems burst at the muzzle's position
      // (facade.at — the live origin), each with the muzzle's seed roll
      const s = m.seed
      flash.facade.at(m.x, 0, m.z).burst(4, { ...FLASH_S, seed: s })
      planes.facade.at(m.x, 0, m.z).burst(5, { ...PLANES_S, seed: s + 1 })
      sparks.facade.at(m.x, 0, m.z).burst(26, { ...SPARKS_S, seed: s + 2 })
      smoke.facade.at(m.x, 0, m.z).burst(7, { ...SMOKE_S, seed: s + 3 })
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
        flash.facade.advance(ctx.dt)
        planes.facade.advance(ctx.dt)
        sparks.facade.advance(ctx.dt)
        smoke.facade.advance(ctx.dt)
      },
    }
  },
}
