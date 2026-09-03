// alphatest.js — three.quarks' AlphaTestDemo: falling LEAVES — textured
// quads with an alpha MASK (discard below the cutoff — no blending, depth
// write ON: the leaves occlude each other correctly), tumbling in 3D
// (their Rotation3DOverLife), decelerating as they fall (their
// SpeedOverLife 1 → 0 — our speedCurve).
export default {
  title: 'Alpha Test (leaves)',
  sub: 'ALPHA_CUTOFF discard · 3D tumble · SpeedOverLife',
  camera: { yaw: 0.4, pitch: 0.2, dist: 7.5, orbit: 0.05, target: [0, 0.6, 0] },

  make(env) {
    const leaves = env.addLayer({
      id: 'leaves',
      facade: env.createParticles({
        capacity: 200,
        rate: 0,
        bursts: [{ time: 0.01, count: 130, cycle: 0, interval: 6, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 0.9, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.9, size: 1, r: 0.95, g: 0.95, b: 0.9, a: 1 },
          { t: 1, size: 0.8, r: 0.85, g: 0.8, b: 0.75, a: 1 },
        ]),
        forces: {
          gravity: [0, -1.4, 0], drag: 0, turbulence: 0.55,
          // SpeedOverLife: 1 → 0.18 — the launch dies into a gentle fall
          speedCurve: env.createRamp([
            { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
            { t: 1, size: 0.18, r: 1, g: 1, b: 1, a: 1 },
          ]),
        },
        spawner: {
          // their demo: a point burst at x=+2, speed 5 (we add a small fan)
          shape: { kind: 'cone', origin: [1.2, 2.6, 0], axis: [0, 1, 0], halfAngle: 0.9, baseRadius: 0.2, length: [0, 0.1] },
          velocity: { mode: 'lobe' },
          speed: [2.6, 3.4], life: [4.5, 6], size: [0.34, 0.5],
          color: [[1, 1, 1, 1], [1, 0.95, 0.85, 1]], seed: 173,
        },
        render: { kind: 'billboard', mode: 'oriented', axis: 'random', spin: 1.8, tiles: env.atlasTiles },
      }),
      material: env.materials.leaf,
      // alpha-TEST (not blend): opaque fragments with discard, depth write
      // TRUE, no cull (the leaf quads are two-sided)
      pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'none' } },
      uniforms: { u_alphaCutoff: 0.5 },
    })

    // the ground: a faint disc the leaves fall past (the depth reference)
    const ground = env.addLayer({
      id: 'leaves-ground',
      facade: env.createParticles({
        capacity: 4,
        rate: 0,
        bursts: [{ time: 0.01, count: 1, cycle: 1, interval: 1, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.3, g: 0.38, b: 0.32, a: 0.5, frame: 5 },
          { t: 1, size: 1, r: 0.3, g: 0.38, b: 0.32, a: 0.5, frame: 5 },
        ]),
        spawner: {
          shape: { kind: 'point', origin: [0, -2.6, 0] },
          velocity: { mode: 'fixed', dir: [0, 1, 0] },
          speed: [0, 0], life: [1000, 1000], size: [13, 13],
          color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 9,
        },
        render: { kind: 'billboard', mode: 'oriented', axis: [0, 0, 1], tiles: env.atlasTiles },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    return {
      frame(ctx) {
        leaves.facade.advance(ctx.dt)
        ground.facade.advance(ctx.dt)
      },
    }
  },
}
