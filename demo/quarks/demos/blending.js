// blending.js — three.quarks' CustomBlendingDemo: three clouds of resting
// gray particles over a LIT FLOOR, each drawn with a different BLEND
// EQUATION (Task 122): One/One with ADD, MAX and SUBTRACT. Add stacks the
// overlaps to white; max keeps the brightest single sprite (a flat cloud);
// subtract EATS the lit floor under it — the three equations read at a
// glance.
export default {
  title: 'Custom Blending',
  sub: 'one/one × add | max | subtract equations',
  camera: { yaw: 0.35, pitch: 0.45, dist: 9, orbit: 0.05, target: [0, 1.4, 0] },

  make(env) {
    // the lit floor (a mid-gray Lambert plane — SUBTRACT needs something
    // bright to bite)
    env.addMesh({
      id: 'blend-floor',
      geometry: env.geometry.plane({ width: 26, height: 26 }),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.52, 0.53, 0.55, 1] },
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })

    // the three clouds (their demo: sphere r=3, 10 quads, looping, gray 0.5)
    const SPEC = [
      ['add', 'oneAdd', 0.5],
      ['max', 'oneMax', 0.5],
      ['subtract', 'oneSubtract', 0.5],
    ]
    const SPACING = 3.4
    const clouds = SPEC.map(([label, pipeline, gray], i) => {
      const x = (i - 1) * SPACING
      env.label(label, x, 0.15, 0)
      return env.addLayer({
        id: `blend-${label}`,
        facade: env.createParticles({
          capacity: 80,
          rate: 0,
          bursts: [{ time: 0.01, count: 48, cycle: 0, interval: 5, probability: 1 }],
          ramp: env.createRamp([
            { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
            { t: 1, size: 1, r: 1, g: 1, b: 1, a: 1 },
          ]),
          spawner: {
            // resting particles IN a sphere shell — the overlaps are the demo
            shape: { kind: 'sphere', origin: [x, 1.6, 0], radius: [1.1, 1.5] },
            velocity: { mode: 'radial' },
            speed: [0, 0.0001], life: [4.6, 4.9], size: [1.5, 1.9],
            color: [[gray, gray, gray, 1], [gray, gray, gray, 1]], seed: 211 + i * 17,
          },
        }),
        material: env.materials.sprite,
        pipeline: env.pipelines[pipeline],
      })
    })

    return {
      frame(ctx) {
        for (const cloud of clouds) cloud.facade.advance(ctx.dt)
      },
    }
  },
}
