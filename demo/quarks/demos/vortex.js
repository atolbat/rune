// vortex.js — a RUNE ORIGINAL: an accretion vortex — the environment-FX
// composition showcase (every existing emitter family in one effect):
//
//   · the DISC's spiral arms + twist — five trailing arms born in the
//     annulus (the galaxy-maker kit);
//   · tangential velocity + speedByRadius (Keplerian: power 0.7 — the
//     inner rim VISIBLY outruns the outer) + a point ATTRACTOR with
//     killRadius (Task 126) — THE FUNNEL: the matter spirals inward,
//     SINKS below the disc (a light gravity), and is CONSUMED at the core
//     (it vanishes INSIDE the pulsing glow — never flies through);
//   · the core: a pulsing additive glow ON the attractor point, fed by
//     everything the sink swallows;
//   · periodic shockwave rings (HORIZONTAL billboards at the funnel's
//     mouth, expanding + fading);
//   · sparks raining from above, bent into the funnel and CONSUMED at
//     the core; ground dust dragged around the base.
//
// The palette: deep blue rim → cyan → white-hot core (the colorByRadius
// mix, color[0] at the rim).
export default {
  title: 'Vortex',
  sub: 'rune original · spiral arms · Keplerian shear · the funnel SINK · shock rings',
  camera: { yaw: 0.7, pitch: 0.42, dist: 10.5, orbit: 0.05, target: [0, 1.5, 0] },

  make(env) {
    const CORE_Y = 1.5 // the funnel's sink (the attractor + the core glow)

    // ── the scene: a dark plane ──
    env.addMesh({
      id: 'vx-floor',
      geometry: env.geometry.plane({ width: 60, height: 60 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      uniforms: { u_albedo: [0.05, 0.055, 0.075, 1] },
    })

    // the shared drain: a REAL funnel — the attractor's pull (~50/(r(r²+s²)))
    // is tuned against the tangential speeds so the orbits are mildly
    // sub-circular: matter FALLS IN, it does not orbit forever — and
    // killRadius CONSUMES it inside the core glow (the sink: nothing
    // flies through the attractor anymore).
    const DRAIN = { attract: { point: [0, CORE_Y, 0], strength: 50, softening: 1.6, killRadius: 0.55 } }

    // ── the accretion disc: the spiral arms, orbiting, shearing, draining ──
    // The disc plane sits 0.55 ABOVE the sink; a light gravity sinks the
    // matter as it spirals in — the arms POUR into the core, exactly the
    // funnel silhouette. The drain is the SPEED CURVE (their SpeedOverLife):
    // the orbital speed decays 1 → 0.3 over the life — a decaying orbit
    // MUST spiral in (the viscosity story of a real accretion disc).
    // The Keplerian power 0.7 keeps the shear: the inner rim visibly
    // outruns the outer, winding the arms tighter as they fall.
    const DISC_S = {
      shape: {
        kind: 'disc', origin: [0, CORE_Y + 0.55, 0], axis: [0, 1, 0], radius: [1.3, 5.0],
        arms: 5, armSpread: 0.42, twist: -3.2,
      },
      velocity: { mode: 'tangential' },
      speedByRadius: { ref: 3.0, power: 0.7 },
      speed: [1.9, 2.2], life: [3.2, 4.6], size: [0.07, 0.16],
      colorByRadius: true,
      color: [[0.16, 0.3, 0.85, 0.85], [0.85, 0.97, 1, 1]], seed: 97,
    }
    const disc = env.addLayer({
      id: 'vx-disc',
      facade: env.createParticles({
        capacity: 1300, rate: 240, prewarm: 4,
        ramp: env.createRamp([
          { t: 0, size: 0.7, r: 1, g: 1, b: 1, a: 0 },
          { t: 0.15, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.75, size: 0.8, r: 1, g: 1, b: 1, a: 0.8 },
          { t: 1, size: 0.15, r: 1, g: 1, b: 1, a: 0 },
        ]),
        forces: { ...DRAIN, gravity: [0, -0.5, 0], drag: 0.05, speedCurve: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.5, size: 0.7, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.3, r: 1, g: 1, b: 1, a: 1 },
        ]) },
        spawner: DISC_S,
        render: { kind: 'billboard', mode: 'camera' },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      // the single-glow sprite: WITHOUT tiles the 4×4 atlas would print a
      // grid of glows into every particle (the "confetti squares" bug)
      texture: () => env.glowTexture,
    })

    // ── the core: a pulsing glow ON the sink (two heartbeats per cycle) ──
    const CORE_S = {
      shape: { kind: 'point', origin: [0, CORE_Y, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [1.4, 1.4], size: [1.1, 1.1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 13,
    }
    const core = env.addLayer({
      id: 'vx-core',
      facade: env.createParticles({
        capacity: 3,
        bursts: [{ time: 0.05, count: 1, cycle: 0, interval: 1.4, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 0.7, r: 1, g: 1, b: 1, a: 0.25 },
          { t: 0.25, size: 1.15, r: 0.9, g: 0.97, b: 1, a: 0.95 },
          { t: 0.5, size: 0.85, r: 0.75, g: 0.92, b: 1, a: 0.5 },
          { t: 0.75, size: 1.25, r: 0.9, g: 0.98, b: 1, a: 1 },
          { t: 1, size: 0.6, r: 1, g: 1, b: 1, a: 0.15 },
        ]),
        spawner: CORE_S,
        render: { kind: 'billboard', mode: 'camera' },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the shock rings: flat at the funnel's mouth, expanding, on a schedule ──
    const RING_S = {
      shape: { kind: 'point', origin: [0, CORE_Y, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0.4, 0.7], life: [0.8, 1.0], size: [0.5, 0.7],
      color: [[0.7, 0.9, 1, 1], [0.5, 0.8, 1, 1]], seed: 19,
    }
    const rings = env.addLayer({
      id: 'vx-rings',
      facade: env.createParticles({
        capacity: 4,
        bursts: [{ time: 0.4, count: 1, cycle: 0, interval: 2.3, probability: 1 }],
        ramp: env.createRamp([
          { t: 0, size: 0.5, r: 0.9, g: 1, b: 1, a: 0.85, frame: 5 },
          { t: 0.6, size: 4.5, r: 0.6, g: 0.85, b: 1, a: 0.35, frame: 5 },
          { t: 1, size: 7.5, r: 0.4, g: 0.7, b: 1, a: 0, frame: 5 },
        ]),
        spawner: RING_S,
        render: { kind: 'billboard', mode: 'horizontal', tiles: [4, 4] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })

    // ── the infalling sparks: rain from above, bent into the funnel,
    //    CONSUMED at the core (they vanish INTO the glow, not through it) ──
    const FALL_S = {
      shape: { kind: 'sphere', origin: [0, 5.6, 0], radius: [1.6, 2.6] },
      velocity: { mode: 'radial' },
      speed: [0.4, 1.4], life: [2.4, 3.4], size: [0.05, 0.11],
      color: [[0.9, 0.95, 1, 1], [0.6, 0.8, 1, 0.9]], seed: 23,
    }
    const fall = env.addLayer({
      id: 'vx-fall',
      facade: env.createParticles({
        capacity: 220, rate: 26,
        ramp: env.createRamp([
          { t: 0, size: 0.5, r: 1, g: 1, b: 1, a: 0 },
          { t: 0.12, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.6, r: 1, g: 1, b: 1, a: 0 },
        ]),
        forces: { ...DRAIN, gravity: [0, -2.2, 0] },
        spawner: FALL_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.14 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.cfxrTextures.trait,
    })

    // ── the ground dust: dragged around the base, flat puffs ──
    const DUST_S = {
      shape: {
        kind: 'disc', origin: [0, 0.1, 0], axis: [0, 1, 0], radius: [4.6, 6.2],
        arms: 3, armSpread: 0.5, twist: -1.8,
      },
      velocity: { mode: 'tangential' },
      speed: [1.0, 1.6], life: [2.8, 4.0], size: [0.5, 0.9],
      color: [[0.2, 0.26, 0.4, 0.35], [0.3, 0.4, 0.55, 0.25]], seed: 29,
    }
    const dust = env.addLayer({
      id: 'vx-dust',
      facade: env.createParticles({
        capacity: 320, rate: 40, prewarm: 4,
        ramp: env.createRamp([
          { t: 0, size: 0.4, r: 0.6, g: 0.68, b: 0.85, a: 0 },
          { t: 0.25, size: 1, r: 0.55, g: 0.65, b: 0.85, a: 0.35 },
          { t: 1, size: 1.9, r: 0.45, g: 0.6, b: 0.9, a: 0 },
        ]),
        forces: { ...DRAIN, drag: 0.2, speedCurve: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.25, r: 1, g: 1, b: 1, a: 1 },
        ]) },
        spawner: DUST_S,
        render: { kind: 'billboard', mode: 'horizontal', tiles: [2, 2], frameJitter: 4, spin: 0.4 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.cfxrTextures.smoke,
    })

    const layers = [dust, rings, disc, fall, core]
    return {
      frame(ctx) {
        for (const l of layers) l.facade.advance(ctx.dt)
      },
    }
  },
}
