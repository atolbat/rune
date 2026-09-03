// explosion.js — three.quarks' ExplosionDemo ("Unity Exported"): a composed
// multi-system effect that plays once, auto-destroys, and re-instances on a
// schedule. Theirs loads ps.json (a Unity export); ours is the same effect
// declared in code — five systems per explosion (core flash, fireball,
// sparks, shockwave ring, smoke), one instance every 1.8 s.
export default {
  title: 'Explosion (composed)',
  sub: 'five systems per effect · shockwave ring · auto-restart',
  camera: { yaw: 0.7, pitch: 0.3, dist: 10, orbit: 0.05, target: [0, 2, 0] },

  make(env) {
    // The full spawner descs (the seed re-rolls per instance).
    const CORE_S = {
      shape: { kind: 'sphere', origin: [0, 2, 0], radius: [0.05, 0.25] },
      velocity: { mode: 'radial' },
      speed: [0.3, 1.5], life: [0.14, 0.3], size: [1.6, 2.8],
      color: [[1, 1, 0.95, 1], [1, 0.85, 0.6, 1]], seed: 61,
    }
    const FIREBALL_S = {
      shape: { kind: 'sphere', origin: [0, 2, 0], radius: [0.1, 0.5] },
      velocity: { mode: 'radial' },
      speed: [1.5, 4.5], life: [0.5, 1.1], size: [0.9, 1.8],
      color: [[1, 0.85, 0.55, 1], [1, 0.5, 0.25, 1]], seed: 67,
    }
    const SPARKS_S = {
      shape: { kind: 'sphere', origin: [0, 2, 0], radius: [0.02, 0.15] },
      velocity: { mode: 'radial' },
      speed: [6, 13], life: [0.6, 1.4], size: [0.12, 0.3],
      color: [[1, 0.95, 0.7, 1], [1, 0.6, 0.25, 1]], seed: 71,
    }
    const SHOCK_S = {
      shape: { kind: 'point', origin: [0, 0.25, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.45, 0.6], size: [3, 4.5],
      color: [[1, 0.95, 0.85, 1], [1, 0.8, 0.5, 0.8]], seed: 73,
    }
    const SMOKE_S = {
      shape: { kind: 'sphere', origin: [0, 1.6, 0], radius: [0.3, 0.8] },
      velocity: { mode: 'radial' },
      speed: [0.5, 2], life: [1.6, 2.8], size: [1, 2],
      color: [[0.42, 0.4, 0.42, 0.55], [0.55, 0.53, 0.55, 0.4]], seed: 79,
    }

    const core = env.addLayer({
      id: 'ex-core',
      facade: env.createParticles({
        capacity: 60,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1, frame: 1 },
          { t: 0.6, size: 2.2, r: 1, g: 0.85, b: 0.5, a: 0.9, frame: 4 },
          { t: 1, size: 3, r: 1, g: 0.5, b: 0.2, a: 0, frame: 11 },
        ]),
        spawner: CORE_S,
        render: { kind: 'billboard', tiles: env.atlasTiles },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    const fireball = env.addLayer({
      id: 'ex-fireball',
      facade: env.createParticles({
        capacity: 300,
        ramp: env.createRamp([
          { t: 0, size: 0.6, r: 1, g: 0.9, b: 0.6, a: 0.9, frame: 6 },
          { t: 0.3, size: 1.6, r: 1, g: 0.55, b: 0.2, a: 0.85, frame: 14 },
          { t: 0.7, size: 2.6, r: 0.7, g: 0.22, b: 0.08, a: 0.4, frame: 3 },
          { t: 1, size: 3.4, r: 0.35, g: 0.12, b: 0.06, a: 0, frame: 3 },
        ]),
        forces: { gravity: [0, 1.6, 0], drag: 1.1, turbulence: 1.4 },
        spawner: FIREBALL_S,
        render: { kind: 'billboard', tiles: env.atlasTiles, spin: 0.8 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    const sparks = env.addLayer({
      id: 'ex-sparks',
      facade: env.createParticles({
        capacity: 900,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.95, b: 0.7, a: 1 },
          { t: 0.5, size: 0.6, r: 1, g: 0.7, b: 0.3, a: 0.9 },
          { t: 1, size: 0.08, r: 1, g: 0.3, b: 0.1, a: 0 },
        ]),
        forces: { gravity: [0, -7, 0], drag: 0.25, turbulence: 0.2 },
        spawner: SPARKS_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.3 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // the shockwave: a FLAT expanding ring (an oriented quad on the ground
    // plane, the ring atlas tile)
    const shock = env.addLayer({
      id: 'ex-shock',
      facade: env.createParticles({
        capacity: 40,
        ramp: env.createRamp([
          { t: 0, size: 0.4, r: 1, g: 0.95, b: 0.85, a: 0.95, frame: 5 },
          { t: 1, size: 7.5, r: 0.8, g: 0.7, b: 0.5, a: 0, frame: 5 },
        ]),
        spawner: SHOCK_S,
        render: { kind: 'billboard', mode: 'oriented', axis: [0, 0, 1], tiles: env.atlasTiles },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    const smoke = env.addLayer({
      id: 'ex-smoke',
      facade: env.createParticles({
        capacity: 500,
        ramp: env.createRamp([
          { t: 0, size: 0.6, r: 0.35, g: 0.33, b: 0.34, a: 0, frame: 6 },
          { t: 0.2, size: 1.4, r: 0.4, g: 0.38, b: 0.4, a: 0.5, frame: 14 },
          { t: 1, size: 4.2, r: 0.28, g: 0.27, b: 0.29, a: 0, frame: 3 },
        ]),
        forces: { gravity: [0, 0.9, 0], drag: 1, turbulence: 0.7 },
        spawner: SMOKE_S,
        render: { kind: 'billboard', tiles: env.atlasTiles, spin: 0.5 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
    })

    let next = 0.3
    let count = 0
    const layers = [core, fireball, sparks, shock, smoke]

    const explode = (ctx) => {
      // a new instance: a random spot on a disc, all five systems burst
      // there (facade.at — the emitter transform of the instance)
      count++
      const ang = count * 2.39996 // the golden-angle walk — no clumping
      const x = Math.cos(ang) * 2.4
      const z = Math.sin(ang) * 2.4
      const y = 0.3 + (count % 3) * 0.7
      const seed = 3000 + count * 13
      core.facade.at(x, y, z).burst(3, { ...CORE_S, seed })
      fireball.facade.at(x, y, z).burst(26, { ...FIREBALL_S, seed: seed + 1 })
      sparks.facade.at(x, y, z).burst(90, { ...SPARKS_S, seed: seed + 2 })
      shock.facade.at(x, 0, z).burst(2, { ...SHOCK_S, seed: seed + 3 })
      smoke.facade.at(x, y, z).burst(16, { ...SMOKE_S, seed: seed + 4 })
      // their emitEnd event analogue: the log line at the START of each
      // instance (the effect "plays once and auto-destroys" — the systems
      // run dry with the lives)
      if (count <= 3 || count % 5 === 0) env.log.event(`explosion #${count} at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`)
    }

    return {
      frame(ctx) {
        next -= ctx.dt
        if (next <= 0) {
          next = 1.3
          explode(ctx)
        }
        for (const l of layers) l.facade.advance(ctx.dt)
      },
    }
  },
}
