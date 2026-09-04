// alphatest.js — three.quarks' AlphaTestDemo: falling LEAVES — exactly
// theirs: a REAL 3D leaf MESH per particle (their instancingGeometry from
// leave.glb — extracted verbatim into leaf-geometry.js + assets/leaves.png
// by scripts/extract-leaf.mjs), a RANDOM start rotation (their
// RandomQuatGenerator — our seed-random axis + seed phase), a 3D TUMBLE
// (their Rotation3DOverLife around (0, 0.5, 0.2) — our spin3d), alpha MASK
// (glTF alphaMode MASK @ cutoff 0.88 — discard, no blending, depth write
// ON: the leaves occlude each other correctly), a point burst at x=+2
// (their PointEmitter: a random unit-sphere direction), startSpeed ~5 with
// their SpeedOverLife 1→0 decay — the launch dies into a drifting fall.
import { LEAF } from './leaf-geometry.js'
import { decodePngRgba } from '../png.mjs'

// their texture, decoded ONCE at module load (the same contract as the
// other demo assets — a missing file falls back to the procedural atlas)
let leafPng = null
try {
  leafPng = await decodePngRgba('assets/leaves.png')
} catch (error) {
  console.warn(`leaves.png: ${error instanceof Error ? error.message : String(error)}`)
}

export default {
  title: 'Alpha Test (leaves)',
  sub: 'the REAL leaf mesh · glTF alpha MASK · 3D tumble · SpeedOverLife',
  camera: { yaw: 0.4, pitch: 0.2, dist: 8, orbit: 0.05, target: [0, 0.4, 0] },

  make(env) {
    // their leaf texture on THIS renderer (bytes decoded at module load)
    let leafTexture = null
    if (leafPng !== null) {
      leafTexture = env.renderer.texture(leafPng.width, leafPng.height)
      leafTexture.upload(leafPng.data)
    }

    const leaves = env.addLayer({
      id: 'leaves',
      facade: env.createParticles({
        capacity: 110,
        rate: 0,
        // their loop: one 100-leaf burst every ~5 s (duration 5, looping)
        bursts: [{ time: 0.01, count: 100, cycle: 0, interval: 5.2, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.9, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.9, r: 1, g: 1, b: 1, a: 1 },
        ]),
        forces: {
          // their SpeedOverLife: Bezier(1, 0.75, 0.5, 0) — the launch dies
          // into a drift; NO gravity (their demo — the leaves hang, tumble
          // and fade, they do not drop)
          gravity: [0, -0.18, 0], drag: 0,
          speedCurve: env.createRamp([
            { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
            { t: 1, size: 0, r: 1, g: 1, b: 1, a: 1 },
          ]),
          turbulence: 0.35,
        },
        spawner: {
          // their PointEmitter at x=+2: the burst scatters on the unit sphere
          shape: { kind: 'point', origin: [2, 1.2, 0] },
          velocity: { mode: 'radial' },
          speed: [4.6, 5.4], life: [4, 5], size: [0.4, 0.5],
          color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 173,
        },
        // their RandomQuat start + Rotation3DOverLife tumble, in one knob:
        // a seed-random axis + the seed-phased start angle + age·spin
        render: { kind: 'mesh', geometry: LEAF, axis: 'random', spin: 1.1 },
      }),
      material: env.materials.leafLit,
      // alpha-TEST (their alphaMode MASK): opaque fragments with discard,
      // depth write TRUE, no cull (the leaf mesh is doubleSided)
      pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'none' } },
      uniforms: {
        u_alphaCutoff: 0.88,
        // the LAMBERT light (the facade layers carry it explicitly —
        // buildMeshCommand only wires the static meshes)
        u_lightDir: () => env.LIGHT_DIR,
        u_lightColor: env.LIGHT_COLOR,
        u_ambient: env.AMBIENT,
      },
      texture: leafTexture !== null ? () => leafTexture : () => env.glowTexture,
    })

    // the ground: a faint disc the leaves drift past (the depth reference)
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

      dispose() {
        leafTexture?.dispose()
      },
    }
  },
}
