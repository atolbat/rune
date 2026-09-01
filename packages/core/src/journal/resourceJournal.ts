/**
 * ResourceJournal (v2) — журнал ПЕРВИЧНЫХ ресурсов с КОНТЕНТОМ.
 *
 * Задача (переработка Task 62): старый Journal хранил декларации с
 * счётчиковыми id фасада. Replay на свежем фасаде выдаёт плотную
 * последовательность id — при любой «дырке» (compact/evict/ленивые
 * пайплайны) id сдвигаются, зависимые опсы ссылаются на чужие текстуры,
 * и приложение не может восстановить сцену («texture id 1, 2, 4 → 1, 2,
 * 3, 4 НЕ СОВПАДАЮТ»).
 *
 * Новая модель — три решения:
 *
 * 1. СТАБИЛЬНЫЕ ID. Опс несёт id, назначенный уровнем НАД фасадом
 *    (resourceSession). Replay принимает id из опса и строит mapping
 *    стабильный-id → новый фасадный id. Id совпадают ДО и ПОСЛЕ потери
 *    устройства ПО ПОСТРОЕНИЮ — сверять нечего, ошибиться негде.
 *
 * 2. ПРИМИТИВНЫЕ ОПСЫ. Все действия движка над первичными ресурсами
 *    сведены к простому набору:
 *      texture.create / texture.write / texture.update / texture.writeMip
 *      / texture.destroy
 *      view.create / view.destroy            (sub-mip views)
 *      target.create / target.destroy        (render targets)
 *    Нормальная работа и восстановление — ОДИН И ТОТ ЖЕ путь: replay
 *    выполняет те же примитивы через тот же фасадный API.
 *
 * 3. КОНТЕНТ В ЖУРНАЛЕ. texture.write/update/writeMip хранят ContentRef —
 *    ссылку на CPU-источник в ContentStore (ImageBitmap/OffscreenCanvas/
 *    HTMLCanvasElement/...). Источники переживают потерю GPU-устройства,
 *    поэтому replay восстанавливает ПИКСЕЛИ, а не только декларации.
 *    «В чём смысл журнала, если он просит пересоздать атлас?» — теперь
 *    атлас восстанавливается сам, включая тайлы.
 *
 * Что в журнал НЕ попадает (намеренно):
 *   - Programs/buffers команд (GL) — ПРОИЗВОДНОЕ состояние: чистая функция
 *     от спеков команд, владелец (renderer) пересоздаёт их лениво при
 *     первом draw. Журнал хранит только ПЕРВИЧНОЕ состояние (контент).
 *   - texSubImage2D (raw-байтовый стриминг) — домен UploadScheduler'а:
 *     Pump сам пере-стримит свои данные, журналирование чанков взорвёт
 *     журнал.
 *   - Frame-опсы (bind/draw/uniform/...) — Tape, не журнал.
 *
 * compact() (сверх пар create→destroy из v1):
 *   - texture.write поглощает ВСЕ предыдущие write/update/writeMip той же
 *     текстуры (полная перезапись делает их бессмысленными);
 *   - повторный texture.update того же точного прямоугольника — выживает
 *     последний (last-write-wins);
 *   - create→destroy пары + висячие ссылки (Task 61) — как в v1:
 *     зависимый опс мёртвой текстуры выбрасывается вместе с destroy-опсами
 *     призумленных view/target (без сирот);
 *   - ContentStore GC (Task 65): источники, на которые не ссылается НИ ОДИН
 *     оставшийся контент-опс, освобождаются — CPU-память не течёт от
 *     «прожал много кнопок» (каждая создала-и-выбросила текстуру).
 *
 * Task 65 (soft reset / ленивая резидентность):
 *   - WorkingSet — какие ресурсы обязаны быть в GPU-памяти после потери
 *     (сцена); всё остальное восстанавливается ЛЕНИВО (ensureResident);
 *   - selectResidentOps(ops, keep) — чистая функция: замыкание рабочего
 *     множества (view → parent texture, target → parent texture, контент →
 *     своя текстура) + списки отложенных ресурсов;
 *   - RestoreReport.deferred — что осталось в журнале невосстановленным.
 *
 * Сериализация (worker migration): ops — plain objects, JSON-safe.
 * Источники ContentStore НЕ сериализуются (ImageBitmap закрыт/передан,
 * canvas — DOM). snapshot() возвращает манифест контента (refs + kind +
 * размеры); принимающая сторона пере-регистрирует источники через
 * attachSource(ref, source) перед replay.
 */

/** Формат текстуры (Task 67: HDR).
 *  'rgba8unorm' — дефолт обоих бэкендов (WebGL2: RGBA8).
 *  'canvas' — формат канваса WebGPU (обычно bgra8unorm); WebGL2 игнорирует
 *  и аллоцирует RGBA8 (рендер в текстуру на GL всегда через свою текстуру).
 *  'rgba16float' / 'rgba32float' — HDR: WebGL2 → RGBA16F/RGBA32F
 *  (texStorage2D/texImage2D internalFormat + HALF_FLOAT/FLOAT type при
 *  загрузке), WebGPU → rgba16float/rgba32float (core, renderable).
 *  Требования: WebGL2 — хранение float-текстур core; ЛИНЕЙНАЯ фильтрация
 *  rgba16float core, rgba32float требует OES_texture_float_linear;
 *  рендер В float-цель требует EXT_color_buffer_float. WebGPU — оба формата
 *  core (rgba32float не фильтруется линейно без feature 'float32-filterable'). */
// Task 110 (реставрация): TextureFormat унифицирован с formats.ts —
// полный канонический каталог (старый журнальный узкий тип был его подмножеством).
import { TEXTURE_FORMATS, type TextureFormat, type TextureFormatId } from '../formats.ts'
export type { TextureFormat }

/** Байт на пиксель по формату: несжатые — texelBytes каталога, сжатые —
 *  оценка по блоку, неизвестные/не указанные — 4 (rgba8-совместимые). */
export function textureFormatBytesPerPixel(format?: TextureFormat): number {
  if (format === undefined) return 4
  const info = TEXTURE_FORMATS[format as TextureFormatId]
  if (info === undefined) return 4
  if (info.blockWidth > 1 || info.blockHeight > 1) {
    // сжатые: байты на блок / текселей на блок (оценка средней плотности)
    return info.blockBytes / (info.blockWidth * info.blockHeight)
  }
  return info.texelBytes
}

/** Цвет очистки цели. */
export type ClearColor2 = readonly [number, number, number, number]

/** Ссылка на CPU-источник пикселей в ContentStore журнала.
 *  kind — имя типа источника ('ImageBitmap', 'OffscreenCanvas', ...),
 *  width/height — размеры НА МОМЕНТ записи (replay не зависит от того,
 *  жив ли источник сейчас: мёртвый → опс пропускается с warning'ом). */
export interface ContentRef {
  readonly ref: number
  readonly kind: string
  readonly width: number
  readonly height: number
}

/** Примитивные опсы над первичными ресурсами. id — СТАБИЛЬНЫЕ id уровня
 *  resourceSession (не фасадные). Зависимые ссылки (textureId) — тоже. */
export type ResOp =
  | { readonly kind: 'texture.create'; readonly id: number; readonly width: number; readonly height: number; readonly format?: TextureFormat; readonly options?: { readonly mipLevels?: number; readonly maxAnisotropy?: number } }
  | { readonly kind: 'texture.write'; readonly id: number; readonly content: ContentRef; readonly flipY: boolean }
  | { readonly kind: 'texture.update'; readonly id: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly content: ContentRef; readonly flipY: boolean }
  | { readonly kind: 'texture.writeMip'; readonly id: number; readonly level: number; readonly content: ContentRef; readonly flipY: boolean }
  | { readonly kind: 'texture.destroy'; readonly id: number }
  | { readonly kind: 'view.create'; readonly id: number; readonly textureId: number; readonly baseMipLevel?: number; readonly mipLevelCount?: number }
  | { readonly kind: 'view.destroy'; readonly id: number }
  | { readonly kind: 'target.create'; readonly id: number; readonly textureId: number; readonly width: number; readonly height: number; readonly depth: boolean; readonly color: ClearColor2 }
  | { readonly kind: 'target.destroy'; readonly id: number }

/** Манифест контента — что должно быть пере-регистрировано на принимающей
 *  стороне (worker migration) перед replay снапшота. */
export interface ContentManifestEntry {
  readonly ref: number
  readonly kind: string
  readonly width: number
  readonly height: number
}

/** Рабочее множество (Task 65 soft reset): какие ресурсы обязаны вернуться в
 *  GPU-память немедленно после потери устройства. Всё живое, что НЕ вошло —
 *  остаётся декларацией в журнале и возвращается лениво (ensureResident).
 *  Пустое множество = «сцены нет»: после loss — чистый бэкенд. */
export interface WorkingSet {
  readonly textureIds?: readonly number[]
  readonly viewIds?: readonly number[]
  readonly targetIds?: readonly number[]
}

/** Результат выбора резидентных опсов: минимальный подсписок журнала,
 *  восстанавливающий рабочее множество (+ что осталось отложенным). */
export interface ResidentSelection {
  /** Опсы для replay в исходном порядке (create + контент + зависимые). */
  readonly ops: readonly ResOp[]
  /** Живые текстуры, НЕ вошедшие в рабочее множество (отложены). */
  readonly deferredTextures: readonly number[]
  /** Живые views, НЕ вошедшие (отложены). */
  readonly deferredViews: readonly number[]
  /** Живые targets, НЕ вошедшие (отложены). */
  readonly deferredTargets: readonly number[]
}

/** Выбрать опсы резидентного подмножества (чистая функция).
 *
 * Замыкание рабочего множества:
 *   • keep.textureIds → их texture.create + ВСЕ их контент-опсы
 *     (write/update/writeMip живой инкарнации);
 *   • keep.viewIds → их view.create + parent-текстура (create + контент —
 *     view без пикселей родителя бессмыслен);
 *   • keep.targetIds → их target.create + parent-текстура (create БЕЗ
 *     контента — в target контент перезапишется рендером);
 *   • views/targets на НЕ вошедших текстурах — отложены (дажели их parent
 *     вошёл: view — отдельный ресурс, возвращается своим ensureResident).
 *
 * Живость — по последнему lifecycle-опсу (семантика compact): последняя
 * инкарнация create→…→destroy→create жива, её опсы и берём. */
export function selectResidentOps(ops: readonly ResOp[], keep: WorkingSet): ResidentSelection {
  // Живые ресурсы: последний lifecycle-опс — create.
  const lastTexLifecycle = new Map<number, 'create' | 'destroy'>()
  const lastViewLifecycle = new Map<number, 'create' | 'destroy'>()
  const lastTargetLifecycle = new Map<number, 'create' | 'destroy'>()
  // Последний create view/target → parent textureId (для замыкания родителей).
  const viewParent = new Map<number, number>()
  const targetParent = new Map<number, number>()
  // Индекс ПОСЛЕДНЕГО create (контент мёртвой инкарнации не восстанавливаем —
  // семантика compact: create→…→destroy→create жива только последняя).
  const lastTexCreateIdx = new Map<number, number>()
  const lastViewCreateIdx = new Map<number, number>()
  const lastTargetCreateIdx = new Map<number, number>()
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (op.kind === 'texture.create') { lastTexLifecycle.set(op.id, 'create'); lastTexCreateIdx.set(op.id, i) }
    else if (op.kind === 'texture.destroy') lastTexLifecycle.set(op.id, 'destroy')
    else if (op.kind === 'view.create') { lastViewLifecycle.set(op.id, 'create'); lastViewCreateIdx.set(op.id, i); viewParent.set(op.id, op.textureId) }
    else if (op.kind === 'view.destroy') lastViewLifecycle.set(op.id, 'destroy')
    else if (op.kind === 'target.create') { lastTargetLifecycle.set(op.id, 'create'); lastTargetCreateIdx.set(op.id, i); targetParent.set(op.id, op.textureId) }
    else if (op.kind === 'target.destroy') lastTargetLifecycle.set(op.id, 'destroy')
  }

  // Замыкание текстур: запрошенные + родители запрошенных views/targets.
  const texKeep = new Set<number>(keep.textureIds ?? [])
  const viewKeep = new Set<number>(keep.viewIds ?? [])
  const targetKeep = new Set<number>(keep.targetIds ?? [])
  for (const viewId of viewKeep) {
    const parent = viewParent.get(viewId)
    if (parent !== undefined) texKeep.add(parent)
  }
  for (const targetId of targetKeep) {
    const parent = targetParent.get(targetId)
    if (parent !== undefined) texKeep.add(parent)
  }
  // Views требуют КОНТЕНТ родителя (сэмплить нечего без пикселей);
  // targets — нет (рендер сам перезапишет).
  const texNeedsContent = new Set<number>(keep.textureIds ?? [])
  for (const viewId of viewKeep) {
    const parent = viewParent.get(viewId)
    if (parent !== undefined) texNeedsContent.add(parent)
  }

  const selected: ResOp[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    switch (op.kind) {
      case 'texture.create': {
        // Только ПОСЛЕДНЯЯ инкарнация (мёртвые create выброшены парой
        // с destroy в compact; без compact — тоже корректно: контент
        // мёртвой инкарнации всё равно не валиден).
        if (texKeep.has(op.id) && lastTexCreateIdx.get(op.id) === i) selected.push(op)
        break
      }
      case 'texture.destroy': {
        break
      }
      case 'texture.write':
      case 'texture.update':
      case 'texture.writeMip': {
        if (texKeep.has(op.id) && texNeedsContent.has(op.id)
          && lastTexLifecycle.get(op.id) === 'create'
          && (lastTexCreateIdx.get(op.id) ?? -1) < i) {
          selected.push(op)
        }
        break
      }
      case 'view.create': {
        if (viewKeep.has(op.id) && lastViewCreateIdx.get(op.id) === i) selected.push(op)
        break
      }
      case 'target.create': {
        if (targetKeep.has(op.id) && lastTargetCreateIdx.get(op.id) === i) selected.push(op)
        break
      }
      default:
        break // destroy-опсы при восстановлении — no-op по определению
    }
  }

  const deferredTextures: number[] = []
  for (const [id, lifecycle] of lastTexLifecycle) {
    if (lifecycle === 'create' && !texKeep.has(id)) deferredTextures.push(id)
  }
  const deferredViews: number[] = []
  for (const [id, lifecycle] of lastViewLifecycle) {
    if (lifecycle === 'create' && !viewKeep.has(id)) deferredViews.push(id)
  }
  const deferredTargets: number[] = []
  for (const [id, lifecycle] of lastTargetLifecycle) {
    if (lifecycle === 'create' && !targetKeep.has(id)) deferredTargets.push(id)
  }
  return { ops: selected, deferredTextures, deferredViews, deferredTargets }
}

/** Снимок журнала: ops JSON-safe + манифест контента. */
export interface ResourceJournalSnapshot {
  readonly ops: readonly ResOp[]
  readonly content: readonly ContentManifestEntry[]
}

/** Квантификация восстановления — что произошло при replay. */
export interface RestoreReport {
  /** Сколько опсов исполнено (без destroy-пропусков). */
  readonly opsReplayed: number
  /** Стабильные id живых текстур (совпадают с id до потери ПО ПОСТРОЕНИЮ). */
  readonly textureIds: readonly number[]
  /** Стабильные id живых view'ов. */
  readonly viewIds: readonly number[]
  /** Стабильные id живых целей. */
  readonly targetIds: readonly number[]
  /** Сколько контент-опсов (write/update/writeMip) пере-залито. */
  readonly contentOps: number
  /** Сколько контент-опсов пропущено (источник мёртв/не пере-регистрирован). */
  readonly skipped: number
  /** Task 65: живые ресурсы, НЕ вошедшие в рабочее множество (soft reset) —
 *  остались декларациями в журнале, вернутся через ensureResident().
 *  Отсутствует/пусто при полном restore (strategy='full'). */
  readonly deferred?: { readonly textures: readonly number[]; readonly views: readonly number[]; readonly targets: readonly number[] }
}

/** Журнал первичных ресурсов: append-only + компактирование + ContentStore. */
export interface ResourceJournal {
  /** Записать примитивный опс. Append-only. */
  record(op: ResOp): void
  /** Исполнить опсы в порядке записи на любом приёмнике. */
  replay(apply: (op: ResOp) => void): void
  /** Все опсы в порядке записи (защитная копия). */
  entries(): readonly ResOp[]
  /** Компактирование: пары create→destroy, поглощение write'ом,
   *  last-write-wins одинаковых rect, prune висячих ссылок. */
  compact(): void
  /** Глубокая копия (ops клонируются; ContentStore разделяется — источники
   *  живые объекты, клонировать битмапы = удвоение памяти). */
  snapshot(): ResourceJournalSnapshot
  /** Убрать опсы под предикатом. */
  evict(predicate: (op: ResOp) => boolean): void
  /** Сброс в пустое состояние (новая сессия). ContentStore не чистится:
   *  источники может держать приложение. */
  reset(): void
  readonly size: number

  // ─── ContentStore ───────────────────────────────────────────────────────
  /** Зарегистрировать CPU-источник пикселей. Возвращает ссылку для опсов. */
  storeSource(source: unknown, kind: string, width: number, height: number): ContentRef
  /** Источник по ссылке (null — не зарегистрирован/мёртв). */
  getSource(ref: number): unknown
  /** Worker migration: пере-регистрировать источник под существующий ref. */
  attachSource(ref: number, source: unknown): void
  /** Жив ли источник (не null и не закрытый ImageBitmap). */
  isSourceAlive(ref: number): boolean

  // ─── Сидирование стабильных id ──────────────────────────────────────────
  /** Максимальный стабильный texture.create id (+1 = следующий свободный). */
  maxTextureId(): number
  /** Максимальный стабильный view.create id. */
  maxViewId(): number
  /** Максимальный стабильный target.create id. */
  maxTargetId(): number
}

/** Мёртвый источник: закрытый ImageBitmap (close()) отдаёт width=0. */
function sourceIsDead(source: unknown): boolean {
  if (source === null || source === undefined) return true
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    return source.width === 0 || source.height === 0
  }
  return false
}

/** Создать пустой ResourceJournal. */
export function createResourceJournal(): ResourceJournal {
  const ops: ResOp[] = []
  const sources = new Map<number, unknown>()
  // Task 65: монотонный счётчик ref — НЕ sources.size: после GC-чистки
  // compact() размер карты падает, а ref'ы обязаны оставаться уникальными
  // навсегда (иначе новый источник перезапишет живой ref).
  let nextRef = 1

  function storeSource(source: unknown, kind: string, width: number, height: number): ContentRef {
    const ref = nextRef++
    sources.set(ref, source)
    return { ref, kind, width, height }
  }

  /** ContentStore GC: выкинуть источники, на которые не ссылается ни один
   *  контент-опс. Вызывается из compact() — CPU-память не течёт от
   *  созданных-и-выброшенных текстур (их опсы уже удалены парами). */
  function pruneSources(): number {
    const used = new Set<number>()
    for (const op of ops) {
      if (op.kind === 'texture.write' || op.kind === 'texture.update' || op.kind === 'texture.writeMip') {
        used.add(op.content.ref)
      }
    }
    let pruned = 0
    for (const ref of [...sources.keys()]) {
      if (!used.has(ref)) { sources.delete(ref); pruned++ }
    }
    return pruned
  }

  return {
    record(op) {
      ops.push(op)
    },
    replay(apply) {
      for (const op of ops) apply(op)
    },
    entries() {
      return ops.slice()
    },

    compact() {
      // ─── Шаг 1: живость текстур (Task 61 семантика, обобщённая на v2) ──
      // Текстура жива в КОНЕЧНОМ состоянии, если её последний lifecycle-опс
      // — create (create→…→destroy→create = жива, инкарнация №2). Зависимые
      // опсы (write/update/writeMip/view.create/target.create) мертвы, если:
      //   1) последний lifecycle-опс текстуры — destroy (мертва в конце); или
      //   2) опс стоит ДО последнего create (принадлежит мёртвой инкарнации);
      //   3) в момент опса текстура была уничтожена (бегущий стейт).
      const lastTexLifecycle = new Map<number, 'create' | 'destroy'>()
      const lastTexCreateIdx = new Map<number, number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        if (op.kind === 'texture.create') {
          lastTexLifecycle.set(op.id, 'create')
          lastTexCreateIdx.set(op.id, i)
        } else if (op.kind === 'texture.destroy') {
          lastTexLifecycle.set(op.id, 'destroy')
        }
      }
      const running = new Map<number, 'create' | 'destroy'>()
      const aliveAt = new Map<number, boolean>()
      // Контент-опсы (write/update/writeMip) ссылаются на текстуру полем id;
      // view.create/target.create — полем textureId.
      const opTextureId = (op: ResOp): number | null =>
        op.kind === 'texture.write' || op.kind === 'texture.update' || op.kind === 'texture.writeMip'
          ? op.id
          : op.kind === 'view.create' || op.kind === 'target.create'
            ? op.textureId
            : null
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        const dep = opTextureId(op)
        if (dep !== null) {
          aliveAt.set(i, running.get(dep) === 'create')
        } else if (op.kind === 'texture.create') {
          running.set(op.id, 'create')
        } else if (op.kind === 'texture.destroy') {
          running.set(op.id, 'destroy')
        }
      }
      const texAliveAt = (i: number, textureId: number): boolean =>
        lastTexLifecycle.get(textureId) === 'create'
        && (lastTexCreateIdx.get(textureId) ?? -1) < i
        && aliveAt.get(i) === true

      // ─── Шаг 2: пары create→destroy + зависимые мёртвых текстур ────────
      // Один проход: create, парный с destroy, выкидывается вместе с destroy.
      // View/target на мёртвой текстуре выкидываются, их destroy'и — тоже
      // (без сирот). Контент-опсы мёртвой текстуры выкидываются.
      const seenTexDestroy = new Set<number>()
      const seenViewDestroy = new Set<number>()
      const seenTargetDestroy = new Set<number>()
      for (const op of ops) {
        if (op.kind === 'texture.destroy') seenTexDestroy.add(op.id)
        else if (op.kind === 'view.destroy') seenViewDestroy.add(op.id)
        else if (op.kind === 'target.destroy') seenTargetDestroy.add(op.id)
      }
      const prunedViews = new Set<number>()
      const prunedTargets = new Set<number>()
      // Паттерн v1 (проверен Task 61): идём по ops; create id с destroy-парой
      // пропускаем ТОЛЬКО ПЕРВЫЙ (и помечаем id); повторный create того же id
      // (create→…→destroy→create) остаётся — выживает последняя инкарнация.
      // destroy помеченного id выбрасывается (его create уже удалён).
      const keep: ResOp[] = []
      const pairedTexCreateDropped = new Set<number>()
      const pairedViewCreateDropped = new Set<number>()
      const pairedTargetCreateDropped = new Set<number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        switch (op.kind) {
          case 'texture.create':
            if (seenTexDestroy.has(op.id) && !pairedTexCreateDropped.has(op.id)) {
              pairedTexCreateDropped.add(op.id) // первый create — парный с destroy
            } else {
              keep.push(op)
            }
            break
          case 'texture.destroy':
            if (pairedTexCreateDropped.has(op.id)) continue // парный create удалён
            keep.push(op)
            break
          case 'view.create':
            if (seenViewDestroy.has(op.id) && !pairedViewCreateDropped.has(op.id)) {
              pairedViewCreateDropped.add(op.id)
              continue
            }
            if (!texAliveAt(i, op.textureId)) { prunedViews.add(op.id); continue }
            keep.push(op)
            break
          case 'view.destroy':
            if (pairedViewCreateDropped.has(op.id)) continue
            if (prunedViews.has(op.id)) continue
            keep.push(op)
            break
          case 'target.create':
            if (seenTargetDestroy.has(op.id) && !pairedTargetCreateDropped.has(op.id)) {
              pairedTargetCreateDropped.add(op.id)
              continue
            }
            if (!texAliveAt(i, op.textureId)) { prunedTargets.add(op.id); continue }
            keep.push(op)
            break
          case 'target.destroy':
            if (pairedTargetCreateDropped.has(op.id)) continue
            if (prunedTargets.has(op.id)) continue
            keep.push(op)
            break
          case 'texture.write':
          case 'texture.update':
          case 'texture.writeMip':
            if (!texAliveAt(i, op.id)) continue
            keep.push(op)
            break
          default:
            keep.push(op)
        }
      }
      ops.length = 0
      ops.push(...keep)

      // ─── Шаг 3: коалесцинг контента ────────────────────────────────────
      // texture.write(x) поглощает все предыдущие контент-опсы x. Повторный
      // texture.update того же rect — выживает последний (last-write-wins).
      // writeMip НЕ поглощается write'ом (другой mip-уровень); одинаковый
      // writeMip(level) — выживает последний.
      const contentKeep: ResOp[] = []
      /** Индексы в contentKeep, которые надо удалить после прохода. */
      const absorbed = new Set<number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        if (op.kind === 'texture.write') {
          // поглотить все предыдущие write/update этой текстуры (полная
          // перезапись делает их бессмысленными). writeMip — ДРУГОЙ mip-уровень,
          // write его НЕ поглощает.
          for (let j = 0; j < contentKeep.length; j++) {
            const prev = contentKeep[j]!
            if (prev.id === op.id && (prev.kind === 'texture.write' || prev.kind === 'texture.update')) {
              absorbed.add(j)
            }
          }
          contentKeep.push(op)
        } else if (op.kind === 'texture.update') {
          // last-write-wins для того же rect
          for (let j = 0; j < contentKeep.length; j++) {
            const prev = contentKeep[j]!
            if (prev.id === op.id && prev.kind === 'texture.update'
              && prev.x === op.x && prev.y === op.y && prev.w === op.w && prev.h === op.h) {
              absorbed.add(j)
            }
          }
          contentKeep.push(op)
        } else if (op.kind === 'texture.writeMip') {
          for (let j = 0; j < contentKeep.length; j++) {
            const prev = contentKeep[j]!
            if (prev.id === op.id && prev.kind === 'texture.writeMip' && prev.level === op.level) {
              absorbed.add(j)
            }
          }
          contentKeep.push(op)
        } else {
          contentKeep.push(op)
        }
      }
      const coalesced = contentKeep.filter((_, j) => !absorbed.has(j))
      ops.length = 0
      ops.push(...coalesced)

      // ─── Шаг 4 (Task 65): ContentStore GC ──────────────────────────────
      // Источники, на которые не ссылается ни один оставшийся контент-опс,
      // освобождаем: их текстуры уже уничтожены (пары create→destroy) или
      // их контент поглощён последним write. Иначе «прожал много кнопок» →
      // десятки мёртвых ImageBitmap/canvas в CPU-памяти навсегда.
      pruneSources()
    },

    snapshot() {
      const manifest: ContentManifestEntry[] = []
      for (const [ref, source] of sources) {
        const meta = opContentByRef(ops, ref)
        manifest.push({ ref, kind: meta.kind, width: meta.width, height: meta.height })
        void source
      }
      return { ops: ops.map(cloneResOp), content: manifest }
    },

    evict(predicate) {
      for (let i = ops.length - 1; i >= 0; i--) {
        if (predicate(ops[i]!)) ops.splice(i, 1)
      }
    },
    reset() {
      ops.length = 0
    },
    get size() {
      return ops.length
    },

    storeSource,
    getSource(ref) {
      return sources.get(ref) ?? null
    },
    attachSource(ref, source) {
      sources.set(ref, source)
    },
    isSourceAlive(ref) {
      return !sourceIsDead(sources.get(ref) ?? null)
    },

    maxTextureId() {
      let max = 0
      for (const op of ops) if (op.kind === 'texture.create' && op.id > max) max = op.id
      return max
    },
    maxViewId() {
      let max = 1_000_000 - 1
      for (const op of ops) if (op.kind === 'view.create' && op.id > max) max = op.id
      return max
    },
    maxTargetId() {
      let max = 0
      for (const op of ops) if (op.kind === 'target.create' && op.id > max) max = op.id
      return max
    },
  }
}

/** Метаданные ContentRef из опсов журнала (для манифеста). */
function opContentByRef(ops: readonly ResOp[], ref: number): ContentManifestEntry {
  for (const op of ops) {
    if (op.kind === 'texture.write' || op.kind === 'texture.update' || op.kind === 'texture.writeMip') {
      if (op.content.ref === ref) return { ref, kind: op.content.kind, width: op.content.width, height: op.content.height }
    }
  }
  return { ref, kind: 'unknown', width: 0, height: 0 }
}

/** Клон опса (глубина 1: все поля readonly-примитивы + ContentRef-объект). */
function cloneResOp(op: ResOp): ResOp {
  if (op.kind === 'texture.write' || op.kind === 'texture.update' || op.kind === 'texture.writeMip') {
    return { ...op, content: { ...op.content } }
  }
  return op
}
