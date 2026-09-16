// forest/world.js — Task 223 — THE FOREST ITSELF.
//
// One tree, a dense forest: the asset's single podocarp instanced ~2.4k
// times over a gentle terrain, THE CELLS + THE BANDS carrying the LOD and
// the frustum on the CPU (zero per-instance GPU readbacks — the run lists
// are the records' own contiguous ranges).
//
//   · THE TERRAIN — @rune/prims' exact-mesh pair (the walker's own
//     bricks): the render soup and the planting sampler read ONE height
//     grid — the feet (the trunks' bases) and the pixels agree.
//   · THE PLANTING — a jittered grid (spacing S + a seeded jitter), a
//     CLEARING at the orbit center (the camera's amphitheater — the
//     demo's own stage wall of trees), per-instance YAW (any of 360° —
//     the single tree reads as a forest) and SCALE (0.8..1.3 — the
//     crown's variety). Every tree sits ON the terrain (the sampler's
//     own h(x,z) — the trunk base anchors, never floats).
//   · THE RECORDS — the occlusion layout contract verbatim (stride 12:
//     center 3, half 3, yaw 1, scale 1, spare 3): the cull kernel reads
//     center/half as the AABB (the yaw-inflated DISC — conservative for
//     any rotation), the tree shaders read yaw/scale (the draw's own).
//   · THE CELLS — 22×22 m tiles, the records SORTED by cell at build
//     time (a cell = one contiguous record range): the per-frame band
//     walker merges neighboring in-frustum cells into RUNS — a handful of
//     draw calls per band, zero per-instance CPU work.
//   · THE BANDS — the LOD ladder's distances (cell-center based):
//     [0,32) LOD0 full · [32,90) LOD1 · [90,175) LOD2 · [175,∞) LOD3.

import {
  terrain, terrainGrid, gridHeightSampler, heightHills,
} from '../../dist/rune.esm.js?v=223'

export const TERRAIN_SIZE = 512
export const TERRAIN_SEG = 128
export const SPACING = 15
export const CELL = 24
export const CLEARING_R = 24
export const BANDS = [32, 90, 175] // the LOD0..3 distance boundaries (m)

/** The mulberry32 — the planting's own deterministic source. */
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Builds the world: the terrain soup + the record store + the cell table.
 * `treeBBox` — the asset's normalized bounds (min/max, the tree's local
 * space, base at the origin). */
export function createWorld(treeBBox, opts = {}) {
  const N_TREES_TARGET = opts.trees ?? 2450
  // ── the terrain: gentle rolling hills (the forest floor) ───────────────
  const grid = terrainGrid(TERRAIN_SIZE, TERRAIN_SEG, heightHills(11), { amplitude: 6.5 })
  const soup = terrain(TERRAIN_SIZE, TERRAIN_SEG, heightHills(11), { amplitude: 6.5 })
  const h = gridHeightSampler(grid)

  // ── the tree's own footprint (the LOCAL bbox — the base at the origin) ──
  // THE TIGHT AABB LAW: the record's box is the yaw-EXACT rotated footprint
  // (the 4 corners rotated, the extents taken), never the yaw-inflated disc
  // — the podocarp's crown is 24×27 m; the disc (42×42) would swallow the
  // camera AND every neighbor at forest spacing, and a straddling box can
  // never be occluded (the first field of this demo's own smoke)
  const fx0 = treeBBox.min[0], fx1 = treeBBox.max[0]
  const fz0 = treeBBox.min[2], fz1 = treeBBox.max[2]
  const fy0 = treeBBox.min[1], fy1 = treeBBox.max[1]
  const H = fy1 - fy0

  // ── the planting: a jittered grid over the terrain ─────────────────────
  const rand = rng(223)
  const placed = []
  const half = TERRAIN_SIZE / 2 - SPACING
  const step = SPACING
  // the thinning: keep every `coarse`-th cell to land near the target
  // (the grid count / target — the OLD inverted math thinned NOTHING)
  const gridCount = Math.ceil(2 * half / step) ** 2
  const coarse = Math.max(1, Math.round(gridCount / Math.max(60, N_TREES_TARGET)))
  let skip = 0
  for (let gz = -half; gz <= half; gz += step) {
    for (let gx = -half; gx <= half; gx += step) {
      if (++skip % coarse !== 0 && coarse > 1) continue // thin to the target count
      const x = gx + (rand() - 0.5) * step * 0.9
      const z = gz + (rand() - 0.5) * step * 0.9
      const d = Math.hypot(x, z)
      if (d < CLEARING_R) continue // the amphitheater
      if (d > half * 1.02) continue
      const scale = 0.75 + rand() * 0.45
      const yaw = rand() * Math.PI * 2
      const y = h(x, z) - fy0 * scale // the trunk base anchors ON the terrain
      placed.push({ x, y, z, scale, yaw })
    }
  }
  const N = placed.length

  // ── the cells: records sorted by cell (a cell = a contiguous range) ────
  const CELLS_PER_SIDE = Math.ceil(TERRAIN_SIZE / CELL)
  const cellOf = (x, z) => {
    const cx = Math.min(CELLS_PER_SIDE - 1, Math.max(0, Math.floor((x + TERRAIN_SIZE / 2) / CELL)))
    const cz = Math.min(CELLS_PER_SIDE - 1, Math.max(0, Math.floor((z + TERRAIN_SIZE / 2) / CELL)))
    return cz * CELLS_PER_SIDE + cx
  }
  const byCell = new Map()
  for (let k = 0; k < placed.length; k++) {
    const c = cellOf(placed[k].x, placed[k].z)
    let arr = byCell.get(c)
    if (arr === undefined) { arr = []; byCell.set(c, arr) }
    arr.push(placed[k])
  }
  // the cells in index order, the records following
  const cellStart = new Int32Array(CELLS_PER_SIDE * CELLS_PER_SIDE).fill(-1)
  const cellCount = new Int32Array(CELLS_PER_SIDE * CELLS_PER_SIDE)
  const cellAABB = new Float32Array(CELLS_PER_SIDE * CELLS_PER_SIDE * 6)
  const trees = []
  let idx = 0
  for (let c = 0; c < CELLS_PER_SIDE * CELLS_PER_SIDE; c++) {
    const arr = byCell.get(c)
    if (arr === undefined) continue
    cellStart[c] = idx
    cellCount[c] = arr.length
    let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9
    for (const t of arr) {
      // THE TIGHT AABB: the 4 footprint corners, rotated by the instance's
      // own yaw — the exact extents (a disc would be 42×42 m and swallow
      // the camera at forest spacing)
      const cs = Math.cos(t.yaw), sn = Math.sin(t.yaw)
      const sc = t.scale
      const rx = [], rz = []
      for (const [lx, lz] of [[fx0, fz0], [fx0, fz1], [fx1, fz0], [fx1, fz1]]) {
        rx.push((lx * cs + lz * sn) * sc)
        rz.push((-lx * sn + lz * cs) * sc)
      }
      const hx = (Math.max(...rx) - Math.min(...rx)) / 2
      const hz = (Math.max(...rz) - Math.min(...rz)) / 2
      const ox = (Math.max(...rx) + Math.min(...rx)) / 2
      const oz = (Math.max(...rz) + Math.min(...rz)) / 2
      const hy = (H * sc) / 2
      const cx = t.x + ox, cy = t.y + fy0 * sc + hy, cz = t.z + oz
      trees.push({ x: t.x, y: t.y, z: t.z, cx, cy, cz, hx, hy, hz, yaw: t.yaw, scale: t.scale })
      mnx = Math.min(mnx, cx - hx); mxx = Math.max(mxx, cx + hx)
      mny = Math.min(mny, cy - hy); mxy = Math.max(mxy, cy + hy)
      mnz = Math.min(mnz, cz - hz); mxz = Math.max(mxz, cz + hz)
      idx++
    }
    const o = c * 6
    cellAABB[o] = mnx; cellAABB[o + 1] = mny; cellAABB[o + 2] = mnz
    cellAABB[o + 3] = mxx; cellAABB[o + 4] = mxy; cellAABB[o + 5] = mxz
  }

  // ── the scene words (the occlusion layout contract, verbatim) ──────────
  const LIST_WORDS = N // the compact's visible list (the device's own contract)
  const FLAGS_OFF = LIST_WORDS
  const HIST_OFF = FLAGS_OFF + N
  const INST_OFF = HIST_OFF + N
  const STRIDE = 12
  const sceneWords = new Uint32Array(INST_OFF + N * STRIDE)
  const sceneF32 = new Float32Array(sceneWords.buffer)
  for (let k = 0; k < N; k++) {
    const t = trees[k]
    const w = (INST_OFF + k * STRIDE) * 4
    sceneWords.fill(0x3f800000, INST_OFF + k * STRIDE + 8, INST_OFF + k * STRIDE + 10) // spare = 1.0 (unused)
    sceneF32[(INST_OFF + k * STRIDE) + 0] = t.cx
    sceneF32[(INST_OFF + k * STRIDE) + 1] = t.cy
    sceneF32[(INST_OFF + k * STRIDE) + 2] = t.cz
    sceneF32[(INST_OFF + k * STRIDE) + 3] = t.hx
    sceneF32[(INST_OFF + k * STRIDE) + 4] = t.hy
    sceneF32[(INST_OFF + k * STRIDE) + 5] = t.hz
    sceneF32[(INST_OFF + k * STRIDE) + 6] = t.yaw
    sceneF32[(INST_OFF + k * STRIDE) + 7] = t.scale
    void w
  }

  return {
    terrainGeometry: soup,
    terrainSampler: h,
    N, STRIDE,
    LIST_WORDS, FLAGS_OFF, HIST_OFF, INST_OFF,
    sceneWords, sceneF32,
    FIELDS: { center: 0, half: 3 },
    trees,
    cells: {
      side: CELLS_PER_SIDE,
      start: cellStart,
      count: cellCount,
      aabb: cellAABB,
      size: CELL,
    },
    treeExtents: { R: Math.max(fx1 - fx0, fz1 - fz0) / 2, H },
  }
}
