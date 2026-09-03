// slash.js — a RUNE ORIGINAL (the Task 124 showcase): the weapon-trail
// game-feel demo — a greatsword arc with everything a combat VFX artist
// asks for:
//
//   · rateOverDistance — the edge GLINTS are shed per WORLD UNIT the blade
//     tip travels (40/u): the faster the swing, the denser the sparkle
//     band; the windup and recovery emit nothing;
//   · the RIBBON — one tip particle whose position is WRITTEN every frame
//     (the fields escape hatch — the "custom plugin" story) carries the
//     trail history: the classic weapon arc, one continuous ribbon;
//   · HIT-STOP — the whole simulation drops to 0.22× for 0.35 s at the
//     impact (the freeze-frame every action game ships), then a shock
//     ring + sparks + dust burst at the pillar;
//   · alternating forehand/backhand swings at two target pillars.
//
// The swing: a ~200° arc around the pivot, eased (slow windup, whip at
// the slash, settle). The blade is a manual LAMBERT slab oriented along
// the swing direction.
const CYCLE = 2.6 // forehand → impact → recover → backhand → impact → recover
const PHASES = [
  { windup: 0.55, slash: 0.22, settle: 0.53, from: -2.4, to: 0.7 }, // forehand
  { windup: 0.55, slash: 0.22, settle: 0.53, from: 0.7, to: -2.4 }, // backhand
]
const PIVOT = [0, 1.35, 0]
const TIP_R = 1.85 // the blade tip radius from the pivot

function ease(t) { return t * t * (3 - 2 * t) }

export default {
  title: 'Sword Slash',
  sub: 'rune original · rate over distance · weapon ribbon · hit-stop · impact',
  camera: { yaw: 0.5, pitch: 0.28, dist: 6.8, orbit: 0.04, target: [0, 1.25, 0] },

  make(env) {
    // ── the scene: the arena floor + the two target pillars ──
    env.addMesh({
      id: 'sl-floor',
      geometry: env.geometry.plane({ width: 40, height: 40 }),
      material: env.materials.lambert,
      model: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      uniforms: { u_albedo: [0.085, 0.085, 0.1, 1] },
    })
    // the pillars stand at the two arc ends
    const pillar = (id, ang) => {
      const x = Math.cos(ang) * (TIP_R + 0.35), z = Math.sin(ang) * (TIP_R + 0.35)
      env.addMesh({
        id,
        geometry: env.geometry.cube(0.5),
        material: env.materials.lambert,
        model: new Float32Array([0.5, 0, 0, 0, 0, 1.7, 0, 0, 0, 0, 0.5, 0, x, 0.85, z, 1]),
        uniforms: { u_albedo: [0.24, 0.21, 0.19, 1] },
      })
      return [x, z]
    }
    pillar('sl-pillar-a', PHASES[0].to)
    pillar('sl-pillar-b', PHASES[1].to)

    // ── the blade: a manual LAMBERT slab riding the arc ──
    const blade = env.addMesh({
      id: 'sl-blade',
      geometry: env.geometry.cube(1),
      material: env.materials.lambert,
      uniforms: { u_albedo: [0.82, 0.85, 0.9, 1] },
      manual: true,
    })
    const bladeModel = new Float32Array(16)

    // ── the edge glints: shed per WORLD UNIT (rateOverDistance) ──
    const GLINT_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [0.4, 1.8], life: [0.25, 0.5], size: [0.05, 0.12],
      color: [[0.85, 1, 1, 1], [0.4, 0.9, 1, 0.8]], seed: 31,
    }
    const glints = env.addLayer({
      id: 'sl-glints',
      facade: env.createParticles({
        capacity: 320, rateOverDistance: 42, inheritVelocity: 0.85,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.9, g: 1, b: 1, a: 1 },
          { t: 0.5, size: 0.55, r: 0.55, g: 0.9, b: 1, a: 0.7 },
          { t: 1, size: 0.1, r: 0.3, g: 0.7, b: 1, a: 0 },
        ]),
        forces: { gravity: [0, -3.5, 0], drag: 1.2 },
        spawner: GLINT_S,
        // STRETCHED ×0.85 inheritance: the glints ride the blade's motion,
        // so their velocity IS the tangent — they streak ALONG the arc
        // (the speed-line smear of a fast swing)
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.05 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.cfxrTextures.trait,
    })

    // ── the weapon ribbon: ONE tip particle, position WRITTEN per frame ──
    // (the fields escape hatch: the trail history follows the written
    // positions — the arc itself is the ribbon)
    const TIP_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0, 0], life: [1, 1], size: [0.1, 0.1],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 7,
    }
    const ribbon = env.addLayer({
      id: 'sl-ribbon',
      facade: env.createParticles({
        capacity: 2,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 0.92, g: 1, b: 1, a: 1 },
          { t: 0.7, size: 0.85, r: 0.5, g: 0.85, b: 1, a: 0.7 },
          { t: 1, size: 0.4, r: 0.25, g: 0.6, b: 1, a: 0 },
        ]),
        spawner: TIP_S,
        // points 30 at 60 Hz = 0.5 s of arc; length caps the ribbon 6.2
        // units behind the head; the width tapers in the baker
        render: { kind: 'trail', points: 30, step: 1 / 60, length: 6.2, width: 0.26 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.glowTexture,
    })

    // ── the impact: shock ring + sparks + dust (at the pillars) ──
    const SHOCK_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'fixed', dir: [0, 1, 0] },
      speed: [0.2, 0.5], life: [0.45, 0.6], size: [0.3, 0.45],
      color: [[1, 1, 1, 1], [0.8, 0.95, 1, 1]], seed: 37,
    }
    const shock = env.addLayer({
      id: 'sl-shock',
      facade: env.createParticles({
        capacity: 6,
        ramp: env.createRamp([
          { t: 0, size: 0.4, r: 0.95, g: 1, b: 1, a: 0.9, frame: 5 },
          { t: 0.6, size: 2.6, r: 0.6, g: 0.85, b: 1, a: 0.4, frame: 5 },
          { t: 1, size: 4.2, r: 0.4, g: 0.7, b: 1, a: 0, frame: 5 },
        ]),
        spawner: SHOCK_S,
        render: { kind: 'billboard', mode: 'horizontal', tiles: [4, 4] },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.additive,
      texture: () => env.atlasTexture,
    })
    const SPARK_S = {
      shape: { kind: 'sphere', origin: [0, 0, 0], radius: [0, 0.7] },
      velocity: { mode: 'radial' },
      speed: [3, 10], life: [0.25, 0.55], size: [0.025, 0.025],
      color: [[1, 1, 1, 1], [1, 1, 1, 1]], seed: 43,
    }
    const sparks = env.addLayer({
      id: 'sl-sparks',
      facade: env.createParticles({
        capacity: 72,
        ramp: env.createRamp([
          { t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 },
          { t: 0.5, size: 1, r: 1, g: 0.7, b: 0.3, a: 0.9 },
          { t: 1, size: 0.5, r: 0.9, g: 0.3, b: 0.1, a: 0 },
        ]),
        forces: { gravity: [0, -11, 0], limitSpeed: { limit: 0, dampen: 0.35 } },
        spawner: SPARK_S,
        render: { kind: 'billboard', mode: 'stretched', speedFactor: 0.09 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.cfxrTextures.trait,
    })
    const DUST_S = {
      shape: { kind: 'point', origin: [0, 0, 0] },
      velocity: { mode: 'radial' },
      speed: [1, 3.5], life: [0.7, 1.1], size: [0.35, 0.6],
      color: [[0.5, 0.48, 0.45, 0.5], [0.42, 0.4, 0.38, 0.35]], seed: 51,
    }
    const dust = env.addLayer({
      id: 'sl-dust',
      facade: env.createParticles({
        capacity: 64,
        ramp: env.createRamp([
          { t: 0, size: 0.3, r: 0.55, g: 0.52, b: 0.5, a: 0 },
          { t: 0.3, size: 1, r: 0.5, g: 0.47, b: 0.44, a: 0.4 },
          { t: 1, size: 2.2, r: 0.4, g: 0.38, b: 0.36, a: 0 },
        ]),
        forces: { gravity: [0, 0.8, 0], drag: 1.4 },
        spawner: DUST_S,
        render: { kind: 'billboard', tiles: [2, 2], frameJitter: 4, spin: 0.9 },
      }),
      material: env.materials.sprite,
      pipeline: env.pipelines.alpha,
      texture: () => env.cfxrTextures.smoke,
    })

    const layers = [glints, ribbon, shock, sparks, dust]
    // open MID-SLASH (not at the windup): the demo is instantly alive —
    // a slow CI runner's live-particle gate never races the first swing
    let t = 0.58
    let hitstop = 0 // seconds of slow-mo left
    let tipFired = false // the ribbon tip particle of THIS swing
    let prevPhase = 'windup' // the slash→settle TRANSITION is the impact

    // the swing angle at cycle-time t (one phase pair per CYCLE)
    function swingState(time) {
      let base = 0
      for (let p = 0; p < PHASES.length; p++) {
        const ph = PHASES[p]
        const dur = ph.windup + ph.slash + ph.settle
        if (time < base + dur || p === PHASES.length - 1) {
          const u = Math.min(time - base, dur)
          if (u < ph.windup) return { angle: ph.from, phase: 'windup', p }
          if (u < ph.windup + ph.slash) {
            const k = (u - ph.windup) / ph.slash
            return { angle: ph.from + (ph.to - ph.from) * ease(k), phase: 'slash', p, k }
          }
          return { angle: ph.to, phase: 'settle', p }
        }
        base += dur
      }
      return { angle: PHASES[0].from, phase: 'windup', p: 0 }
    }

    return {
      frame(ctx) {
        // ── the hit-stop: the sim AND this demo's clock (the swing itself)
        // freeze for a beat; the camera (the harness, on real dt) stays
        // live — the freeze-frame every action game ships ──
        let dt = ctx.dt
        if (hitstop > 0) {
          hitstop -= ctx.dt
          dt = ctx.dt * 0.22
        }
        // ── the stall guard: the swing clock never advances more than 1/30
        // per frame — a stall (a hidden tab, a slow machine) SLOWS the
        // fight, it never SKIPS it (a 0.22 s slash must never fall between
        // two frames; the integrator's own MAX_STEP substeps the physics) ──
        t += Math.min(dt, 1 / 30)

        const st = swingState(t % CYCLE)
        const ph = PHASES[st.p]
        const ang = st.angle

        // the blade direction: outward in XZ, slightly down (a horizontal
        // cut); the tip at radius TIP_R, the blade slab centered at 1.05
        const dlen = Math.hypot(Math.cos(ang), -0.14, Math.sin(ang))
        const dx = Math.cos(ang) / dlen, dy = -0.14 / dlen, dz = Math.sin(ang) / dlen
        const tipX = PIVOT[0] + dx * TIP_R, tipY = PIVOT[1] + dy * TIP_R, tipZ = PIVOT[2] + dz * TIP_R

        // the blade slab: local Y (long) → d; side = cross(ref, d)
        let sx = dz, sy = 0, sz = -dx
        const sl = Math.hypot(sx, sy, sz) || 1
        sx /= sl; sz /= sl
        const zx = sy * dz - sz * dy, zy = sz * dx - sx * dz, zz = sx * dy - sy * dx
        // scale the unit cube: X 0.06 (edge), Y 1.5 (length), Z 0.3 (width)
        bladeModel.fill(0)
        bladeModel[0] = sx * 0.06; bladeModel[1] = sy * 0.06; bladeModel[2] = sz * 0.06
        bladeModel[4] = dx * 1.5; bladeModel[5] = dy * 1.5; bladeModel[6] = dz * 1.5
        bladeModel[8] = zx * 0.3; bladeModel[9] = zy * 0.3; bladeModel[10] = zz * 0.3
        bladeModel[12] = PIVOT[0] + dx * 1.05; bladeModel[13] = PIVOT[1] + dy * 1.05; bladeModel[14] = PIVOT[2] + dz * 1.05
        bladeModel[15] = 1
        ctx.record(blade.command, { mvp: ctx.modelMvp(bladeModel), model: bladeModel, camPos: ctx.camEye })

        // the glints emitter rides the tip (rateOverDistance does the rest:
        // the windup barely emits, the slash sprays)
        glints.facade.at(tipX, tipY, tipZ)

        // ── the ribbon tip: fire ONE particle at the slash start, then
        //    WRITE its position every frame (the fields escape hatch) ──
        if (st.phase === 'slash' && !tipFired) {
          tipFired = true
          // the tip lives through the hit-stop so the arc trail LINGERS
          // frozen — the signature frame of the impact
          ribbon.facade.burst(1, { ...TIP_S, life: [ph.slash + 0.85, ph.slash + 0.85] })
        }
        if (st.phase !== 'slash' && st.phase !== 'windup') tipFired = false
        if (ribbon.facade.count > 0) {
          const f = ribbon.facade.fields
          f.px[0] = tipX; f.py[0] = tipY; f.pz[0] = tipZ
        }

        // ── the impact: the slash→settle TRANSITION (a k > 0.985 window is
        //    narrower than a slow frame's step — the transition always
        //    lands on a frame) ──
        if (prevPhase === 'slash' && st.phase === 'settle' && hitstop <= 0 && t > 0.3) {
          hitstop = 0.35
          const px = Math.cos(ph.to) * (TIP_R + 0.2), pz = Math.sin(ph.to) * (TIP_R + 0.2)
          shock.facade.at(px, 0.25, pz)
          shock.facade.burst(1, { ...SHOCK_S, seed: 300 + st.p })
          sparks.facade.at(px, 1.0, pz)
          sparks.facade.burst(34, { ...SPARK_S, seed: 400 + st.p })
          dust.facade.at(px, 0.5, pz)
          dust.facade.burst(14, { ...DUST_S, seed: 500 + st.p })
          env.log.event(`impact ${st.p === 0 ? 'forehand' : 'backhand'} — hit-stop`)
        }
        prevPhase = st.phase

        for (const l of layers) l.facade.advance(dt)
      },
    }
  },
}
