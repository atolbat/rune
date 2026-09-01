/**
 * resourceSessionGL — стабильно-id сессия над GLFacade + журнал v2.
 *
 * КОРЕНЬ ПЕРЕДЕЛКИ (Task 62): раньше журнал хранил счётчиковые id фасада,
 * и replay на свежем фасаде выдавал ДРУГИЕ id при любых дырках → зависимые
 * опсы били мимо текстур → сцена не восстанавливалась.
 *
 * Теперь сессия вводит СТАБИЛЬНЫЕ id собственным счётчиком (над фасадом):
 *   • публичный facade.createTexture(...) → стабильный id, mapping
 *     стабильный → raw-fasadный, journal.record(texture.create);
 *   • все методы, принимающие textureId/viewId/targetId, транслируют
 *     стабильный id → raw id текущей инкарнации устройства;
 *   • restore() принимает id ИЗ ОПСА журнала и строит mapping заново на
 *     свежем фасаде → id совпадают до и после потери ПО ПОСТРОЕНИЮ.
 *
 * Журналируются ПЕРВИЧНЫЕ ресурсы с КОНТЕНТОМ (texture.write/update/
 * writeMip хранят ContentRef на CPU-источник — источники переживают loss).
 * Programs/buffers — ПРОИЗВОДНОЕ состояние: pass-through raw id без записи
 * (renderer пересоздаёт их лениво из спеков команд). Raw-байтовый
 * texSubImage2D — домен UploadScheduler'а, не журналируется.
 *
 * Восстановление и нормальная работа — ОДИН путь: restore() зовёт те же
 * методы raw-фасада, что и живой код (texImage2DFromSource /
 * texSubImage2DFromSource / texImage2DLevel / createTextureView / ...).
 */

import type { ResourceJournal, ResOp, RestoreReport, ContentRef, WorkingSet, EvictionReport, ResidencyStats, TextureFormat } from '@rune/core'
import { selectResidentOps, selectLRUEvictions, estimateTextureBytes } from '@rune/core'
import type { GLFacade, GLImageSource, GLTextureFormat } from '@rune/webgl2'

/** Стартовый id для namespace view'ов (паритет с realGL: ≥ 1M). */
const VIEW_ID_BASE = 1_000_000

/** Task 67: формат журнала (WebGPU-имена) → формат GL-фасада.
 *  'canvas' и 'rgba8unorm' — RGBA8 (дефолт GL, в опсы не пишем).
 *  'rgba16float' → 'rgba16f' (texStorage2D RGBA16F + HALF_FLOAT загрузки).
 *  'rgba32float' → 'rgba32f' (RGBA32F + FLOAT). */
export function glFormatFromTextureFormat(fmt?: TextureFormat): GLTextureFormat | undefined {
  if (fmt === 'rgba16float') return 'rgba16f'
  if (fmt === 'rgba32float') return 'rgba32f'
  return undefined
}

/** Task 67: формат GL-фасада → формат журнала (undefined = дефолт rgba8unorm). */
export function textureFormatFromGL(fmt?: GLTextureFormat): TextureFormat | undefined {
  if (fmt === 'rgba16f') return 'rgba16float'
  if (fmt === 'rgba32f') return 'rgba32float'
  return undefined
}

export interface ResourceSessionGL {
  /** Публичный фасад: тот же контракт GLFacade, но id — стабильные. */
  readonly facade: GLFacade
  /** Текущий стабильный textureId → raw id (диагностика/тесты). */
  readonly mapping: ReadonlyMap<number, number>
  /** Перевод любого стабильного id (texture/view/target) в raw id текущей
   *  инкарнации устройства. undefined — id не известен сессии. */
  rawId(stableId: number): number | undefined
  /** Replay журнала на СВЕЖЕМ raw-фасаде этой сессии.
   *  Вызывать после re-init устройства, ДО создания новых ресурсов.
   *  Повторный вызов на живом фасаде создаст дубликаты (как и любой replay).
   *
   *  Task 65 soft reset: keep (рабочее множество) — восстановить ТОЛЬКО
   *  его замыкание (сцена + контент + родители views); остальное живое
   *  остаётся декларацией в журнале (report.deferred) и вернётся лениво
   *  через ensureResident(). Без keep — полный replay (strategy='full'). */
  restore(keep?: WorkingSet): RestoreReport
  /** Task 65: ленивый возврат ОДНОГО ресурса в GPU-память после soft reset.
   *  textureId → create + контент; viewId → parent (create + контент) + view;
   *  targetId → parent create + target. Идемпотентно: уже резидентный
   *  ресурс — no-op (null). Возвращает отчёт replay подсписка журнала. */
  ensureResident(resourceId: number): RestoreReport | null
  /** Task 66: LRU-вытеснение резидентных текстур до бюджета (обратная
   *  сторона ensureResident). Вытесненные views/targets — замыкание поверх
   *  вытесненных текстур. Raw-ресурсы освобождаются, декларации+контент
   *  остаются в журнале (ресурс вернётся ensureResident'ом). Журнал НЕ
   *  меняется. pinned (например, рабочее множество сцены) неприкосновенен. */
  evictLRU(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport
  /** Task 66: оценка резидентной GPU-памяти + порядок LRU (диагностика). */
  residencyStats(): ResidencyStats
}

/** Создать сессию: стабильные id + журналирование поверх raw-фасада. */
export function createResourceSessionGL(raw: GLFacade, journal: ResourceJournal): ResourceSessionGL {
  // стабильный id → raw id (текущая инкарнация устройства)
  const texMap = new Map<number, number>()
  const viewMap = new Map<number, number>()
  const targetMap = new Map<number, number>()
  // Task 66: LRU-учёт резидентности.
  //  • lastUse: стабильный textureId → монотонный счётчик использования;
  //  • viewParent/targetParent: зависимый id → родительская текстура
  //    (замыкание вытеснения: текстура тянет за собой свои views/targets);
  //  • texMeta: размеры+mipLevels резидентных текстур (оценка GPU-памяти).
  let useCounter = 0
  const lastUse = new Map<number, number>()
  const viewParent = new Map<number, number>()
  const targetParent = new Map<number, number>()
  const texMeta = new Map<number, { w: number; h: number; mips: number; format?: TextureFormat }>()
  // размеры стабильных текстур — для классификации полного upload'а на GPU;
  // на GL не нужны (texImage2DFromSource всегда полный), но держим для паритета
  let nextTex = 1
  let nextView = VIEW_ID_BASE
  let nextTarget = 1

  /** Отметить использование текстуры (свежесть LRU). */
  function touch(textureId: number): void {
    lastUse.set(textureId, ++useCounter)
  }
  /** Touch по texture-ИЛИ-view id (view → родительская текстура). */
  function touchTexOrView(texOrViewId: number): void {
    touch(texOrViewId >= VIEW_ID_BASE ? (viewParent.get(texOrViewId) ?? texOrViewId) : texOrViewId)
  }

  function seedCounters(): void {
    nextTex = Math.max(nextTex, journal.maxTextureId() + 1)
    nextView = Math.max(nextView, journal.maxViewId() + 1)
    nextTarget = Math.max(nextTarget, journal.maxTargetId() + 1)
  }
  seedCounters()

  const rawTex = (id: number): number => {
    const mapped = texMap.get(id)
    if (mapped === undefined) {
      throw new Error(`resourceSession: неизвестный стабильный textureId=${id}. ` +
        `Ресурс не создан в этой сессии (или restore() не выполнен после потери устройства).`)
    }
    return mapped
  }
  const rawView = (id: number): number => {
    const mapped = viewMap.get(id)
    if (mapped === undefined) {
      throw new Error(`resourceSession: неизвестный стабильный viewId=${id}.`)
    }
    return mapped
  }
  const rawTarget = (id: number): number => {
    const mapped = targetMap.get(id)
    if (mapped === undefined) {
      throw new Error(`resourceSession: неизвестный стабильный targetId=${id}.`)
    }
    return mapped
  }
  /** id может быть textureId (<VIEW_ID_BASE) или viewId (≥VIEW_ID_BASE). */
  const rawTexOrView = (id: number): number =>
    id >= VIEW_ID_BASE ? rawView(id) : rawTex(id)

  const facade: GLFacade = {
    // ─── Производное состояние: pass-through raw id, БЕЗ журнала ─────────
    createProgram: (vertex, fragment) => raw.createProgram(vertex, fragment),
    useProgram: programId => raw.useProgram(programId),
    createBuffer: data => raw.createBuffer(data),
    bindVertexBuffer: (bufferId, location, size, stride, byteOffset, divisor) => raw.bindVertexBuffer(bufferId, location, size, stride, byteOffset, divisor),
    // M5 (Task 73): feed dual-bind — frame-op (per-frame dirty range), не журналируется.
    updateBuffer: (bufferId, data, byteOffset) => raw.updateBuffer(bufferId, data, byteOffset),
    setUniformMatrix4: (programId, name, values) => raw.setUniformMatrix4(programId, name, values),
    setUniform4fv: (programId, name, values) => raw.setUniform4fv(programId, name, values),
    setUniform3fv: (programId, name, values) => raw.setUniform3fv(programId, name, values),
    setUniform2fv: (programId, name, values) => raw.setUniform2fv(programId, name, values),
    setUniform1f: (programId, name, value) => raw.setUniform1f(programId, name, value),
    setUniform1i: (programId, name, value) => raw.setUniform1i(programId, name, value),

    // ─── Первичные ресурсы: стабильные id + журнал ───────────────────────
    createTexture: (width, height, options) => {
      const rawId = raw.createTexture(width, height, options)
      const id = nextTex++
      texMap.set(id, rawId)
      // Task 67: формат хранения — в meta (residency-байты: HDR 2×/4×) и в
      // журнал (replay/ensureResident пересоздаст текстуру тем же форматом).
      // GL-имя ('rgba16f') нормализуем в журнальное ('rgba16float'); в options
      // формат НЕ дублируем — он живёт на верхнем уровне опса. Опции без
      // содержимого пишем как undefined — журнал остаётся компактным и
      // replay передаёт фасаду ровно те же args, что и живой путь.
      const format = textureFormatFromGL(options?.format)
      const { format: _glFmt, ...rest } = options ?? {}
      const journalOptions = Object.keys(rest).length > 0 ? rest : undefined
      texMeta.set(id, { w: width, h: height, mips: options?.mipLevels ?? 1, format })
      touch(id)
      journal.record({ kind: 'texture.create', id, width, height, format, options: journalOptions })
      return id
    },
    texImage2DFromSource: (textureId, source, options) => {
      raw.texImage2DFromSource(rawTex(textureId), source, options)
      touch(textureId)
      const [w, h] = glSourceSize(source)
      const content = journal.storeSource(source, describeSourceKind(source), w, h)
      journal.record({ kind: 'texture.write', id: textureId, content, flipY: options?.flipY ?? false })
    },
    texSubImage2DFromSource: (textureId, x, y, source, options) => {
      raw.texSubImage2DFromSource(rawTex(textureId), x, y, source, options)
      touch(textureId)
      const [w, h] = glSourceSize(source)
      const content = journal.storeSource(source, describeSourceKind(source), w, h)
      journal.record({ kind: 'texture.update', id: textureId, x, y, w, h, content, flipY: options?.flipY ?? false })
    },
    texImage2DLevel: (textureId, level, source, options) => {
      raw.texImage2DLevel(rawTex(textureId), level, source, options)
      touch(textureId)
      const [w, h] = glSourceSize(source)
      const content = journal.storeSource(source, describeSourceKind(source), w, h)
      journal.record({ kind: 'texture.writeMip', id: textureId, level, content, flipY: options?.flipY ?? false })
    },
    // Raw-байтовый стриминг — домен UploadScheduler'а: данные держит Pump,
    // он же их пере-стримит. Журналирование чанков взорвёт журнал.
    texSubImage2D: (textureId, x, y, width, height, bytes) => {
      touch(textureId)
      raw.texSubImage2D(rawTex(textureId), x, y, width, height, bytes)
    },
    bindTexture: (textureOrViewId, unit) => {
      touchTexOrView(textureOrViewId)
      raw.bindTexture(rawTexOrView(textureOrViewId), unit)
    },
    createTextureView: (textureId, options) => {
      const rawViewId = raw.createTextureView(rawTex(textureId), options)
      const id = nextView++
      viewMap.set(id, rawViewId)
      viewParent.set(id, textureId)
      touch(textureId)
      journal.record({
        kind: 'view.create',
        id,
        textureId,
        baseMipLevel: options?.baseMipLevel,
        mipLevelCount: options?.mipLevelCount,
      })
      return id
    },
    deleteTextureView: viewId => {
      // Task 65: отложенный view — только декларация в журнале.
      const mapped = viewMap.get(viewId)
      if (mapped !== undefined) raw.deleteTextureView(mapped)
      viewMap.delete(viewId)
      viewParent.delete(viewId)
      journal.record({ kind: 'view.destroy', id: viewId })
    },
    createTarget: (textureId, width, height, depth, color) => {
      const rawId = raw.createTarget(rawTex(textureId), width, height, depth, color)
      const id = nextTarget++
      targetMap.set(id, rawId)
      targetParent.set(id, textureId)
      touch(textureId)
      journal.record({ kind: 'target.create', id, textureId, width, height, depth, color })
      return id
    },
    bindTarget: (targetId, clear) => {
      if (targetId !== 0) {
        const parent = targetParent.get(targetId)
        if (parent !== undefined) touch(parent)
      }
      raw.bindTarget(targetId === 0 ? 0 : rawTarget(targetId), clear)
    },
    // Task 80: readback — перевод стабильного id цели в raw-id (pass-through,
    // чтение не журналируется).
    readTargetPixels: targetId => raw.readTargetPixels(targetId === 0 ? 0 : rawTarget(targetId)),
    deleteTarget: targetId => {
      // Task 65: отложенная target — только декларация в журнале.
      const mapped = targetMap.get(targetId)
      if (mapped !== undefined) raw.deleteTarget(mapped)
      targetMap.delete(targetId)
      targetParent.delete(targetId)
      journal.record({ kind: 'target.destroy', id: targetId })
    },
    deleteTexture: textureId => {
      // Task 65: ресурс может быть ОТЛОЖЕН (soft reset не восстановил его) —
      // тогда raw-вызова нет, но texture.destroy в журнале обязателен
      // (убить декларацию → compact вычистит пару create→destroy).
      // Task 66: вытесненный (evictLRU) — то же самое: raw нет, декларацию
      // убивает только ЯВНОЕ удаление (вытеснение — не смерть ресурса).
      const mapped = texMap.get(textureId)
      if (mapped !== undefined) raw.deleteTexture(mapped)
      texMap.delete(textureId)
      texMeta.delete(textureId)
      lastUse.delete(textureId)
      journal.record({ kind: 'texture.destroy', id: textureId })
    },

    // ─── Frame-опсы: pass-through (не ресурсы) ───────────────────────────
    setViewport: (width, height) => raw.setViewport(width, height),
    setDepthMode: (test, write) => raw.setDepthMode(test, write),
    setCull: mode => raw.setCull(mode),
    setBlend: (src, dst) => raw.setBlend(src, dst),
    clear: (color, depth) => raw.clear(color, depth),
    drawArrays: (mode, first, count, instances) => raw.drawArrays(mode, first, count, instances),
    deleteProgram: programId => raw.deleteProgram(programId),
    deleteBuffer: bufferId => raw.deleteBuffer(bufferId),
  }

  // ─── Task 65: применение одного опса на raw-фасаде БЕЗ записи в журнал ─────
  // Один код-путь для restore() и ensureResident() (принцип «живое и
  // восстановление — один путь»): те же фасадные вызовы, что и при живой
  // работе, только id принимается из опса, а не генерируется счётчиком.
  // Task 66: каждый применённый опс отмечает использование (touch) —
  // ensureResident делает ресурс самым свежим в LRU.
  function applyOp(op: ResOp, acc: {
    opsReplayed: number; contentOps: number; skipped: number
    textureIds: number[]; viewIds: number[]; targetIds: number[]
  }): void {
    switch (op.kind) {
      case 'texture.create': {
        // Task 67: формат из опса → формат GL-фасада (rgba16float→rgba16f).
        // «Живое и восстановление — один путь»: applyOp зовёт тот же
        // raw.createTexture с теми же опциями, что и живой код. Формат
        // подмешиваем ТОЛЬКО когда он есть — args-контракт идентичен живому
        // пути (без format-ключа для обычных RGBA8-текстур).
        const glFormat = glFormatFromTextureFormat(op.format)
        const rawId = raw.createTexture(
          op.width,
          op.height,
          glFormat === undefined ? op.options : { ...op.options, format: glFormat },
        )
        texMap.set(op.id, rawId)
        texMeta.set(op.id, { w: op.width, h: op.height, mips: op.options?.mipLevels ?? 1, format: op.format })
        touch(op.id)
        acc.textureIds.push(op.id)
        acc.opsReplayed++
        break
      }
      case 'texture.write': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !sourceAlive(source)) { acc.skipped++; break }
        raw.texImage2DFromSource(rawTex(op.id), source as GLImageSource, { flipY: op.flipY })
        touch(op.id)
        acc.contentOps++
        acc.opsReplayed++
        break
      }
      case 'texture.update': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !sourceAlive(source)) { acc.skipped++; break }
        raw.texSubImage2DFromSource(rawTex(op.id), op.x, op.y, source as GLImageSource, { flipY: op.flipY })
        touch(op.id)
        acc.contentOps++
        acc.opsReplayed++
        break
      }
      case 'texture.writeMip': {
        const source = journal.getSource(op.content.ref)
        if (source === null || !sourceAlive(source)) { acc.skipped++; break }
        raw.texImage2DLevel(rawTex(op.id), op.level, source as GLImageSource, { flipY: op.flipY })
        touch(op.id)
        acc.contentOps++
        acc.opsReplayed++
        break
      }
      case 'view.create': {
        const rawViewId = raw.createTextureView(rawTex(op.textureId), {
          baseMipLevel: op.baseMipLevel,
          mipLevelCount: op.mipLevelCount,
        })
        viewMap.set(op.id, rawViewId)
        viewParent.set(op.id, op.textureId)
        touch(op.textureId)
        acc.viewIds.push(op.id)
        acc.opsReplayed++
        break
      }
      case 'target.create': {
        const rawId = raw.createTarget(rawTex(op.textureId), op.width, op.height, op.depth, op.color)
        targetMap.set(op.id, rawId)
        targetParent.set(op.id, op.textureId)
        touch(op.textureId)
        acc.targetIds.push(op.id)
        acc.opsReplayed++
        break
      }
      // destroy-опсы на свежем фасаде — no-op: ресурсов прежней
      // инкарнации здесь нет (они умерли вместе с устройством).
      default:
        break
    }
  }

  function restore(keep?: WorkingSet): RestoreReport {
    seedCounters()
    // Свежая инкарнация устройства: маппинги и LRU-учёт прежней — мусор
    // (raw id мертвы, а отложенные ресурсы НЕ резидентны). Чистим, иначе
    // evictLRU/residencyStats считали бы «резидентными» мёртвые id.
    texMap.clear()
    viewMap.clear()
    targetMap.clear()
    viewParent.clear()
    targetParent.clear()
    texMeta.clear()
    lastUse.clear()
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
    if (keep !== undefined) {
      // Task 65 soft reset: только замыкание рабочего множества; остальное
      // живое — deferred (вернётся лениво через ensureResident).
      const sel = selectResidentOps(journal.entries(), keep)
      for (const op of sel.ops) applyOp(op, acc)
      return {
        ...acc,
        deferred: { textures: sel.deferredTextures, views: sel.deferredViews, targets: sel.deferredTargets },
      }
    }
    journal.replay(op => applyOp(op, acc))
    return { ...acc }
  }

  function ensureResident(resourceId: number): RestoreReport | null {
    // Уже резидентен — no-op. namespace: viewId ≥ 1M; texture/target
    // проверяем по journal-опсам (id < 1M: сперва texture, затем target).
    if (resourceId >= VIEW_ID_BASE) {
      if (viewMap.has(resourceId)) return null
      const sel = selectResidentOps(journal.entries(), { viewIds: [resourceId] })
      const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
      for (const op of sel.ops) applyOp(op, acc)
      return { ...acc }
    }
    if (texMap.has(resourceId)) return null
    // texture или target? Смотрим, что живо в журнале под этим id.
    const isTexture = journal.entries().some(op => op.kind === 'texture.create' && op.id === resourceId)
    const sel = selectResidentOps(
      journal.entries(),
      isTexture ? { textureIds: [resourceId] } : { targetIds: [resourceId] },
    )
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [] as number[], viewIds: [] as number[], targetIds: [] as number[] }
    for (const op of sel.ops) applyOp(op, acc)
    return { ...acc }
  }

  // ─── Task 66: LRU-вытеснение (pressure → evict) ────────────────────────────
  /** Родители запиненных views/targets из ЖУРНАЛА (источник истины; сессия
   *  знает родителей только резидентных). Взят ПОСЛЕДНИЙ create-опс id. */
  function pinnedTextures(pinned?: WorkingSet): Set<number> {
    const pin = new Set<number>(pinned?.textureIds ?? [])
    if (pinned?.viewIds !== undefined || pinned?.targetIds !== undefined) {
      for (const op of journal.entries()) {
        if (op.kind === 'view.create' && pinned.viewIds?.includes(op.id)) pin.add(op.textureId)
        else if (op.kind === 'target.create' && pinned.targetIds?.includes(op.id)) pin.add(op.textureId)
      }
    }
    return pin
  }

  /** Записи LRU-учёта резидентных текстур. */
  function residencyEntries(): { id: number; bytes: number; lastUse: number }[] {
    const entries: { id: number; bytes: number; lastUse: number }[] = []
    for (const id of texMap.keys()) {
      const meta = texMeta.get(id)
      // Task 67: оценка учитывает формат (rgba16float — 8 б/пиксель,
      // rgba32float — 16): HDR-текстура «весит» в вытеснении честно.
      const bytes = meta !== undefined ? estimateTextureBytes(meta.w, meta.h, meta.mips, meta.format) : 0
      entries.push({ id, bytes, lastUse: lastUse.get(id) ?? 0 })
    }
    return entries
  }

  function residencyStats(): ResidencyStats {
    const textures = residencyEntries().sort((a, b) => a.lastUse - b.lastUse || a.id - b.id)
    return {
      textures,
      totalBytes: textures.reduce((sum, e) => sum + e.bytes, 0),
      views: [...viewMap.keys()].sort((a, b) => a - b),
      targets: [...targetMap.keys()].sort((a, b) => a - b),
    }
  }

  function evictLRU(options?: { budgetBytes?: number; pinned?: WorkingSet }): EvictionReport {
    const budget = options?.budgetBytes ?? Number.POSITIVE_INFINITY
    const pin = pinnedTextures(options?.pinned)
    const entries = residencyEntries()
    const plan = selectLRUEvictions(entries, budget, pin)
    const evictedViews: number[] = []
    const evictedTargets: number[] = []
    for (const texId of plan.evictIds) {
      // Замыкание: резидентные views/targets этой текстуры непригодны без
      // её хранилища (GL: view — мип-диапазон, target — FBO на текстуре).
      for (const [viewId, parent] of viewParent) {
        if (parent === texId && viewMap.has(viewId)) {
          raw.deleteTextureView(viewMap.get(viewId)!)
          viewMap.delete(viewId)
          viewParent.delete(viewId)
          evictedViews.push(viewId)
        }
      }
      for (const [targetId, parent] of targetParent) {
        if (parent === texId && targetMap.has(targetId)) {
          raw.deleteTarget(targetMap.get(targetId)!)
          targetMap.delete(targetId)
          targetParent.delete(targetId)
          evictedTargets.push(targetId)
        }
      }
      // Освободить raw-текстуру БЕЗ записи в журнал: ресурс жив декларацией
      // + контентом (как deferred после soft reset) и вернётся через
      // ensureResident тем же код-путём. Вытеснение — не уничтожение.
      const mapped = texMap.get(texId)
      if (mapped !== undefined) raw.deleteTexture(mapped)
      texMap.delete(texId)
      texMeta.delete(texId)
      lastUse.delete(texId)
    }
    return {
      textures: plan.evictIds,
      views: evictedViews,
      targets: evictedTargets,
      freedBytes: plan.freedBytes,
      residentBytes: plan.residentBytes,
      residentTextures: [...texMap.keys()].sort((a, b) => a - b),
    }
  }

  return {
    facade,
    get mapping() { return texMap as ReadonlyMap<number, number> },
    rawId(stableId: number): number | undefined {
      if (stableId >= VIEW_ID_BASE) return viewMap.get(stableId)
      return texMap.get(stableId) ?? targetMap.get(stableId)
    },
    restore,
    ensureResident,
    evictLRU,
    residencyStats,
  }
}

/** Размер GL-источника (аналог externalImageSize из @rune/webgpu). */
function glSourceSize(source: GLImageSource): [number, number] {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
    return [source.videoWidth || 0, source.videoHeight || 0]
  }
  const s = source as { width?: number; height?: number; displayWidth?: number; displayHeight?: number }
  if (typeof s.displayWidth === 'number' && s.displayWidth > 0) return [s.displayWidth, s.displayHeight ?? 0]
  return [s.width ?? 0, s.height ?? 0]
}

/** Имя типа источника (паритет с journalGl/journalGpu v1). */
function describeSourceKind(source: GLImageSource): string {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  if (typeof source === 'object' && source !== null) {
    if ('getContext' in source) return 'OffscreenCanvas'
    if ('close' in source && 'width' in source) return 'ImageBitmap'
  }
  return (source as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
}

/** Мёртвый источник: null/undefined, закрытый ImageBitmap (width=0),
 *  или любой bitmap-подобный объект с нулевыми числовыми размерами
 *  (закрытый/невалидный canvas). Такие источники заливать нельзя. */
function sourceAlive(source: unknown): boolean {
  if (source === null || source === undefined) return false
  const s = source as { width?: unknown; height?: unknown }
  if (typeof s.width === 'number' && typeof s.height === 'number') {
    return s.width > 0 && s.height > 0
  }
  return true
}

/** Применить один ResOp к GL-фасаду БЕЗ сессии (raw id = стабильный id).
 *  Полезно для тестов и для приёма опсов на фасаде, где id уже совпадают. */
export function applyResOpGL(op: ResOp, gl: GLFacade, sourceFor: (content: ContentRef) => GLImageSource | null): void {
  switch (op.kind) {
    case 'texture.create': {
      const glFormat = glFormatFromTextureFormat(op.format)
      gl.createTexture(
        op.width,
        op.height,
        glFormat === undefined ? op.options : { ...op.options, format: glFormat },
      )
      break
    }
    case 'texture.write': {
      const source = sourceFor(op.content)
      if (source !== null) gl.texImage2DFromSource(op.id, source, { flipY: op.flipY })
      break
    }
    case 'texture.update': {
      const source = sourceFor(op.content)
      if (source !== null) gl.texSubImage2DFromSource(op.id, op.x, op.y, source, { flipY: op.flipY })
      break
    }
    case 'texture.writeMip': {
      const source = sourceFor(op.content)
      if (source !== null) gl.texImage2DLevel(op.id, op.level, source, { flipY: op.flipY })
      break
    }
    case 'view.create':
      gl.createTextureView(op.textureId, { baseMipLevel: op.baseMipLevel, mipLevelCount: op.mipLevelCount })
      break
    case 'target.create':
      gl.createTarget(op.textureId, op.width, op.height, op.depth, op.color)
      break
    default:
      break
  }
}
