// alphatest.js — FALLING PETALS: the alpha-TEST (alpha MASK) study — the
// cutout class where blending is WRONG and discard is right:
//
//   · a REAL 3D petal MESH per particle (our procedural strip — a tapered,
//     upward-curling blade with a feathered alpha border), not a flat quad;
//   · alpha MASK: opaque fragments + discard below the cutoff, depth write
//     ON, no cull (double-sided) — the petals OCCLUDE each other and the
//     ground correctly, no sorting artifacts, no halo;
//   · a seed-random axis + seed-phased start angle + age·spin — the 3D
//     tumble every falling leaf does;
//   · SpeedOverLife decay: the burst's launch dies into a slow drift, the
//     petals hang in the air and fade — a launch → float → dissolve arc.
import { PETAL, makePetalBytes } from './petal-geometry.js'

export default {
  title: 'Alpha Test (petals)',
  sub: 'the cutout class · alpha MASK + discard · 3D petal mesh tumble',
  camera: { yaw: 0.4, pitch: 0.2, dist: 8, orbit: 0.05, target: [0, 0.4, 0] },

  make(env) {
    // our petal texture on THIS renderer (the demo re-makes on boots)
    const petalTex = env.renderer.texture(64, 64)
    petalTex.upload(makePetalBytes())

    const petals = env.addLayer({
      id: 'petals',
      facade: env.createParticles({
        capacity: 90,
        rate: 0,
        // the loop: a 80-petal burst every ~6 s
        bursts: [{ time: 0.01, count: 80, cycle: 0, interval: 6.1, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.88, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.92, r: 0.9, g: 0.9, b: 0.9, a: 1 },
        ]),
        forces: {
          // the launch dies into a drift; a whisper of gravity — the petals
          // sink as they fade (a leaf hangs, a petal settles)
          gravity: [0, -0.22, 0], drag: 0,
          speedCurve: env.createRamp([
            { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
            { t: 1, size: 0, r: 1, g: 1, b: 1, a: 1 },
          ]),
          turbulence: 0.4,
        },
        spawner: {
          // the burst point: the petals scatter on the unit sphere from x=+2
          shape: { kind: 'point', origin: [2, 1.2, 0] },
          velocity: { mode: 'radial' },
          speed: [4.2, 5.2], life: [4.4, 5.4], size: [0.42, 0.55],
          // the petal palette: a rose → amber blend
          color: [
            [1, 0.52, 0.42, 1], [1, 0.86, 0.52, 1],
          ],
          seed: 173,
        },
        // a seed-random tumble axis + the seed-phased start + age·spin
        render: { kind: 'mesh', geometry: PETAL, axis: 'random', spin: 1.15 },
      }),
      material: env.materials.leafLit,
      // alpha-TEST (the MASK): opaque fragments with discard, depth write
      // TRUE, no cull (the petal mesh is double-sided)
      pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'none' } },
      uniforms: {
        u_alphaCutoff: 0.5,
        // the LAMBERT light (the layer carries it explicitly —
        // buildMeshCommand only wires the static meshes)
        u_lightDir: () => env.LIGHT_DIR,
        u_lightColor: env.LIGHT_COLOR,
        u_ambient: env.AMBIENT,
      },
      texture: () => petalTex,
    })

    // the ground: a faint disc the petals drift past (the depth reference)
    const ground = env.addLayer({
      id: 'petals-ground',
      facade: env.createParticles({
        capacity: 4,
        rate: 0,
        bursts: [{ time: 0.01, count: 1, cycle: 0, interval: 1000, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.16, g: 0.14, b: 0.11, a: 1, frame: 13 },
          { t: 1, size: 1, r: 0.16, g: 0.14, b: 0.11, a: 1, frame: 13 },
        ]),
        spawner: {
          shape: { kind: 'point', origin: [0, -0.02, 0] },
          velocity: { mode: 'fixed', dir: [0, 1, 0] },
          speed: [0, 0], life: [1000, 1000], size: [30, 30],
          color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 9,
        },
        render: { kind: 'billboard', mode: 'horizontal', tiles: [4, 4] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.atlasTexture,
    })

    return {
      frame(ctx) {
        petals.facade.advance(ctx.dt)
        ground.facade.advance(ctx.dt)
      },
      dispose() {
        petalTex.dispose()
      },
    }
  },
}
