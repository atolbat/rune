// shapes.js — THE EMITTER SHAPE ATLAS: every spawn shape, side by side,
// each a live point cloud (tiny additive billboards spawned IN the shape,
// drifting slowly outward — the DISTRIBUTION is the demo). The labels are
// world-anchored DOM chips projected per frame.
export default {
  title: 'Emitter Shapes',
  sub: 'point · sphere · hemisphere · cone · circle · donut · rect · grid · line',
  camera: { yaw: 0.35, pitch: 0.42, dist: 11, orbit: 0.05, target: [0, 0.4, 0] },

  make(env) {
    // (label, shape, velocity mode) — the lineup, plus the line
    const CELLS = [
      ['point', { kind: 'point', origin: [0, 0, 0] }, 'radial'],
      ['sphere', { kind: 'sphere', origin: [0, 0, 0], radius: [0.2, 0.9] }, 'radial'],
      ['hemisphere', { kind: 'hemisphere', origin: [0, 0, 0], axis: [0, 1, 0], radius: [0.15, 0.9] }, 'radial'],
      ['cone', { kind: 'cone', origin: [0, -0.4, 0], axis: [0, 1, 0], halfAngle: 0.42, baseRadius: 0.5, length: [0, 0.1] }, 'lobe'],
      ['circle (disc)', { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [0.85, 1] }, 'radial'],
      ['donut', { kind: 'donut', origin: [0, 0, 0], axis: [0, 1, 0], radius: 0.75, tube: [0.05, 0.28] }, 'tangential'],
      ['rectangle', { kind: 'rectangle', origin: [0, 0, 0], axis: [0, 1, 0], width: 1.9, height: 1.2 }, 'radial'],
      ['grid', { kind: 'grid', origin: [0, 0, 0], axis: [0, 1, 0], width: 1.9, height: 1.9, rows: 9, columns: 9, mode: 'lattice' }, 'radial'],
      ['line', { kind: 'line', from: [-0.95, -0.5, 0], to: [0.95, 0.5, 0] }, 'radial'],
    ]

    /** Moves a shape desc into its grid cell (origin OR the line's ends). */
    const place = (shape, x, y) => {
      if (shape.kind === 'line') {
        return {
          ...shape,
          from: [shape.from[0] + x, shape.from[1] + y, shape.from[2]],
          to: [shape.to[0] + x, shape.to[1] + y, shape.to[2]],
        }
      }
      return { ...shape, origin: [shape.origin[0] + x, shape.origin[1] + y, shape.origin[2]] }
    }

    // the 3×3 grid of mini-systems
    const COLUMNS = 3
    const SPACING = 3.2
    const ROW = 2.4
    const systems = []
    CELLS.forEach((cell, i) => {
      const [label, shape, mode] = cell
      const col = i % COLUMNS
      const row = Math.floor(i / COLUMNS)
      const x = (col - 1) * SPACING
      const y = 1.8 - row * ROW
      // the label sits UNDER its cloud (a label under each shape)
      env.label(label, x, y - 1.35, 0)
      systems.push(env.addLayer({
        id: `shape-${label}`,
        facade: env.createParticles({
          capacity: 1200,
          // the density: 1000/s with a ~1 s life — a solid glowing cloud
          // per shape (the spawn stream fix makes every particle unique —
          // the cloud actually FILLS the shape instead of a thin jet)
          rate: 700,
          ramp: env.createRamp([
            { t: 0, size: 0.5, r: 1, g: 0.91, b: 0.51, a: 0 },
            { t: 0.15, size: 1, r: 1, g: 0.91, b: 0.51, a: 0.9 },
            { t: 1, size: 0.3, r: 1, g: 0.44, b: 0.16, a: 0 },
          ]),
          spawner: {
            shape: place(shape, x, y),
            velocity: { mode },
            speed: mode === 'lobe' ? [0.4, 0.7] : [0.25, 0.5],
            life: [0.9, 1.4], size: [0.05, 0.09],
            color: [[1, 0.91, 0.51, 1], [1, 0.44, 0.16, 1]], seed: 90 + i * 7,
          },
        }),
        material: env.materials.sprite,
        pipeline: env.pipelines.additive,
      }))
    })

    return {
      frame(ctx) {
        for (const s of systems) s.facade.advance(ctx.dt)
      },
    }
  },
}
