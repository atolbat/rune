/**
 * Journal — реестр долгоживущих деклараций (create/destroy ресурса) с replay.
 *
 * Контракт (DESIGN.md §9.5 P3, §5.1, §9.9, §8 задача 1):
 *   Journal.replay(newBackend) = switchBackend = device-loss recovery =
 *   = worker migration — один механизм на три сценария.
 *
 * Что журналируется (M1 — базовый набор):
 *   - createTexture / destroyTexture
 *   - createProgram / destroyProgram
 *   - createBuffer / destroyBuffer
 *   - createTarget / destroyTarget
 *   - texImage2DFromSource — частично: source не сериализуем (ImageBitmap может
 *     быть закрыт, HTMLCanvasElement — DOM-зависим). Журнал хранит kind+flipY;
 *     пользователь при replay регистрирует источник через sourceFor(kind).
 *
 * Что НЕ журналируется:
 *   - Frame-опсы (drawArrays, setUniform*, bindTexture) — это per-frame,
 *     идут в Tape, а не в Journal. Journal — только долгоживущие ресурсы.
 *   - texSubImage2D (стриминг) — belongs to Pump<UploadJob>, не к декларациям.
 *
 * compact(): удалить пары create→destroy одного id (heap compaction #13).
 *            Если destroy был, но create повторился — оставить последний create.
 *
 * snapshot(): глубокая копия журнала (#41 resume-snapshot). Пользователь
 *             может replay-нуть на новом backend'е без перезаписи истории.
 *
 * evict(predicate): убрать опсы, подошедшие под предикат (#14 lazy re-declaration).
 *
 * Идемпотентность replay: повторный replay на том же backend'е даёт те же
 * id'шники — Journal не знает о состоянии backend'а, только о порядке опсов.
 * Если backend уже имеет ресурс с тем же id — ответственность на backend'е
 * (либо игнорировать, либо бросить). Для WebGL2 realGL: createTexture всегда
 * выдаёт новый id — повторный replay создаст дубликаты. Поэтому правильное
 * использование — после потери устройства, на СВЕЖЕМ backend'е.
 */

/** Цвет очистки цели (используется в createTarget). */
import type { TextureFormat } from '../formats.ts'

export type ClearColor = readonly [number, number, number, number]

/** Декларация — create или destroy долгоживущего ресурса.
 *  id — это id, выданный facade при create. При replay новый backend
 *  должен выдать тот же id (поэтому replay через registerIdMap). */
export type DeclOp =
  // Task 57: format добавлен для WebGPU — у GPUFacade.createTexture
  // сигнатура (width, height, format?, options?) отличается от WebGL2
  // (width, height, options?). При cross-backend replay (например,
  // journal на WebGPU → replay на WebGL2) format='canvas' будет
  // молча проигнорирован WebGL2 (он всегда RGBA8). При том же бэкенде
  // replay передаёт format как есть.
  // Task 67: формат расширен HDR-значениями (rgba16float/rgba32float) —
  // сессии маппят их в internalFormat WebGL2 (RGBA16F/RGBA32F) и в
  // GPUTextureFormat WebGPU ('rgba16float'/'rgba32float').
  | { readonly kind: 'createTexture'; readonly id: number; readonly width: number; readonly height: number; readonly format?: TextureFormat; readonly options?: { readonly mipLevels?: number; readonly maxAnisotropy?: number } }
  | { readonly kind: 'destroyTexture'; readonly id: number }
  | { readonly kind: 'createProgram'; readonly id: number; readonly vertex: string; readonly fragment: string }
  | { readonly kind: 'destroyProgram'; readonly id: number }
  | { readonly kind: 'createBuffer'; readonly id: number; readonly data: Float32Array }
  | { readonly kind: 'destroyBuffer'; readonly id: number }
  | { readonly kind: 'createTarget'; readonly id: number; readonly textureId: number; readonly width: number; readonly height: number; readonly depth: boolean; readonly color: ClearColor }
  | { readonly kind: 'destroyTarget'; readonly id: number }
  | { readonly kind: 'texImage2DFromSource'; readonly textureId: number; readonly sourceKind: string; readonly flipY: boolean }
  // Sub-mip views (Task 56): createTextureView/destroyTextureView — долгоживущие
  // декларации (как createTexture). При replay на новом backend'е вид
  // воссоздаётся через target.createTextureView(textureId, { baseMipLevel,
  // mipLevelCount }). ВНИМАНИЕ: textureId в createTextureView — это id на
  // исходном backend'е (до device-loss). При replay должен быть замаплен на
  // новый id через idMap (см. replayJournalOn — caller несёт ответственность
  // за id-mapping, т.к. только он знает порядок create-ов).
  | { readonly kind: 'createTextureView'; readonly id: number; readonly textureId: number; readonly baseMipLevel?: number; readonly mipLevelCount?: number }
  | { readonly kind: 'destroyTextureView'; readonly id: number }

/** Snapshot — глубокая копия журнала для resume (#41). */
export interface JournalSnapshot {
  readonly ops: readonly DeclOp[]
}

/** Журнал деклараций: append-only с компактированием. */
export interface Journal {
  /** Записать декларацию. Append-only, не итерирует. */
  record(op: DeclOp): void
  /** Воспроизвести опсы на любом совместимом приёмнике.
   *  Для device-loss recovery: создать новый backend'овый фасад, зарегистри-
   *  ровать source-provider (для texImage2DFromSource), и replay'нуть. */
  replay(apply: (op: DeclOp) => void): void
  /** Все опсы в порядке записи (для отладки/аудита). */
  entries(): readonly DeclOp[]
  /** Удалить create→destroy пары того же id; уничтоженные до конца — не нужны.
   *  Оставшиеся destroy без create — оставляем (это странное состояние, аудит). */
  compact(): void
  /** Глубокая копия (#41 resume-snapshot). */
  snapshot(): JournalSnapshot
  /** Убрать опсы под предикатом (#14 lazy re-declaration). */
  evict(predicate: (op: DeclOp) => boolean): void
  /** Сбросить журнал в пустое состояние (новая сессия). */
  reset(): void
  /** Количество опсов. */
  readonly size: number
}

/** Создать пустой Journal. */
export function createJournal(): Journal {
  const ops: DeclOp[] = []

  return {
    record(op) {
      // Task 61: JSON round-trip (worker migration / device-loss recovery)
      // превращает Float32Array в plain-object {"0":v0,"1":v1,...}. Записываем
      // такие опсы через нормализацию — журнал самовосстанавливается до
      // типизированного состояния, и snapshot()/replay() не падают на
      // op.data.slice (регрессия «Unhandled rejection: op.data.slice is not
      // a function»). Все остальные kind'ы проходят как есть.
      ops.push(op.kind === 'createBuffer' && !(op.data instanceof Float32Array)
        ? { ...op, data: toFloat32Array(op.data) }
        : op)
    },
    replay(apply) {
      for (const op of ops) apply(op)
    },
    entries() {
      // Defensive copy: внешний код не должен мутировать внутреннее состояние
      return ops.slice()
    },
    compact() {
      // Удалить пары create→destroy одного id. Идём с конца: если destroy,
      // ищем предшествующий create того же ресурса — удаляем оба. Иначе
      // оставляем (destroy без create — аудиторская аномалия).
      //
      // Task 61 (prune мёртвых ссылок): помимо create→destroy пар, убираем
      // опсы, ссылающиеся на УНИЧТОЖЕННУЮ текстуру — texImage2DFromSource,
      // createTextureView и createTarget. Иначе replay такого журнала на
      // свежем фасаде упадёт: create текстуры удалён парой, а зависимый опс
      // продолжает ссылаться на несуществующий textureId.
      const destroyedTextures = new Set<number>()
      const destroyedPrograms = new Set<number>()
      const destroyedBuffers = new Set<number>()
      const destroyedTargets = new Set<number>()
      // Sub-mip views (Task 56): id-namespace отделен от textureId (≥1M),
      // но компактирование идёт по тому же принципу — пара create+destroy
      // одного viewId удаляет оба опса.
      const destroyedTextureViews = new Set<number>()

      // Проход 0 (Task 61): позиционная живость текстур для зависимых опсов
      // (texImage2DFromSource / createTextureView / createTarget).
      //
      // Текстура жива в КОНЕЧНОМ состоянии, если её последний lifecycle-опс —
      // create. Но этого мало: при «пересоздании» id (create→…→destroy→create)
      // выживающий create — ПОСЛЕДНИЙ, а зависимый опс мог стоять до него —
      // такой опс принадлежит мёртвой инкарнации id и на replay ссылался бы
      // на текстуру до её (пере)создания. Поэтому правило тройное:
      //   1) последний lifecycle-опс текстуры — create (жива в конце);
      //   2) зависимый опс стоит ПОСЛЕ последнего create своей текстуры;
      //   3) в момент зависимого опса текстура существовала (последний
      //      lifecycle-опс ДО него — create, не destroy).
      const lastTexLifecycle = new Map<number, 'create' | 'destroy'>()
      const lastTexCreateIdx = new Map<number, number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        if (op.kind === 'createTexture') {
          lastTexLifecycle.set(op.id, 'create')
          lastTexCreateIdx.set(op.id, i)
        } else if (op.kind === 'destroyTexture') {
          lastTexLifecycle.set(op.id, 'destroy')
        }
      }
      // Состояние текстуры на момент каждой позиции (один проход с бегущим стейтом)
      const runningState = new Map<number, 'create' | 'destroy'>()
      const aliveAt = new Map<number, boolean>() // индекс зависимого опса → жива ли его текстура (усл. 3)
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        if (op.kind === 'texImage2DFromSource' || op.kind === 'createTextureView' || op.kind === 'createTarget') {
          aliveAt.set(i, runningState.get(op.textureId) === 'create')
        } else if (op.kind === 'createTexture') {
          runningState.set(op.id, 'create')
        } else if (op.kind === 'destroyTexture') {
          runningState.set(op.id, 'destroy')
        }
      }
      const texAliveAt = (i: number, textureId: number): boolean =>
        lastTexLifecycle.get(textureId) === 'create'            // усл. 1: жива в конце
        && (lastTexCreateIdx.get(textureId) ?? -1) < i          // усл. 2: после последнего create
        && aliveAt.get(i) === true                              // усл. 3: существовала в момент опса

      // Первый проход: собрать все destroy'и (id + тип)
      for (const op of ops) {
        if (op.kind === 'destroyTexture') destroyedTextures.add(op.id)
        else if (op.kind === 'destroyProgram') destroyedPrograms.add(op.id)
        else if (op.kind === 'destroyBuffer') destroyedBuffers.add(op.id)
        else if (op.kind === 'destroyTarget') destroyedTargets.add(op.id)
        else if (op.kind === 'destroyTextureView') destroyedTextureViews.add(op.id)
      }

      // Второй проход: убрать create+destroy пары того же id; оставить только
      // либо create без destroy (живые), либо destroy без create (аномалия).
      const keep: DeclOp[] = []
      const seenDestroy = {
        tex: new Set<number>(),
        prog: new Set<number>(),
        buf: new Set<number>(),
        tgt: new Set<number>(),
        view: new Set<number>(),
      }
      // Task 61: view- и target-ресурсы, чьи create-опсы выброшены prune'ом
      // (текстура мертва) — их destroy-опсы тоже выкидываем, чтобы не
      // оставлять сирот.
      const prunedViewIds = new Set<number>()
      const prunedTargetIds = new Set<number>()
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]!
        switch (op.kind) {
          case 'createTexture':
            if (destroyedTextures.has(op.id) && !seenDestroy.tex.has(op.id)) {
              seenDestroy.tex.add(op.id) // пропускаем create — он парный с destroy
            } else {
              keep.push(op)
            }
            break
          case 'destroyTexture':
            if (seenDestroy.tex.has(op.id)) continue // уже удалили create — destroy тоже выкинуть
            keep.push(op)
            break
          case 'createProgram':
            if (destroyedPrograms.has(op.id) && !seenDestroy.prog.has(op.id)) {
              seenDestroy.prog.add(op.id)
            } else {
              keep.push(op)
            }
            break
          case 'destroyProgram':
            if (seenDestroy.prog.has(op.id)) continue
            keep.push(op)
            break
          case 'createBuffer':
            if (destroyedBuffers.has(op.id) && !seenDestroy.buf.has(op.id)) {
              seenDestroy.buf.add(op.id)
            } else {
              keep.push(op)
            }
            break
          case 'destroyBuffer':
            if (seenDestroy.buf.has(op.id)) continue
            keep.push(op)
            break
          case 'createTarget':
            // Task 61: target на мёртвой текстуре не восстанавливается —
            // create выкидываем, его destroy помечаем к удалению.
            if (!texAliveAt(i, op.textureId)) {
              prunedTargetIds.add(op.id)
              continue
            }
            if (destroyedTargets.has(op.id) && !seenDestroy.tgt.has(op.id)) {
              seenDestroy.tgt.add(op.id)
            } else {
              keep.push(op)
            }
            break
          case 'destroyTarget':
            if (prunedTargetIds.has(op.id)) continue // create выброшен prune'ом
            if (seenDestroy.tgt.has(op.id)) continue
            keep.push(op)
            break
          // Sub-mip views (Task 56): компактятся по тому же принципу.
          case 'createTextureView':
            // Task 61: view на мёртвой текстуре не восстанавливается.
            if (!texAliveAt(i, op.textureId)) {
              prunedViewIds.add(op.id)
              continue
            }
            if (destroyedTextureViews.has(op.id) && !seenDestroy.view.has(op.id)) {
              seenDestroy.view.add(op.id)
            } else {
              keep.push(op)
            }
            break
          case 'destroyTextureView':
            if (prunedViewIds.has(op.id)) continue // create выброшен prune'ом
            if (seenDestroy.view.has(op.id)) continue
            keep.push(op)
            break
          case 'texImage2DFromSource':
            // Task 61: загрузка в мёртвую текстуру не воспроизводится.
            if (!texAliveAt(i, op.textureId)) continue
            keep.push(op)
            break
          default:
            keep.push(op)
        }
      }
      ops.length = 0
      ops.push(...keep)
    },
    snapshot() {
      // Глубокая копия опсов. Float32Array копируется через slice.
      const copy = ops.map(cloneOp)
      return { ops: copy }
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
  }
}

/** Клонирование опса для snapshot (Float32Array — slice, остальные — readonly). */
function cloneOp(op: DeclOp): DeclOp {
  if (op.kind === 'createBuffer') {
    // Task 61: toFloat32Array — защита от «протухших» опсов, попавших в
    // журнал в обход нормализации record() (внешняя запись/эксперименты).
    // Живой путь покрыт record(); здесь — belt-and-suspenders.
    return { ...op, data: toFloat32Array(op.data).slice() }
  }
  return op
}

/** Task 61: коэрсинг данных createBuffer к Float32Array.
 *
 * JSON.stringify(Float32Array) даёт {"0":v0,"1":v1,...} — plain object с
 * числовыми ключами (integer-like ключи итерируются в порядке возрастания,
 * порядок значений сохраняется). JSON.parse возвращает такой же plain
 * object — без .slice(), без ArrayBuffer. Эта функция восстанавливает
 * типизированный вид из любого допустимого представления:
 *   • Float32Array → как есть (тот же экземпляр)
 *   • number[]     → new Float32Array(arr)
 *   • plain object {"0":..,"1":..} → new Float32Array(Object.values(obj))
 *   • прочее       → пустой Float32Array (не падаем)
 */
export function toFloat32Array(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data
  if (Array.isArray(data)) return new Float32Array(data)
  if (typeof data === 'object' && data !== null) {
    const values = Object.values(data as Record<string, unknown>)
    return new Float32Array(values.filter(v => typeof v === 'number') as number[])
  }
  return new Float32Array(0)
}
