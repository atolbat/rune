// follow.js — three.quarks' FollowObjectDemo: a particle emitter ATTACHED
// to a moving object — a green box flying a wide circle, trailing sparks
// and smoke from its tail (their worldSpace: false — the emitter follows
// the object transform). Ours: facade.at() — the live emitter origin,
// updated every frame; the camera target FOLLOWS the box (their camera
// rides the circle with it).
export default {
  title: 'Follow Object',
  sub: 'emitter attached to a flying box · camera follows',
  camera: { yaw: 0.5, pitch: 0.3, dist: 9, orbit: 0, target: [0, 1, 0] },

  make(env) {
    // ── the flying object: a green LAMBERT box (a manual mesh layer — the
    //    model matrix is dynamic, recorded by this demo's frame) ──
    const cube = env.geometry.cube ? env.geometry.cube(0.55) : null
    const box = env.addMesh({
      id: 'follow-box',
      geometry: cube ?? env.geometry.capsule({ radius: 0.4, height: 0.5, radialSegments: 8, capSegments: 3 }),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.2, 0.85, 0.35, 1] },
      manual: true, // this demo records it with its own model matrix
    })
    // the box's model matrix (position + a banking roll), written per frame
    const boxModel = new Float32Array(16)

    // ── the exhaust: sparks (stretched additive) + smoke (alpha puffs) ──
    const sparks = env.addLayer({
      id: 'follow-sparks',
      facade: env.createParticles({
        capacity: 1200,
        rate: 320,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 0.95, b: 0.6, a: 1 },
          { t: 0.45, size: 0.6, r: 1, g: 0.6, b: 0.25, a: 0.9 },
          { t: 1, size: 0.08, r: 1, g: 0.35, b: 0.1, a: 0 },
        ]),
        forces: { gravity: [0, -2.5, 0], drag: 0.6, turbulence: 0.8 },
        spawner: {
          // a narrow cone BACKWARD from the box's motion (the tail jet)
          shape: { kind: 'cone', origin: [0, 0, 0], axis: [-1, 0.06, 0], halfAngle: 0.2, baseRadius: 0.06, length: [0, 0.02] },
          velocity: { mode: 'lobe' },
          speed: [2.2, 3.6], life: [0.8, 1.6], size: [0.08, 0.2],
          color: [[1, 0.95, 0.6, 1], [1, 0.55, 0.25, 1]], seed: 233,
        },
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.25 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
    })

    const smoke = env.addLayer({
      id: 'follow-smoke',
      facade: env.createParticles({
        capacity: 500,
        rate: 60,
        ramp: env.createRamp([
          { t: 0, size: 0.5, r: 0.5, g: 0.52, b: 0.56, a: 0, frame: 6 },
          { t: 0.2, size: 1, r: 0.55, g: 0.57, b: 0.6, a: 0.35, frame: 14 },
          { t: 1, size: 2.4, r: 0.45, g: 0.46, b: 0.5, a: 0, frame: 3 },
        ]),
        forces: { gravity: [0, 0.4, 0], drag: 1.1, turbulence: 0.6 },
        spawner: {
          shape: { kind: 'cone', origin: [0, 0, 0], axis: [-1, 0.1, 0], halfAngle: 0.4, baseRadius: 0.15, length: [0, 0.1] },
          velocity: { mode: 'lobe' },
          speed: [0.8, 1.8], life: [1.4, 2.4], size: [0.6, 1.1],
          color: [[0.6, 0.62, 0.66, 0.4], [0.72, 0.74, 0.78, 0.3]], seed: 239,
        },
        render: { kind: 'billboard', tiles: env.atlasTiles, spin: 0.8 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
    })

    // the flight: a wide circle, the box banking into the turn
    const RADIUS = 11
    const SPEED = 0.55 // rad/s
    let t = 0
    const boxPos = [0, 0, 0]

    return {
      frame(ctx) {
        t += ctx.dt * SPEED
        const x = Math.cos(t) * RADIUS
        const z = Math.sin(t) * RADIUS
        const y = 1.1 + Math.sin(t * 2.3) * 0.9
        boxPos[0] = x; boxPos[1] = y; boxPos[2] = z

        // the box's model: a Y rotation facing the motion + a banking roll
        const heading = t + Math.PI / 2 // the tangent direction
        const cy = Math.cos(heading), sy = Math.sin(heading)
        const roll = -0.5 // banking into the circle
        const cr = Math.cos(roll), sr = Math.sin(roll)
        // Ry(heading) · Rx(roll)
        boxModel.fill(0)
        boxModel[0] = cy; boxModel[2] = -sy
        boxModel[4] = sy * sr; boxModel[5] = cr; boxModel[6] = cy * sr
        boxModel[8] = sy * cr; boxModel[9] = -sr; boxModel[10] = cy * cr
        boxModel[12] = x; boxModel[13] = y; boxModel[14] = z
        boxModel[15] = 1
        // record the box with the DYNAMIC model (the manual layer)
        ctx.record(box.command, { mvp: ctx.mvp, model: boxModel, camPos: ctx.camEye })

        // the emitters ride the box: at() translates every spawn cloud to
        // its tail (a point ~0.9 behind the heading)
        const tailX = x - Math.cos(heading) * 0.9
        const tailZ = z - Math.sin(heading) * 0.9
        sparks.facade.at(tailX, y, tailZ)
        smoke.facade.at(tailX, y, tailZ)

        // the camera TARGET follows the box (their camera rides the circle)
        ctx.camTarget[0] = x
        ctx.camTarget[1] = y
        ctx.camTarget[2] = z

        sparks.facade.advance(ctx.dt)
        smoke.facade.advance(ctx.dt)
      },
    }
  },
}
