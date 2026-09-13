// occlusion/scene.js — Task 197: the SHARED SCENE, extracted from main.js
// so the two backend tiers (WebGPU / WebGL2) build the EXACT same world —
// the cross-tier pixel-parity gate depends on it: same boxes, same colors,
// same cameras, same Hi-Z tile geometry, bit for bit.
//
// The scene is a city canyon: 23 occluders (ground, 20 buildings, 2 towers)
// and OCCL occludee boxes in the street and the backyards; a seeded
// deterministic RNG — every reload, every backend, the identical scene.

// ── mat4 (column-major, WebGPU NDC z in [0,1], +y up-screen) ──────────────
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2)
  const nf = 1 / (near - far)
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ])
}
export function lookAt(eye, target, up) {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2]
  let l = Math.hypot(fx, fy, fz); fx /= l; fy /= l; fz /= l
  let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0]
  l = Math.hypot(rx, ry, rz); rx /= l; ry /= l; rz /= l
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx
  return new Float32Array([
    rx, ux, -fx, 0,
    ry, uy, -fy, 0,
    rz, uz, -fz, 0,
    -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
    -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
    fx * eye[0] + fy * eye[1] + fz * eye[2],
    1,
  ])
}
export function mat4Mul(a, b) {
  const out = new Float32Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

/** The deterministic city (shared by both tiers). */
export function createScene(occl) {
  const K = 23 // occluders: ground + 20 buildings + 2 towers
  const N = occl + K
  const LIST_WORDS = occl
  const FLAGS_OFF = occl // word offset of the per-instance verdict flags
  const INST_OFF = 2 * occl // word offset of instance 0's record (12 words each)

  let seed = 0x9e3779b9
  function rng() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }

  const sceneWords = new Uint32Array(LIST_WORDS + occl + N * 12) // [list][flags][instance records]
  const sceneF32 = new Float32Array(sceneWords.buffer)
  const occluderBoxes = [] // for prop rejection
  function putInstance(i, center, half, color) {
    const wo = INST_OFF + i * 12
    sceneF32[wo] = center[0]; sceneF32[wo + 1] = center[1]; sceneF32[wo + 2] = center[2]
    sceneF32[wo + 3] = half[0]; sceneF32[wo + 4] = half[1]; sceneF32[wo + 5] = half[2]
    sceneF32[wo + 6] = color[0]; sceneF32[wo + 7] = color[1]; sceneF32[wo + 8] = color[2]
  }
  // occluder 0: the ground slab
  putInstance(0, [0, -0.25, 0], [60, 0.25, 70], [0.09, 0.10, 0.13])
  occluderBoxes.push({ c: [0, -0.25, 0], h: [60, 0.25, 70] })
  // occluders 1..20: the canyon's two building rows
  let next = 1
  for (let i = 0; i < 10; i++) {
    for (const side of [-1, 1]) {
      const hx = 2.7 + rng() * 0.7
      const hy = 8 + rng() * 7
      const hz = 2.7 + rng() * 0.7
      const c = [side * 8, hy, -54 + i * 12 + (rng() - 0.5) * 3]
      const shade = 0.24 + rng() * 0.1
      putInstance(next, c, [hx, hy, hz], [shade, shade * 1.08, shade * 1.3])
      occluderBoxes.push({ c, h: [hx, hy, hz] })
      next++
    }
  }
  // occluders 21..22: the two big towers (the strong occluders)
  putInstance(21, [15, 11, -18], [5, 11, 5], [0.2, 0.23, 0.3])
  occluderBoxes.push({ c: [15, 11, -18], h: [5, 11, 5] })
  putInstance(22, [-15, 11, 18], [5, 11, 5], [0.2, 0.23, 0.3])
  occluderBoxes.push({ c: [-15, 11, 18], h: [5, 11, 5] })

  const PALETTE = [
    [1.0, 0.62, 0.27], [0.94, 0.38, 0.30], [0.27, 0.63, 0.60],
    [0.90, 0.85, 0.78], [0.52, 0.42, 0.75], [0.85, 0.55, 0.35],
  ]
  function insideOccluder(x, y, z, pad) {
    for (const b of occluderBoxes) {
      if (Math.abs(x - b.c[0]) < b.h[0] + pad && Math.abs(y - b.c[1]) < b.h[1] + pad && Math.abs(z - b.c[2]) < b.h[2] + pad) return true
    }
    return false
  }
  for (let i = 0; i < occl; i++) {
    for (let tries = 0; ; tries++) {
      const street = rng() < 0.3
      const x = street ? (rng() * 2 - 1) * 4.0 : (12.5 + rng() * 30) * (rng() < 0.5 ? -1 : 1)
      const z = (rng() * 2 - 1) * 66
      let hx = 0.15 + rng() * 0.45, hy = hx, hz = hx
      if (rng() < 0.1) hy *= 2.5
      const y = hy + 0.03 + rng() * 2.5
      if (tries < 32 && insideOccluder(x, y, z, Math.max(hx, hy, hz) + 0.05)) continue
      const pal = PALETTE[(rng() * PALETTE.length) | 0]
      const j = 0.85 + rng() * 0.3
      putInstance(K + i, [x, y, z], [hx, hy, hz], [pal[0] * j, pal[1] * j, pal[2] * j])
      break
    }
  }

  return { K, N, occl, LIST_WORDS, FLAGS_OFF, INST_OFF, sceneWords, sceneF32 }
}

// ── the box geometry (unit corners [0,1]³, 24 verts, 36 indices) ──────────
export const BOX_VERTS = new Float32Array([
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1,
  0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1,
  0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1,
  1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1,
])
export const BOX_INDICES = new Uint16Array([
  0, 2, 1, 2, 3, 1, 4, 5, 6, 5, 7, 6, 8, 9, 10, 9, 11, 10,
  12, 14, 13, 14, 15, 13, 16, 17, 18, 17, 19, 18, 20, 22, 21, 22, 23, 21,
])
export const QUAD_VERTS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])
/** The 4-vertex TRIANGLE_STRIP form (the GL tier's reduce/panel quads). */
export const QUAD_STRIP_VERTS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])

// ── the render resolution + the Hi-Z tile (half-res, the standard practice) ─
export const CANVAS_W = 960, CANVAS_H = 540
export const HIZ_W = Math.ceil(CANVAS_W / 2), HIZ_H = Math.ceil(CANVAS_H / 2)
export const LEVEL_DIMS = [{ w: HIZ_W, h: HIZ_H }]
for (;;) {
  const prev = LEVEL_DIMS[LEVEL_DIMS.length - 1]
  const w = Math.max(1, Math.ceil(prev.w / 2)), h = Math.max(1, Math.ceil(prev.h / 2))
  LEVEL_DIMS.push({ w, h })
  if (w === 1 && h === 1) break
}
export const LEVELS = LEVEL_DIMS.length
export const MAX_LEVEL = LEVELS - 1
export const LEVEL_OFF = [0]
for (let L = 1; L < LEVELS; L++) LEVEL_OFF.push(LEVEL_OFF[L - 1] + LEVEL_DIMS[L - 1].w * LEVEL_DIMS[L - 1].h)
export const PYRAMID_WORDS = LEVEL_OFF[LEVELS - 1] + LEVEL_DIMS[MAX_LEVEL].w * LEVEL_DIMS[MAX_LEVEL].h

// ── the shared cameras (the parity gate runs these on EVERY tier) ─────────
export const VAL_CAMERAS = [
  { yaw: 0.55, pitch: 0.28, dist: 34 },
  { yaw: 1.45, pitch: 0.38, dist: 42 },
  { yaw: 2.6, pitch: 0.22, dist: 30 },
]
export function cameraAt(yaw, pitch, dist) {
  const eye = [
    Math.cos(pitch) * Math.sin(yaw) * dist,
    5.5 + Math.sin(pitch) * dist,
    Math.cos(pitch) * Math.cos(yaw) * dist,
  ]
  const mvp = mat4Mul(perspective(Math.PI / 3, 16 / 9, 0.5, 300), lookAt(eye, [0, 5.5, 0], [0, 1, 0]))
  return { eye, mvp }
}
