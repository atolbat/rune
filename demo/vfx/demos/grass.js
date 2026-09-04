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
//   · Task 128 — THE DENSITY MASK: the blade frequency is driven by a
//     (x, z) → [0, 1] field — here a two-octave value-noise "meadow
//     patchiness" with TWO CARVED PATHS (a straight dirt track and a
//     winding one) where nothing grows. The bake rejects candidates in
//     sparse spots (the spacing widens) and scales the height with the
//     density (dense patches are lusher) — a field that reads as a PLACE,
//     not a uniform carpet;
//   · Task 128 — THE WIND AS WAVES: the bend DIRECTION swings with
//     traveling wave fronts (~5 crests visible at once, crossing at an
//     angle) — gusts visibly ROLL across the field instead of the whole
//     carpet pulsing in place; plus the per-blade flutter;
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

/** A small deterministic value noise (two octaves) for the mask's meadow
 *  patchiness — the same recipe the procedural sprites use. */
const maskNoise = (x, y) => {
  const h2 = (xi, yi) => {
    const v = Math.sin(xi * 127.1 + yi * 311.7 + 74.7) * 43758.5453
    return v - Math.floor(v)
  }
  const smooth = (xf, yf) => {
    const xi = Math.floor(xf), yi = Math.floor(yf)
    const u = xf - xi, v = yf - yi
    const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v)
    return h2(xi, yi) * (1 - su) * (1 - sv) + h2(xi + 1, yi) * su * (1 - sv)
      + h2(xi, yi + 1) * (1 - su) * sv + h2(xi + 1, yi + 1) * su * sv
  }
  return smooth(x, y) * 0.65 + smooth(x * 2.7 + 11, y * 2.7 + 5) * 0.35
}

/** THE DENSITY MASK (Task 128): (x, z) → [0, 1].
 *   · the base: two-octave noise patchiness (0.45..1 — a natural meadow,
 *     not a lawn);
 *   · a straight DIRT TRACK along X at z ≈ 7.5 (the camera looks across
 *     it — the gap makes the mask instantly legible);
 *   · a WINDING path: z = 18·sin(x/14) — a deer trail curving through;
 *   · a soft clearing around the ORIGIN (where the camera hovers — the
 *     blades would otherwise fill the lens at close range).
 * The smoothstep falloffs keep the path edges soft (a 2.5-unit feather —
 * a hard mask edge would read as a painted decal). */
function makeGrassMask() {
  const ss = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)
  }
  return (x, z) => {
    // the meadow patchiness
    let w = 0.45 + 0.55 * Math.min(1, Math.max(0, maskNoise(x * 0.055, z * 0.055)))
    // the straight track: distance to the z = 7.5 line
    w *= ss(1.9, 4.4, Math.abs(z - 7.5))
    // the winding trail: distance to z = 18·sin(x/14) + 3
    const trail = z - (18 * Math.sin(x / 14) + 3)
    w *= ss(1.6, 4.0, Math.abs(trail))
    // the soft clearing at the origin
    w *= ss(2.2, 6.5, Math.hypot(x, z))
    return w
  }
}

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
  sub: 'rune original · mask-driven density · traveling wind waves · 42k blades ONE draw',
  camera: { yaw: 0.35, pitch: 0.5, dist: 11, orbit: 0.05, target: [0, 0.8, 0] },

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

    // ── THE FIELD: 42k blades, one instanced draw, GPU wind, THE MASK ──
    const field = env.createGrassField({
      count: 42000,
      radius: 60,
      height: [0.32, 0.9],
      width: [0.05, 0.12],
      color: [[0.16, 0.3, 0.09], [0.5, 0.58, 0.2]],
      seed: 4213,
      // Task 128 — THE DENSITY MASK: the noise patches + the two carved
      // paths + the clearing (see makeGrassMask). The bake accepts ~70%
      // of candidates (dense where w→1, sparse where w→0.45) and grows
      // the survivors taller in the dense patches.
      mask: makeGrassMask(),
      // THE SMOOTH DISSOLVE: fade 40 with a 0.5 band — the [20..40] unit
      // thinning spans ~115 px at THIS camera (a low, sky-in-view camera
      // compresses the band to a dozen pixels AT THE HORIZON and it reads
      // as a hard line; the camera looks down enough that the dissolve
      // happens mid-frame over open ground)
      fade: 40,
      fadeBand: 0.5,
    })
    const grassCommand = renderer.command({
      id: 'vfx:grass-field',
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
    // the probe counters (scripts/task128-probe.mjs reads them): the
    // baked blade count (mask-rejected from the 42k ceiling) + the live
    // adaptive count
    const C = (typeof window !== 'undefined' ? (window.__vfxCounters ??= {}) : {})
    C.bladesBaked = field.count
    C.blades = bladeCount

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
      texture: () => env.sparkTexture,
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
          C.blades = bladeCount
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
