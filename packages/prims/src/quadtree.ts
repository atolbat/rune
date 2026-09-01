/**
 * Quadtree LOD — тайловая сетка с адаптивным разрешением «до горизонта»
 * (Task 113; репорт пользователя: «один квад… создай структуру типа
 * квадтри, чтобы много мелких квадов формировали океан до горизонта
 * (или лимита расстояния)»).
 *
 * РЕШЕНИЕ: эта прима ЗАМЕНЯЕТ плановую terrain-приму досье §10.2 —
 * универсальная система «квад-дерево вокруг наблюдателя» покрывает и
 * океан (дисплейс-текстура FFT), и высотки (карта высот): одна и та же
 * геометрия тайлов, один и тот же критерий расщепления.
 *
 * Проектировка по индустриальным образцам (исследование Task 113):
 *  • Crest Ocean System (SIGGRAPH 2017/2019, wave-harmonic) — «поверхность
 *    составлена из концентрических колец геометрия-тайлов, каждое кольцо —
 *    степень двойки»; квадтри вокруг наблюдателя даёт ту же структуру;
 *  • Geometry Clipmaps (GPU Gems 2, гл. 2) — статичная геометрия, адаптация
 *    положением/масштабом, а не перестройкой буферов;
 *  • GPU Gems 2, гл. 18 (Pacific Fighters) — вершина-читает-текстуру.
 *
 * ОПТИМИЗАЦИЯ (ключевая идея): НИ ОДИН вершинный/индексный буфер не
 * перестраивается в кадре. Единичный тайл-меш статичен; за кадр CPU
 * только выбирает видимые тайлы (сотни узлов, микросекунды) и пакует их
 * в инстанс-буфер [cx, cz, size, level]×N → ОДИН instanced draw на весь
 * океан. Расширение мировой позиции — в вершинном шейдере.
 *
 * Трещины между уровнями (T-junction) закрываются «юбкой» (skirt) —
 * вертикальной стенкой по периметру тайла (кессонный приём Cesium и
 * ландшафтных рендереров): проще и робастнее морфинга Crest'а, +6% вершин.
 *
 * Чистые данные без GL-зависимостей — генерируется и в воркере.
 */

/** Выбранные тайлы selectQuadtreeTiles (камера-центрированный вариант). */
export interface QuadtreeTilesSelection {
  /** Упакованные инстансы: [cx, cz, size, level] × count (stride 4). */
  readonly instances: Float32Array
  /** Число тайлов (instances.length === 4·count). */
  count: number
  /** Минимальный/максимальный уровень выбранных тайлов (для статистики). */
  minLevel: number
  maxLevel: number
  /** Ёмкость instances (в числах float; не путать с count). */
  readonly capacity: number
}

export interface QuadtreeSelectOptions {
  /** Центр квадтри по X (позиция наблюдателя, лучше снапнутая — см. ниже). */
  readonly centerX: number
  /** Центр квадтри по Z. */
  readonly centerZ: number
  /** Размер КОРНЕВОГО квада (край мира; степень двойки). */
  readonly rootSize: number
  /** Число уровней: 1 = только корень; уровень L-1 — самые мелкие тайлы
   *  (size = rootSize / 2^(levels-1)). */
  readonly levels: number
  /** Делить узел, пока size > splitFactor · dist(центр узла, центр).
   *  Меньше — плотнее у камеры (каждая ячейка ≈ splitFactor/N радиан). */
  readonly splitFactor?: number
  /** Предохранитель на число тайлов (default 4096). */
  readonly maxTiles?: number
  /** Фрустум-куллинг: 6 нормированных плоскостей (a,b,c,d)×6 — 24 float,
   *  «внутри» = a·x+b·y+c·z+d ≥ 0. Без поля — рисуем все тайлы. */
  readonly frustum?: Float32Array
  /** Вертикальный полуразмер тайлов для куллинга (волны/юбка/высоты). */
  readonly yRadius?: number
  /** Повторно используемая выборка (ёмкость вырастает при нехватке). */
  readonly out?: QuadtreeTilesSelection
}

/**
 * Выборка тайлов квадтри вокруг центра: рекурсия от корня, расщепление по
 * дистанции, отсечение фрустумом (консервативная сфера). Стабильность:
 * передавайте центр, снапнутый к сетке 2·(rootSize/2^levels) — тогда
 * тесселяция меняется только при пересечении границ, без «плавания».
 */
export function selectQuadtreeTiles(options: QuadtreeSelectOptions): QuadtreeTilesSelection {
  const {
    centerX,
    centerZ,
    rootSize,
    levels,
    frustum,
  } = options
  const splitFactor = options.splitFactor ?? 1
  const maxTiles = options.maxTiles ?? 4096
  const yRadius = options.yRadius ?? 0

  if (!Number.isFinite(rootSize) || rootSize <= 0) {
    throw new Error(`quadtree: rootSize должен быть > 0, получено ${rootSize}`)
  }
  if (!Number.isInteger(levels) || levels < 1 || levels > 24) {
    throw new Error(`quadtree: levels — целое 1..24, получено ${levels}`)
  }
  if (!Number.isFinite(splitFactor) || splitFactor <= 0) {
    throw new Error(`quadtree: splitFactor должен быть > 0, получено ${splitFactor}`)
  }
  if (frustum !== undefined && frustum.length !== 24) {
    throw new Error(`quadtree: frustum — 24 float (6 плоскостей), получено ${frustum.length}`)
  }

  const out = options.out ?? {
    instances: new Float32Array(4 * 64),
    count: 0,
    minLevel: 0,
    maxLevel: 0,
    capacity: 4 * 64,
  }
  out.count = 0
  out.minLevel = levels - 1
  out.maxLevel = 0

  // Явный стек узлов (без рекурсии): [cx, cz, size, level]×depth-bounded.
  // Каждый посещённый узел либо попадает в выборку, либо делится на 4 —
  // всего посещается ≤ (4/3)·maxTiles узлов.
  const stack: number[] = [centerX, centerZ, rootSize, 0]
  let minLevelSeen = levels - 1
  let maxLevelSeen = 0

  while (stack.length > 0) {
    const level = stack.pop() as number
    const size = stack.pop() as number
    const cz = stack.pop() as number
    const cx = stack.pop() as number

    // Фрустум: консервативная сфера (центр y=0, радиус = полудиагональ + y).
    if (frustum !== undefined && quadtreeSphereOutside(frustum, cx, cz, size, yRadius)) {
      continue
    }

    // Расщепление: тайл держит постоянный УГЛОВОЙ размер ~splitFactor/N —
    // критерий Crest/GPU-Gems (screen-space error через дистанцию).
    const dx = cx - centerX
    const dz = cz - centerZ
    const dist = Math.sqrt(dx * dx + dz * dz)
    const halfSide = size * 0.5 // ближайшая точка тайла к центру
    if (level + 1 < levels && size > splitFactor * Math.max(dist - halfSide, 0) && out.count + 4 <= maxTiles) {
      const q = size * 0.25
      stack.push(cx - q, cz - q, size * 0.5, level + 1)
      stack.push(cx + q, cz - q, size * 0.5, level + 1)
      stack.push(cx - q, cz + q, size * 0.5, level + 1)
      stack.push(cx + q, cz + q, size * 0.5, level + 1)
      continue
    }
    // ЖЁСТКИЙ кап: инстанс-буфер живёт ровно maxTiles записей (стек-хвост
    // отбрасывается — в реальных сценах счёт ≪ капа, это предохранитель).
    if (out.count >= maxTiles) break

    if (out.count * 4 + 4 > out.instances.length) {
      // Ленивый рост ёмкости (обычный кадр — без роста: буфер уже тёплый).
      const grown = new Float32Array(out.instances.length * 2)
      grown.set(out.instances)
      const mutable = out as { instances: Float32Array; capacity: number }
      mutable.instances = grown
      mutable.capacity = grown.length
    }
    const o = out.count * 4
    out.instances[o] = cx
    out.instances[o + 1] = cz
    out.instances[o + 2] = size
    out.instances[o + 3] = level
    out.count++
    if (level < minLevelSeen) minLevelSeen = level
    if (level > maxLevelSeen) maxLevelSeen = level
  }

  out.minLevel = out.count === 0 ? 0 : minLevelSeen
  out.maxLevel = out.count === 0 ? 0 : maxLevelSeen
  return out
}

/** Сфера тайла целиком вне одной из плоскостей → отсечь. */
function quadtreeSphereOutside(
  planes: Float32Array,
  cx: number,
  cz: number,
  size: number,
  yRadius: number,
): boolean {
  // Радиус по XZ: полудиагональ квадрата; по Y — yRadius (сфера).
  const r = Math.sqrt(0.5 * size * 0.5 * size * 2 + yRadius * yRadius)
  for (let p = 0; p < 6; p++) {
    const o = p * 4
    const d = planes[o] * cx + planes[o + 2] * cz + planes[o + 3]
    if (d < -r) return true
  }
  return false
}

/** Геометрия единичного тайла: сетка [0..1]² + юбка по периметру. */
export interface QuadtreeTileMesh {
  /** Позиции: stride 3 — (u, v, skirt), u/v ∈ [0..1], юбка повторяет UV
   *  кромки с skirt=1 (стенка уходит ВНИЗ в шейдере: y -= skirt·depth). */
  readonly positions: Float32Array
  /** UV = (u, v) — те же координаты сети (stride 2). */
  readonly uvs: Float32Array
  /** Треугольники: сетка + юбка (4·segments стенок). */
  readonly indices: Uint32Array
  /** Уникальные рёбра СЕТКИ (без юбки) — wireframe/LOD-инспекция. */
  readonly edgeIndices: Uint32Array
  readonly vertexCount: number
  /** Число вершин юбки (для статистики). */
  readonly skirtVertexCount: number
  readonly segments: number
}

export interface QuadtreeTileMeshOptions {
  /** Ячеек по стороне (default 32; вершины (N+1)²). */
  readonly segments?: number
  /** Юбка-стенка по периметру (default true). */
  readonly skirt?: boolean
}

/**
 * Единичный тайл [0..1]² — СТАТИЧНАЯ геометрия для instanced-рендера:
 * мировая позиция = instance.xy + (uv − 0.5)·instance.size (шейдер).
 *
 * Юбка: дублированные кромочные вершины (те же u/v, skirt=1) + вертикальные
 * стенки-квады; закрывает T-трещины между соседями разных уровней.
 * Индексы рёбер (wireframe) юбку НЕ включают — структура LOD читается чисто.
 */
export function quadtreeTileMesh(options: QuadtreeTileMeshOptions = {}): QuadtreeTileMesh {
  const segments = options.segments ?? 32
  const withSkirt = options.skirt ?? true
  if (!Number.isInteger(segments) || segments < 1 || segments > 256) {
    throw new Error(`quadtreeTileMesh: segments — целое 1..256, получено ${segments}`)
  }

  const cols = segments + 1
  const gridCount = cols * cols
  // Юбка: 4 кромки × (segments+1) вершин (углы дублируются — простота).
  const skirtCount = withSkirt ? 4 * cols : 0
  const vertexCount = gridCount + skirtCount

  const positions = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)

  let at = 0
  let uvAt = 0
  for (let z = 0; z < cols; z++) {
    for (let x = 0; x < cols; x++) {
      const u = x / segments
      const v = z / segments
      positions[at++] = u
      positions[at++] = v
      positions[at++] = 0
      uvs[uvAt++] = u
      uvs[uvAt++] = v
    }
  }

  // Юбка: индекс вершины кромки → дубль со skirt=1.
  const skirtIndexOf = new Int32Array(gridCount).fill(-1)
  if (withSkirt) {
    let s = gridCount
    // верхняя (v=0) и нижняя (v=1) кромки
    for (let x = 0; x < cols; x++) {
      const top = x
      const bottom = segments * cols + x
      skirtIndexOf[top] = s
      positions[s * 3] = positions[top * 3]
      positions[s * 3 + 1] = positions[top * 3 + 1]
      positions[s * 3 + 2] = 1
      uvs[s * 2] = positions[top * 3]
      uvs[s * 2 + 1] = positions[top * 3 + 1]
      s++
      skirtIndexOf[bottom] = s
      positions[s * 3] = positions[bottom * 3]
      positions[s * 3 + 1] = positions[bottom * 3 + 1]
      positions[s * 3 + 2] = 1
      uvs[s * 2] = positions[bottom * 3]
      uvs[s * 2 + 1] = positions[bottom * 3 + 1]
      s++
    }
    // левая (u=0) и правая (u=1) кромки (углы уже есть — дублируем и их:
    // стенки смежных кромок перекрываются в углах, это безвредно)
    for (let z = 0; z < cols; z++) {
      const left = z * cols
      const right = z * cols + segments
      skirtIndexOf[left] = s
      positions[s * 3] = positions[left * 3]
      positions[s * 3 + 1] = positions[left * 3 + 1]
      positions[s * 3 + 2] = 1
      uvs[s * 2] = positions[left * 3]
      uvs[s * 2 + 1] = positions[left * 3 + 1]
      s++
      skirtIndexOf[right] = s
      positions[s * 3] = positions[right * 3]
      positions[s * 3 + 1] = positions[right * 3 + 1]
      positions[s * 3 + 2] = 1
      uvs[s * 2] = positions[right * 3]
      uvs[s * 2 + 1] = positions[right * 3 + 1]
      s++
    }
  }

  // Треугольники сетки — CCW сверху (та же ориентация, что prims/grid).
  const triCount = segments * segments * 2 + (withSkirt ? segments * 8 : 0)
  const indices = new Uint32Array(triCount * 3)
  let t = 0
  for (let z = 0; z < segments; z++) {
    for (let x = 0; x < segments; x++) {
      const topLeft = z * cols + x
      const topRight = topLeft + 1
      const bottomLeft = topLeft + cols
      const bottomRight = bottomLeft + 1
      indices[t++] = topLeft
      indices[t++] = bottomLeft
      indices[t++] = bottomRight
      indices[t++] = bottomRight
      indices[t++] = topRight
      indices[t++] = topLeft
    }
  }

  // Стенки юбки: квад (кромка-вершина, её юбка-дубль, следующая пара).
  if (withSkirt) {
    const wall = (a: number, b: number): void => {
      // a → b вдоль кромки; sa/sb — юбки a/b. Два треугольника, любая
      // ориентация (стенка вертикальная, видна с обеих сторон — обычно
      // рендерится с cull off или ориентация чередуется; океан не каллится).
      const sa = skirtIndexOf[a]
      const sb = skirtIndexOf[b]
      if (sa < 0 || sb < 0) return
      indices[t++] = a
      indices[t++] = sa
      indices[t++] = sb
      indices[t++] = sb
      indices[t++] = b
      indices[t++] = a
    }
    for (let x = 0; x < segments; x++) {
      wall(x, x + 1) // верхняя кромка
      wall(segments * cols + x, segments * cols + x + 1) // нижняя
    }
    for (let z = 0; z < segments; z++) {
      wall(z * cols, (z + 1) * cols) // левая
      wall(z * cols + segments, (z + 1) * cols + segments) // правая
    }
  }

  // Рёбра сетки (unique, с диагоналями — как у prims/grid): юбку не включаем.
  const edgeSet = new Set<number>()
  const edges: number[] = []
  const addEdge = (a: number, b: number): void => {
    const key = a < b ? a * vertexCount + b : b * vertexCount + a
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    edges.push(a, b)
  }
  for (let z = 0; z < segments; z++) {
    for (let x = 0; x < segments; x++) {
      const topLeft = z * cols + x
      const topRight = topLeft + 1
      const bottomLeft = topLeft + cols
      const bottomRight = bottomLeft + 1
      addEdge(topLeft, bottomLeft)
      addEdge(bottomLeft, bottomRight)
      addEdge(bottomRight, topRight)
      addEdge(topRight, topLeft)
      addEdge(topLeft, bottomRight)
    }
  }

  return {
    positions,
    uvs,
    indices,
    edgeIndices: new Uint32Array(edges),
    vertexCount,
    skirtVertexCount: skirtCount,
    segments,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Пара «ОКЕАН-ТОЧНАЯ» API (Task 113 → библиотека, Task 115): мировая фикс-сетка
// корней, отсечение по направлению взгляда, ноль аллокаций на кадр, юбки
// побитово-непрерывного дисплейса. Перенесено 1:1 из валидированного демо
// FFT-океана (кваддрево до 10 км, 300K+ трис, UI-агрессивность LOD).
// ════════════════════════════════════════════════════════════════════════════

/** Ячеек в стороне патча по умолчанию (вершин 33×33 внутри + кольцо юбки). */
export const PATCH_CELLS = 32
/** Вершины патча: (PATCH_CELLS+3)² — внутренний грид + юбка. */
export const PATCH_VERTEX_COUNT = (PATCH_CELLS + 3) * (PATCH_CELLS + 3)
/** Треугольников на лист: весь грид 35×35 ячеек (интерьер + стены юбки). */
export const PATCH_TRIANGLE_COUNT = (PATCH_CELLS + 2) * (PATCH_CELLS + 2) * 2
/** Рёбер каркаса: только внутренний грид (юбку не рисуем — чище вид). */
export const PATCH_WIRE_EDGE_COUNT = PATCH_CELLS * (PATCH_CELLS + 1) * 2

/** Корневой тайл кваддрева по умолчанию, м (фикс-сетка мира). */
export const ROOT_SIZE = 4096
/** Дальность покрытия по умолчанию, м. */
export const HORIZON_DISTANCE = 10000
/** Потолок листьев по умолчанию (ёмкость буфера инстансов). */
export const MAX_INSTANCES = 2048

/** LOD-параметры из агрессивности (единая настройка: спад + ближний лимит). */
export interface LodParams {
  /** Узел дробится, пока dist < size·K. Меньше K ⇒ агрессивнее упрощение. */
  K: number
  /** Жёсткий потолок глубины (лимит детализации вблизи). */
  maxDepth: number
  /** Минимальный лист, м. */
  minLeafSize: number
}

/**
 * Агрессивность → LOD-параметры (репорт юзера: «агрессивно изначально,
 * с настройкой — и детализацию ближайших квадов (лимит), и скорость спада»):
 *  - A ∈ [1..3], по умолчанию 2 (агрессивно);
 *  - K = 4.5/A — скорость спада детализации с расстоянием;
 *  - minLeafSize 64/128/256 м по ступеням A — жёсткий лимит ближней
 *    детализации («не до бесконечности»).
 */
export function lodParams(aggressiveness: number): LodParams {
  const a = Math.max(1, Math.min(3, aggressiveness))
  const K = 4.5 / a
  const minLeafSize = a < 1.5 ? 64 : a < 2.5 ? 128 : 256
  const maxDepth = Math.round(Math.log2(ROOT_SIZE / minLeafSize))
  return { K, maxDepth, minLeafSize }
}

/**
 * Патч-грид кваддрева: (segments+3)² вершин (x, z, skirt) — локальные
 * координаты в ЯЧЕЙКАХ [0..segments]; у кольца юбки позиция ПРИТЯНУТА к
 * кромке (та же (x,z) ⇒ тот же мировой XZ ⇒ тот же uv ⇒ побитово тот же
 * дисплейс кромки — трещин на T-стыках нет), флаг skirt=1 (стенка уходит
 * вниз в шейдере). Индексы: треугольники всего грида + рёбра внутренника
 * (wireframe без юбки — видна чистая структура LOD).
 */
export interface QuadtreePatch {
  /** (x, z, skirt)×N, stride 3. */
  readonly vertices: Float32Array
  readonly triangleIndices: Uint16Array
  readonly edgeIndices: Uint16Array
  readonly segments: number
}

/** Индекс вершины в гриде −1..segments+1. */
function patchCellIndex(gx: number, gy: number, segments: number): number {
  return (gy + 1) * (segments + 3) + (gx + 1)
}

export function quadtreePatch(segments = PATCH_CELLS): QuadtreePatch {
  if (!Number.isInteger(segments) || segments < 1 || segments > 253) {
    throw new Error(`quadtreePatch: segments — целое 1..253, получено ${segments}`)
  }
  const side = segments + 3 // грид от −1 до segments+1 включительно
  const verts = new Float32Array(side * side * 3)
  let v = 0
  for (let gy = -1; gy <= segments + 1; gy++) {
    for (let gx = -1; gx <= segments + 1; gx++) {
      const skirt = gx < 0 || gy < 0 || gx > segments || gy > segments ? 1 : 0
      verts[v++] = Math.max(0, Math.min(segments, gx))
      verts[v++] = Math.max(0, Math.min(segments, gy))
      verts[v++] = skirt
    }
  }

  // Треугольники: весь грид (side−1)² ячеек — интерьер + стены юбки; угловые
  // ячейки вырождаются в нулевую площадь (безвредно, зато индексация единая).
  const tris = new Uint16Array((side - 1) * (side - 1) * 6)
  let t = 0
  for (let gy = -1; gy < segments + 1; gy++) {
    for (let gx = -1; gx < segments + 1; gx++) {
      const a = patchCellIndex(gx, gy, segments)
      const b = patchCellIndex(gx + 1, gy, segments)
      const c = patchCellIndex(gx, gy + 1, segments)
      const d = patchCellIndex(gx + 1, gy + 1, segments)
      tris[t++] = a
      tris[t++] = b
      tris[t++] = c
      tris[t++] = b
      tris[t++] = d
      tris[t++] = c
    }
  }

  // Каркас: линии внутреннего грида (segments+1)² (без юбки).
  const wireCount = segments * (segments + 1) * 2
  const edges = new Uint16Array(wireCount * 2)
  let e = 0
  for (let y = 0; y <= segments; y++) {
    for (let x = 0; x < segments; x++) {
      edges[e++] = patchCellIndex(x, y, segments)
      edges[e++] = patchCellIndex(x + 1, y, segments)
    }
  }
  for (let x = 0; x <= segments; x++) {
    for (let y = 0; y < segments; y++) {
      edges[e++] = patchCellIndex(x, y, segments)
      edges[e++] = patchCellIndex(x, y + 1, segments)
    }
  }

  return { vertices: verts, triangleIndices: tris, edgeIndices: edges, segments }
}

/** Результат селекции листьев. Свежий лёгкий объект на вызов (~100 байт —
 *  никакой алгоритмической аллокации); instanceData — РАЗДЕЛЯЕМЫЙ
 *  пре-аллоцированный буфер: его содержимое валидно ДО СЛЕДУЮЩЕГО вызова
 *  selectQuadtreeLeaves (загружайте в GPU в том же кадре). Два результата
 *  можно держать одновременно (числа честные); буферы — один и тот же. */
export interface QuadtreeLeavesSelection {
  /** Число листьев = число инстансов патча. */
  leafCount: number
  /** (originX, originZ, size, 0) × leafCount — данные буфера инстансов. */
  instanceData: Float32Array
  /** Треугольников всего (с юбками). */
  triangles: number
  minLeafSize: number
  maxLeafSize: number
  /** Параметры LOD этого прохода (для HUD). */
  lod: LodParams
}

export interface QuadtreeLeavesOptions {
  /** LOD-агрессивность 1..3 (default 2 — «агрессивно изначально»). */
  readonly aggressiveness?: number
  /** Размер корневого тайла фикс-сетки мира, м (default 4096). */
  readonly rootSize?: number
  /** Радиус покрытия от камеры, м (default 10000). */
  readonly horizon?: number
  /** Потолок листьев = ёмкость инстанс-буфера (default 2048). */
  readonly maxInstances?: number
  /** Горизонтальное направление взгляда (нормировать не обязательно):
   *  листья вне сектора «65° + угловой радиус листа» отсекаются. Ноль/NaN
   *  — отсечение выключено (вид строго вниз). */
  readonly forward?: { readonly x: number; readonly z: number }
}

// Пре-аллоцированное состояние модуля: стек обхода + инстансы + результат.
// Стек: (originX, originZ, depth); DFS ⇒ глубина ≤ 3·maxDepth+4 (с запасом).
const LEAF_STACK_CAP = 320
const leafStack = new Float64Array(LEAF_STACK_CAP * 3)
let leafInstances = new Float32Array(MAX_INSTANCES * 4)
let leafCapacity = MAX_INSTANCES

/**
 * Набор листьев кваддрева для текущего кадра — СИСТЕМА ОКЕАНА (валидирована
 * демо FFT-океана, Task 113):
 *  - корни — тайлы ФИКС-СЕТКИ мира rootSize (вершины не «плывут» при
 *    движении камеры — меняется только набор листьев);
 *  - дробление: 3D-дистанция до ближайшей точки узла (с высотой камеры) <
 *    size·K и depth < maxDepth (жёсткий лимит ближней детализации);
 *  - отсечение по направлению взгляда (сектор 65° + угловой радиус листа);
 *  - НОЛЬ аллокаций на кадр (стек, инстансы и результат — пре-аллоцированы).
 */
export function selectQuadtreeLeaves(
  camX: number,
  camZ: number,
  camY: number,
  options: QuadtreeLeavesOptions = {},
): QuadtreeLeavesSelection {
  const rootSize = options.rootSize ?? ROOT_SIZE
  const horizon = options.horizon ?? HORIZON_DISTANCE
  const maxInstances = Math.max(16, options.maxInstances ?? MAX_INSTANCES)
  if (maxInstances > leafCapacity) {
    // Ленивый рост ёмкости ОДИН раз (обычный кадр — без аллокаций).
    leafInstances = new Float32Array(maxInstances * 4)
    leafCapacity = maxInstances
  }
  const lod = lodParams(options.aggressiveness ?? 2)
  const maxDepth = Math.min(24, Math.max(1, Math.round(Math.log2(rootSize / lod.minLeafSize))))
  const needBase = lod.K
  const fwdX = options.forward?.x ?? 0
  const fwdZ = options.forward?.z ?? 0
  const hasForward =
    Number.isFinite(fwdX) && Number.isFinite(fwdZ) && fwdX * fwdX + fwdZ * fwdZ > 1e-6

  let leafCount = 0
  let minLeaf = Infinity
  let maxLeaf = 0

  const r0 = Math.floor((camX - horizon) / rootSize)
  const r1 = Math.floor((camX + horizon) / rootSize)
  const z0 = Math.floor((camZ - horizon) / rootSize)
  const z1 = Math.floor((camZ + horizon) / rootSize)
  const h2 = horizon * horizon

  for (let rz = z0; rz <= z1; rz++) {
    for (let rx = r0; rx <= r1; rx++) {
      const ox = rx * rootSize
      const oz = rz * rootSize
      // XZ-дистанция до ближайшей точки корня (быстрый отсев).
      const dxr = Math.max(Math.abs(camX - (ox + rootSize / 2)) - rootSize / 2, 0)
      const dzr = Math.max(Math.abs(camZ - (oz + rootSize / 2)) - rootSize / 2, 0)
      if (dxr * dxr + dzr * dzr > h2) continue

      // DFS по поддереву корня (явный стек — без рекурсии и аллокаций).
      let sp = 0
      leafStack[sp * 3] = ox
      leafStack[sp * 3 + 1] = oz
      leafStack[sp * 3 + 2] = 0
      sp++
      while (sp > 0) {
        sp--
        const x = leafStack[sp * 3]
        const z = leafStack[sp * 3 + 1]
        const depth = leafStack[sp * 3 + 2]
        const size = rootSize / (1 << depth)
        const half = size / 2

        // 3D-дистанция до ближайшей точки квадрата (с высотой камеры).
        const dx = Math.max(Math.abs(camX - (x + half)) - half, 0)
        const dz = Math.max(Math.abs(camZ - (z + half)) - half, 0)
        const distSq = dx * dx + dz * dz + camY * camY
        const need = size * needBase

        if (hasForward && distSq > camY * camY) {
          // Отсечение по направлению взгляда: угол от forward до центра листа
          // минус угловой радиус листа должен влезать в сектор обзора.
          const cx = x + half - camX
          const cz = z + half - camZ
          const len = Math.sqrt(cx * cx + cz * cz)
          const angular = Math.atan2(half * Math.SQRT2, len)
          const cosKeep = Math.cos(((60 + 5) * Math.PI) / 180 + angular)
          if ((cx * fwdX + cz * fwdZ) / (len || 1) < cosKeep) continue
        }

        if (depth < maxDepth && leafCount < maxInstances - 4 && distSq < need * need) {
          const q = size / 2
          leafStack[sp * 3] = x
          leafStack[sp * 3 + 1] = z
          leafStack[sp * 3 + 2] = depth + 1
          leafStack[(sp + 1) * 3] = x + q
          leafStack[(sp + 1) * 3 + 1] = z
          leafStack[(sp + 1) * 3 + 2] = depth + 1
          leafStack[(sp + 2) * 3] = x
          leafStack[(sp + 2) * 3 + 1] = z + q
          leafStack[(sp + 2) * 3 + 2] = depth + 1
          leafStack[(sp + 3) * 3] = x + q
          leafStack[(sp + 3) * 3 + 1] = z + q
          leafStack[(sp + 3) * 3 + 2] = depth + 1
          sp += 4
        } else {
          if (leafCount >= maxInstances) {
            // ЖЁСТКИЙ кап (урок Task 115: эмиссия без капа переполняла
            // контракт при малых maxInstances — хвост DFS молча писал мимо).
            break
          }
          const o = leafCount * 4
          leafInstances[o] = x
          leafInstances[o + 1] = z
          leafInstances[o + 2] = size
          leafInstances[o + 3] = 0
          leafCount++
          if (size < minLeaf) minLeaf = size
          if (size > maxLeaf) maxLeaf = size
        }
      }
      if (leafCount >= maxInstances) break
    }
  }

  // ⚠️ Свежий объект-результат: держать ДВЕ выборки одновременно — легально
  // (урок Task 115: синглтон алиасил выборки, тесты/сравнение молча врали).
  // Буфер инстансов — общий (ноль больших аллокаций на кадр).
  return {
    leafCount,
    instanceData: leafInstances,
    triangles: leafCount * PATCH_TRIANGLE_COUNT,
    minLeafSize: leafCount === 0 ? 0 : minLeaf,
    maxLeafSize: leafCount === 0 ? 0 : maxLeaf,
    lod,
  }
}

/**
 * Глубина юбки, м: перекрывает перепад высот рельефа на стыке LOD.
 * Формула валидирована океаном (дисплейс-амплитуда растёт с «разрешением»
 * листа относительно периода карты высот).
 */
export function skirtDepthFor(leafSize: number, periodSize: number): number {
  return Math.max(8, Math.min(300, (periodSize / leafSize) * 12))
}

// Горизонтальный forward из view-матрицы (колоночно-мажорной): направление
// взгляда = −третья строка ротационной части. Возвращается СИНГЛТОН — без
// аллокаций; нулевой вектор (вид строго вниз) отключает отсечение.
const forwardScratch = { x: 0, z: 0 }
export function viewForwardXZ(view: Float32Array): { x: number; z: number } {
  const x = -view[2]
  const z = -view[10]
  const len = Math.sqrt(x * x + z * z)
  if (!(len > 1e-6) || !Number.isFinite(len)) {
    forwardScratch.x = 0
    forwardScratch.z = 0
    return forwardScratch
  }
  forwardScratch.x = x / len
  forwardScratch.z = z / len
  return forwardScratch
}
