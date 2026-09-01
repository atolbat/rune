/**
 * Платоновы тела: тетраэдр, октаэдр, икосаэдр, додекаэдр — с ПАРАМЕТРОМ
 * DETAIL (Task 109): каждый треугольник грани делится на (detail+1)²
 * подтреугольников, новые вершины проецируются на описанную сферу
 * (геодезическая сабдивизия, как PolyhedronGeometry в three.js).
 * detail = 0 — классическое тело с ПЛОСКИМИ гранями (додекаэдр —
 * честные копланарные пятиугольники; в three.js грани выпуклены всегда —
 * у нас плоские вершины радиусные, грани у detail 0 плоские).
 *
 * Затенение — плоское: нормаль на вершину = нормаль (под)треугольника.
 * Радиус описанной сферы = 1·radius.
 *
 * Додекаэдр: 20 вершин (золотое сечение φ), 12 пятиугольных граней —
 * двойственность к икосаэдру (вершины = центры граней, грань = 5 центров
 * смежных при вершине, CCW-сортировка по углу в плоскости ⊥ вершине).
 *
 * UV (Task 108): ПЛАНАРНАЯ развёртка в плоскости ИСХОДНОЙ грани — базис
 * из нормали, проекция вершин веера, bbox → [0,1]². При сабдивизии UV
 * подтреугольников — барицентрическая интерполяция углов грани —
 * непрерывность текстуры внутри грани сохраняется.
 */

import type { Geometry } from './types.ts'

type V3 = readonly [number, number, number]

export interface PolyhedronParams {
  /** Радиус описанной сферы (default 1). */
  readonly radius?: number
  /**
   * Сабдивизия граней (default 0): 0 — классика, 1 — 4 подтреугольника,
   * 2 — 16, 3 — 64 … Вершины подтреугольников проецируются на сферу
   * радиуса — при detail ≥ 1 тело стремится к сфере.
   */
  readonly detail?: number
}

/** Планарные UV углов грани (базис из нормали, bbox → [0,1]²). */
function planarCornerUv(fan: readonly V3[]): readonly (readonly [number, number])[] {
  const a = fan[0]!
  const b1 = fan[1]!
  const c1 = fan[2]!
  const ux = b1[0] - a[0], uy = b1[1] - a[1], uz = b1[2] - a[2]
  const wx = c1[0] - a[0], wy = c1[1] - a[1], wz = c1[2] - a[2]
  let nx = uy * wz - uz * wy
  let ny = uz * wx - ux * wz
  let nz = ux * wy - uy * wx
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len
  ny /= len
  nz /= len
  // Базис плоскости грани: t = up × n (up — не коллинеарен n), b = n × t
  const upX = Math.abs(ny) < 0.9 ? 0 : 1
  const upY = Math.abs(ny) < 0.9 ? 1 : 0
  let tx = upY * nz
  let ty = -upX * nz
  let tz = upX * ny - upY * nx
  const tLen = Math.hypot(tx, ty, tz) || 1
  tx /= tLen
  ty /= tLen
  tz /= tLen
  const bx = ny * tz - nz * ty
  const by = nz * tx - nx * tz
  const bz = nx * ty - ny * tx
  const us: number[] = []
  const vs: number[] = []
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity
  for (const p of fan) {
    const du = p[0] * tx + p[1] * ty + p[2] * tz
    const dv = p[0] * bx + p[1] * by + p[2] * bz
    us.push(du)
    vs.push(dv)
    if (du < uMin) uMin = du
    if (du > uMax) uMax = du
    if (dv < vMin) vMin = dv
    if (dv > vMax) vMax = dv
  }
  const uSpan = Math.max(uMax - uMin, 1e-9)
  const vSpan = Math.max(vMax - vMin, 1e-9)
  return fan.map((_, k) => [(us[k]! - uMin) / uSpan, (vs[k]! - vMin) / vSpan] as const)
}

/**
 * Сабдивизия треугольника (a, b, c) на (d+1)² подтреугольников.
 * Вершины — точки решётки барицентрических координат; при project=true
 * каждая проецируется на сферу радиуса radius. Возвращает подтреугольники
 * с барицентрическими весами для UV-интерполяции.
 */
function subdivide(
  a: V3, b: V3, c: V3,
  d: number,
  radius: number,
  project: boolean,
): Array<{ tri: readonly [V3, V3, V3]; w: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] }> {
  const onSphere = (p: V3): V3 => {
    if (!project) return p
    const len = Math.hypot(p[0], p[1], p[2])
    if (len < 1e-12) return p
    return [p[0] / len * radius, p[1] / len * radius, p[2] / len * radius]
  }
  const out: Array<{ tri: readonly [V3, V3, V3]; w: readonly [readonly [number, number], readonly [number, number], readonly [number, number]] }> = []
  const n = d + 1 // решётка n×n подтреугольников по строкам
  // Вершины решётки: P(i,j) = a + i/n·(b−a) + j/n·(c−a), i+j ≤ n
  const point = (i: number, j: number): V3 =>
    onSphere([
      a[0] + (b[0] - a[0]) * (i / n) + (c[0] - a[0]) * (j / n),
      a[1] + (b[1] - a[1]) * (i / n) + (c[1] - a[1]) * (j / n),
      a[2] + (b[2] - a[2]) * (i / n) + (c[2] - a[2]) * (j / n),
    ])
  const bary = (i: number, j: number): readonly [number, number] => [i / n, j / n]
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n - j; i++) {
      // Нисходящий подтреугольник: (i,j), (i+1,j), (i,j+1)
      // Восходящий (если не на диагонали): (i+1,j), (i+1,j+1), (i,j+1)
      const p00 = point(i, j)
      const p10 = point(i + 1, j)
      const p01 = point(i, j + 1)
      out.push({
        tri: [p00, p10, p01],
        w: [bary(i, j), bary(i + 1, j), bary(i, j + 1)],
      })
      if (i + 1 + j + 1 <= n) {
        const p11 = point(i + 1, j + 1)
        out.push({
          tri: [p10, p11, p01],
          w: [bary(i + 1, j), bary(i + 1, j + 1), bary(i, j + 1)],
        })
      }
    }
  }
  return out
}

/** Плоский веер грани (с сабдивизией): n-угольник → (n−2)·(d+1)² тр-ков. */
function flatFan(
  fan: readonly V3[],
  radius: number,
  detail: number,
): { positions: number[]; normals: number[]; uvs: number[] } {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const cornerUv = planarCornerUv(fan)
  const d = Math.max(0, Math.floor(detail))
  const project = d > 0
  // Веер: (fan[0], fan[i], fan[i+1]) — ориентация таблиц CCW снаружи
  for (let i = 1; i < fan.length - 1; i++) {
    const a = fan[0]!
    const b = fan[i]!
    const c = fan[i + 1]!
    const ua = cornerUv[0]!
    const ub = cornerUv[i]!
    const uc = cornerUv[i + 1]!
    for (const { tri, w } of subdivide(a, b, c, d, radius, project)) {
      // Нормаль (под)треугольника — плоское затенение
      const [pa, pb, pc] = tri
      const ex = pb[0] - pa[0], ey = pb[1] - pa[1], ez = pb[2] - pa[2]
      const fx = pc[0] - pa[0], fy = pc[1] - pa[1], fz = pc[2] - pa[2]
      let nx = ey * fz - ez * fy
      let ny = ez * fx - ex * fz
      let nz = ex * fy - ey * fx
      const len = Math.hypot(nx, ny, nz)
      if (len > 1e-12) {
        nx /= len
        ny /= len
        nz /= len
      }
      const uvOf = (k: number): readonly [number, number] => [
        ua[0] + (ub[0] - ua[0]) * w[k]![0] + (uc[0] - ua[0]) * w[k]![1],
        ua[1] + (ub[1] - ua[1]) * w[k]![0] + (uc[1] - ua[1]) * w[k]![1],
      ]
      const corners: readonly V3[] = tri
      for (let k = 0; k < 3; k++) {
        const p = corners[k]!
        positions.push(p[0], p[1], p[2])
        normals.push(nx, ny, nz)
        const [u, vv] = uvOf(k)
        uvs.push(u, vv)
      }
    }
  }
  return { positions, normals, uvs }
}

function pack(parts: Array<{ positions: number[]; normals: number[]; uvs: number[] }>): Geometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  for (const part of parts) {
    positions.push(...part.positions)
    normals.push(...part.normals)
    uvs.push(...part.uvs)
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3,
  }
}

/** Полигоны тела → Geometry с параметрами (radius, detail). */
function polyhedron(
  faces: ReadonlyArray<readonly V3[]>,
  params: PolyhedronParams,
): Geometry {
  const radius = params.radius ?? 1
  const detail = params.detail ?? 0
  return pack(faces.map(f => flatFan(f, radius, detail)))
}

// ─── Тетраэдр (4 грани × 4 вершины) ─────────────────────────────────────────

const TETRA: readonly V3[] = [
  [1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1],
]
const TETRA_FACES: ReadonlyArray<readonly V3[]> = [
  [TETRA[0]!, TETRA[1]!, TETRA[2]!],
  [TETRA[0]!, TETRA[3]!, TETRA[1]!],
  [TETRA[0]!, TETRA[2]!, TETRA[3]!],
  [TETRA[1]!, TETRA[3]!, TETRA[2]!],
]

export function tetrahedron(params: PolyhedronParams = {}): Geometry {
  const radius = params.radius ?? 1
  const s = radius / Math.sqrt(3)
  return polyhedron(TETRA_FACES.map(f => f.map(v => [v[0] * s, v[1] * s, v[2] * s] as V3)), { ...params, radius })
}

// ─── Октаэдр (8 граней) ──────────────────────────────────────────────────────

const OCTA_FACES: ReadonlyArray<readonly V3[]> = (() => {
  const v: readonly V3[] = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ]
  return [
    [v[0]!, v[2]!, v[4]!], [v[2]!, v[1]!, v[4]!], [v[1]!, v[3]!, v[4]!], [v[3]!, v[0]!, v[4]!],
    [v[2]!, v[0]!, v[5]!], [v[1]!, v[2]!, v[5]!], [v[3]!, v[1]!, v[5]!], [v[0]!, v[3]!, v[5]!],
  ]
})()

export function octahedron(params: PolyhedronParams = {}): Geometry {
  const radius = params.radius ?? 1
  return polyhedron(OCTA_FACES.map(f => f.map(v => [v[0] * radius, v[1] * radius, v[2] * radius] as V3)), params)
}

// ─── Икосаэдр (20 треугольных граней) ────────────────────────────────────────

const ICO_FACES: ReadonlyArray<readonly V3[]> = (() => {
  const t = (1 + Math.sqrt(5)) / 2
  const raw: readonly V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]
  const v = raw.map(p => {
    const len = Math.hypot(p[0], p[1], p[2])
    return [p[0] / len, p[1] / len, p[2] / len] as V3
  })
  return [
    [v[0]!, v[11]!, v[5]!], [v[0]!, v[5]!, v[1]!], [v[0]!, v[1]!, v[7]!], [v[0]!, v[7]!, v[10]!], [v[0]!, v[10]!, v[11]!],
    [v[1]!, v[5]!, v[9]!], [v[5]!, v[11]!, v[4]!], [v[11]!, v[10]!, v[2]!], [v[10]!, v[7]!, v[6]!], [v[7]!, v[1]!, v[8]!],
    [v[3]!, v[9]!, v[4]!], [v[3]!, v[4]!, v[2]!], [v[3]!, v[2]!, v[6]!], [v[3]!, v[6]!, v[8]!], [v[3]!, v[8]!, v[9]!],
    [v[4]!, v[9]!, v[5]!], [v[2]!, v[4]!, v[11]!], [v[6]!, v[2]!, v[10]!], [v[8]!, v[6]!, v[7]!], [v[9]!, v[8]!, v[1]!],
  ]
})()

export function icosahedron(params: PolyhedronParams = {}): Geometry {
  const radius = params.radius ?? 1
  return polyhedron(ICO_FACES.map(f => f.map(v => [v[0] * radius, v[1] * radius, v[2] * radius] as V3)), { ...params, radius })
}

// ─── Додекаэдр (12 пятиугольных граней) ──────────────────────────────────────

/**
 * Додекаэдр строится как ДВОЙСТВЕННЫЙ икосаэдру — без таблиц «из головы»:
 *   • 20 вершин = центры 20 граней икосаэдра (нормализованы на радиус);
 *   • 12 граней = по одной на вершину икосаэдра: 5 центров граней,
 *     СМЕЖНЫХ в этой вершине, сортируются по углу в плоскости ⊥ вершине
 *     (CCW снаружи).
 * Правильность следует из правильности икосаэдра: двойственность
 * гарантирует и копланарность пятёрок, и пятиугольность.
 */
export function dodecahedron(params: PolyhedronParams = {}): Geometry {
  const radius = params.radius ?? 1
  // Уникальные вершины икосаэдра (все на радиусе 1)
  const vertices: V3[] = []
  const seen = new Set<string>()
  for (const face of ICO_FACES) {
    for (const v of face) {
      const key = v.join(',')
      if (!seen.has(key)) {
        seen.add(key)
        vertices.push(v)
      }
    }
  }
  // Вершины додекаэдра = центры граней икосаэдра (нормализованы)
  const dv = ICO_FACES.map(f => {
    const c: V3 = [
      (f[0]![0] + f[1]![0] + f[2]![0]) / 3,
      (f[0]![1] + f[1]![1] + f[2]![1]) / 3,
      (f[0]![2] + f[1]![2] + f[2]![2]) / 3,
    ]
    const len = Math.hypot(c[0], c[1], c[2]) || 1
    return [c[0] / len, c[1] / len, c[2] / len] as V3
  })
  // Грань додекаэдра при вершине икосаэдра k: центры граней икосаэдра,
  // содержащих k (их ровно 5), CCW вокруг направления вершины
  const dFaces: V3[][] = []
  for (const c of vertices) {
    const ring: V3[] = []
    for (let f = 0; f < ICO_FACES.length; f++) {
      if (ICO_FACES[f]!.includes(c)) ring.push(dv[f]!)
    }
    if (ring.length !== 5) {
      throw new Error(`rune: prims — двойственность сломана: у вершины икосаэдра ${ring.length} смежных граней (ожидалось 5)`)
    }
    // Базис плоскости грани: un × w = c — CCW при взгляде СНАРУЖИ (с +c)
    const up: V3 = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
    const u: V3 = [
      up[1] * c[2] - up[2] * c[1],
      up[2] * c[0] - up[0] * c[2],
      up[0] * c[1] - up[1] * c[0],
    ]
    const uLen = Math.hypot(u[0], u[1], u[2]) || 1
    const un: V3 = [u[0] / uLen, u[1] / uLen, u[2] / uLen]
    const w: V3 = [
      c[1] * un[2] - c[2] * un[1],
      c[2] * un[0] - c[0] * un[2],
      c[0] * un[1] - c[1] * un[0],
    ]
    const angleOf = (p: V3): number => {
      const du = p[0] * un[0] + p[1] * un[1] + p[2] * un[2]
      const dw = p[0] * w[0] + p[1] * w[1] + p[2] * w[2]
      return Math.atan2(dw, du)
    }
    ring.sort((a, b) => angleOf(a) - angleOf(b))
    dFaces.push(ring)
  }
  return polyhedron(dFaces.map(f => f.map(v => [v[0] * radius, v[1] * radius, v[2] * radius] as V3)), params)
}
