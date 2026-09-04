// fireflies.js — a RUNE ORIGINAL: the living-ambient demo — a night meadow
// of fireflies gathering around a wandering lantern:
//
//   · the simplex NOISE field — the organic wander (no two flies share a
//     path; the field is sampled at position·scale advected by age·speed);
//   · the SEEK spring, RETARGETED LIVE — the per-particle targets
//     (fields.tx/ty/tz — the documented escape hatch) are rewritten every
//     frame to a slowly-moving point AROUND the lantern (a per-particle
//     phase, so they GATHER in a loose swarm, never a clump);
//   · the flicker — the ramp's alpha/size channels oscillate over the
//     6–9 s lives (de-synchronized by the per-particle life spread);
//   · a moon glow + dark bushes + the lantern's own additive halo.
//
// The feel target: an idle-game / RPG night scene that feels ALIVE.
const TAU = Math.PI * 2

export default {
  title: 'Fireflies',
  sub: 'rune original · noise wander · live seek retarget · lantern swarm',
  camera: { yaw: 0.9, pitch: 0.16, dist: 9.5, orbit: 0.025, target: [0, 1.2, 0] },

  make(env) {
    // ── the scene: the night meadow ──
    env.addMesh({
      id: 'ff-floor',
      geometry: env.geometry.plane({ width: 70, height: 70 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      uniforms: { u_albedo: [0.045, 0.06, 0.05, 1] },
    })
    // the bushes: dark rounded masses, rim-lit by the moon
    const bush = (id, x, z, s) => {
      env.addMesh({
        id,
        geometry: env.geometry.capsule({ radius: 0.55 * s, height: 0.7 * s, radialSegments: 8, capSegments: 3 }),
        material: env.materials.lambert,
        model: new Float32Array([
          s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, 0.4 * s, z, 1,
        ]),
        uniforms: { u_albedo: [0.1, 0.14, 0.1, 1] },
      })
    }
    bush('ff-bush-a', -3.4, -2.2, 1.5)
    bush('ff-bush-b', 3.8, -1.4, 1.1)
    bush('ff-bush-c', -1.2, 3.6, 1.8)
    bush('ff-bush-d', 2.6, 3.1, 0.9)

    // the lantern post + head: a manual mesh pair (the head follows the
    // same lissajous as the glow point)
    const post = env.addMesh({
      id: 'ff-post',
      geometry: env.geometry.capsule({ radius: 0.035, height: 1.15, radialSegments: 6, capSegments: 3 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.6, 0, 1]),
      uniforms: { u_albedo: [0.16, 0.12, 0.08, 1] },
    })
    const head = env.addMesh({
      id: 'ff-head',
      geometry: env.geometry.cube(0.2),
      material: env.materials.lambert,
      model: new Float32Array([0.2, 0, 0, 0, 0, 0.26, 0, 0, 0, 0, 0.2, 0, 0, 1.3, 0, 1]),
      manual: true, // rides the lissajous
      uniforms: { u_albedo: [1.0, 0.72, 0.25, 1] },
    })
    const headModel = new Float32Array(16)

    // ── the lantern halo: the additive glow riding the same path ──
    const HALO_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [1.2, 1.2], size: [1.05, 1.05],
      color: [[1, 0.8, 0.4, 1], [1, 0.8, 0.4, 1]], seed: 5,
    }
    const halo = env.addLayer({
      id: 'ff-halo',
      facade: env.createParticles({
        capacity: 2, rate: 1.1,
        ramp: env.createRamp([
          { t: 0, size: 0.94, r: 1, g: 0.82, b: 0.45, a: 0.5 },
          { t: 0.5, size: 1.06, r: 1, g: 0.85, b: 0.5, a: 0.62 },
          { t: 1, size: 0.94, r: 1, g: 0.8, b: 0.42, a: 0.5 },
        ]),
        spawner: HALO_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'camera' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the moon: a fixed pale glow, far up ──
    const MOON_S = {
      shape: { kind: 'point', origin: [-16, 10, -24] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [4, 4], size: [4.4, 4.4],
      color: [[0.9, 0.93, 1, 1], [0.9, 0.93, 1, 1]], seed: 9,
    }
    const moon = env.addLayer({
      id: 'ff-moon',
      facade: env.createParticles({
        capacity: 2, rate: 0.34, prewarm: 6,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.9, g: 0.93, b: 1, a: 0.4 },
          { t: 1, size: 1, r: 0.9, g: 0.93, b: 1, a: 0.4 },
        ]),
        spawner: MOON_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'camera' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the fireflies: noise wander + the live-retargeted seek ──
    const FLY_S = {
      shape: { kind: 'sphere', origin: [0, 1.4, 0], radius: [2.5, 5.5] },
      velocity: { mode: 'radial' },
      speed: [0.2, 0.7], life: [6, 9], size: [0.06, 0.15],
      color: [[1, 0.92, 0.35, 1], [0.75, 1, 0.4, 1]], seed: 77,
    }
    const flies = env.addLayer({
      id: 'ff-flies',
      facade: env.createParticles({
        capacity: 160, rate: 14, prewarm: 6,
        // the flicker: the alpha (and the size) oscillate over the life —
        // the 6–9 s life spread de-synchronizes the swarm
        ramp: env.createRamp([
          { t: 0, size: 0.5, r: 1, g: 0.92, b: 0.35, a: 0 },
          { t: 0.06, size: 1, r: 1, g: 0.95, b: 0.45, a: 1 },
          { t: 0.13, size: 0.55, r: 1, g: 0.9, b: 0.4, a: 0.15 },
          { t: 0.22, size: 1.1, r: 0.85, g: 1, b: 0.4, a: 1 },
          { t: 0.31, size: 0.5, r: 1, g: 0.92, b: 0.35, a: 0.2 },
          { t: 0.44, size: 1.05, r: 1, g: 0.95, b: 0.45, a: 0.95 },
          { t: 0.55, size: 0.6, r: 1, g: 0.9, b: 0.4, a: 0.25 },
          { t: 0.68, size: 1, r: 0.85, g: 1, b: 0.4, a: 1 },
          { t: 0.79, size: 0.55, r: 1, g: 0.92, b: 0.35, a: 0.3 },
          { t: 0.9, size: 0.95, r: 1, g: 0.95, b: 0.45, a: 0.85 },
          { t: 1, size: 0.3, r: 1, g: 0.85, b: 0.3, a: 0 },
        ]),
        // the wander + the swarm pull; the targets are REWRITTEN per frame
        forces: {
          gravity: [0, 0.08, 0], drag: 0.5,
          noise: { strength: 1.5, scale: 0.32, speed: 0.45 },
          seek: { strength: 1.5, damping: 2.7 },
        },
        spawner: FLY_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'camera' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      // the single-glow sprite: WITHOUT tiles the 4×4 atlas would print a
      // grid of glows into every particle (the "sharp squares" bug)
      texture: () => env.glowTexture,
    })

    const layers = [moon, halo, flies]
    const f = flies.facade.fields
    let t = 0
    let lx = 0, ly = 1.3, lz = 0 // the lantern glow point (the lissajous)

    return {
      frame(ctx) {
        t += ctx.dt
        // the lantern's slow lissajous wander
        lx = Math.sin(t * 0.21) * 2.3
        lz = Math.sin(t * 0.17 + 1.3) * 2.3
        ly = 1.35 + Math.sin(t * 0.3) * 0.35

        // the lantern head follows (a scale-keep model: just translation)
        headModel.set([0.2, 0, 0, 0, 0, 0.26, 0, 0, 0, 0, 0.2, 0, lx, ly, lz, 1])
        ctx.record(head.command, { mvp: ctx.modelMvp(headModel), model: headModel, camPos: ctx.camEye })
        // the halo rides the same point
        halo.facade.at(lx, ly, lz)

        // THE live retarget: every fly seeks its own point around the
        // lantern (a per-particle phase from the spawn seed — a loose
        // swarm shell, not a clump)
        const n = flies.facade.count
        for (let i = 0; i < n; i++) {
          const ph = f.seed[i] * TAU
          const wob = 0.55 + 0.75 * f.seed[i]
          f.tx[i] = lx + Math.cos(ph + t * (0.5 + f.seed[i] * 0.7)) * wob
          f.ty[i] = ly + Math.sin(ph * 2.3 + t * 0.9) * (wob * 0.5) + 0.25
          f.tz[i] = lz + Math.sin(ph + t * (0.5 + f.seed[i] * 0.7)) * wob
        }

        for (const l of layers) l.facade.advance(ctx.dt)
      },
    }
  },
}
