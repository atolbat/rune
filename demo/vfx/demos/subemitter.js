// subemitter.js — THE SUB EMITTER: a system whose particles SPAWN
// ANOTHER SYSTEM on death — a boiling acid pool whose bubbles POP into
// splashes. The mechanism: the onRetire hook — every bubble's final state
// lands in the splash system at the death site (facade.at + burst), the
// sub-emitter pattern in two facades.
export default {
  title: 'Sub Emitter',
  sub: 'bubbles pop on death → splash bursts (onRetire)',
  camera: { yaw: 0.55, pitch: 0.62, dist: 7.2, orbit: 0.06, target: [0, 0.8, 0] },

  make(env) {
    // the splash spawner desc (the full desc for the retire-hook bursts)
    const SPLASH_S = {
      // the local burst: an up-fan around the pop site (translated
      // there by facade.at in the retire hook)
      shape: { kind: 'cone', origin: [0, 0, 0], axis: [0, 1, 0], halfAngle: 0.75, baseRadius: 0.03, length: [0, 0.01] },
      velocity: { mode: 'lobe' },
      speed: [1.6, 3.6], life: [0.5, 0.9], size: [0.07, 0.16],
      color: [[0.75, 1, 0.55, 1], [0.55, 0.95, 0.35, 0.9]], seed: 141,
    }

    // ── the splash system (the SUB emitter): fast droplets, gravity ──
    const splash = env.addLayer({
      id: 'acid-splash',
      facade: env.createParticles({
        capacity: 1200,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.7, g: 1, b: 0.5, a: 1, frame: 10 },
          { t: 0.5, size: 0.8, r: 0.6, g: 0.95, b: 0.45, a: 0.85, frame: 10 },
          { t: 1, size: 0.3, r: 0.5, g: 0.9, b: 0.4, a: 0, frame: 10 },
        ]),
        forces: { gravity: [0, -11, 0], drag: 0.1, turbulence: 0.3 },
        spawner: SPLASH_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.alpha,
    })

    // ── the bubbles (the MAIN system): rise, grow, POP at a random height;
    //    onRetire fires the splash at the pop site ──
    const bubbles = env.addLayer({
      id: 'acid-bubbles',
      facade: env.createParticles({
        capacity: 300,
        rate: 16,
        ramp: env.createRamp([
          { t: 0, size: 0.35, r: 0.7, g: 1, b: 0.55, a: 0 },
          { t: 0.15, size: 1, r: 0.75, g: 1, b: 0.6, a: 0.9, frame: 9 },
          { t: 1, size: 1.5, r: 0.8, g: 1, b: 0.65, a: 0.7, frame: 9 },
        ]),
        forces: { gravity: [0, 1.1, 0], drag: 0.3, turbulence: 0.35 },
        spawner: {
          // the pool surface: a disc of rising bubbles
          shape: { kind: 'disc', origin: [0, 0, 0], axis: [0, 1, 0], radius: [0.15, 2.4] },
          velocity: { mode: 'axis' },
          speed: [0.7, 1.4], life: [1.1, 2.3], size: [0.12, 0.3],
          color: [[0.7, 1, 0.55, 0.9], [0.85, 1, 0.7, 0.75]], seed: 149,
        },
        render: { kind: 'billboard', draw: 'instance', tiles: env.atlasTiles },
        // THE SUB-EMITTER: every retired bubble bursts the splash system at
        // its death position (the record is REUSED — read it synchronously)
        onRetire: (record) => {
          splash.facade.at(record.x, record.y, record.z).burst(9 + ((record.seed * 7) | 0) % 5, { ...SPLASH_S, seed: 7000 + ((record.seed * 4096) | 0) })
        },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
    })

    // ── the pool surface (a flat additive disc + the rim ring) ──
    const pool = env.addLayer({
      id: 'acid-pool',
      facade: env.createParticles({
        capacity: 8,
        rate: 0,
        bursts: [{ time: 0.01, count: 1, cycle: 1, interval: 1, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.35, g: 0.9, b: 0.4, a: 0.55, frame: 5 },
          { t: 1, size: 1, r: 0.35, g: 0.9, b: 0.4, a: 0.55, frame: 5 },
        ]),
        spawner: {
          shape: { kind: 'point', origin: [0, 0, 0] },
          velocity: { mode: 'fixed', dir: [0, 1, 0] },
          speed: [0, 0], life: [1000, 1000], size: [5.6, 5.6],
          color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 5,
        },
        render: { kind: 'billboard', draw: 'instance', mode: 'oriented', axis: [0, 0, 1], tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
    })

    return {
      frame(ctx) {
        bubbles.facade.advance(ctx.dt)
        splash.facade.advance(ctx.dt)
        pool.facade.advance(ctx.dt)
        // the pop-rate log (~every 4 s)
        if (ctx.time > 4 && ctx.time % 4 < ctx.dt) {
          env.log.event(`acid: ${bubbles.facade.stats().retired} bubbles popped → ${splash.facade.stats().spawned} droplets`)
        }
      },
    }
  },
}
