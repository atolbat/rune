// blending.js — three.quarks' CustomBlendingDemo: three clouds of RESTING
// gray particles over a LIT FLOOR, each drawn with a different BLEND
// EQUATION (Task 122): One/One with ADD, MAX and SUBTRACT.
//
// THE TEXTURE (the demo's own, why it exists): their particle_default.png
// is a radial WHITE→BLACK rgb gradient with alpha 255 EVERYWHERE — the
// rgb IS the falloff, exactly what One/One compositing needs (a plain
// glow sprite — const white rgb + an alpha gradient — adds the FULL rgb
// at the transparent edge: hard squares, the "custom blending looks
// broken" report). We bake the same gradient: rgb = radial falloff,
// alpha = 1.
//
// Their numbers: 10 particles per cloud, sizes 1–2, gray 0.5, spawned in
// a SOLID sphere (radius 3 at their scene scale — ours ~1.5), resting
// (startSpeed 0 — the SpeedOverLife 1→0 has nothing to slow), looping
// every ~5 s.
export default {
  title: 'Custom Blending',
  sub: 'one/one × add | max | subtract equations',
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
        // a soft disc (their gradient shape): full to 0.2·R, gaussian out
        const a = r >= 0.5 ? 0 : Math.min(1, Math.exp(-9 * Math.max(0, r - 0.18) * Math.max(0, r - 0.18) / 0.09))
        const i = (y * SPR + x) * 4
        bytes[i] = bytes[i + 1] = bytes[i + 2] = Math.round(255 * a)
        bytes[i + 3] = 255
      }
    }
    sprite.upload(bytes)

    // the lit floor (their 0x222222 ≈ 0.13 — SUBTRACT needs a DARK floor:
    // on our old 0.52-gray the whole subtract quad clamped to pure black;
    // on theirs the sprite core (0.5·gradient) still reads above it)
    env.addMesh({
      id: 'blend-floor',
      geometry: env.geometry.plane({ width: 26, height: 26 }),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.14, 0.145, 0.16, 1] },
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    })

    // the three clouds (their demo: 10 quads, gray 0.5, resting, looping)
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
          capacity: 12,
          rate: 0,
          bursts: [{ time: 0.01, count: 10, cycle: 0, interval: 5.5, probability: 1 }],
          ramp: env.createRamp([
            { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
            { t: 1, size: 1, r: 1, g: 1, b: 1, a: 1 },
          ]),
          spawner: {
            // resting particles in a SOLID sphere — the overlaps are the demo
            shape: { kind: 'sphere', origin: [x, 1.5, 0], radius: [0, 1.5] },
            velocity: { mode: 'fixed', dir: [0, 1, 0] },
            speed: [0, 0], life: [5.3, 5.3], size: [1.1, 1.9],
            color: [[0.5, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 1]], seed: 211 + i * 17,
          },
        }),
        material: env.materials.sprite,
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
