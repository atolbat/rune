// plugin.js — three.quarks' CustomPluginDemo ("Customized Plugin"): their
// SinWave behavior — 2500 particles on a grid whose z is a traveling sine
// field: z = sin(t·freq + (x+y)/wavelength)·height. Their plugin API
// (loadPlugin + a custom behavior class); OURS is the composable-core
// escape hatch: the facade's public FIELDS — write them between advance()
// calls and any behavior you can express as a function of (position, age,
// time) is yours, no plugin system needed. This demo IS that story.
export default {
  title: 'Custom Behavior (SinWave)',
  sub: 'the composable core: fields written per frame',
  camera: { yaw: 0, pitch: 0.18, dist: 11, orbit: 0, target: [0, 0, 0] },

  make(env) {
    const COUNT = 2500
    const COLS = 50
    const ROWS = 50
    const WIDTH = 15
    const FREQ = 2.1
    const HEIGHT = 1.15
    const WAVE = 5

    const wave = env.addLayer({
      id: 'sinwave',
      facade: env.createParticles({
        capacity: COUNT,
        rate: 0,
        bursts: [{ time: 0.01, count: COUNT, cycle: 1, interval: 1, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 1, r: 1, g: 1, b: 1, a: 1 },
        ]),
        spawner: {
          // the LATTICE grid: one burst of rows×columns fills it exactly —
          // index → cell, deterministic (their GridEmitter + a lifetime of
          // 10 s)
          shape: { kind: 'grid', origin: [0, 0, 0], axis: [0, 1, 0], width: WIDTH, height: WIDTH, rows: ROWS, columns: COLS, mode: 'lattice' },
          velocity: { mode: 'fixed', dir: [0, 1, 0] },
          speed: [0, 0], life: [1000, 1000], size: [0.16, 0.16],
          color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 181,
        },
        render: { kind: 'billboard', mode: 'oriented', axis: [1, 0, 0], spin: 0 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    let t = 0
    return {
      frame(ctx) {
        // ── THE CUSTOM BEHAVIOR: write the fields (their SinWave.update) ──
        // z = sin(t·freq + (x+y)/wave)·height − height/2
        // plus a color modulation by the wave phase (an extra flourish:
        // the tint follows the same field — the CPU-side equivalent of a
        // vertex shader write)
        t += ctx.dt
        const f = wave.facade.fields
        const n = wave.facade.count
        const height = HEIGHT
        for (let i = 0; i < n; i++) {
          const x = f.px[i], y = f.py[i]
          const phase = t * FREQ + (x + y) * (1 / WAVE)
          const z = Math.sin(phase) * height - height / 2
          f.pz[i] = z
          // the crest brightness: sin ∈ [-1, 1] → [0.55, 1.0] × cool→warm
          const crest = (Math.sin(phase) + 1) * 0.5
          f.cr[i] = 0.55 + 0.45 * crest
          f.cg[i] = 0.7 + 0.2 * crest
          f.cb[i] = 1 - 0.4 * crest
          f.ca[i] = 0.85
        }
        // advance ages nothing visibly (life 1000 s) but keeps the store
        // honest — the composition contract: your writes, its clock
        wave.facade.advance(ctx.dt)
      },
    }
  },
}
