// rocket.js — a RUNE ORIGINAL (the Task 124 showcase): a cruise missile
// launch-and-strike — the game-designer's "projectile with a real trail"
// problem, solved with the new emitter-motion family:
//
//   · inheritVelocity — the engine SMOKE rides 0.75 of the missile's own
//     velocity: it streams behind the flight path and billows where the
//     missile actually flew, instead of blooming in place (the classic
//     game-engine "inherit velocity" knob, the thing that makes rocket
//     trails read as ROCKET trails);
//   · rateOverDistance — the spark debris is shed per WORLD UNIT traveled
//     (6/u): the trail tracks the speed, not the clock (the pause between
//     launches emits nothing);
//   · at() — every emitter rides the moving nozzle;
//   · onRetire-style sequencing — at the strike: flash + sparks + smoke
//     burst (a miniature of the explosion demo, same cfxr textures).
//
// The flight: a cubic Bézier from the pad up over the field into the target
// marker, ~3.4 s, eased (slow launch, terminal dive). The body is a manual
// LAMBERT capsule oriented along the velocity; the camera target lerps
// after it.
const FLIGHT = 3.4 // seconds pad → target
const PAUSE = 1.1 // smoke settles before the next launch
const TOTAL = FLIGHT + PAUSE

// the Bézier: pad (−6, 0.6, −2) → over the field (0, 7.5, −7.5) → target
const P0 = [-6, 0.6, -2], P1 = [-1.5, 8.5, -9], P2 = [3.5, 6.2, -5.5], P3 = [6.2, 0.55, 1.6]
function bez(t, o, a, b, c) {
  const u = 1 - t
  return u * u * u * o + 3 * u * u * t * a + 3 * u * t * t * b + t * t * t * c
}
function bezD(t, o, a, b, c) {
  const u = 1 - t
  return 3 * u * u * (a - o) + 6 * u * t * (b - a) + 3 * t * t * (c - b)
}

export default {
  title: 'Rocket',
  sub: 'rune original · inherit velocity · rate over distance · strike loop',
  camera: { yaw: 0.9, pitch: 0.34, dist: 13.5, orbit: 0.05, target: [0, 1.6, -2] },

  make(env) {
    // ── the scene: a dark field, the pad, the target marker ──
    env.addMesh({
      id: 'rk-floor',
      geometry: env.geometry.plane({ width: 90, height: 90 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      uniforms: { u_albedo: [0.075, 0.085, 0.1, 1] },
    })
    // the launch pad: a low dark box at P0
    env.addMesh({
      id: 'rk-pad',
      geometry: env.geometry.cube(1.6),
      material: env.materials.lambert,
      model: new Float32Array([1.6, 0, 0, 0, 0, 0.45, 0, 0, 0, 0, 1.6, 0, P0[0], 0.22, P0[2], 1]),
      uniforms: { u_albedo: [0.16, 0.17, 0.2, 1] },
    })
    // the target marker: a small red-lit box at the strike point
    env.addMesh({
      id: 'rk-target',
      geometry: env.geometry.cube(0.9),
      material: env.materials.lambert,
      model: new Float32Array([1.1, 0, 0, 0, 0, 0.32, 0, 0, 0, 0, 1.1, 0, P3[0], 0.16, P3[2], 1]),
      uniforms: { u_albedo: [0.42, 0.1, 0.08, 1] },
    })

    // ── the missile body: a manual LAMBERT capsule riding the path ──
    const body = env.addMesh({
      id: 'rk-body',
      geometry: env.geometry.capsule({ radius: 0.13, height: 0.85, radialSegments: 10, capSegments: 4 }),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.72, 0.74, 0.78, 1] },
      manual: true, // this demo records it with its own per-frame model
    })
    const bodyModel = new Float32Array(16)

    // ── the engine flame: a scatter core clinging to the nozzle ──
    // (point + RADIAL now SCATTERS in every direction — the Task 124 fix —
    // and 0.92 inheritance keeps the plume flying WITH the missile while the
    // small radial speed separates it: a proper flame wake)
    const FLAME_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [1.2, 3.2], life: [0.1, 0.22], size: [0.22, 0.4],
      color: [[1, 0.85, 0.45, 1], [1, 0.45, 0.12, 1]], seed: 41,
    }
    const flame = env.addLayer({
      id: 'rk-flame',
      facade: env.createParticles({
        capacity: 220, rate: 340, inheritVelocity: 0.92,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.9, b: 0.6, a: 1 },
          { t: 0.5, size: 0.75, r: 1, g: 0.55, b: 0.18, a: 0.85 },
          { t: 1, size: 0.25, r: 0.9, g: 0.2, b: 0.05, a: 0 },
        ]),
        forces: { drag: 2.2 },
        spawner: FLAME_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.06 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the engine smoke: THE inheritance showcase ──
    // 0.75 of the missile velocity + slow buoyant rise + drag: the column
    // streams along the real flight path
    const SMOKE_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [0.4, 1.4], life: [2.0, 3.2], size: [0.5, 0.9],
      color: [[0.62, 0.63, 0.66, 0.5], [0.5, 0.51, 0.54, 0.38]], seed: 47,
    }
    const smoke = env.addLayer({
      id: 'rk-smoke',
      facade: env.createParticles({
        capacity: 640, rate: 90, inheritVelocity: 0.75,
        ramp: env.createRamp([
          { t: 0, size: 0.3, r: 0.66, g: 0.66, b: 0.68, a: 0 },
          { t: 0.12, size: 0.85, r: 0.68, g: 0.66, b: 0.63, a: 0.5 },
          { t: 0.55, size: 2.1, r: 0.55, g: 0.55, b: 0.57, a: 0.3 },
          { t: 1, size: 3.4, r: 0.42, g: 0.42, b: 0.45, a: 0 },
        ]),
        forces: { gravity: [0, 0.55, 0], drag: 0.85, turbulence: 0.35 },
        spawner: SMOKE_S,
        render: { kind: 'billboard', tiles: [2, 2], frameJitter: 4, spin: 0.5 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.smokeAtlas,
    })

    // ── the debris sparks: shed per WORLD UNIT (rateOverDistance) ──
    const DEBRIS_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [0.6, 2.4], life: [0.5, 1.1], size: [0.04, 0.09],
      color: [[1, 0.8, 0.4, 1], [1, 0.4, 0.1, 1]], seed: 53,
    }
    const debris = env.addLayer({
      id: 'rk-debris',
      facade: env.createParticles({
        capacity: 260, rateOverDistance: 7, inheritVelocity: 0.55,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.85, b: 0.5, a: 1 },
          { t: 0.7, size: 0.5, r: 1, g: 0.45, b: 0.12, a: 0.7 },
          { t: 1, size: 0.1, r: 0.8, g: 0.2, b: 0.05, a: 0 },
        ]),
        forces: { gravity: [0, -7, 0], drag: 0.4 },
        spawner: DEBRIS_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.05 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.sparkTexture,
    })

    // ── the STRIKE: a miniature of the explosion demo ──
    const FLASH_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [0.34, 0.34], size: [5, 5],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 61,
    }
    const strikeFlash = env.addLayer({
      id: 'rk-strike-flash',
      facade: env.createParticles({
        capacity: 4,
        ramp: env.createRamp([
          { t: 0, size: 0.55, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.3, size: 0.8, r: 1, g: 0.75, b: 0.2, a: 1 },
          { t: 1, size: 1, r: 1, g: 0.25, b: 0.05, a: 0.55 },
        ]),
        spawner: FLASH_S,
        render: { kind: 'billboard', mode: 'oriented', axis: [0, 0, 1] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.flashTexture,
    })
    const SPARKS_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 1.2] },
      velocity: { mode: 'radial' },
      speed: [4, 14], life: [0.3, 0.7], size: [0.03, 0.03],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 67,
    }
    const strikeSparks = env.addLayer({
      id: 'rk-strike-sparks',
      facade: env.createParticles({
        capacity: 96,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.4, size: 1, r: 1, g: 0.6, b: 0.15, a: 1 },
          { t: 1, size: 0.6, r: 0.9, g: 0.15, b: 0, a: 0 },
        ]),
        forces: { gravity: [0, -9, 0], limitSpeed: { limit: 0, dampen: 0.3 } },
        spawner: SPARKS_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.1 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.sparkTexture,
    })
    const BURN_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [2, 6], life: [1.0, 1.6], size: [1.2, 2.2],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 71,
    }
    const strikeSmoke = env.addLayer({
      id: 'rk-strike-smoke',
      facade: env.createParticles({
        capacity: 48,
        ramp: env.createRamp([
          { t: 0, size: 0.15, r: 1, g: 0.9, b: 0.6, a: 1 },
          { t: 0.2, size: 0.5, r: 1, g: 0.5, b: 0.15, a: 0.9 },
          { t: 0.45, size: 0.8, r: 0.5, g: 0.48, b: 0.46, a: 0.7 },
          { t: 1, size: 1.6, r: 0.4, g: 0.4, b: 0.42, a: 0 },
        ]),
        forces: { gravity: [0, 0.8, 0], limitSpeed: { limit: 0.4, dampen: 0.2 } },
        spawner: BURN_S,
        render: { kind: 'billboard', tiles: [2, 2], frameJitter: 4, spin: 0.7 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.smokeAtlas,
    })

    const layers = [flame, smoke, debris, strikeFlash, strikeSparks, strikeSmoke]
    const emitters = [flame, smoke, debris]
    let t = 0
    let struckCycle = -1 // the cycle index whose strike has fired
    let camX = 0, camY = 1.6, camZ = -2

    return {
      frame(ctx) {
        t += ctx.dt
        const cycle = t % TOTAL
        const flying = cycle < FLIGHT

        if (flying) {
          // the eased path parameter: slow ignition, terminal dive
          const k = cycle / FLIGHT
          const s = k * k * (3 - 2 * k) * 0.35 + k * 0.65 // smoothstep blend
          const px = bez(s, P0[0], P1[0], P2[0], P3[0])
          const py = bez(s, P0[1], P1[1], P2[1], P3[1])
          const pz = bez(s, P0[2], P1[2], P2[2], P3[2])
          const dx = bezD(s, P0[0], P1[0], P2[0], P3[0])
          const dy = bezD(s, P0[1], P1[1], P2[1], P3[1])
          const dz = bezD(s, P0[2], P1[2], P2[2], P3[2])
          const dl = Math.hypot(dx, dy, dz) || 1

          // the body: the capsule's local Y (its LONG axis) aims along the
          // velocity. Column-major: col X = side, col Y = forward, col Z =
          // cross(side, forward) — a proper right-handed basis. The side
          // axis comes off a reference (world Y, or world Z when the flight
          // is near-vertical — the launch climb).
          const nx = dx / dl, ny = dy / dl, nz = dz / dl
          let sx = nz, sy = 0, sz = -nx
          if (Math.abs(ny) > 0.95) { sx = -ny; sy = nx; sz = 0 }
          const sl = Math.hypot(sx, sy, sz) || 1
          sx /= sl; sy /= sl; sz /= sl
          // Z = cross(side, forward)
          const zx = sy * nz - sz * ny, zy = sz * nx - sx * nz, zz = sx * ny - sy * nx
          bodyModel.fill(0)
          bodyModel[0] = sx; bodyModel[1] = sy; bodyModel[2] = sz
          bodyModel[4] = nx; bodyModel[5] = ny; bodyModel[6] = nz
          bodyModel[8] = zx; bodyModel[9] = zy; bodyModel[10] = zz
          bodyModel[12] = px - nx * 0.45; bodyModel[13] = py - ny * 0.45; bodyModel[14] = pz - nz * 0.45
          bodyModel[15] = 1
          ctx.record(body.command, { mvp: ctx.modelMvp(bodyModel), model: bodyModel, camPos: ctx.camEye })

          // every emitter rides the NOZZLE — the actual tail: the capsule
          // is radius 0.13 × height 0.85 (total length ≈ 1.11, half 0.555)
          // and the body center sits 0.45 behind the path point, so the
          // tail is ~1.0 behind it. The old 0.58 put the flame nearly
          // MID-BODY ("the jet flame is in the middle of the rocket").
          const nxz = px - nx * 1.03, nyz = py - ny * 1.03, nzz = pz - nz * 1.03
          for (const l of emitters) l.facade.at(nxz, nyz, nzz)

          // the camera target chases the missile
          camX += (px - camX) * Math.min(1, ctx.dt * 3)
          camY += (py - camY) * Math.min(1, ctx.dt * 3)
          camZ += (pz - camZ) * Math.min(1, ctx.dt * 3)
          ctx.camTarget[0] = camX; ctx.camTarget[1] = camY; ctx.camTarget[2] = camZ
        } else {
          // between launches: drift the camera target back to the field center
          camX += (0 - camX) * Math.min(1, ctx.dt * 1.2)
          camY += (1.6 - camY) * Math.min(1, ctx.dt * 1.2)
          camZ += (-2 - camZ) * Math.min(1, ctx.dt * 1.2)
          ctx.camTarget[0] = camX; ctx.camTarget[1] = camY; ctx.camTarget[2] = camZ
          // the strike fires ONCE per cycle, the first frame past the
          // landing (the cycle INDEX guards it — a frame-timing guard like
          // `cycle - FLIGHT < dt` misfires on the NEXT launch under slow
          // frames)
          const cycleIndex = Math.floor(t / TOTAL)
          if (struckCycle !== cycleIndex) {
            struckCycle = cycleIndex
            // the blast at the target marker (explicit — the last flight
            // frame may have landed a frame-width short of it)
            strikeFlash.facade.at(P3[0], P3[1] + 0.35, P3[2])
            strikeSparks.facade.at(P3[0], P3[1] + 0.5, P3[2])
            strikeSmoke.facade.at(P3[0], P3[1] + 0.4, P3[2])
            strikeFlash.facade.burst(1, { ...FLASH_S, seed: 900 + cycleIndex * 17 })
            strikeSparks.facade.burst(46, { ...SPARKS_S, seed: 901 + cycleIndex * 17 })
            strikeSmoke.facade.burst(24, { ...BURN_S, seed: 902 + cycleIndex * 17 })
            env.log.event(`strike #${cycleIndex} at the target marker`)
          }
        }

        for (const l of layers) l.facade.advance(ctx.dt)
      },
    }
  },
}
