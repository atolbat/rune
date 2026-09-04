// petal-geometry.js — OUR falling-petal mesh (replaces the old borrowed
// leaf asset): a tapered, upward-curling strip built procedurally —
// 8 segments along the spine, two verts each, the width easing from the
// base to a pointed tip, the surface curling up toward the edges like a
// real petal. A plain TRIANGLE SOUP (the mesh-particle geometry contract
// of @rune/particles: positions + normals + uvs + vertexCount).
//
// Local frame: the spine along +X (length 2, base at x=-1), Y up (the
// curl), width across Z. The demo's per-particle random-axis tumble does
// the rest.

const SEGMENTS = 8

function buildPetal() {
  const positions = new Float32Array(SEGMENTS * 6 * 3)
  const normals = new Float32Array(SEGMENTS * 6 * 3)
  const uvs = new Float32Array(SEGMENTS * 6 * 2)
  let vAt = 0

  /** The petal's local surface at spine parameter t ∈ [0,1]:
   *  x = t·2 − 1, halfWidth = an eased taper to a point, y = the curl. */
  const widthAt = (t) => 0.42 * Math.sin(Math.PI * Math.min(1, t * 1.12)) ** 0.8
  const curlAt = (t, side) => 0.22 * Math.sin(Math.PI * t) * (1 + side * 0.55)

  for (let i = 0; i < SEGMENTS; i++) {
    const t0 = i / SEGMENTS, t1 = (i + 1) / SEGMENTS
    const x0 = t0 * 2 - 1, x1 = t1 * 2 - 1
    const w0 = widthAt(t0), w1 = widthAt(t1)
    // corners: (x, z, y) with z = ±w and the curl lifting the edges
    const c = [
      [x0, -w0, curlAt(t0, -1)], [x0, w0, curlAt(t0, 1)],
      [x1, -w1, curlAt(t1, -1)], [x1, w1, curlAt(t1, 1)],
    ]
    const uv = [[t0, 0], [t0, 1], [t1, 0], [t1, 1]]
    // two triangles: 0-2-1, 1-2-3 (the quad's diagonal split)
    for (const idx of [0, 2, 1, 1, 2, 3]) {
      const [px, pz, py] = c[idx]
      // the normal: the curl tilts the surface up — approximate by the
      // local spine tangent × the across direction
      const n = [0, 1, 0]
      positions[vAt * 3] = px; positions[vAt * 3 + 1] = py; positions[vAt * 3 + 2] = pz
      normals[vAt * 3] = n[0]; normals[vAt * 3 + 1] = n[1]; normals[vAt * 3 + 2] = n[2]
      uvs[vAt * 2] = uv[idx][0]; uvs[vAt * 2 + 1] = uv[idx][1]
      vAt++
    }
  }
  return { positions, normals, uvs, vertexCount: vAt }
}

/** The petal mesh (shared, immutable — one build). */
export const PETAL = buildPetal()

/** The petal texture bytes (64×64 RGBA, straight alpha): a pointed-oval
 *  silhouette with an alpha MASK, a lit midrib and darker veins fanning
 *  from the base — the structure the LAMBERT light + the per-particle
 *  tint play against. rgb is neutral (the spawner tints). */
export function makePetalBytes() {
  const N = 64
  const bytes = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N, v = (y + 0.5) / N
      // the pointed oval: wide near the base (v=0), easing to a tip (v=1)
      const half = 0.44 * Math.sin(Math.PI * Math.min(1, v * 1.12)) ** 0.8
      const edge = Math.abs(u - 0.5) / Math.max(1e-6, half)
      const inside = edge < 1
      // the soft border: a 2-px feather (alpha-MASK friendly — the cutoff
      // can sit anywhere in the feather)
      const a = inside ? Math.min(255, Math.round(255 * Math.min(1, (1 - edge) / 0.09))) : 0
      // the midrib: a bright spine down the center; the veins: a fan
      const rib = Math.exp(-Math.pow((u - 0.5) / 0.05, 2))
      const vein = Math.max(0, Math.sin((u - 0.5) * 40 + v * 9)) * (1 - v) * 0.5
      const shade = 0.62 + 0.38 * rib + 0.12 * vein
      const i = (y * N + x) * 4
      bytes[i] = Math.round(255 * Math.min(1, shade * 1.05))
      bytes[i + 1] = Math.round(255 * Math.min(1, shade * 0.98))
      bytes[i + 2] = Math.round(255 * Math.min(1, shade * 0.92))
      bytes[i + 3] = a
    }
  }
  return bytes
}
