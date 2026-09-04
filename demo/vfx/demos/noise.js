// noise.js — TURBULENCE: a cone of particles pushed through a
// simplex-noise flow field. forces.noise — the deterministic 3D simplex
// evaluated at position·scale advected by time — bends a straight jet into
// curling wisps. Compare with the sine turbulence (forces.turbulence) in
// the particles demo's embers preset: this is the real field.
export default {
  title: 'Noise Field',
  sub: 'simplex flow · 500/s · the TurbulenceField behavior',
  camera: { yaw: -0.5, pitch: 0.12, dist: 9, orbit: 0.05, target: [0, 1.5, 0] },

  make(env) {
    // the jet: 500 particles/second from a cone pointing +X (the reference demo
    // fires a cone along its emitter axis; we sweep it sideways for a long
    // readable stream)
    const jet = env.addLayer({
      id: 'noise-jet',
      facade: env.createParticles({
        capacity: 3000,
        render: { kind: 'billboard', draw: 'instance' },
        rate: 500,
        ramp: env.createRamp([
          { t: 0, size: 0.5, r: 0.85, g: 0.95, b: 1, a: 0 },
          { t: 0.1, size: 1, r: 1, g: 1, b: 1, a: 0.85 },
          { t: 1, size: 0.3, r: 0.6, g: 0.7, b: 1, a: 0 },
        ]),
        forces: {
          gravity: [0, 0, 0], drag: 0.05, turbulence: 0,
          // THE FIELD: strength 9 (units/s² of acceleration), spatial scale
          // 0.5 (bigger lobes = visible curls), temporal speed 1.2 (the drift)
          noise: { strength: 9, scale: 0.5, speed: 1.2 },
        },
        spawner: {
          shape: { kind: 'cone', origin: [-7, 0.5, 0], axis: [1, 0.06, 0], halfAngle: 0.34, baseRadius: 0.5, length: [0, 0.1] },
          velocity: { mode: 'lobe' },
          speed: [5, 6.2], life: [3.4, 4.2], size: [0.09, 0.16],
          color: [[1, 1, 1, 1], [0.55, 0.75, 1, 0.9]], seed: 161,
        },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      // the single GLOW sprite: a no-tiles layer must NOT sample the 4×4
      // atlas (16 sub-blobs per quad read as a rigid SQUARE at small sizes)
      texture: () => env.glowTexture,
    })

    return {
      frame(ctx) {
        jet.facade.advance(ctx.dt)
      },
    }
  },
}
