// walker/world.js — Task 216 — THE SEEDED PARKOUR WORLD.
//
// ONE source of truth for the renderer, the culler, and the FEET: the
// terrain's height grid (terrainGrid — the exact-mesh sampler's own
// bytes) builds both the render soup and the collision oracle; the
// props/movers live in the SAME 12-word records the GPU culls and draws
// (the occlusion demo's layout contract verbatim — [list N][flags N]
// [hist N][records 12N]); the octree is built from the records view
// (Task 213's front door — zero boxing), and the movers ride the FULL
// Task-211/212/213 path every frame: column writes → markRecordDirty →
// takeUploadRanges (coalesced, 4-aligned) → the tier's partial upload,
// with updateBox keeping the collision tree honest through the override
// lane (the node counts NEVER move — Task 212's law).
//
// THE COURSE anchors to a deterministic HEIGHT LADDER (a gentle climb
// from the spawn plaza into −z), so every hop is engineered against the
// character brick's tuned numbers (airtime 2·v0/g ≈ 0.75 s at walkSpeed
// 7.5 → a ~5.5 m flat jump; the gaps sit at 3.2..4.4, the rises ≤ 1.2)
// regardless of how the fBm hills run underneath — the terrain is always
// there to walk on (the ground oracle answers it first), the course
// floats above it as the parkour layer.
import {
  terrain, terrainGrid, gridHeightSampler, heightHills,
  buildOctreeRecords, recordView, adoptStore,
} from '../../dist/rune.esm.js?v=222'

export const TERRAIN_SIZE = 512
export const TERRAIN_SEG = 128 // step 4 m exactly (the sampler's power-of-two round trip)
export const TERRAIN_AMP = 15
const RELIEF = heightHills(7)

// the walker's tuned body (the character brick's spec — the course's
// gaps are engineered against THESE numbers; airStepUp — the Task-217
// ledge save: a jump clipping a platform's face pops onto the top)
export const BODY = {
  radius: 0.38, height: 1.7, walkSpeed: 7.5, accelGround: 55, accelAir: 16,
  gravity: 22, jumpSpeed: 8.2, stepHeight: 0.62, airStepUp: 0.35, coyoteTime: 0.12,
  jumpBuffer: 0.15, maxFall: 55, snapDown: 0.2, fixedDt: 1 / 120,
}
export const EYE_HEIGHT = 1.62

export function createWorld(crowdCount = 7000) {
  // ── the terrain: grid (collision) + soup (render) + sampler ──────────
  const grid = terrainGrid(TERRAIN_SIZE, TERRAIN_SEG, RELIEF, { amplitude: TERRAIN_AMP })
  const soup = terrain(TERRAIN_SIZE, TERRAIN_SEG, RELIEF, { amplitude: TERRAIN_AMP })
  const h = gridHeightSampler(grid)

  // ── the deterministic rng (xorshift32 — the demo family's own) ───────
  let seed = 0x216216
  const rng = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }

  // ── the records: the occlusion layout contract, verbatim ─────────────
  const records = []
  function put(cx, cy, cz, hx, hy, hz, r, g, b, kind) {
    records.push({ cx, cy, cz, hx, hy, hz, r, g, b, kind })
    return records.length - 1
  }
  const PAL = {
    slab: [0.62, 0.58, 0.52], plat: [0.83, 0.55, 0.30], platB: [0.90, 0.70, 0.34],
    stair: [0.55, 0.55, 0.58], tower: [0.42, 0.47, 0.56], ledge: [0.35, 0.55, 0.52],
    beam: [0.50, 0.42, 0.38], mover: [0.95, 0.62, 0.16], rock: [0.36, 0.33, 0.30],
    wall: [0.30, 0.32, 0.36], pad: [0.30, 0.55, 0.50],
  }
  const tint = (p, k = 0.85 + rng() * 0.3) => [p[0] * k, p[1] * k, p[2] * k]

  // ── THE COURSE: spawn plaza at (0, 20), stations into −z ────────────
  // ANCHORING POLICY (the round's own lesson): every structural piece
  // anchors to the LOCAL terrain h(x, z) with small offsets — each station
  // reachable from the ground beneath it (a missed hop lands on the
  // terrain, and the course continues from there); the CHAIN pieces
  // (stairs → landing → elevator) connect level-to-level explicitly.
  const plazaH = h(0, 20)
  put(0, plazaH - 0.2, 20, 8, 0.45, 8, ...tint(PAL.slab), 'slab') // top = plazaH + 0.25

  // station B — the platform run: 6 hops, each INDEPENDENTLY jumpable
  // from the terrain under it (top ≤ ground + 1.2, gap 3.2..4.2)
  let pz = 12
  for (let k = 0; k < 6; k++) {
    const x = (k % 2 === 0 ? -1 : 1) * 1.6
    const top = h(x, pz) + 0.9 + (k % 3) * 0.15 // +0.9..+1.2 — the arc (apex 1.45) clears every platform
    const gap = 3.2 + rng() * 1.0
    put(x, top - 0.28, pz, 1.25, 0.28, 1.25, ...tint(k % 2 ? PAL.platB : PAL.plat), 'plat')
    pz -= gap + 2.5
  }
  const runEndZ = pz + 2.5 + 1.25 // the last platform's far edge

  // station C — the staircase (10 steps, 0.55 rise, 1.1 run): the FIRST
  // step is one step-up from the local terrain; the chain climbs to the
  // landing pad — the ONLY route up (that is the point of stairs).
  // Task 217 (the field report's stairs): the steps widened 3.2 → 4.4 m
  // (the analog stick's drift deserves room) and the pad's near edge is
  // FLUSH with the last step's far edge (the old 0.15 m seam dropped the
  // body the moment the CENTER crossed it — the point ray's blind spot)
  const stairZ = runEndZ - 4.5
  const stairBase = h(0, stairZ)
  for (let s = 0; s < 10; s++) {
    const top = stairBase + 0.55 + s * 0.55
    const depth = top - (stairBase - 2) // every step reaches 2 m below — no gaps on slopes
    put(0, top - depth / 2, stairZ - s * 1.1, 2.2, depth / 2, 0.55, ...tint(PAL.stair), 'stair')
  }
  const stairTop = stairBase + 10 * 0.55 + 0.55
  const landingZ = stairZ - 10 * 1.1 - 2.2
  put(0, stairTop - 0.25, landingZ, 2.2, 0.25, 2.75, ...tint(PAL.pad), 'pad')

  // station D — THE ELEVATOR: swings so its TOP passes the landing pad's
  // level (board at the pad, ride — the carry law), adjacent to the pad
  const elevZ = landingZ - 4.5 // the pad's far edge landingZ−2.6, the platform's near edge elevZ+1.35 — a step across
  const elevBase = stairTop - 5.15 // swing: [stairTop−4.9, stairTop+0.25]

  // station E — the ferry gap: pad A AT the landing-pad level (adjacent to
  // the elevator), the platform slides the 11 m to pad B at the tower
  const ferryZ0 = elevZ - 6.5
  const ferryZ1 = ferryZ0 - 11
  const ferryY = stairTop
  put(0, ferryY - 0.3, ferryZ0, 1.4, 0.3, 1.4, ...tint(PAL.pad), 'pad')
  put(0, ferryY - 0.3, ferryZ1, 1.4, 0.3, 1.4, ...tint(PAL.pad), 'pad')

  // station F — the tower (terrain-anchored) + the express (ground → the
  // top) + the ledge ladder (an alternate climb, each step jumpable)
  const towerZ = ferryZ1 - 11
  const towerBase = h(0, towerZ) + 0.4
  const towerH = 7.5
  const towerTop = towerBase + towerH
  put(0, towerBase + towerH / 2, towerZ, 2.6, towerH / 2, 2.6, ...tint(PAL.tower), 'tower')
  for (let l = 0; l < 5; l++) {
    const a = l * Math.PI * 0.8
    put(Math.cos(a) * 3.7, towerBase + 1.05 + l * 1.15, towerZ + Math.sin(a) * 3.7, 0.95, 0.22, 0.95, ...tint(PAL.ledge), 'ledge')
  }

  // station G — the arch: the beam one hop past the tower's top (the
  // pillar ledges are the alternate climb), spanning the course's exit
  const archZ = towerZ - 6.5
  const archBase = towerBase
  const beamTop = towerTop + 0.3
  const beamCy = beamTop - 0.5
  const pillarH = beamCy - 0.5 - archBase
  put(-4, archBase + pillarH / 2, archZ, 0.8, pillarH / 2, 0.8, ...tint(PAL.tower), 'pillar')
  put(4, archBase + pillarH / 2, archZ, 0.8, pillarH / 2, 0.8, ...tint(PAL.tower), 'pillar')
  put(0, beamCy, archZ, 5.4, 0.5, 0.9, ...tint(PAL.beam), 'beam')
  for (let l = 0; l < 4; l++) {
    put(-2.4, archBase + 1.0 + l * 1.15, archZ, 0.65, 0.18, 0.65, ...tint(PAL.ledge), 'ledge')
  }

  // station H — the finish pad (a leap down from the beam)
  const finishZ = archZ - 9
  put(0, h(0, finishZ) - 0.05, finishZ, 4.5, 0.45, 4.5, ...tint(PAL.pad), 'pad')

  // ── THE MOVERS (the last structural ids — stable, dynamic, dirty) ────
  const moverOf = new Map() // id → mover (the oracle's velocity source)
  const elevatorId = put(0, elevBase, elevZ, 1.35, 0.25, 1.35, ...PAL.mover, 'mover')
  const ferryId = put(0, ferryY, (ferryZ0 + ferryZ1) / 2, 1.35, 0.25, 1.35, ...PAL.mover.map(c => c * 0.85), 'mover')
  const expressId = put(3.4, towerBase + 0.5, towerZ, 1.05, 0.22, 1.05, ...PAL.mover.map(c => c * 0.7), 'mover')
  const MOVERS = [
    { id: elevatorId, base: [0, elevBase, elevZ], axis: 1, amp: 5.4, period: 7, phase: 0, hx: 1.35, hy: 0.25, hz: 1.35 },
    { id: ferryId, base: [0, ferryY, (ferryZ0 + ferryZ1) / 2], axis: 2, amp: (ferryZ0 - ferryZ1) / 2, period: 9, phase: Math.PI, hx: 1.35, hy: 0.25, hz: 1.35 },
    { id: expressId, base: [3.4, towerBase + 0.5, towerZ], axis: 1, amp: towerH - 0.9, period: 6, phase: 0, hx: 1.05, hy: 0.22, hz: 1.05 },
  ]

  // the path math (analytic position AND velocity — the carry reads them)
  function moverPos(m, t) {
    const s = (1 - Math.cos(2 * Math.PI * t / m.period + m.phase)) * 0.5
    const p = [m.base[0], m.base[1], m.base[2]]
    p[m.axis] += m.amp * s
    return p
  }
  function moverVel(m, t) {
    const w = 2 * Math.PI / m.period
    const v = m.amp * w * 0.5 * Math.sin(w * t + m.phase)
    const out = [0, 0, 0]
    out[m.axis] = v
    return out
  }
  for (const m of MOVERS) {
    m.vx = 0; m.vy = 0; m.vz = 0
    moverOf.set(m.id, m)
    const p = moverPos(m, 0) // the record starts AT the path's t=0 point
    const rec = records[m.id]
    rec.cx = p[0]; rec.cy = p[1]; rec.cz = p[2]
  }

  // ── THE CROWD (the culling showcase — the occlusion demo's own scale) ─
  for (let k = 0; k < crowdCount; k++) {
    let x = 0, z = 0
    for (let tries = 0; tries < 24; tries++) {
      x = (rng() * 2 - 1) * (TERRAIN_SIZE / 2 - 12)
      z = (rng() * 2 - 1) * (TERRAIN_SIZE / 2 - 12)
      if (Math.abs(x) < 13 && z < 32 && z > finishZ - 8) continue // the course corridor stays clean
      break
    }
    const roll = rng()
    let hx, hy, hz, pal
    if (roll < 0.62) { hx = 0.25 + rng() * 0.7; hy = hx * (0.6 + rng() * 0.8); hz = hx; pal = PAL.rock }
    else if (roll < 0.86) { hx = 0.5 + rng() * 0.9; hy = 0.5 + rng() * 1.2; hz = hx; pal = PAL.wall }
    else { hx = 1.2 + rng() * 1.6; hy = 1.4 + rng() * 1.8; hz = 0.5 + rng() * 0.7; pal = PAL.wall }
    put(x, h(x, z) + hy * 0.35, z, hx, hy, hz, ...tint(pal, 0.75 + rng() * 0.5), 'crowd')
  }

  // ── the layout words (the occlusion contract) ─────────────────────────
  const N = records.length
  const LIST_WORDS = N
  const FLAGS_OFF = N
  const HIST_OFF = 2 * N
  const INST_OFF = 3 * N
  const sceneWords = new Uint32Array(N * 3 + N * 12)
  const sceneF32 = new Float32Array(sceneWords.buffer)
  for (let i = 0; i < N; i++) {
    const rec = records[i]
    const wo = INST_OFF + i * 12
    sceneF32[wo] = rec.cx; sceneF32[wo + 1] = rec.cy; sceneF32[wo + 2] = rec.cz
    sceneF32[wo + 3] = rec.hx; sceneF32[wo + 4] = rec.hy; sceneF32[wo + 5] = rec.hz
    sceneF32[wo + 6] = rec.r; sceneF32[wo + 7] = rec.g; sceneF32[wo + 8] = rec.b
  }
  const STRIDE = 12
  const FIELDS = { center: 0, half: 3, color: 6 }

  // ── the store (Task 211 adoption — zero copies, dirty ranges) ────────
  const sceneStore = adoptStore(sceneWords.buffer, [{ name: 'rec', kind: 'f32', width: 12 }], N, INST_OFF * 4)

  // ── the collision tree (Task 213 records front door — zero boxing) ───
  const view = recordView(sceneF32, INST_OFF, N, STRIDE, FIELDS)
  const octree = buildOctreeRecords(view)

  // ── THE GROUND ORACLE (the character brick's world) ──────────────────
  // Task 217 — THE FOOTPRINT PROBE: five columns — the center + the four
  // toe corners at 0.7·radius — answer as ONE ground (the highest walkable
  // top under ANY column). The Task-216 point ray dropped the body the
  // moment the CENTER left a surface (the field report's icy platform
  // edges, the stair→pad seam); the toes keep it standing to the last 30%
  // of the foot — the platformer edge law. The fromY ceiling stays the
  // CALLER's: a surface above the feet is never ground (the carry probe's
  // own discipline — the toes must not snap the body onto higher boxes).
  const FOOT = BODY.radius * 0.7
  const COLX = [0, -FOOT, FOOT, -FOOT, FOOT]
  const COLZ = [0, -FOOT, -FOOT, FOOT, FOOT]
  const oracle = {
    groundBelow(x, z, fromY, out) {
      let best = -Infinity
      let bestId = -1
      const lim = fromY + 1e-3
      for (let c = 0; c < 5; c++) {
        const th = h(x + COLX[c], z + COLZ[c])
        if (th <= lim && th > best) { best = th; bestId = -1 }
      }
      // the ray law over the footprint: one box query over the five
      // columns' hull, the per-box test = any column inside its x/z span
      const hits = octree.queryBox([x - FOOT, fromY - 500, z - FOOT], [x + FOOT, lim, z + FOOT])
      for (let k = 0; k < hits.length; k++) {
        const id = hits[k]
        const wo = INST_OFF + id * 12
        const top = sceneF32[wo + 1] + sceneF32[wo + 4]
        if (top > lim || top <= best) continue
        const bx = sceneF32[wo], bz = sceneF32[wo + 2]
        const hx = sceneF32[wo + 3], hz = sceneF32[wo + 5]
        for (let c = 0; c < 5; c++) {
          if (Math.abs(x + COLX[c] - bx) <= hx && Math.abs(z + COLZ[c] - bz) <= hz) {
            best = top
            bestId = id
            break
          }
        }
      }
      if (best === -Infinity) return false
      out.top = best
      out.mover = bestId
      const m = moverOf.get(bestId)
      if (m !== undefined) { out.vx = m.vx; out.vy = m.vy; out.vz = m.vz }
      else { out.vx = 0; out.vy = 0; out.vz = 0 }
      return true
    },
    boxesIn(x0, y0, z0, x1, y1, z1, out) {
      const ids = octree.queryBox([x0, y0, z0], [x1, y1, z1])
      let n = 0
      for (let k = 0; k < ids.length && n < out.length; k++) out[n++] = ids[k]
      return n
    },
    boxAt(id, out) {
      if (id < 0 || id >= N) return false
      const wo = INST_OFF + id * 12
      out[0] = sceneF32[wo]; out[1] = sceneF32[wo + 1]; out[2] = sceneF32[wo + 2]
      out[3] = sceneF32[wo + 3]; out[4] = sceneF32[wo + 4]; out[5] = sceneF32[wo + 5]
      return true
    },
  }

  // ── THE MOVERS' TICK (the full Task-211/212/213 path, live) ──────────
  function tickMovers(t) {
    for (const m of MOVERS) {
      const p = moverPos(m, t)
      const v = moverVel(m, t)
      const wo = INST_OFF + m.id * 12
      sceneF32[wo] = p[0]; sceneF32[wo + 1] = p[1]; sceneF32[wo + 2] = p[2]
      m.vx = v[0]; m.vy = v[1]; m.vz = v[2]
      sceneStore.markRecordDirty(m.id)
      octree.updateBox(m.id, p[0], p[1], p[2], m.hx, m.hy, m.hz)
    }
    const ranges = sceneStore.takeUploadRanges()
    let bytes = 0
    for (const r of ranges) bytes += r.end - r.start
    return { ranges, bytes }
  }

  return {
    scene: { K: 40, N, STRIDE, FIELDS, LIST_WORDS, FLAGS_OFF, HIST_OFF, INST_OFF, sceneWords, sceneF32 },
    soup, sampler: h, grid, oracle, octree, sceneStore,
    movers: MOVERS, moverOf, tickMovers, moverPos, moverVel,
    spawn: { x: 0, y: plazaH + 0.25, z: 18, yaw: 0 },
    course: { plazaH, stairZ, stairBase, stairTop, landingZ, elevZ, elevBase, ferryY, ferryZ0, ferryZ1, towerZ, towerBase, towerH, towerTop, archZ, archBase, finishZ },
  }
}
