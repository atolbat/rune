// laser.js — THE LASER BEAM (Task 129 — the live request: "add bright
// beams flying from the cannon into the target, and sparks that fly off
// the target taking into account the curvature of the hit; and a laser
// beam"). The turret here is a CUTTING laser: it acquires a hovering
// drone, CHARGES (a thin flickering beam), then BURNS it — a continuous
// particle beam drawn along the exact muzzle→hit segment (the LINE
// spawner's Task-130 LATTICE mode: one burst per frame covers every
// station of the segment gap-free, so the beam reads as a SOLID line of
// light, not a dashed train of blobs — the "the beam is discrete, many
// projectiles flying in a row" report), whose aim point WANDERS over the
// drone's face so the surface normal at the hit keeps changing — and the
// impact sparks fly along the REFLECTION of the beam direction off that
// normal, exactly as the curvature dictates: a glancing hit sprays
// sideways wide, a head-on hit sprays back toward the turret. The drone
// is a BRIGHT sphere whose radius IS the reflection sphere — the beam
// terminates ON the visible surface (the old invisible cube + the
// oversized hit proxy made the beam bite empty air — the "can't see what
// it hits, there's emptiness" report); a small tracking reticle rides
// the acquired drone so the target is never lost. The drone overheats
// for a beat and detonates (flash + ring + bouncing debris + smoke), the
// turret picks the next one, and when the patrol is gone a fresh wave
// flies in.
//
// The library surface this demo adds to the page: the LINE LATTICE
// emitter shape (the continuous-beam primitive — a live from/to re-burst
// every frame at a frame-scaled life), a continuous per-frame burst
// schedule (the manual rate channel), the reflection cone (a world-space
// cone spawner whose axis is recomputed every burst), the same
// die-at-the-target sub-emitter chain the sentry uses, and breathing
// manual meshes with a collapsing scale (the death animation).
export default {
  title: 'Laser Beam',
  sub: 'rune original · continuous lattice beam · reflection sparks off the curvature · burn → destroy loop',
  camera: { yaw: 0.7, pitch: 0.3, dist: 14.5, orbit: 0.035, target: [0, 1.8, 0] },

  make(env) {
    // ── the scene: the floor + the turret (yaw + PITCH this time) ──
    env.addMesh({
      id: 'ls-floor',
      geometry: env.geometry.plane({ width: 80, height: 80 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      uniforms: { u_albedo: [0.08, 0.09, 0.12, 1] },
    })
    env.addMesh({
      id: 'ls-base',
      geometry: env.geometry.cube(0.5),
      material: env.materials.lambert,
      model: new Float32Array([1.2, 0, 0, 0, 0, 1.1, 0, 0, 0, 0, 1.2, 0, 0, 0.55, 0, 1]),
      uniforms: { u_albedo: [0.16, 0.18, 0.22, 1] },
    })
    const head = env.addMesh({
      id: 'ls-head',
      geometry: env.geometry.cube(0.5),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.24, 0.3, 0.36, 1] },
      manual: true,
    })
    const barrel = env.addMesh({
      id: 'ls-barrel',
      geometry: env.geometry.cube(0.5),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.12, 0.13, 0.16, 1] },
      manual: true,
    })

    // column-major 4×4 multiply (a·b → out)
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
    const M = () => new Float32Array(16)
    // the turret frame F = T(0,1.35,0) · Ry(−yaw) · Rz(pitch) · T(−recoil,0,0)
    // (Rz is the ELEVATION for a +X barrel: it lifts the muzzle, Ry aims it)
    const HEAD_L = new Float32Array([0.8, 0, 0, 0, 0, 0.55, 0, 0, 0, 0, 0.62, 0, 0, 0, 0, 1])
    const BARREL_L = new Float32Array([1.4, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 0.2, 0, 1.2, 0, 0, 1])
    const RY = M(), RZ = M(), TR = M(), TT = M(), S1 = M(), S2 = M(), F = M()
    const headModel = M(), barrelModel = M()
    const tip = [0, 1.35, 0]

    // ── the drones: three bright spheres on offset orbits — the mesh IS the
    //    reflection sphere (DRONE_R): the beam lands ON the visible surface,
    //    never in the air around it. The old dark cubes vs the oversized
    //    0.62 hit proxy put the bite up to 0.35u OUTSIDE the cube — "it hits
    //    emptiness". Rust-orange reads loud on the dark floor. ──
    const DRONES = [
      { r: 6.8, h: 2.2, w: 0.34, phase: 0.0, alive: true, x: 0, y: 0, z: 0, scale: 1 },
      { r: 8.0, h: 3.0, w: -0.2, phase: 2.1, alive: true, x: 0, y: 0, z: 0, scale: 1 },
      { r: 5.6, h: 1.6, w: 0.46, phase: 4.4, alive: true, x: 0, y: 0, z: 0, scale: 1 },
    ]
    const DRONE_R = 0.7 // the reflection sphere (the curvature that bends the sparks) = the mesh
    const droneModels = [M(), M(), M()]
    const DT = M()
    const drones = DRONES.map((d, i) => env.addMesh({
      id: `ls-drone-${i}`,
      geometry: env.geometry.sphere({ radius: DRONE_R, widthSegments: 28, heightSegments: 20 }),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.85, 0.5, 0.2, 1] },
      manual: true,
    }))

    // ── the lock on the acquired drone: the one-shot expanding ring (the
    //    acquire beat) + a small TRACKING reticle re-burst every frame that
    //    rides the drone's orbit (the old single ring burst stayed behind
    //    in space while the target flew on) ──
    const LOCK_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.9, 0.9], size: [1, 1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 11,
    }
    const lock = env.addLayer({
      id: 'ls-lock',
      facade: env.createParticles({
        capacity: 16,
        ramp: env.createRamp([
          { t: 0, size: 0.55, r: 0.6, g: 0.9, b: 1, a: 0.9, frame: 5 },
          { t: 1, size: 1, r: 0.45, g: 0.75, b: 1, a: 0, frame: 5 },
        ]),
        spawner: LOCK_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })

    // ── the beam: TWO line-LATTICE systems, re-burst every frame along the
    //    exact muzzle→hit segment (Task 130: mode 'lattice' maps the call
    //    index → station, so ONE burst covers every station of the segment
    //    gap-free — a SOLID line of light, not the old hash-random scatter
    //    of ~36 blobs that read as "many projectiles flying in a row").
    //    The life is dt-scaled (~2-3 FRAMES whatever the refresh rate), so
    //    2-3 staggered full covers are always alive; the per-frame seed
    //    re-hashes only the size/life (positions are lattice), a stable
    //    geometry with an organic shimmer. ──
    const BEAM_CORE_S = {
      shape: { kind: 'line', from: [0, 1.35, 0], to: [8, 2.3, 0], mode: 'lattice', spacing: 0.1 },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.05, 0.06], size: [0.5, 0.58],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 21,
    }
    const beamCore = env.addLayer({
      id: 'ls-core',
      facade: env.createParticles({
        capacity: 384,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.8, r: 0.9, g: 0.97, b: 1, a: 0.45 },
        ]),
        spawner: BEAM_CORE_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'camera' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })
    const BEAM_HALO_S = {
      shape: { kind: 'line', from: [0, 1.35, 0], to: [8, 2.3, 0], mode: 'lattice', spacing: 0.16 },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.05, 0.07], size: [0.95, 1.15],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 23,
    }
    const beamHalo = env.addLayer({
      id: 'ls-halo',
      facade: env.createParticles({
        capacity: 256,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.55, g: 0.85, b: 1, a: 0.5 },
          { t: 1, size: 1.15, r: 0.4, g: 0.7, b: 1, a: 0 },
        ]),
        spawner: BEAM_HALO_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'camera' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the impact flare: the hot spot where the beam bites the drone's
    //    face — the "the beam is HITTING something" cue ──
    const FLARE_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.1, 0.14], size: [1.1, 1.5],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 25,
    }
    const flare = env.addLayer({
      id: 'ls-flare',
      facade: env.createParticles({
        capacity: 32,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 1, size: 0.7, r: 0.9, g: 0.95, b: 1, a: 0 },
        ]),
        spawner: FLARE_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'camera' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })
    // the charge-up flare at the MUZZLE (grows through the charge phase)
    const CHARGE_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.12, 0.16], size: [0.3, 0.5],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 27,
    }
    const charge = env.addLayer({
      id: 'ls-charge',
      facade: env.createParticles({
        capacity: 16,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.8, g: 0.95, b: 1, a: 0.9 },
          { t: 1, size: 1.4, r: 0.55, g: 0.8, b: 1, a: 0 },
        ]),
        spawner: CHARGE_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'camera' },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the REFLECTION sparks: a world-space cone whose axis is the mirror
    //    of the beam direction off the hit normal — recomputed EVERY frame
    //    (the aim wanders over the drone's face, so the normal turns and
    //    the sparks sweep — the curvature made visible) ──
    const RSPARKS_S = {
      shape: { kind: 'cone', origin: [0, 0, 0], axis: [0, 1, 0], halfAngle: 0.3, baseRadius: 0.05, length: [0, 0.15] },
      velocity: { mode: 'lobe' },
      speed: [3.5, 9], life: [0.25, 0.5], size: [0.06, 0.15],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 29,
    }
    const refSparks = env.addLayer({
      id: 'ls-rsparks',
      facade: env.createParticles({
        capacity: 256,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.45, size: 0.9, r: 1, g: 0.8, b: 0.45, a: 0.9 },
          { t: 1, size: 0.1, r: 1, g: 0.55, b: 0.2, a: 0 },
        ]),
        forces: { gravity: [0, -7, 0], drag: 0.6 },
        spawner: RSPARKS_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.14 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the molten pops: a slow ember burst every half-second of the burn ──
    const POP_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 0.18] },
      velocity: { mode: 'radial' },
      speed: [1.2, 3.2], life: [0.5, 0.9], size: [0.08, 0.18],
      color: [[1, 0.8, 0.4, 1], [1, 0.5, 0.2, 1]], seed: 31,
    }
    const pops = env.addLayer({
      id: 'ls-pops',
      facade: env.createParticles({
        capacity: 64,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.85, b: 0.5, a: 1 },
          { t: 1, size: 0.2, r: 1, g: 0.45, b: 0.15, a: 0 },
        ]),
        forces: { gravity: [0, -4, 0], drag: 0.8 },
        spawner: POP_S,
        render: { kind: 'billboard', draw: 'instance', mode: 'stretched', speedFactor: 0.1 },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the burn smoke: thin wisps off the hit point ──
    const WISP_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0.5, 1.1], life: [0.7, 1.1], size: [0.45, 0.8],
      color: [[0.55, 0.55, 0.58, 0.3], [0.7, 0.7, 0.73, 0.22]], seed: 33,
    }
    const wisps = env.addLayer({
      id: 'ls-wisps',
      facade: env.createParticles({
        capacity: 48,
        ramp: env.createRamp([
          { t: 0, size: 0.8, r: 1, g: 1, b: 1, a: 1, frame: 4 },
          { t: 1, size: 1.5, r: 1, g: 1, b: 1, a: 0, frame: 7 },
        ]),
        spin: 0.9,
        spawner: WISP_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.muzzleTiles, sort: true },
      }),
      material: env.materials.bbHaze,
      pipeline: env.pipelines.alpha,
      texture: () => env.muzzleSheet,
    })

    // ── the destroy package ──
    const BOOM_FLASH_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.16, 0.24], size: [2.6, 3.4],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 35,
    }
    const boomFlash = env.addLayer({
      id: 'ls-bflash',
      facade: env.createParticles({
        capacity: 8,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1, frame: 0 },
          { t: 1, size: 0.7, r: 1, g: 0.6, b: 0.3, a: 0, frame: 2 },
        ]),
        spawner: BOOM_FLASH_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.muzzleTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.muzzleSheet,
    })
    const BOOM_RING_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.5, 0.65], size: [1, 1.2],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 37,
    }
    const boomRing = env.addLayer({
      id: 'ls-bring',
      facade: env.createParticles({
        capacity: 8,
        ramp: env.createRamp([
          { t: 0, size: 0.3, r: 1, g: 0.9, b: 0.7, a: 0.9, frame: 5 },
          { t: 1, size: 2.4, r: 1, g: 0.7, b: 0.4, a: 0, frame: 5 },
        ]),
        spawner: BOOM_RING_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })
    const DEBRIS_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 0.3] },
      velocity: { mode: 'radial' },
      speed: [3.5, 9], life: [1.3, 2.0], size: [0.06, 0.14],
      color: [[1, 0.8, 0.5, 1], [1, 0.55, 0.3, 1]], seed: 39,
    }
    const debris = env.addLayer({
      id: 'ls-debris',
      facade: env.createParticles({
        capacity: 96,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.85, b: 0.6, a: 1 },
          { t: 0.85, size: 1, r: 1, g: 0.75, b: 0.45, a: 1 },
          { t: 1, size: 1, r: 1, g: 0.7, b: 0.4, a: 0 },
        ]),
        forces: {
          gravity: [0, -18, 0], drag: 0.04,
          collide: { planes: [{ normal: [0, 1, 0], point: [0, 0, 0], restitution: 0.35, friction: 0.25 }] },
        },
        spawner: DEBRIS_S,
        render: { kind: 'billboard', draw: 'instance', spin: 7, tiles: env.atlasTiles },
      }),
      material: env.materials.bbSprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.atlasTexture,
    })
    const BOOM_SMOKE_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 0.5] },
      velocity: { mode: 'radial' },
      speed: [0.6, 2.0], life: [0.8, 1.4], size: [0.8, 1.4],
      color: [[0.55, 0.55, 0.55, 0.4], [0.7, 0.7, 0.7, 0.3]], seed: 41,
    }
    const boomSmoke = env.addLayer({
      id: 'ls-bsmoke',
      facade: env.createParticles({
        capacity: 64,
        ramp: env.createRamp([
          { t: 0, size: 0.9, r: 1, g: 1, b: 1, a: 1, frame: 4 },
          { t: 1, size: 1.7, r: 1, g: 1, b: 1, a: 0, frame: 7 },
        ]),
        spin: 1.4,
        spawner: BOOM_SMOKE_S,
        render: { kind: 'billboard', draw: 'instance', tiles: env.muzzleTiles, sort: true },
      }),
      material: env.materials.bbHaze,
      pipeline: env.pipelines.alpha,
      texture: () => env.muzzleSheet,
    })

    // ── the state machine: acquire → charge → burn → boom → dwell → next ──
    const AIM_RATE = 2.6 // rad/s (yaw)
    const PITCH_RATE = 1.7 // rad/s
    const CHARGE_T = 0.55
    const BURN_T = 3.4
    let yaw = 0.7
    let pitch = 0.12
    let recoil = 0
    let phase = 'acquire'
    let phaseT = 0
    let droneIdx = 0
    let destroyed = 0
    let popT = 0
    let wispT = 0
    const C = (typeof window !== 'undefined' ? (window.__vfxCounters ??= {}) : {})
    // the per-frame hit state (the reflection math writes it, the bursts read it)
    const hit = [0, 0, 0]
    const hitN = [0, 0, 0]
    const hitDir = [1, 0, 0]

    /** The aim point: the drone center + a wandering offset — the beam
     *  ROAMS over the drone's face so the surface normal at the hit keeps
     *  turning (the reflection sweeps: the curvature, made visible). */
    const aim = [0, 0, 0]
    const computeAim = (t, d) => {
      const phi = 1.9 * t + d.phase * 3
      aim[0] = d.x + 0.4 * Math.cos(phi)
      aim[1] = d.y + 0.24 * Math.sin(phi * 1.3)
      aim[2] = d.z + 0.4 * Math.sin(phi)
    }

    /** Ray→sphere: the exact surface point where the beam lands, its
     *  normal, and the arrival direction (the reflection inputs). */
    const computeHit = (d) => {
      let dx = aim[0] - tip[0], dy = aim[1] - tip[1], dz = aim[2] - tip[2]
      const dl = Math.hypot(dx, dy, dz) || 1
      dx /= dl; dy /= dl; dz /= dl
      hitDir[0] = dx; hitDir[1] = dy; hitDir[2] = dz
      const ocx = tip[0] - d.x, ocy = tip[1] - d.y, ocz = tip[2] - d.z
      const b = ocx * dx + ocy * dy + ocz * dz
      const cc = ocx * ocx + ocy * ocy + ocz * ocz - DRONE_R * DRONE_R
      const disc = b * b - cc
      if (disc > 0) {
        const tNear = -b - Math.sqrt(disc)
        hit[0] = tip[0] + dx * tNear
        hit[1] = tip[1] + dy * tNear
        hit[2] = tip[2] + dz * tNear
      } else {
        // the aim drifted off the sphere (a fast drone): bite at the aim
        hit[0] = aim[0]; hit[1] = aim[1]; hit[2] = aim[2]
      }
      let nx = hit[0] - d.x, ny = hit[1] - d.y, nz = hit[2] - d.z
      const nl = Math.hypot(nx, ny, nz) || 1
      hitN[0] = nx / nl; hitN[1] = ny / nl; hitN[2] = nz / nl
    }

    const destroyDrone = (d) => {
      destroyed++
      C.destroys = (C.destroys ?? 0) + 1
      d.alive = false
      boomFlash.facade.at(d.x, d.y, d.z)
      boomFlash.facade.burst(1, { ...BOOM_FLASH_S, seed: 300 + destroyed })
      boomRing.facade.at(d.x, d.y, d.z)
      boomRing.facade.burst(1, { ...BOOM_RING_S, seed: 320 + destroyed })
      debris.facade.at(d.x, d.y, d.z)
      debris.facade.burst(14, { ...DEBRIS_S, seed: 340 + destroyed })
      boomSmoke.facade.at(d.x, d.y, d.z)
      boomSmoke.facade.burst(6, { ...BOOM_SMOKE_S, seed: 360 + destroyed })
      env.log.event(`laser: drone ${droneIdx + 1} destroyed (#${destroyed})`)
    }

    return {
      frame(ctx) {
        const dt = ctx.dt
        const t = ctx.time

        // the drone patrol: positions + the hover breathe (a uniform sphere
        // has no tumble to show — a ±4% scale pulse keeps them ALIVE)
        for (let i = 0; i < DRONES.length; i++) {
          const d = DRONES[i]
          const a = d.w * t + d.phase
          d.x = Math.cos(a) * d.r
          d.z = Math.sin(a) * d.r
          d.y = d.h + Math.sin(0.7 * t + d.phase) * 0.5
          // the death collapse: the scale implodes over the boom
          if (!d.alive) d.scale = Math.max(0, d.scale - dt * 7)
          else if (d.scale < 1) d.scale = Math.min(1, d.scale + dt * 3)
          // the model: T(pos) · S — the breathe rides the death scale
          const s = Math.max(0.0001, d.scale * (1 + 0.04 * Math.sin(1.7 * t + d.phase * 2)))
          DT.fill(0)
          DT[0] = s; DT[5] = s; DT[10] = s; DT[15] = 1
          DT[12] = d.x; DT[13] = d.y; DT[14] = d.z
          // a full T·S in one write: the rotation-free drone frame
          droneModels[i].set(DT)
          ctx.record(drones[i].command, { mvp: ctx.modelMvp(droneModels[i]), model: droneModels[i], camPos: ctx.camEye })
        }

        // the active drone (the next alive one — the state machine owns it)
        const d = DRONES[droneIdx]

        // the turret aim: yaw + pitch at the drone center
        const desiredYaw = Math.atan2(d.z, d.x)
        const hd = Math.hypot(d.x, d.z)
        const desiredPitch = Math.atan2(d.y - 1.35, hd)
        let dyaw = desiredYaw - yaw
        while (dyaw > Math.PI) dyaw -= 2 * Math.PI
        while (dyaw < -Math.PI) dyaw += 2 * Math.PI
        const dpitch = desiredPitch - pitch
        yaw += Math.min(Math.abs(dyaw), AIM_RATE * dt) * Math.sign(dyaw)
        pitch += Math.min(Math.abs(dpitch), PITCH_RATE * dt) * Math.sign(dpitch)
        recoil = Math.max(0, recoil - dt * 2.2)

        // the turret frame F = T(0,1.35,0) · Ry(−yaw) · Rz(pitch) · T(−recoil,0,0)
        RY.fill(0)
        RY[0] = Math.cos(yaw); RY[2] = Math.sin(yaw)
        RY[5] = 1
        RY[8] = -Math.sin(yaw); RY[10] = Math.cos(yaw)
        RY[15] = 1
        RZ.fill(0)
        RZ[0] = Math.cos(pitch); RZ[1] = Math.sin(pitch)
        RZ[4] = -Math.sin(pitch); RZ[5] = Math.cos(pitch)
        RZ[10] = 1; RZ[15] = 1
        TR.fill(0)
        TR[0] = TR[5] = TR[10] = 1
        TR[12] = -recoil; TR[15] = 1
        TT.fill(0)
        TT[0] = TT[5] = TT[10] = 1
        TT[13] = 1.35; TT[15] = 1
        mul(RY, RZ, S1)
        mul(S1, TR, S2)
        mul(TT, S2, F)
        mul(F, HEAD_L, headModel)
        mul(F, BARREL_L, barrelModel)
        ctx.record(head.command, { mvp: ctx.modelMvp(headModel), model: headModel, camPos: ctx.camEye })
        ctx.record(barrel.command, { mvp: ctx.modelMvp(barrelModel), model: barrelModel, camPos: ctx.camEye })

        // the muzzle tip: F applied to (1.9, 0, 0)
        tip[0] = F[0] * 1.9 + F[12]
        tip[1] = F[1] * 1.9 + F[13]
        tip[2] = F[2] * 1.9 + F[14]

        // the beam geometry: aim (the wandering point) → the exact hit
        computeAim(t, d)
        computeHit(d)
        const dn = hitDir[0] * hitN[0] + hitDir[1] * hitN[1] + hitDir[2] * hitN[2]
        // the reflection r = d − 2(d·n)n — the sparks' flight direction
        let rx = hitDir[0] - 2 * dn * hitN[0]
        let ry = hitDir[1] - 2 * dn * hitN[1]
        let rz = hitDir[2] - 2 * dn * hitN[2]
        const rl = Math.hypot(rx, ry, rz) || 1
        rx /= rl; ry /= rl; rz /= rl
        const incidence = Math.min(1, Math.abs(dn))

        // ── the phases ──
        phaseT += dt
        // the tracking reticle: a small ring re-burst EVERY frame that rides
        // the acquired drone's orbit (a live target marker, not a one-shot
        // ring left behind in space). Only while the drone is alive.
        if (d.alive && phase !== 'boom') {
          lock.facade.at(d.x, d.y, d.z)
          lock.facade.burst(1, { ...LOCK_S, life: [dt * 3, dt * 3], size: [0.5, 0.5], seed: 13 + droneIdx })
        }
        // the live beam segment (the lattice re-derives the station count
        // from THIS frame's length — the burst size follows it)
        const segLen = Math.hypot(hit[0] - tip[0], hit[1] - tip[1], hit[2] - tip[2])
        if (phase === 'acquire') {
          if (Math.abs(dyaw) < 0.06 && Math.abs(dpitch) < 0.06 && phaseT > 0.3) {
            phase = 'charge'
            phaseT = 0
            env.log.event(`laser: locked drone ${droneIdx + 1} (${d.x.toFixed(1)}, ${d.y.toFixed(1)}, ${d.z.toFixed(1)})`)
          }
        } else if (phase === 'charge') {
          // a THIN continuous lattice beam + the muzzle charge flare growing
          charge.facade.at(tip[0], tip[1], tip[2])
          charge.facade.burst(1, { ...CHARGE_S, seed: 40 + ((phaseT * 60) | 0), size: [0.25 + phaseT * 1.1, 0.4 + phaseT * 1.4] })
          beamCore.facade.burst(Math.ceil(segLen / 0.16) + 2, {
            ...BEAM_CORE_S,
            shape: { kind: 'line', from: [tip[0], tip[1], tip[2]], to: [hit[0], hit[1], hit[2]], mode: 'lattice', spacing: 0.16 },
            life: [dt * 1.6, dt * 2], size: [0.12, 0.16], seed: 44 + ((phaseT * 60) | 0),
          })
          if (phaseT > CHARGE_T) { phase = 'burn'; phaseT = 0; popT = 0; wispT = 0; recoil = 0.1 }
        } else if (phase === 'burn') {
          C.laserFrames = (C.laserFrames ?? 0) + 1
          // THE BEAM: core + halo, the line LATTICE along the exact segment —
          // every station covered every frame (a solid line of light; the
          // 2-frame life keeps 2 staggered covers alive at any refresh rate)
          C.beamAlive = beamCore.facade.count
          beamCore.facade.burst(Math.min(160, Math.ceil(segLen / 0.1) + 2), {
            ...BEAM_CORE_S,
            shape: { kind: 'line', from: [tip[0], tip[1], tip[2]], to: [hit[0], hit[1], hit[2]], mode: 'lattice', spacing: 0.1 },
            life: [dt * 1.8, dt * 2.4],
            seed: 50 + ((t * 60) | 0),
          })
          beamHalo.facade.burst(Math.min(96, Math.ceil(segLen / 0.16) + 2), {
            ...BEAM_HALO_S,
            shape: { kind: 'line', from: [tip[0], tip[1], tip[2]], to: [hit[0], hit[1], hit[2]], mode: 'lattice', spacing: 0.16 },
            life: [dt * 2.6, dt * 3.4],
            seed: 60 + ((t * 60) | 0),
          })
          // the hot spot at the bite
          flare.facade.at(hit[0], hit[1], hit[2])
          flare.facade.burst(2, { ...FLARE_S, seed: 70 + ((t * 60) | 0) })
          // the reflection sparks: the cone rides the mirror direction,
          // grazing bites scatter WIDE (the curvature decides)
          C.reflections = (C.reflections ?? 0) + 1
          refSparks.facade.at(hit[0], hit[1], hit[2])
          refSparks.facade.burst(3, {
            ...RSPARKS_S,
            shape: { kind: 'cone', origin: [0, 0, 0], axis: [rx, ry, rz], halfAngle: 0.16 + 0.4 * (1 - incidence), baseRadius: 0.05, length: [0, 0.15] },
            seed: 80 + ((t * 60) | 0),
          })
          // the molten pops + the wisps (the slow residue of the burn)
          popT -= dt
          if (popT <= 0) {
            popT = 0.45 + Math.random() * 0.2
            C.pops = (C.pops ?? 0) + 1
            pops.facade.at(hit[0], hit[1], hit[2])
            pops.facade.burst(5, { ...POP_S, seed: 90 + ((t * 20) | 0) })
          }
          wispT -= dt
          if (wispT <= 0) {
            wispT = 0.13
            wisps.facade.at(hit[0], hit[1], hit[2])
            wisps.facade.burst(1, { ...WISP_S, seed: 95 + ((t * 20) | 0) })
          }
          // the heat beat: the recoil pulses with the beam (a cutting feel)
          recoil = 0.05 + 0.03 * Math.sin(t * 31)
          if (phaseT > BURN_T) {
            phase = 'boom'
            phaseT = 0
            destroyDrone(d)
          }
        } else if (phase === 'boom') {
          // the collapse plays out on the drone's scale (recorded above)
          if (phaseT > 0.35) { phase = 'dwell'; phaseT = 0 }
        } else {
          // dwell: pick the next drone (a fresh patrol when all are gone)
          if (phaseT > 1.0) {
            if (DRONES.every(dd => !dd.alive)) {
              for (const dd of DRONES) dd.alive = true
              env.log.event('laser: a fresh patrol flies in')
            }
            let next = droneIdx
            let guard = 0
            while (!DRONES[next].alive && guard++ < 6) next = (next + 1) % DRONES.length
            droneIdx = next
            const nd = DRONES[droneIdx]
            lock.facade.at(nd.x, nd.y, nd.z)
            lock.facade.burst(1, { ...LOCK_S, seed: 11 + droneIdx })
            phase = 'acquire'
            phaseT = 0
          }
        }

        for (const l of [lock, beamCore, beamHalo, flare, charge, refSparks, pops, wisps,
          boomFlash, boomRing, debris, boomSmoke]) l.facade.advance(dt)
      },
    }
  },
}
