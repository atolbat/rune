// trail.js — three.quarks' TrailDemo ("Trail Renderer and Physics"): a
// fountain of fast particles with long ribbon trails that BOUNCE off the
// floor (their ApplyCollision with restitution 0.6) under gravity, each
// trail tinted red→green (their RandomColorBetweenGradient). Our trails:
// the decimated position history + the ribbon baker (Task 122) — the same
// soup, the same material, one draw call.
export default {
  title: 'Trails & Collision',
  sub: 'ribbon history · floor bounce 0.6 · gravity −20',
  camera: { yaw: 0.5, pitch: 0.16, dist: 12, orbit: 0.06, target: [0, -1, 0] },

  make(env) {
    const trails = env.addLayer({
      id: 'trail-ribbon',
      facade: env.createParticles({
        capacity: 220,
        rate: 42,
        // the over-life ramp: the trail HEAD color (the tail fades in the
        // baker); size = the head width
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.9, b: 0.9, a: 1 },
          { t: 0.6, size: 0.8, r: 1, g: 1, b: 0.4, a: 0.8 },
          { t: 1, size: 0.5, r: 0.4, g: 1, b: 0.4, a: 0 },
        ]),
        forces: {
          gravity: [0, -20, 0], drag: 0.02, turbulence: 0,
          // their ApplyCollision: the floor at y = −6, bounce 0.6
          collide: { planes: [{ normal: [0, 1, 0], point: [0, -6, 0], restitution: 0.6, friction: 0.02 }] },
        },
        spawner: {
          // a wide cone shooting up-and-out (their beam: cone r 0.1, angle 1,
          // speed 10–15, burst of 100)
          shape: { kind: 'cone', origin: [0, -6, 0], axis: [0, 1, 0], halfAngle: 0.95, baseRadius: 0.12, length: [0, 0.1] },
          velocity: { mode: 'lobe' },
          speed: [10, 15], life: [3.6, 4.6], size: [0.28, 0.4],
          color: [[1, 0.35, 0.25, 1], [0.35, 1, 0.35, 1]], seed: 117,
        },
        render: { kind: 'trail', points: 26, step: 1 / 40, length: 9, width: 0.9 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    // the heads: small bright cores at the trail tips (their trail renderer
    // shows only ribbons; the heads make the physics readable)
    const heads = env.addLayer({
      id: 'trail-heads',
      facade: env.createParticles({
        capacity: 220,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.4, r: 1, g: 0.9, b: 0.5, a: 0 },
        ]),
        forces: {
          gravity: [0, -20, 0], drag: 0.02, turbulence: 0,
          collide: { planes: [{ normal: [0, 1, 0], point: [0, -6, 0], restitution: 0.6, friction: 0.02 }] },
        },
        spawner: {
          shape: { kind: 'cone', origin: [0, -6, 0], axis: [0, 1, 0], halfAngle: 0.95, baseRadius: 0.12, length: [0, 0.1] },
          velocity: { mode: 'lobe' },
          speed: [10, 15], life: [3.6, 4.6], size: [0.3, 0.45],
          color: [[1, 0.95, 0.9, 1], [1, 1, 0.8, 1]], seed: 117,
        },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    // the floor: a faint grid decal so the bounce plane reads (an oriented
    // quad at y = −6, the ring tile stretched)
    const floor = env.addLayer({
      id: 'trail-floor',
      facade: env.createParticles({
        capacity: 4,
        rate: 0,
        bursts: [{ time: 0.01, count: 1, cycle: 1, interval: 1, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.32, g: 0.4, b: 0.5, a: 0.5, frame: 5 },
          { t: 1, size: 1, r: 0.32, g: 0.4, b: 0.5, a: 0.5, frame: 5 },
        ]),
        spawner: {
          shape: { kind: 'point', origin: [0, -6, 0] },
          velocity: { mode: 'fixed', dir: [0, 1, 0] },
          speed: [0, 0], life: [1000, 1000], size: [26, 26],
          color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 3,
        },
        render: { kind: 'billboard', mode: 'oriented', axis: [0, 0, 1], tiles: env.atlasTiles },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    return {
      frame(ctx) {
        trails.facade.advance(ctx.dt)
        heads.facade.advance(ctx.dt)
        floor.facade.advance(ctx.dt)
      },
    }
  },
}
