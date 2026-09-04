// trail.js — TRAILS & PHYSICS: a FIREWORK of ~110 fast particles in ONE
// burst every 5 s — each particle a long comet ribbon that arcs under
// gravity −20 and BOUNCES off the floor at y = −6 (restitution 0.6), each
// trail tinted red→green. The trails: the decimated position history +
// the ribbon baker — the same soup, the same material, one draw call.
// The heads are the physics-readable cores.
export default {
  title: 'Trails & Collision',
  sub: 'the firework burst · ribbon history · floor bounce 0.6 · gravity −20',
  camera: { yaw: 0.5, pitch: 0.16, dist: 13, orbit: 0.06, target: [0, -1.5, 0] },

  make(env) {
    // the spawner: cone radius 0.12 angle ~54°, speed 10–15, life
    // 3.6–4.6 — a fountain that rises ~4 units, arcs and rains back
    const SPAWN = {
      shape: { kind: 'cone', origin: [0, -6, 0], axis: [0, 1, 0], halfAngle: 0.95, baseRadius: 0.12, length: [0, 0.1] },
      velocity: { mode: 'lobe' },
      speed: [10, 15], life: [3.6, 4.6], size: [0.3, 0.45],
      color: [[1, 0.3, 0.25, 1], [0.3, 1, 0.35, 1]], seed: 117,
    }
    // the forces: gravity (0,−1,0)·20 + the collision floor y=−6,
    // restitution 0.6
    const FORCES = {
      gravity: [0, -20, 0], drag: 0.02, turbulence: 0,
      collide: { planes: [{ normal: [0, 1, 0], point: [0, -6, 0], restitution: 0.6, friction: 0.02 }] },
    }

    // the floor: a REAL lit plane at y = −6 (the dark bounce surface
    // reads as ground, not a glow blob)
    const floorModel = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -6, 0, 1])
    env.addMesh({
      id: 'trail-floor',
      geometry: env.geometry.plane({ width: 46, height: 46 }),
      material: env.materials.lambert,
      model: floorModel,
      uniforms: { u_albedo: [0.17, 0.18, 0.22, 1] },
    })

        const trails = env.addLayer({
      id: 'trail-ribbon',
      facade: env.createParticles({
        capacity: 260,
        rate: 0,
        // THE firework cadence: one 110-particle burst every 5 s
        bursts: [{ time: 0.6, count: 110, cycle: 0, interval: 5, probability: 1 }],
        // the over-life ramp: the trail HEAD color (the tail fades in the
        // baker); size = the head width
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.6, size: 0.85, r: 1, g: 1, b: 1, a: 0.85 },
          { t: 1, size: 0.5, r: 1, g: 1, b: 1, a: 0 },
        ]),
        forces: FORCES,
        spawner: SPAWN,
        render: { kind: 'trail', points: 22, step: 1 / 30, length: 9, width: 0.8 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      // a dedicated single-glow texture — the ribbons sample the FULL
      // texture (u along the length, v across the width); the 4×4 atlas
      // would print a grid of glows into every segment
      texture: () => env.glowTexture,
    })

    // the heads: small bright cores at the trail tips (the trail
    // renderer shows only ribbons; the heads make the physics readable)
    const heads = env.addLayer({
      id: 'trail-heads',
      facade: env.createParticles({
        capacity: 260,
        rate: 0,
        bursts: [{ time: 0.6, count: 110, cycle: 0, interval: 5, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.4, r: 1, g: 0.95, b: 0.7, a: 0 },
        ]),
        forces: FORCES,
        spawner: SPAWN,
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })


    return {
      frame(ctx) {
        trails.facade.advance(ctx.dt)
        heads.facade.advance(ctx.dt)
      },
    }
  },
}
