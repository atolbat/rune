// sequencer.js — three.quarks' SequencerDemo ("Texture Sequencer"): 1500
// particles born in a random cloud that FLY INTO a text mask, hold, then
// MORPH into a second shape, forever. Theirs: TextureSequencer.fromImage +
// ApplySequences over a grid emitter. Ours: the IMAGE seek target (the
// cumulated lit-pixel index — Task 122) + the seek spring, retargeted by
// writing fields.tx/ty/tz (the composable-core escape hatch on the facade).
//
// The masks are drawn with canvas 2D (text + a spiral), read back as
// alpha masks — CPU-side only, no GPU upload, no premultiply semantics
// (the Task 118 lesson applies to SAMPLING only, and this never samples).
export default {
  title: 'Texture Sequencer',
  sub: '1500 particles seek image targets · morphs RUNE ⇄ spiral',
  camera: { yaw: 0, pitch: 0.02, dist: 9.5, orbit: 0.0, target: [0, 0.4, 0] },

  make(env) {
    // ── the masks (canvas 2D → one byte per pixel) ──
    const makeMask = (draw) => {
      const w = 256, h = 96
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const g = canvas.getContext('2d', { willReadFrequently: true })
      // NO background fill: the canvas stays TRANSPARENT (alpha 0) and only
      // the drawn strokes carry alpha 255 — the mask's lit-pixel test reads
      // the ALPHA channel (a filled black background would light the whole
      // rect and the target would degenerate to a uniform cloud — the bug
      // this demo shipped with on its first cut).
      draw(g, w, h)
      const img = g.getImageData(0, 0, w, h)
      const data = new Uint8Array(w * h)
      for (let i = 0; i < w * h; i++) data[i] = img.data[i * 4 + 3]
      return { width: w, height: h, data }
    }
    const textMask = makeMask((g, w, h) => {
      g.fillStyle = '#fff'
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.font = '900 74px system-ui, -apple-system, "Segoe UI", sans-serif'
      g.fillText('RUNE', w / 2, h / 2 + 2)
    })
    const spiralMask = makeMask((g, w, h) => {
      g.strokeStyle = '#fff'
      g.lineWidth = 9
      g.lineCap = 'round'
      g.beginPath()
      const cx = w / 2, cy = h / 2
      for (let a = 0; a < Math.PI * 6; a += 0.02) {
        const r = 4 + a * 2.1 // reaches ~44 px — inside the 256×96 canvas
        const x = cx + Math.cos(a) * r
        const y = cy + Math.sin(a) * r * 0.62
        if (a === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
    })

    const COUNT = 1500
    const CYCLE = 11 // s: cloud → text (hold) → spiral (hold) → dissolve

    // The retarget target banks: one fill per mask through a throwaway
    // spawner (the same machinery that filled the newborn targets — the
    // same seed + index → the same pixel, so slot identity holds).
    const buildTargets = (mask) => {
      const targets = new Float32Array(COUNT * 3)
      const rec = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 1, g: 1, b: 1, a: 1, seed: 0, tx: 0, ty: 0, tz: 0 }
      const spawner = env.createSpawner({
        shape: { kind: 'sphere', origin: [0, 0.4, 0], radius: [0, 0] },
        velocity: { mode: 'radial' },
        speed: [0, 0], life: [1, 1], size: [1, 1],
        color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 211,
        target: { mode: 'image', origin: [0, 0.4, 0], axis: [0, 0, 1], width: 8.4, height: 3.15, mask },
      })
      for (let i = 0; i < COUNT; i++) {
        spawner(i, rec)
        targets[i * 3] = rec.tx; targets[i * 3 + 1] = rec.ty; targets[i * 3 + 2] = rec.tz
      }
      return targets
    }
    const textTargets = buildTargets(textMask)
    const spiralTargets = buildTargets(spiralMask)

    const layer = env.addLayer({
      id: 'seq',
      // (a debug handle for the demo-shots gates)
      expose: true,
      facade: env.createParticles({
        capacity: COUNT,
        // the newborns: a loose cloud around the text plane, heading to the
        // TEXT targets (the image target does the seeking)
        rate: 0,
        bursts: [{ time: 0.01, count: COUNT, cycle: 0, interval: CYCLE, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 0.6, r: 0.5, g: 1, b: 1, a: 0 },
          { t: 0.12, size: 1, r: 0.5, g: 1, b: 1, a: 0.9 },
          { t: 0.92, size: 1, r: 1, g: 0.4, b: 1, a: 0.8 },
          { t: 1, size: 0.5, r: 1, g: 0.4, b: 1, a: 0 },
        ]),
        forces: {
          gravity: [0, 0, 0], drag: 0, turbulence: 0,
          // the sequencer pull: strong + near-critically damped — a crisp
          // formation, no overshoot ringing
          seek: { strength: 26, damping: 9.5 },
        },
        spawner: {
          // born in a wide shell (their grid + ApplySequences pulls them in)
          shape: { kind: 'sphere', origin: [0, 0.4, 0], radius: [4.5, 6.5] },
          velocity: { mode: 'radial' },
          speed: [0.3, 1.2], life: [CYCLE * 0.96, CYCLE * 0.99], size: [0.1, 0.19],
          color: [[0.5, 1, 1, 1], [1, 0.45, 1, 0.9]], seed: 211,
          target: { mode: 'image', origin: [0, 0.4, 0], axis: [0, 0, 1], width: 8.4, height: 3.15, mask: textMask },
        },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      // the single GLOW sprite (no tiles → never the 4×4 atlas)
      texture: () => env.glowTexture,
    })

    if (typeof window !== 'undefined') (window.__seqLayer = layer) // the shots gate reads it

    let phase = 0 // 0 = forming text, 1 = spiral
    let switchAt = 6.5
    let announced = false

    const retarget = (targets) => {
      const f = layer.facade.fields
      const n = layer.facade.count
      for (let i = 0; i < n; i++) {
        f.tx[i] = targets[i * 3]
        f.ty[i] = targets[i * 3 + 1]
        f.tz[i] = targets[i * 3 + 2]
      }
    }

    return {
      frame(ctx, rt) {
        // the schedule: form text at ~0, morph to the spiral at 4.4, the
        // cycle dissolves at ~10.5 and re-bursts (the burst schedule)
        switchAt -= ctx.dt
        if (switchAt <= 0 && rt.morphed !== true) {
          if (phase === 0) {
            phase = 1
            retarget(spiralTargets)
            env.log.event('sequencer: morph → spiral')
          }
          rt.morphed = true
        }
        if (!announced && ctx.time > 0.4) {
          announced = true
          env.log.event('sequencer: 1500 particles seeking the RUNE mask')
        }
        // the dissolve-and-reburst: when the cycle ends the burst schedule
        // refires (count drops to 0 first — the life ends just before)
        const count = layer.facade.count
        if (count === 0 && rt.reburst !== true && ctx.time > 1) {
          rt.reburst = true
          phase = 0
          rt.morphed = false
          switchAt = 6.5
          // the fresh burst re-seeks the TEXT (the spawner's target desc)
        }
        if (count > 0 && rt.reburst === true) rt.reburst = false

        layer.facade.advance(ctx.dt)
      },
    }
  },
}
