// grass.js — a RUNE ORIGINAL (Task 126): the VEGETATION FIELD — the one
// particle class a CPU-simulated soup cannot scale: 42,000 grass blades
// covering a 60-unit radius, ONE instanced draw call, animated entirely in
// the vertex shader.
//
//   · the GPU-static field (@rune/particles createGrassField): the
//     per-blade data (anchor, height, lean, flutter phase, width, tint)
//     is baked ONCE, deterministically, into three instanced buffers —
//     ZERO per-frame CPU geometry (the soup path would re-bake 252k verts
//     every frame);
//   · the WIND lives in the vertex shader: two TRAVELING waves across the
//     field (the gusts cross it like weather, NOT a uniform wiggle) + a
//     per-blade flutter phase — the field develops non-uniformly, waves
//     of bending rolling through it;
//   · CYLINDRICAL billboards: the blades face the camera around world Y
//     and stay anchored at the base — grass reads as grass from any
//     angle;
//   · the far fade (the density LOD): the fragment discards blades past
//     the fade distance — the field thins smoothly into the ground
//     instead of aliasing/shimmering;
//   · the demo drives the wind (a slow surge + gust pulses through
//     u_wind) and drifts a few dandelion seeds over the field (a classic
//     facade system — the living contrast to the static field).
const BLADE_W = 32
const BLADE_H = 64

/** The blade sprite: rgb = a neutral brightness gradient (dark base →
 *  bright tip — the per-instance tint carries the green), alpha = the
 *  tapered, slightly bent blade silhouette. */
function makeBladeBytes() {
  const bytes = new Uint8Array(BLADE_W * BLADE_H * 4)
  for (let y = 0; y < BLADE_H; y++) {
    for (let x = 0; x < BLADE_W; x++) {
      const v = (y + 0.5) / BLADE_H // 0 = base, 1 = tip (v grows UP)
      const u = (x + 0.5) / BLADE_W - 0.5
      // the blade bends sideways as it rises (a natural curve)
      const bend = 0.13 * Math.sin(v * Math.PI)
      // the half-width: widest low, tapering to a point at the tip
      const halfW = 0.5 * Math.pow(1 - v, 0.55)
      const edge = Math.abs(u - bend)
      const inside = edge < halfW - 0.04
      const soft = edge < halfW + 0.02
      const a = inside ? 255 : soft ? 90 : 0
      // brightness: dark base → bright tip (the tint multiplies)
      const bright = Math.round(255 * (0.3 + 0.7 * Math.pow(v, 0.8)))
      const i = (y * BLADE_W + x) * 4
      bytes[i] = bytes[i + 1] = bytes[i + 2] = bright
      bytes[i + 3] = a
    }
  }
  return bytes
}

export default {
  title: 'Grass Field',
  sub: 'rune original · 42k blades · ONE instanced draw · GPU wind waves · LOD fade',
  camera: { yaw: 0.35, pitch: 0.13, dist: 8.5, orbit: 0.05, target: [0, 0.55, 0] },

  make(env) {
    const renderer = env.renderer

    // ── the scene: a dark meadow floor ──
    env.addMesh({
      id: 'gr-floor',
      geometry: env.geometry.plane({ width: 160, height: 160 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      uniforms: { u_albedo: [0.05, 0.075, 0.04, 1] },
    })

    // ── the blade texture (on THIS renderer — the demo re-makes on boots) ──
    const bladeTex = renderer.texture(BLADE_W, BLADE_H)
    bladeTex.upload(makeBladeBytes())

    // ── THE FIELD: 42k blades, one instanced draw, GPU wind ──
    const field = env.createGrassField({
      count: 42000,
      radius: 60,
      height: [0.32, 0.9],
      width: [0.05, 0.12],
      color: [[0.16, 0.3, 0.09], [0.5, 0.58, 0.2]],
      seed: 4213,
    })
    const grassCommand = renderer.command({
      id: 'quarks:grass-field',
      shader: { glsl: field.glsl, wgsl: field.wgsl },
      // solid blades with alpha MASK: depth write ON (they occlude each
      // other), no culling (double-sided)
      pipeline: { depth: { test: 'less', write: true }, raster: { cull: 'none' } },
      attributes: {
        i_pos: { data: field.pos, size: 3, step: 'instance' },
        i_par: { data: field.par, size: 4, step: 'instance' },
        i_tint: { data: field.tint, size: 4, step: 'instance' },
      },
      textures: { u_tex: bladeTex, texTexture: bladeTex },
      uniforms: {
        u_mvp: (p) => p.mvp,
        u_camPos: (p) => p.camPos,
        u_time: (p) => p.time,
        u_wind: (p) => p.wind,
      },
      count: 6, // the quad — the instances are the blades
      // ADAPTIVE DENSITY: a weak GPU (SwiftShader, an old iGPU) halves the
      // drawn blades until the frame time recovers — the FIELD stays, the
      // vertex load flexes (the buffers are static, only the count moves)
      instances: (p) => p.instanceCount ?? 0,
    })
    let bladeCount = field.count
    let frameAvg = 16 / 1000
    let warmup = 1.2

    // ── the seeds drifting over the field (the living contrast) ──
    const SEED_S = {
      shape: { kind: 'disc', origin: [0, 4.5, 0], axis: [0, 1, 0], radius: [2, 14] },
      velocity: { mode: 'radial' },
      speed: [0.3, 0.8], life: [7, 11], size: [0.05, 0.09],
      color: [[1, 1, 0.85, 0.9], [0.9, 0.95, 0.8, 0.6]], seed: 77,
    }
    const seeds = env.addLayer({
      id: 'gr-seeds',
      facade: env.createParticles({
        capacity: 140, rate: 14,
        ramp: env.createRamp([
          { t: 0, size: 0.7, r: 1, g: 1, b: 0.9, a: 0 },
          { t: 0.15, size: 1, r: 1, g: 1, b: 0.9, a: 0.85 },
          { t: 0.85, size: 0.9, r: 1, g: 0.98, b: 0.85, a: 0.6 },
          { t: 1, size: 0.6, r: 1, g: 0.95, b: 0.8, a: 0 },
        ]),
        forces: {
          gravity: [0, 0.25, 0], drag: 0.4,
          noise: { strength: 1.6, scale: 0.14, speed: 0.11 },
        },
        spawner: SEED_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.03, lengthFactor: 0.5 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.cfxrTextures.trait,
    })

    // THE RAW LAYER: the field records itself (the soft demo's prepass
    // pattern — a demo-owned command, rebuilt on every renderer boot by
    // the shell's re-make)
    env.addLayer({
      id: 'gr-field',
      record: (ctx) => {
        // the wind: a fixed direction, a slow surge + traveling gust
        // pulses (the gustiness channel drives the per-blade flutter)
        const t = ctx.time
        const surge = 0.55 + 0.3 * Math.sin(t * 0.21) + 0.25 * Math.sin(t * 0.53 + 1.7)
        const gust = 0.5 + 0.5 * Math.sin(t * 0.37 + 0.6)
        ctx.record(grassCommand, {
          mvp: ctx.mvp,
          camPos: ctx.camEye,
          time: t,
          wind: [0.83, 0.55, surge, gust * 0.6],
          instanceCount: bladeCount,
        })
      },
    })

    return {
      frame(ctx) {
        // THE ADAPTIVE DENSITY: an EMA of the frame time; after the 1.2-s
        // warmup, a machine slower than ~24 fps halves the blades (min
        // 10k — SwiftShader and weak iGPUs keep a smooth, smaller field;
        // real GPUs keep all 42k)
        frameAvg += (ctx.dt - frameAvg) * Math.min(1, ctx.dt * 2)
        warmup -= ctx.dt
        if (warmup <= 0 && frameAvg > 1 / 24 && bladeCount > 10000) {
          bladeCount = Math.max(10000, Math.floor(bladeCount / 2))
          frameAvg = 16 / 1000
          warmup = 1.2
          env.log.event(`grass field: ${bladeCount.toLocaleString('en-US')} blades (adaptive density) `)
        }
        seeds.facade.advance(ctx.dt)
      },

      dispose() {
        bladeTex.dispose()
      },
    }
  },
}
