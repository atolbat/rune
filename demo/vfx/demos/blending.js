// blending.js — the BLEND EQUATION study: three clouds of RESTING
// particles over a dark LIT FLOOR, each drawn with a different One/One
// equation — ADD, MAX and SUBTRACT.
//
// THE SPRITE: rgb = the radial falloff, alpha = 1 — exactly what One/One
// compositing needs (a plain glow sprite — const white rgb + an alpha
// gradient — adds the FULL rgb at the transparent edge: hard squares).
//
// THE DIRECTIONS (measured on real hardware, both backends —
// scripts/blend-probe.mjs): 'add' stacks, 'max' plateaus, and the
// SUBTRACT cloud here uses dst − src ('reverse-subtract') — the sprite
// SUBTRACTS ITS LIGHT from the scene: the core bites a dark hole in the
// floor, the faded edge leaves it untouched. (The raw 'subtract' —
// src − dst — reads as a bright core with hard black edges: faithful to
// the equation, visually just confusing.)
//
// THE MOTION: a slow continuous drift inside each sphere — the overlap
// field keeps morphing (no re-burst, no vanish, no reshuffle: the clouds
// are continuously replenished, one particle at a time, with fade-in/out
// ramps — a standing interference pattern, not a blinking reset).
export default {
  title: 'Custom Blending',
  sub: 'one/one × add | max | subtract (dst − src) · continuous drift',
  camera: { yaw: 0.35, pitch: 0.45, dist: 9, orbit: 0.05, target: [0, 1.4, 0] },

  make(env) {
    // ── the blending sprite: rgb = the radial falloff, alpha = 1 ────────
    const SPR = 64
    const sprite = env.renderer.texture(SPR, SPR)
    const bytes = new Uint8Array(SPR * SPR * 4)
    for (let y = 0; y < SPR; y++) {
      for (let x = 0; x < SPR; x++) {
        const u = (x + 0.5) / SPR - 0.5, v = (y + 0.5) / SPR - 0.5
        const r = Math.hypot(u, v)
        // a soft disc: full to 0.2·R, gaussian out to zero AT the edge
        const a = r >= 0.5 ? 0 : Math.min(1, Math.exp(-9 * Math.max(0, r - 0.18) * Math.max(0, r - 0.18) / 0.09))
        const i = (y * SPR + x) * 4
        bytes[i] = bytes[i + 1] = bytes[i + 2] = Math.round(255 * a)
        bytes[i + 3] = 255
      }
    }
    sprite.upload(bytes)

    // the lit floor (dark: SUBTRACT needs it — on a light floor the bite
    // clamps and disappears)
    env.addMesh({
      id: 'blend-floor',
      geometry: env.geometry.plane({ width: 26, height: 26 }),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.14, 0.145, 0.16, 1] },
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })

    // the three clouds (the equations are the point — the geometry shares)
    const SPEC = [
      ['add', 'oneAdd'],
      ['max', 'oneMax'],
      ['subtract', 'oneSubtract'],
    ]
    const SPACING = 3.4
    const clouds = SPEC.map(([label, pipeline], i) => {
      const x = (i - 1) * SPACING
      env.label(label, x, 0.15, 0)
      return env.addLayer({
        id: `blend-${label}`,
        facade: env.createParticles({
          capacity: 34,
          render: { kind: 'billboard', draw: 'instance' },
          prewarm: 10,
          // a slow trickle: every ~0.35 s a new sprite fades in as an old
          // one fades out — the cloud NEVER empties, NEVER re-arranges at
          // once (the overlap field evolves continuously). NOTE: One/One
          // factors IGNORE the alpha channel — the fade rides the ramp's
          // RGB (the vertex color multiplies the texel rgb).
          rate: 2.6,
          ramp: env.createRamp([
            { t: 0, size: 0.9, r: 0, g: 0, b: 0, a: 1 },
            { t: 0.12, size: 1, r: 1, g: 1, b: 1, a: 1 },
            { t: 0.88, size: 1, r: 1, g: 1, b: 1, a: 1 },
            { t: 1, size: 1.06, r: 0, g: 0, b: 0, a: 1 },
          ]),
          spawner: {
            // resting particles in a SOLID sphere — the overlaps are the demo
            shape: { kind: 'sphere', origin: [x, 1.5, 0], radius: [0, 1.5] },
            velocity: { mode: 'fixed', dir: [0, 1, 0] },
            speed: [0, 0], life: [9, 11.5], size: [1.1, 1.9],
            color: [[0.5, 0.5, 0.5, 1], [0.55, 0.55, 0.55, 1]], seed: 211 + i * 17,
          },
        }),
        material: env.materials.bbSprite,
        pipeline: env.pipelines[pipeline],
        texture: () => sprite,
      })
    })

    return {
      frame(ctx) {
        for (const cloud of clouds) cloud.facade.advance(ctx.dt)
      },

      dispose() {
        sprite.dispose()
      },
    }
  },
}
