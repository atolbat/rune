// billboard.js — THE BILLBOARD MODES: the three orientations side by
// side, each column a stream of ARROW sprites drifting upward — the
// arrowhead makes the orientation readable (our procedural arrow tile).
//
//   vertical   — upright: up = world +Y, turns around Y to face the camera
//   horizontal — flat: a ground decal in the XZ plane
//   stretched  — velocity-aligned: the long axis follows the motion
export default {
  title: 'Billboard Modes',
  sub: 'vertical · horizontal · stretched (velocity-aligned)',
  camera: { yaw: 0, pitch: 0.34, dist: 8.5, orbit: 0.04, target: [0, 0.4, 0] },

  make(env) {
    const COLUMNS = [
      ['vertical', 'vertical', 1],
      ['horizontal', 'horizontal', 1.6],
      ['stretched', 'stretched', 2.2],
    ]
    const SPACING = 3

    const layers = COLUMNS.map(([label, mode, lengthFactor], i) => {
      const x = (i - 1) * SPACING
      env.label(label, x, -1.5, 0)
      return env.addLayer({
        id: `bb-${label}`,
        facade: env.createParticles({
          capacity: 80,
          rate: 3.2,
          ramp: env.createRamp([
            // frame 7 = the ARROW tile (pinned for the whole life — the
            // arrowhead makes the orientation readable)
            { t: 0, size: 0.7, r: 0.8, g: 0.95, b: 1, a: 0, frame: 7 },
            { t: 0.15, size: 1, r: 1, g: 1, b: 1, a: 1, frame: 7 },
            { t: 1, size: 0.6, r: 1, g: 0.65, b: 0.4, a: 0, frame: 7 },
          ]),
          spawner: {
            // born low, drifting up — the stretch axis is the motion
            shape: { kind: 'disc', origin: [x, -1.1, 0], axis: [0, 1, 0], radius: [0, 0.5] },
            velocity: { mode: 'axis' },
            speed: [0.5, 0.75], life: [4, 5], size: [0.85, 1.1],
            color: [[1, 1, 1, 1], [0.7, 0.9, 1, 1]], seed: 191 + i * 13,
          },
          render: {
            kind: 'billboard',
            mode,
            tiles: env.atlasTiles,
            ...(mode === 'stretched' ? { speedFactor: 0.2, lengthFactor } : {}),
          },
        }),
        material: env.materials.sprite,
        pipeline: env.pipelines.alpha,
      })
    })

    return {
      frame(ctx) {
        for (const layer of layers) layer.facade.advance(ctx.dt)
      },
    }
  },
}
