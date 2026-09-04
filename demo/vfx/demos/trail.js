// trail.js — TRAILS & PHYSICS: a FIREWORK of ~110 fast particles in ONE
// burst every 5 s — each particle a long comet ribbon that arcs under
// gravity −20 and BOUNCES off the floor at y = −6 (restitution 0.6) AND
// off the two PROPS on the floor — a solid SPHERE and a CRATE (Task 128's
// collision shapes: the sphere pushes out along its radial normal, the
// box along its minimum-penetration face) — each trail tinted red→green.
// The trails: the decimated position history + the ribbon baker — the
// same soup, the same material, one draw call. The heads are the
// physics-readable cores.
export default {
  title: 'Trails & Collision',
  sub: 'the firework burst · ribbon history · floor + sphere + crate bounces',
  camera: { yaw: 0.5, pitch: 0.16, dist: 13, orbit: 0.06, target: [0, -1.5, 0] },

  make(env) {
    // the probe counter (scripts/task128-probe.mjs reads it)
    const C = (typeof window !== 'undefined' ? (window.__vfxCounters ??= {}) : {})
    // the spawner: cone radius 0.12 angle ~54°, speed 10–15, life
    // 3.6–4.6 — a fountain that rises ~4 units, arcs and rains back
    const SPAWN = {
      shape: { kind: 'cone', origin: [0, -6, 0], axis: [0, 1, 0], halfAngle: 0.95, baseRadius: 0.12, length: [0, 0.1] },
      velocity: { mode: 'lobe' },
      speed: [10, 15], life: [3.6, 4.6], size: [0.3, 0.45],
      color: [[1, 0.3, 0.25, 1], [0.3, 1, 0.35, 1]], seed: 117,
    }
    // the forces: gravity (0,−1,0)·20 + the collision floor y=−6 with the
    // two props (restitution 0.6 everywhere, light friction). THE SHAPES
    // (Task 128): `planes` + `spheres` + `boxes` — the firework rains
    // onto the sphere and rolls off it radially, hits the crate's face
    // and deflects along it; every contact is a real bounce, not a
    // pass-through.
    const FORCES = {
      gravity: [0, -20, 0], drag: 0.02, turbulence: 0,
      collide: {
        planes: [{ normal: [0, 1, 0], point: [0, -6, 0], restitution: 0.6, friction: 0.02 }],
        spheres: [{ center: [2.6, -4.7, 1.3], radius: 1.3, restitution: 0.6, friction: 0.05 }],
        boxes: [{ center: [-3.1, -5.2, -1.7], half: [1.5, 0.8, 1.5], restitution: 0.55, friction: 0.08 }],
        // the probe counter: which shapes are actually being HIT (each
        // kind counted once per contact — floor / sphere / crate)
        onCollide: (rec) => {
          if (rec.plane >= 0) C.bouncePlane = (C.bouncePlane ?? 0) + 1
          if (rec.sphere >= 0) C.bounceSphere = (C.bounceSphere ?? 0) + 1
          if (rec.box >= 0) C.bounceBox = (C.bounceBox ?? 0) + 1
        },
      },
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

    // ── the PROPS (Task 128): the collision shapes, VISIBLE ──
    // a capsule with height ~0 reads as a sphere; a stretched cube reads
    // as the crate. Their meshes sit exactly where the colliders sit —
    // what bounces is what you see.
    env.addMesh({
      id: 'trail-sphere',
      geometry: env.geometry.capsule({ radius: 1.3, height: 0.01, radialSegments: 24, capSegments: 12 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2.6, -4.7, 1.3, 1]),
      uniforms: { u_albedo: [0.28, 0.36, 0.5, 1] },
    })
    env.addMesh({
      id: 'trail-crate',
      geometry: env.geometry.cube(1),
      material: env.materials.lambert,
      // cube(1) spans [−1, 1]³ — scaling by the half extents lands the
      // visual EXACTLY on the collider (a 3.0×1.6×3.0 crate)
      model: new Float32Array([1.5, 0, 0, 0, 0, 0.8, 0, 0, 0, 0, 1.5, 0, -3.1, -5.2, -1.7, 1]),
      uniforms: { u_albedo: [0.42, 0.3, 0.2, 1] },
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
        render: { kind: 'billboard', draw: 'instance' },
      }),
      material: env.materials.bbSprite,
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
