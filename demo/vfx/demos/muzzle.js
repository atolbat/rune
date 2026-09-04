// muzzle.js — THE SENTRY TURRET (the muzzle-flash kit, demonstrated
// differently — Task 128's redesign): a sentry gun that ACQUIRES targets
// around it, YAWS to face each one and fires a 4-round burst. The same
// feature set as the old firing range — the frame-animated sheet
// (flash 0→1→2, beam 3, smoke 4→7), the stretched sparks, the smoke —
// but now on a ROTATING emitter (facade.at() + facade.orient() with a
// LIVE matrix: every system rides the turret's frame wherever it aims),
// plus the interactions the range never showed:
//
//   · TRACERS — a fast streak particle per round, its LIFE sized to the
//     exact muzzle→target distance: it dies AT the target, and onRetire
//     bursts the IMPACT package there (flash card + REFLECTION sparks +
//     a shock ring + a smoke puff — the sub-emitter chain);
//   · BEAM VOLLEYS (Task 129 — the live request): every third burst is
//     three fat energy BOLTS aimed at offset points ON the target's
//     sphere — and every impact (bolt OR tracer) sprays its sparks off
//     the REFLECTION of the arrival direction off the surface normal:
//     grazing hits scatter WIDE to the side, head-on hits bounce tight
//     back at the shooter — the curvature under which the target was
//     hit decides where the sparks fly;
//   · SHELL CASINGS — a chip ejected sideways on every round, gravity,
//     BOUNCING off the floor (the collision planes) and spinning out;
//   · RECOIL — the head meshes kick back along the barrel and recover
//     (a manual model matrix composed per frame).
//
// The turret: a static base + a yawing head (cube) + a barrel, all
// LAMBERT. The targets: six dim glow markers; the ACTIVE one carries a
// lock ring. The camera orbits slowly, watching the sweeps.
export default {
  title: 'Sentry Turret',
  sub: 'rotating emitter · tracers + BEAM volleys · reflection sparks · bouncing shells',
  camera: { yaw: 0.9, pitch: 0.3, dist: 16, orbit: 0.04, target: [0, 1.3, 0] },

  make(env) {
    // ── the scene: the floor + the turret meshes ──
    env.addMesh({
      id: 'sn-floor',
      geometry: env.geometry.plane({ width: 80, height: 80 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      uniforms: { u_albedo: [0.09, 0.1, 0.12, 1] },
    })
    // the base: a static block, y ∈ [0, 1.1]
    env.addMesh({
      id: 'sn-base',
      geometry: env.geometry.cube(0.5),
      material: env.materials.lambert,
      model: new Float32Array([1.2, 0, 0, 0, 0, 1.1, 0, 0, 0, 0, 1.2, 0, 0, 0.55, 0, 1]),
      uniforms: { u_albedo: [0.16, 0.18, 0.22, 1] },
    })

    // the manual head + barrel: recorded per frame with the composed F
    const head = env.addMesh({
      id: 'sn-head',
      geometry: env.geometry.cube(0.5),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.24, 0.3, 0.36, 1] },
      manual: true,
    })
    const barrel = env.addMesh({
      id: 'sn-barrel',
      geometry: env.geometry.cube(0.5),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.12, 0.13, 0.16, 1] },
      manual: true,
    })

    // column-major 4×4 multiply (a·b → out); the demo composes the turret
    // frame F = T(0, 1.35, 0) · Ry(−yaw) · T(−recoil, 0, 0) and the mesh
    // locals once
    const mul = (a, b, out) => {
      for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3]
        out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
      }
      return out
    }
    // the head local: S(0.8, 0.55, 0.62) at the frame origin (y 1.075..1.625)
    const HEAD_L = new Float32Array([0.8, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0.62, 0, 0, 0, 0, 1])
    // the barrel local: T(1.2, 0, 0) · S(1.4, 0.2, 0.2) — spans x 0.5..1.9
    const BARREL_L = new Float32Array([1.4, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0.2, 0, 1.2, 0, 0, 1])
    const F = new Float32Array(16)
    const headModel = new Float32Array(16)
    const barrelModel = new Float32Array(16)

    // ── the targets: six markers around the sentry ──
    const TARGETS = [
      [8.5, 0.7, 3.4], [-7.2, 1.7, 6.0], [-9.2, 0.5, -3.8],
      [3.2, 2.6, -8.6], [9.6, 1.1, -2.6], [0.6, 0.7, 10.6],
    ]
    const MARKER_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [1e9, 1e9], size: [0.34, 0.34],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 9,
    }
    const markers = env.addLayer({
      id: 'sn-markers',
      facade: env.createParticles({
        capacity: 8,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.45, g: 0.6, b: 0.9, a: 0.5, frame: 0 },
          { t: 1, size: 1, r: 0.45, g: 0.6, b: 0.9, a: 0.5, frame: 0 },
        ]),
        spawner: MARKER_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })
    for (const [tx, ty, tz] of TARGETS) {
      markers.facade.at(tx, ty, tz)
      markers.facade.burst(1, { ...MARKER_S, seed: Math.round(tx * 31 + tz * 7) })
    }
    // the ACTIVE target's lock ring: a camera-facing ring, re-burst on
    // every switch (the acquire beat)
    const LOCK_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.9, 0.9], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 11,
    }
    const lock = env.addLayer({
      id: 'sn-lock',
      facade: env.createParticles({
        capacity: 4,
        ramp: env.createRamp([
          { t: 0, size: 0.55, r: 1, g: 0.6, b: 0.35, a: 0.9, frame: 5 },
          { t: 1, size: 1, r: 1, g: 0.75, b: 0.45, a: 0, frame: 5 },
        ]),
        spawner: LOCK_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })

    // ── the muzzle systems (all in the TURRET's local frame: orient(F)
    //    rotates them with the head; the barrel is local +X) ──
    const TILES = env.muzzleTiles
    const SMOKE_S = {
      shape: { kind: 'cone', origin: [1.95, 0, 0], axis: [1, 0.22, 0], halfAngle: 0.3, baseRadius: 0.25, length: [0, 0.35] },
      velocity: { mode: 'lobe' },
      speed: [1.6, 4.2], life: [0.5, 0.85], size: [0.7, 1.3],
      color: [[0.63, 0.63, 0.63, 0.32], [1, 1, 1, 0.5]], seed: 53,
    }
    const smoke = env.addLayer({
      id: 'sn-smoke',
      facade: env.createParticles({
        capacity: 96,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1, frame: 4 },
          { t: 1, size: 1.3, r: 1, g: 1, b: 1, a: 0, frame: 7 },
        ]),
        spin: 1.1,
        spawner: SMOKE_S,
        render: { kind: 'billboard', draw: 'instance', tiles: TILES },
      }),
      // the dithered translucent material — the smoke's low-alpha tail
      // stays smooth (no 8-bit staircase)
      material: env.materials.bbHaze,
      pipeline: env.pipelines.alpha,
      texture: () => env.muzzleSheet,
    })

    // the flash cards: the full FrameOverLife walk 0→1→2 (the tight star,
    // the crossed fins, the soft blob — one card each per round, the
    // seed phases their spin)
    const FLASH_S = {
      shape: { kind: 'point', origin: [1.9, 0, 0] },
      velocity: { mode: 'fixed', dir: [1, 0, 0] },
      speed: [0, 0], life: [0.1, 0.16], size: [1.5, 2.3],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 45,
    }
    const flash = env.addLayer({
      id: 'sn-flash',
      facade: env.createParticles({
        capacity: 32,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.95, b: 0.85, a: 1, frame: 0 },
          { t: 0.45, size: 1.05, r: 1, g: 0.7, b: 0.4, a: 1, frame: 1 },
          { t: 1, size: 0.9, r: 1, g: 0.5, b: 0.25, a: 0, frame: 2 },
        ]),
        spawner: FLASH_S,
        render: { kind: 'billboard', draw: 'instance', tiles: TILES },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.muzzleSheet,
    })

    // the beam: a stretched quad whose velocity points ALONG the barrel —
    // orient(F) rotates the velocity, the stretch aligns the card: a
    // barrel-exit streak without any oriented-mode machinery
    const BEAM_S = {
      shape: { kind: 'point', origin: [2.0, 0.02, 0] },
      velocity: { mode: 'fixed', dir: [1, 0.04, 0] },
      speed: [2.2, 2.2], life: [0.1, 0.14], size: [0.9, 1.1],
      color: [[1, 0.72, 0.3, 1], [1, 0.72, 0.3, 1]], seed: 41,
    }
    const beam = env.addLayer({
      id: 'sn-beam',
      facade: env.createParticles({
        capacity: 24,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.72, b: 0.3, a: 1, frame: 3 },
          { t: 1, size: 0.1, r: 1, g: 0.85, b: 0.45, a: 0, frame: 3 },
        ]),
        spawner: BEAM_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.85, lengthFactor: 0.25 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.muzzleSheet,
    })

    // the sparks: the cone along the barrel, stretched streaks
    const SPARKS_S = {
      shape: { kind: 'cone', origin: [1.9, 0, 0], axis: [1, 0.12, 0], halfAngle: 0.26, baseRadius: 0.16, length: [0, 0.25] },
      velocity: { mode: 'lobe' },
      speed: [8, 20], life: [0.15, 0.35], size: [0.09, 0.2],
      color: [[1, 0.91, 0.51, 1], [1, 0.44, 0.16, 1]], seed: 47,
    }
    const sparks = env.addLayer({
      id: 'sn-sparks',
      facade: env.createParticles({
        capacity: 256,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0, r: 1, g: 1, b: 1, a: 1 },
        ]),
        forces: { gravity: [0, -9, 0], drag: 0.5 },
        spawner: SPARKS_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.22 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // the shell casings: a chip per round, ejected to local +Z + up,
    // gravity, FLOOR BOUNCE (the collision plane), spinning out — the
    // physics-readable residue of the burst
    const SHELL_S = {
      shape: { kind: 'point', origin: [0.85, 0.15, 0.3] },
      velocity: { mode: 'fixed', dir: [0.1, 1.15, 0.85] },
      speed: [2.4, 3.1], life: [2.1, 2.7], size: [0.05, 0.06],
      color: [[1, 0.85, 0.55, 1], [1, 0.8, 0.5, 1]], seed: 49,
    }
    const shells = env.addLayer({
      id: 'sn-shells',
      facade: env.createParticles({
        capacity: 48,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.9, b: 0.6, a: 1 },
          { t: 0.85, size: 1, r: 1, g: 0.85, b: 0.5, a: 1 },
          { t: 1, size: 1, r: 1, g: 0.85, b: 0.5, a: 0 },
        ]),
        forces: {
          gravity: [0, -22, 0], drag: 0.02,
          collide: { planes: [{ normal: [0, 1, 0], point: [0, 0, 0], restitution: 0.38, friction: 0.22 }] },
        },
        spawner: SHELL_S,
        render: { kind: 'billboard', draw: 'instance', spin: 9, tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.atlasTexture,
    })

    // ── the tracer: a world-space layer (NO orient — the burst passes the
    //    exact muzzle→target direction), life sized to the distance: the
    //    streak dies AT the target and onRetire queues the impact (with
    //    the arrival direction — the reflection math reads it back) ──
    const TRACER_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [1, 0, 0] },
      speed: [55, 55], life: [0.2, 0.2], size: [0.16, 0.16],
      color: [[1, 0.9, 0.6, 1], [1, 0.9, 0.6, 1]], seed: 51,
    }
    const impacts = [] // the TRACER impacts queued: x, y, z, vx, vy, vz (the record is reused)
    const boltImpacts = [] // the BOLT impacts: the same 6 scalars, tagged by queue
    const tracer = env.addLayer({
      id: 'sn-tracer',
      facade: env.createParticles({
        capacity: 16,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 0.85, a: 1 },
          { t: 0.92, size: 1, r: 1, g: 0.95, b: 0.7, a: 0.9 },
          { t: 1, size: 1, r: 1, g: 0.95, b: 0.7, a: 0 },
        ]),
        onRetire: (rec) => { impacts.push(rec.x, rec.y, rec.z, rec.vx, rec.vy, rec.vz) },
        spawner: TRACER_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.028, lengthFactor: 0.4 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the BEAM BOLT (Task 129 — the live request): a fat energy round
    //    per volley shot. Same die-at-the-target trick as the tracer (the
    //    life is the exact distance/speed), but slower, thicker and
    //    aimed at an OFFSET point of the target's sphere — the arrival
    //    angle varies, and the impact sparks REFLECT off that curvature ──
    const BOLT_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [1, 0, 0] },
      speed: [26, 26], life: [0.5, 0.5], size: [0.52, 0.62],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 57,
    }
    const bolt = env.addLayer({
      id: 'sn-bolt',
      facade: env.createParticles({
        capacity: 8,
        ramp: env.createRamp([
          { t: 0, size: 0.5, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.8, size: 1, r: 0.72, g: 0.92, b: 1, a: 0.95 },
          { t: 1, size: 0.85, r: 0.45, g: 0.7, b: 1, a: 0 },
        ]),
        onRetire: (rec) => { boltImpacts.push(rec.x, rec.y, rec.z, rec.vx, rec.vy, rec.vz) },
        spawner: BOLT_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.1, lengthFactor: 1.15 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the reflection sparks: the impact package's directional half. The
    //    cone's axis is set PER BURST to the reflected arrival direction —
    //    grazing hits scatter wide to the side, head-on hits bounce tight
    //    back toward the shooter ("the curvature under which the target
    //    was hit") ──
    const RSPARKS_S = {
      shape: { kind: 'cone', origin: [0, 0, 0], axis: [0, 1, 0], halfAngle: 0.3, baseRadius: 0.05, length: [0, 0.2] },
      velocity: { mode: 'lobe' },
      speed: [4, 11], life: [0.3, 0.55], size: [0.07, 0.16],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 77,
    }
    const refSparks = env.addLayer({
      id: 'nirsparks',
      facade: env.createParticles({
        capacity: 320,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.4, size: 0.9, r: 0.85, g: 0.95, b: 1, a: 0.9 },
          { t: 1, size: 0.1, r: 0.55, g: 0.75, b: 1, a: 0 },
        ]),
        forces: { gravity: [0, -7, 0], drag: 0.55 },
        spawner: RSPARKS_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.14 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })
    // the beam impact's own flash card — cyan-hot (the energy read)
    const BOLT_FLASH_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.16, 0.22], size: [1.5, 2.1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 79,
    }
    const boltFlash = env.addLayer({
      id: 'nibflash',
      facade: env.createParticles({
        capacity: 16,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.85, g: 0.97, b: 1, a: 1, frame: 0 },
          { t: 1, size: 0.7, r: 0.4, g: 0.7, b: 1, a: 0, frame: 2 },
        ]),
        spawner: BOLT_FLASH_S,
        render: { kind: 'billboard', draw: 'instance', tiles: TILES },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.muzzleSheet,
    })

    // ── the impact package (burst at the target on the retire) ──
    const IMPACT_FLASH_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.14, 0.2], size: [1.2, 1.7],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 61,
    }
    const impactFlash = env.addLayer({
      id: 'sn-iflash',
      facade: env.createParticles({
        capacity: 24,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1, frame: 0 },
          { t: 1, size: 0.7, r: 1, g: 0.6, b: 0.3, a: 0, frame: 2 },
        ]),
        spawner: IMPACT_FLASH_S,
        render: { kind: 'billboard', draw: 'instance', tiles: TILES },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.muzzleSheet,
    })
    const IMPACT_RING_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.4, 0.55], size: [0.9, 1.1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 71,
    }
    const impactRing = env.addLayer({
      id: 'sn-iring',
      facade: env.createParticles({
        capacity: 16,
        ramp: env.createRamp([
          { t: 0, size: 0.3, r: 1, g: 0.85, b: 0.6, a: 0.9, frame: 5 },
          { t: 1, size: 1.6, r: 1, g: 0.7, b: 0.4, a: 0, frame: 5 },
        ]),
        spawner: IMPACT_RING_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })
    const IMPACT_SMOKE_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [0.4, 1.2], life: [0.4, 0.7], size: [0.5, 0.9],
      color: [[0.6, 0.6, 0.6, 0.35], [0.75, 0.75, 0.75, 0.25]], seed: 73,
    }
    const impactSmoke = env.addLayer({
      id: 'nismoke',
      facade: env.createParticles({
        capacity: 48,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1, frame: 4 },
          { t: 1, size: 1.35, r: 1, g: 1, b: 1, a: 0, frame: 7 },
        ]),
        spin: 1.3,
        spawner: IMPACT_SMOKE_S,
        render: { kind: 'billboard', draw: 'instance', tiles: TILES },
      }),
      material: env.materials.bbHaze,
      pipeline: env.pipelines.alpha,
      texture: () => env.muzzleSheet,
    })

    // ── the behavior: acquire → aim → burst (every third = a BEAM volley) → dwell → next ──
    const AIM_RATE = 2.4 // rad/s
    const ROUNDS = 4
    const ROUND_DT = 0.095
    const BOLT_ROUNDS = 3
    const BOLT_DT = 0.17
    const DWELL = 0.85
    let yaw = 0.6
    let targetIdx = 0
    let phase = 'aim' // 'aim' | 'fire' | 'cool'
    let phaseT = 0
    let burstLeft = 0
    let shotT = 0
    let recoil = 0
    let shotSeed = 500
    let burstN = 0
    let volley = false // every third burst fires BEAM BOLTS instead of tracers
    const tip = [0, 1.35, 0]
    // the probe counters (scripts/task128-probe.mjs reads them)
    const C = (typeof window !== 'undefined' ? (window.__vfxCounters ??= {}) : {})

    const fireRound = () => {
      const s = shotSeed++
      C.shots = (C.shots ?? 0) + 1
      const t = TARGETS[targetIdx]
      smoke.facade.burst(4, { ...SMOKE_S, seed: s })
      flash.facade.burst(2, { ...FLASH_S, seed: s + 1 })
      beam.facade.burst(1, { ...BEAM_S, seed: s + 2 })
      sparks.facade.burst(7, { ...SPARKS_S, seed: s + 3 })
      shells.facade.burst(1, { ...SHELL_S, seed: s + 4 })
      // the tracer: the exact world direction tip → target, life = dist/55
      const dx = t[0] - tip[0], dy = t[1] - tip[1], dz = t[2] - tip[2]
      const dist = Math.hypot(dx, dy, dz)
      tracer.facade.at(tip[0], tip[1], tip[2])
      tracer.facade.burst(1, {
        ...TRACER_S,
        velocity: { mode: 'fixed', dir: [dx / dist, dy / dist, dz / dist] },
        speed: [55, 55], life: [dist / 55, dist / 55], seed: s + 5,
      })
      recoil = 0.11
    }

    // the BEAM bolt: aimed at an OFFSET point of the target's sphere so
    // the arrival ANGLE varies — grazing hits and head-on hits look
    // different in the sparks that fly off (the curvature decides)
    const fireBolt = () => {
      const s = shotSeed++
      C.bolts = (C.bolts ?? 0) + 1
      const t = TARGETS[targetIdx]
      // a random surface offset (inside r≈0.45 of the target center)
      let ox = 0, oy = 0, oz = 0
      do {
        ox = Math.random() * 0.9 - 0.45
        oy = Math.random() * 0.9 - 0.45
        oz = Math.random() * 0.9 - 0.45
      } while (ox * ox + oy * oy + oz * oz > 0.45 * 0.45)
      const ax = t[0] + ox, ay = t[1] + oy, az = t[2] + oz
      const dx = ax - tip[0], dy = ay - tip[1], dz = az - tip[2]
      const dist = Math.hypot(dx, dy, dz)
      bolt.facade.at(tip[0], tip[1], tip[2])
      bolt.facade.burst(1, {
        ...BOLT_S,
        velocity: { mode: 'fixed', dir: [dx / dist, dy / dist, dz / dist] },
        speed: [26, 26], life: [dist / 26, dist / 26], seed: s,
      })
      // the launch package: a fatter beam card + a hot flash (no shells —
      // the energy weapon does not eject brass)
      beam.facade.burst(1, { ...BEAM_S, seed: s + 1, size: [1.5, 1.8] })
      flash.facade.burst(2, { ...FLASH_S, seed: s + 2, size: [1.9, 2.6] })
      sparks.facade.burst(5, { ...SPARKS_S, seed: s + 3, speed: [10, 24] })
      recoil = 0.17
    }

    return {
      frame(ctx) {
        const dt = ctx.dt
        const t = TARGETS[targetIdx]
        // the aim: the barrel's world +X is (cos yaw, 0, sin yaw) — the
        // desired yaw points at the target (shortest arc)
        const desired = Math.atan2(t[2], t[0])
        let d = desired - yaw
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI

        if (phase === 'aim') {
          const step = Math.min(Math.abs(d), AIM_RATE * dt) * Math.sign(d)
          yaw += step
          if (Math.abs(d) < 0.03) {
            phase = 'fire'
            burstN++
            volley = burstN % 3 === 0 // every third burst: the energy weapon
            burstLeft = volley ? BOLT_ROUNDS : ROUNDS
            shotT = 0
            const t = TARGETS[targetIdx]
            env.log.event(`sentry ${volley ? 'BEAM volley' : 'burst'} #${burstN} → target ${targetIdx + 1} (${t[0].toFixed(1)}, ${t[1].toFixed(1)}, ${t[2].toFixed(1)})`)
          }
        } else if (phase === 'fire') {
          shotT -= dt
          if (shotT <= 0 && burstLeft > 0) {
            if (volley) fireBolt()
            else fireRound()
            burstLeft--
            shotT = volley ? BOLT_DT : ROUND_DT
          }
          if (burstLeft === 0) { phase = 'cool'; phaseT = volley ? 1.15 : DWELL }
        } else {
          phaseT -= dt
          if (phaseT <= 0) {
            // the next target: never the one just fired at
            let next = targetIdx
            while (next === targetIdx) next = Math.floor(Math.random() * TARGETS.length)
            targetIdx = next
            const nt = TARGETS[targetIdx]
            lock.facade.at(nt[0], nt[1], nt[2])
            lock.facade.burst(1, { ...LOCK_S, seed: 11 + targetIdx })
            phase = 'aim'
          }
        }
        recoil = Math.max(0, recoil - dt * 0.55)

        // the turret frame F = T(0, 1.35, 0) · Ry(−yaw) · T(−recoil, 0, 0)
        // (column-major; col0 = the barrel direction (cy, 0, sy))
        const cy = Math.cos(yaw), sy = Math.sin(yaw)
        F.fill(0)
        F[0] = cy; F[2] = sy
        F[5] = 1
        F[8] = -sy; F[10] = cy
        F[12] = -recoil * cy; F[13] = 1.35; F[14] = -recoil * sy
        F[15] = 1
        mul(F, HEAD_L, headModel)
        mul(F, BARREL_L, barrelModel)
        ctx.record(head.command, { mvp: ctx.modelMvp(headModel), model: headModel, camPos: ctx.camEye })
        ctx.record(barrel.command, { mvp: ctx.modelMvp(barrelModel), model: barrelModel, camPos: ctx.camEye })

        // the muzzle systems ride the frame: the origin at the muzzle tip,
        // the orientation = the turret's rotation (the cones follow the
        // barrel wherever it points)
        tip[0] = 1.9 * cy - recoil * cy
        tip[1] = 1.35
        tip[2] = 1.9 * sy - recoil * sy
        smoke.facade.at(tip[0], tip[1], tip[2])
        flash.facade.at(tip[0], tip[1], tip[2])
        beam.facade.at(tip[0], tip[1], tip[2])
        sparks.facade.at(tip[0], tip[1], tip[2])
        shells.facade.at(F[12], 1.35, F[14])
        smoke.facade.orient(F)
        flash.facade.orient(F)
        beam.facade.orient(F)
        sparks.facade.orient(F)
        shells.facade.orient(F)

        // the impact queues: the tracers/bolts that DIED at their targets.
        // Every record carries the ARRIVAL DIRECTION — the sparks fly off
        // the REFLECTION of it against the target's surface sphere:
        //   n   = normalize(hit − center)     (the surface normal — the curvature)
        //   r   = d − 2(d·n)n                (the mirror direction)
        //   cone half-angle / count scale with the incidence: grazing hits
        //   (|d·n| small) scatter WIDE and plentiful, head-on hits bounce
        //   back at the shooter in a tight narrow spray
        const burstImpact = (ix, iy, iz, ivx, ivy, ivz, beamHit) => {
          C.impacts = (C.impacts ?? 0) + 1
          C.reflections = (C.reflections ?? 0) + 1
          // the sphere we hit: the nearest target
          let bx = TARGETS[0][0], by = TARGETS[0][1], bz = TARGETS[0][2]
          let bd = Infinity
          for (const [tx, ty, tz] of TARGETS) {
            const dd = (ix - tx) * (ix - tx) + (iy - ty) * (iy - ty) + (iz - tz) * (iz - tz)
            if (dd < bd) { bd = dd; bx = tx; by = ty; bz = tz }
          }
          let nx = ix - bx, ny = iy - by, nz = iz - bz
          const nl = Math.hypot(nx, ny, nz) || 1
          nx /= nl; ny /= nl; nz /= nl
          const vl = Math.hypot(ivx, ivy, ivz) || 1
          const dX = ivx / vl, dY = ivy / vl, dZ = ivz / vl
          const dn = dX * nx + dY * ny + dZ * nz
          let rx = dX - 2 * dn * nx, ry = dY - 2 * dn * ny, rz = dZ - 2 * dn * nz
          const rl = Math.hypot(rx, ry, rz) || 1
          rx /= rl; ry /= rl; rz /= rl
          const incidence = Math.min(1, Math.abs(dn)) // 1 = head-on, →0 = grazing
          const half = 0.13 + 0.5 * (1 - incidence)
          const count = 7 + Math.round(9 * (1 - incidence))
          const s = shotSeed + 7
          // the reflection sparks: the cone rides the mirror direction
          refSparks.facade.at(ix, iy, iz)
          refSparks.facade.burst(count, {
            ...RSPARKS_S,
            shape: { kind: 'cone', origin: [0, 0, 0], axis: [rx, ry, rz], halfAngle: half, baseRadius: 0.05, length: [0, 0.2] },
            seed: s,
          })
          if (beamHit) {
            // the cyan bolt-flash (the energy read) over the warm package
            boltFlash.facade.at(ix, iy, iz)
            boltFlash.facade.burst(1, { ...BOLT_FLASH_S, seed: s + 1 })
          }
          impactFlash.facade.at(ix, iy, iz)
          impactFlash.facade.burst(1, { ...IMPACT_FLASH_S, seed: s + 2, size: beamHit ? [1.6, 2.2] : [1.2, 1.7] })
          impactRing.facade.at(ix, iy, iz)
          impactRing.facade.burst(1, { ...IMPACT_RING_S, seed: s + 3, size: beamHit ? [1.1, 1.3] : [0.9, 1.1] })
          impactSmoke.facade.at(ix, iy, iz)
          impactSmoke.facade.burst(beamHit ? 4 : 3, { ...IMPACT_SMOKE_S, seed: s + 4 })
        }
        while (impacts.length > 0) {
          burstImpact(impacts.shift(), impacts.shift(), impacts.shift(),
            impacts.shift(), impacts.shift(), impacts.shift(), false)
        }
        while (boltImpacts.length > 0) {
          burstImpact(boltImpacts.shift(), boltImpacts.shift(), boltImpacts.shift(),
            boltImpacts.shift(), boltImpacts.shift(), boltImpacts.shift(), true)
        }

        for (const l of [markers, lock, smoke, flash, beam, sparks, shells, tracer, bolt, refSparks, boltFlash,
          impactFlash, impactRing, impactSmoke]) l.facade.advance(dt)
      },
    }
  },
}
