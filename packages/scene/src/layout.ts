/**
 * layout.ts — единая раскладка памяти сцены (Task 81, @rune/scene).
 *
 * Один буфер — один контракт: сцена живёт ЛИБО в локальном ArrayBuffer
 * (T0, один поток), ЛИБО в SharedArrayBuffer (T1/T2, воркер обновляет
 * трансформы/видимость параллельно с main). Инвариант транспортов досье
 * (§7.2): меняется только латентность, не семантика — горячие циклы
 * (updateWorld / cull / collectInstances) работают с одними и теми же
 * views и НЕ знают, в каком потоке исполняются.
 *
 * Раскладка — data-oriented SoA (flecs-style иерархии, NullGraph'2026):
 * всё — плоские типизированные массивы по слотам узлов; ни одного JS-объекта
 * на узел в горячих путях.
 *
 * Битсеты видимости и пул инстанс-матриц — ДВУХБУФЕРНЫЕ (epoch & 1):
 * воркер пишет в буфер эпохи k, main читает буфер предыдущей свежей эпохи —
 * tearing исключён без блокировок (seq-cst атомики заголовка упорядочивают).
 */

/** Индексы слов заголовка (Int32Array/Uint32Array, слово 0..H_WORDS-1). */
export const H_MAGIC = 0
export const H_CAPACITY = 1
export const H_NODE_COUNT = 2
export const H_CAMERA_MAX = 3
export const H_CAMERA_COUNT = 4
export const H_INPUT_EPOCH = 5
export const H_OUTPUT_EPOCH = 6
export const H_LAYOUT_EPOCH = 7
export const H_CLOCK = 8
export const H_CMD_FLAGS = 9
export const H_BITS_WORDS = 10
export const H_GROUP_COUNT = 11
export const H_INSTANCE_POOL = 12
export const H_DROPPED_INSTANCES = 13
export const H_STALE_TAKES = 14
export const H_INT_WORDS = 15
export const H_FLOAT_FLOATS = 16
export const H_MAX_INSTANCES = 17
export const H_GROUP_MAX = 18
/** Task 85: H_LAYOUT_EPOCH, который видел последний collectInstances (дифф видимости между эпохами валиден только при неизменных рангах). */
export const H_COLLECT_LAYOUT_EPOCH = 19
export const H_WORDS = 20

/** Магическое слово 'RNS2' (int32 LE; v2 — groupTouch + dirtyBounds). */
export const SCENE_MAGIC = 0x3253_4e52

/** Флаги кадровой команды (H_CMD_FLAGS) для воркера. */
export const CMD_UPDATE_WORLD = 1
export const CMD_CULL = 2
export const CMD_INSTANCES = 4
export const CMD_REFIT = 8
export const CMD_ALL = CMD_UPDATE_WORLD | CMD_CULL | CMD_INSTANCES | CMD_REFIT
/** Останов воркера (мост dispose()). */
export const CMD_STOP = 1 << 30

/** Флаги узла (nodeFlags). */
export const NF_VISIBLE = 1
/** Слот занят живым узлом (0 — свободный слот). */
export const NF_ALIVE = 2

/** Параметры аллокации буфера сцены. */
export interface SceneBufferOptions {
  /** Максимум узлов (слоты). Default 1024. */
  readonly capacity?: number
  /** Максимум камер с битовыми полями видимости. Default 4. */
  readonly cameraMax?: number
  /** Максимум инстанс-групп (плотные id 0..G-1). Default 64. */
  readonly groupMax?: number
  /** Максимум видимых инстансов на кадр (пул матриц). Default = capacity. */
  readonly maxInstances?: number
  /** SharedArrayBuffer (воркер) вместо ArrayBuffer (T0). Default false. */
  readonly shared?: boolean
}

/** Все views поверх одного буфера сцены. */
export interface SceneViews {
  readonly buffer: ArrayBufferLike
  /** Знаковые слова заголовка (магия/счётчики). */
  readonly headerI: Int32Array
  /** Беззнаковые слова заголовка (эпохи/штампы). */
  readonly headerU: Uint32Array

  // ─── структура (слот → …) ───────────────────────────────────────────
  readonly parent: Int32Array
  readonly firstChild: Int32Array
  readonly nextSibling: Int32Array
  readonly prevSibling: Int32Array
  /** rank → slot: порядок обхода в глубину (parent всегда раньше детей). */
  readonly order: Int32Array
  /** slot → конец поддерева (rank, эксклюзивно). */
  readonly subtreeEnd: Int32Array
  readonly group: Int32Array
  readonly payload: Int32Array
  readonly nodeFlags: Int32Array
  readonly generation: Int32Array

  // ─── грязь (u32-штампы монотонного H_CLOCK) ─────────────────────────
  readonly localStamp: Uint32Array
  readonly worldStamp: Uint32Array

  // ─── видимость (двухбуферная, ранговое пространство) ────────────────
  /** 2 × cameraMax × bitsWords слов; буфер = epoch & 1. */
  readonly bits: Uint32Array
  /** 2 × cameraMax × groupMax: видимых инстансов группы g (камера × буфер). */
  readonly instCounts: Int32Array
  /** 2 × cameraMax × groupMax: офсет группы g в instPool (камера × буфер). */
  readonly instOffsets: Int32Array

  // ─── Task 85: оптимизационные области ─────────────────────────────
  /** groupMax: штамп H_CLOCK последнего изменения КОНТЕНТА группы (все
   *  камеры): мир любого узла группы пересчитан (updateWorld) или состав
   *  сменился (setVisible). Живёт в SAB: пишет конвейерный поток. */
  readonly groupTouch: Int32Array
  /** cameraMax × groupMax: штамп последнего ФЛИПА видимости узла группы
   *  ДЛЯ КОНКРЕТНОЙ камеры (Task 85): флип дрона не должен перевыгружать
   *  статику миникарты — инстанс-буферы у камер РАЗНЫЕ, и грязь тоже.
   * Индекс: cameraIndex × groupMax + group. */
  readonly groupFlip: Int32Array
  /** bitsWords (по биту на УЗЕЛ, не на ранг — слот-адресуемо): «поддерево
   *  узла могло изменить границы — refit должен пересобрать». Ставится в
   *  updateWorld (рекомпьют узла + подъём по предкам), снимается refit'ом.
 *  Чисто оптимизационная подсказка: лишний бит = лишняя работа, ошибочно
   *  СНЯТЫЙ бит невозможен (снимает только сам refit после обработки). */
  readonly dirtyBounds: Uint32Array

  // ─── геометрия (слоты) ──────────────────────────────────────────────
  readonly pos: Float32Array
  readonly quat: Float32Array
  readonly scale: Float32Array
  readonly world: Float32Array
  /** Локальная сфера (cx, cy, cz, r); r ≤ 0 у внутреннего узла — авто. */
  readonly sphereL: Float32Array
  readonly sphereW: Float32Array

  // ─── камеры и инстансы ──────────────────────────────────────────────
  /** cameraMax × 24: плоскости фрустума (нормированные). */
  readonly planes: Float32Array
  /** 2 × cameraMax × maxInstances × 16: матрицы миров видимых инстансов
   *  (сегмент на камеру — мульткамерные пулы не конфликтуют). */
  readonly instPool: Float32Array

  // ─── производные размеры ────────────────────────────────────────────
  readonly capacity: number
  readonly cameraMax: number
  readonly groupMax: number
  readonly maxInstances: number
  readonly bitsWords: number
}

/** Число 32-битных слов битсета на камеру. */
export function sceneBitsWords(capacity: number): number {
  return (capacity + 31) >> 5
}

/** Точка входа свободного списка в int-регионе (после 12 массивов слотов). */
export function freeListWord(views: Pick<SceneViews, 'capacity'>): number {
  return H_WORDS + views.capacity * 12
}

/** Аллоцирует буфер сцены и инициализирует заголовок. */
export function createSceneBuffer(options: SceneBufferOptions = {}): ArrayBufferLike {
  const capacity = Math.max(1, options.capacity ?? 1024)
  const cameraMax = Math.max(1, options.cameraMax ?? 4)
  const groupMax = Math.max(1, options.groupMax ?? 64)
  const maxInstances = Math.max(0, options.maxInstances ?? capacity)
  const bitsWords = sceneBitsWords(capacity)

  const intWords =
    H_WORDS +
    capacity * 12 + // parent, firstChild, nextSibling, prevSibling, order, subtreeEnd, group, payload, nodeFlags, generation, localStamp, worldStamp
    2 + // freeHead, freeCount
    2 * cameraMax * bitsWords +
    2 * cameraMax * groupMax * 2 +
    groupMax + // groupTouch (Task 85)
    cameraMax * groupMax + // groupFlip — перкамерные штампы флипов (Task 85)
    bitsWords // dirtyBounds (Task 85)
  const floatFloats =
    capacity * (3 + 4 + 3 + 16 + 4 + 4) +
    cameraMax * 24 +
    2 * cameraMax * maxInstances * 16

  const bytes = intWords * 4 + floatFloats * 4
  const buffer = options.shared === true ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes)

  const headerI = new Int32Array(buffer, 0, H_WORDS)
  headerI[H_MAGIC] = SCENE_MAGIC
  headerI[H_CAPACITY] = capacity
  headerI[H_NODE_COUNT] = 0
  headerI[H_CAMERA_MAX] = cameraMax
  headerI[H_CAMERA_COUNT] = 0
  headerI[H_INPUT_EPOCH] = 0
  headerI[H_OUTPUT_EPOCH] = 0
  headerI[H_LAYOUT_EPOCH] = 0
  headerI[H_CLOCK] = 0
  headerI[H_CMD_FLAGS] = CMD_ALL
  headerI[H_BITS_WORDS] = bitsWords
  headerI[H_GROUP_COUNT] = 0
  headerI[H_INSTANCE_POOL] = maxInstances
  headerI[H_DROPPED_INSTANCES] = 0
  headerI[H_STALE_TAKES] = 0
  headerI[H_INT_WORDS] = intWords
  headerI[H_FLOAT_FLOATS] = floatFloats
  headerI[H_MAX_INSTANCES] = maxInstances
  headerI[H_GROUP_MAX] = groupMax

  // Структурные массивы: значения «пусто».
  const views = buildSceneViews(buffer)
  views.parent.fill(-1)
  views.firstChild.fill(-1)
  views.nextSibling.fill(-1)
  views.prevSibling.fill(-1)
  views.subtreeEnd.fill(0)
  views.group.fill(-1)
  views.payload.fill(-1)
  views.nodeFlags.fill(0) // все слоты свободны; NF_ALIVE ставит create()
  views.instCounts.fill(0)
  views.instOffsets.fill(0)
  views.groupTouch.fill(0)
  views.groupFlip.fill(0)
  views.dirtyBounds.fill(0)

  // Свободный список: slot i → slot i+1 (через nextSibling), голова 0.
  // Пишем через ПОЛНЫЙ int-вью (headerI ограничен H_WORDS словами).
  const full = new Int32Array(buffer)
  const freeList = freeListWord(views)
  full[freeList] = capacity > 0 ? 0 : -1
  full[freeList + 1] = capacity
  for (let i = 0; i < capacity - 1; i++) views.nextSibling[i] = i + 1
  views.nextSibling[capacity - 1] = -1

  // Единичные трансформы.
  for (let i = 0; i < capacity; i++) {
    views.quat[i * 4 + 3] = 1
    views.scale[i * 3] = 1
    views.scale[i * 3 + 1] = 1
    views.scale[i * 3 + 2] = 1
  }
  return buffer
}

/** Строит все views поверх существующего буфера (+валидация магии). */
export function buildSceneViews(buffer: ArrayBufferLike): SceneViews {
  if (buffer.byteLength < H_WORDS * 4) {
    throw new Error('scene: буфер слишком мал для заголовка')
  }
  const probe = new Int32Array(buffer, 0, H_WORDS)
  if (probe[H_MAGIC] !== SCENE_MAGIC) {
    throw new Error('scene: буфер не является сценой (магия не совпадает)')
  }
  const capacity = probe[H_CAPACITY]
  const cameraMax = probe[H_CAMERA_MAX]
  const groupMax = probe[H_GROUP_MAX]
  const maxInstances = probe[H_MAX_INSTANCES]
  const bitsWords = probe[H_BITS_WORDS]
  const intWords = probe[H_INT_WORDS]
  const floatFloats = probe[H_FLOAT_FLOATS]
  const expectedBytes = intWords * 4 + floatFloats * 4
  if (buffer.byteLength < expectedBytes) {
    throw new Error(`scene: буфер меньше раскладки (${buffer.byteLength} < ${expectedBytes})`)
  }

  const headerI = probe
  const headerU = new Uint32Array(buffer, 0, H_WORDS)

  let w = H_WORDS
  const int = (len: number): Int32Array => {
    const v = new Int32Array(buffer, w * 4, len)
    w += len
    return v
  }
  const uint = (len: number): Uint32Array => {
    const v = new Uint32Array(buffer, w * 4, len)
    w += len
    return v
  }

  const parent = int(capacity)
  const firstChild = int(capacity)
  const nextSibling = int(capacity)
  const prevSibling = int(capacity)
  const order = int(capacity)
  const subtreeEnd = int(capacity)
  const group = int(capacity)
  const payload = int(capacity)
  const nodeFlags = int(capacity)
  const generation = int(capacity)
  const localStamp = uint(capacity)
  const worldStamp = uint(capacity)
  int(2) // freeHead, freeCount — за пределами H_WORDS (freeListWord)

  const bits = uint(2 * cameraMax * bitsWords)
  const instCounts = int(2 * cameraMax * groupMax)
  const instOffsets = int(2 * cameraMax * groupMax)
  const groupTouch = int(groupMax)
  const groupFlip = int(cameraMax * groupMax)
  const dirtyBounds = uint(bitsWords)
  if (w !== intWords) {
    throw new Error(`scene: раскладка int-региона разъехалась (${w} ≠ ${intWords})`)
  }

  let f = intWords
  const floats = (len: number): Float32Array => {
    const v = new Float32Array(buffer, f * 4, len)
    f += len
    return v
  }
  const pos = floats(capacity * 3)
  const quat = floats(capacity * 4)
  const scale = floats(capacity * 3)
  const world = floats(capacity * 16)
  const sphereL = floats(capacity * 4)
  const sphereW = floats(capacity * 4)
  const planes = floats(cameraMax * 24)
  const instPool = floats(2 * cameraMax * Math.max(maxInstances, 0) * 16)
  if (f !== intWords + floatFloats) {
    throw new Error(`scene: раскладка float-региона разъехалась (${f} ≠ ${intWords + floatFloats})`)
  }

  return {
    buffer,
    headerI,
    headerU,
    parent, firstChild, nextSibling, prevSibling,
    order, subtreeEnd, group, payload, nodeFlags, generation,
    localStamp, worldStamp,
    bits, instCounts, instOffsets, groupTouch, groupFlip, dirtyBounds,
    pos, quat, scale, world, sphereL, sphereW,
    planes, instPool,
    capacity, cameraMax, groupMax, maxInstances, bitsWords,
  }
}
