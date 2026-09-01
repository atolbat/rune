import { describe, expect, it } from 'bun:test'
import { createJournal } from '../src/journal/journal.ts'
import type { DeclOp } from '../src/journal/journal.ts'

/**
 * Journal (M1, §9.5 P3): реестр долгоживущих деклараций с replay.
 *
 * Контракт: Journal.replay = switchBackend = device-loss recovery =
 * = worker migration — один механизм на три сценария.
 *
 * Это тесты примитива как такового — без интеграции с realGL.
 * Интеграционные тесты (запись через WebGL2Renderer) — в отдельном файле.
 */

describe('Journal — примитив реестра деклараций', () => {
  it('record + replay: опсы идут в порядке записи', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })
    journal.record({ kind: 'createProgram', id: 1, vertex: 'V', fragment: 'F' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([1, 2, 3]) })

    const seen: string[] = []
    journal.replay(op => { seen.push(op.kind) })
    expect(seen).toEqual(['createTexture', 'createProgram', 'createBuffer'])
    expect(journal.size).toBe(3)
  })

  it('replay идемпотентен — повторный вызов даёт ту же последовательность', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 8, height: 8 })
    journal.record({ kind: 'destroyTexture', id: 1 })

    const seen1: number[] = []
    journal.replay(op => { if ('id' in op) seen1.push(op.id) })
    const seen2: number[] = []
    journal.replay(op => { if ('id' in op) seen2.push(op.id) })
    expect(seen1).toEqual(seen2)
  })

  it('compact убирает create→destroy пары (heap compaction #13)', () => {
    const journal = createJournal()
    // texture 1: создана и уничтожена — пара
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })
    journal.record({ kind: 'destroyTexture', id: 1 })
    // texture 2: создана, живёт — оставляем
    journal.record({ kind: 'createTexture', id: 2, width: 128, height: 128 })
    // program 1: уничтожен без create — аномалия, оставляем для аудита
    journal.record({ kind: 'destroyProgram', id: 7 })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'destroyProgram'])
  })

  it('compact не трогает повторный create того же id после destroy', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 5, width: 8, height: 8 })
    journal.record({ kind: 'destroyTexture', id: 5 })
    journal.record({ kind: 'createTexture', id: 5, width: 16, height: 16 }) // пересоздание

    journal.compact()
    // create 8x8 + destroy 5 — пара, выкидываем; второй create 16x16 остаётся
    expect(journal.entries()).toEqual([
      { kind: 'createTexture', id: 5, width: 16, height: 16 },
    ])
  })

  it('snapshot — глубокая копия: мутация оригинала не меняет snapshot', () => {
    const journal = createJournal()
    const data = new Float32Array([1, 2, 3])
    journal.record({ kind: 'createBuffer', id: 1, data })
    journal.record({ kind: 'createTexture', id: 1, width: 8, height: 8 })

    const snap = journal.snapshot()
    // Добавляем ещё опс в оригинал — snapshot не должен меняться
    journal.record({ kind: 'destroyTexture', id: 1 })
    expect(snap.ops.length).toBe(2)
    expect(journal.size).toBe(3)

    // Мутация исходного Float32Array не должна менять snapshot-копию
    data[0] = 999
    const snapBuffer = snap.ops.find(op => op.kind === 'createBuffer') as Extract<DeclOp, { kind: 'createBuffer' }>
    expect(snapBuffer.data[0]).toBe(1) // snapshot изолирован
  })

  it('evict(predicate) убирает опсы под предикатом (#14 lazy re-declaration)', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })
    journal.record({ kind: 'createTexture', id: 2, width: 128, height: 128 })
    journal.record({ kind: 'createTexture', id: 3, width: 256, height: 256 })

    // Убрать только маленькие текстуры (64x64)
    journal.evict(op => op.kind === 'createTexture' && op.width === 64)
    const ids = journal.entries().map(op => 'id' in op ? op.id : -1)
    expect(ids).toEqual([2, 3])
  })

  it('reset сбрасывает журнал в пустое состояние', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 8, height: 8 })
    expect(journal.size).toBe(1)
    journal.reset()
    expect(journal.size).toBe(0)
    expect(journal.entries()).toEqual([])
  })

  it('entries() возвращает readonly-срез — нельзя мутировать извне', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 8, height: 8 })
    const entries = journal.entries() as DeclOp[]
    // push вернёт новое число, но к journal это не применится (return типа readonly)
    // Проверяем что entries — это просто массив-срез, и оригинал живёт отдельно:
    expect(() => entries.push({ kind: 'destroyTexture', id: 999 } as DeclOp)).not.toThrow()
    // journal.size не изменился — push не прошёл в исходный массив
    expect(journal.size).toBe(1)
  })

  it('replay end-to-end на мок-приёмник — все декларации доходят', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64 })
    journal.record({ kind: 'createProgram', id: 1, vertex: 'attribute vec2 a; void main(){}', fragment: 'precision mediump float; void main(){}' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([0, 0, 1, 0, 0, 1]) })
    journal.record({ kind: 'createTarget', id: 1, textureId: 1, width: 64, height: 64, depth: true, color: [0.1, 0.1, 0.1, 1] })
    journal.record({ kind: 'texImage2DFromSource', textureId: 1, sourceKind: 'ImageBitmap', flipY: false })

    const calls: string[] = []
    journal.replay(op => {
      switch (op.kind) {
        case 'createTexture': calls.push(`createTexture(${op.width}x${op.height})→id=${op.id}`); break
        case 'createProgram': calls.push(`createProgram(vs=${op.vertex.length},fs=${op.fragment.length})→id=${op.id}`); break
        case 'createBuffer': calls.push(`createBuffer(${op.data.length} floats)→id=${op.id}`); break
        case 'createTarget': calls.push(`createTarget(tex=${op.textureId},${op.width}x${op.height},depth=${op.depth})→id=${op.id}`); break
        case 'texImage2DFromSource': calls.push(`texImage2DFromSource(tex=${op.textureId},${op.sourceKind},flipY=${op.flipY})`); break
        default: /* destroy-опсы — не ожидаем в этом тесте */ break
      }
    })
    expect(calls).toEqual([
      'createTexture(64x64)→id=1',
      'createProgram(vs=31,fs=38)→id=1',
      'createBuffer(6 floats)→id=1',
      'createTarget(tex=1,64x64,depth=true)→id=1',
      'texImage2DFromSource(tex=1,ImageBitmap,flipY=false)',
    ])
  })

  it('порядок «всех четырёх ресурсов»: типовой цикл device-loss recovery', () => {
    // Сценарий: пользователь создал текстуру, программу, буфер, цель;
    // потом устройство потеряно. Journal.replay должен воссоздать ВСЕ
    // четыре ресурса в правильном порядке (createTexture → createProgram →
    // createBuffer → createTarget, т.к. target зависит от texture).
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 800, height: 600 })
    journal.record({ kind: 'createProgram', id: 1, vertex: 'vs', fragment: 'fs' })
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array(36) })
    journal.record({ kind: 'createTarget', id: 1, textureId: 1, width: 800, height: 600, depth: true, color: [0, 0, 0, 1] })

    // Мок нового фасада: считает create-опсы
    const recreated: string[] = []
    journal.replay(op => {
      if (op.kind.startsWith('create')) recreated.push(op.kind)
    })
    expect(recreated).toEqual(['createTexture', 'createProgram', 'createBuffer', 'createTarget'])
  })

  // ─── Task 56: sub-mip views (createTextureView / destroyTextureView) ──────

  it('Task 56: createTextureView записывается и читается через replay', () => {
    // Сценарий: пользователь создал mip-chain текстуру + sub-mip view.
    // После device-loss journal.replay должен воссоздать оба.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 256, height: 256, options: { mipLevels: 9 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 1, baseMipLevel: 2, mipLevelCount: 3 })

    const recreated: string[] = []
    journal.replay(op => {
      if (op.kind === 'createTextureView') recreated.push(`view id=${op.id} tex=${op.textureId} mip=${op.baseMipLevel}+${op.mipLevelCount}`)
      else if (op.kind === 'createTexture') recreated.push(`texture id=${op.id} ${op.width}x${op.height} mip=${op.options?.mipLevels ?? 1}`)
    })
    expect(recreated).toEqual([
      'texture id=1 256x256 mip=9',
      'view id=1000000 tex=1 mip=2+3',
    ])
  })

  it('Task 56: compact убирает create→destroy пары textureView', () => {
    // Сценарий: view создан и сразу уничтожен в одной сессии —
    // compact должен убрать оба опса (как для createTexture).
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64, options: { mipLevels: 7 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 1, baseMipLevel: 1, mipLevelCount: 2 })
    journal.record({ kind: 'destroyTextureView', id: 1_000_000 }) // пара — обе удалятся
    journal.record({ kind: 'createTextureView', id: 1_000_001, textureId: 1, baseMipLevel: 3 }) // живой view

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'createTextureView'])
    const view = journal.entries().find(op => op.kind === 'createTextureView') as Extract<DeclOp, { kind: 'createTextureView' }>
    expect(view.id).toBe(1_000_001) // остался второй view, не уничтоженный
  })

  it('Task 56: snapshot изолирует createTextureView-опсы (deep copy)', () => {
    // Сценарий: snapshot должен содержать опсы createTextureView как есть.
    // Глубокая копия — добавление новых опсов в оригинал не трогает snapshot.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 1, width: 64, height: 64, options: { mipLevels: 7 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 1, baseMipLevel: 2, mipLevelCount: 3 })

    const snap = journal.snapshot()
    expect(snap.ops.length).toBe(2)
    // Добавляем ещё опс в оригинал — snapshot не должен меняться
    journal.record({ kind: 'destroyTextureView', id: 1_000_000 })
    expect(snap.ops.length).toBe(2)
    expect(journal.size).toBe(3)
  })

  it('Task 56: evict убирает createTextureView по предикату (lazy re-declaration)', () => {
    // Сценарий: пользователь решает убрать все sub-views с baseMipLevel ≥ 5
    // (например, для глубоких мипов с низким приоритетом). evict должен убрать
    // только их, оставив остальные.
    const journal = createJournal()
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 1, baseMipLevel: 2 })
    journal.record({ kind: 'createTextureView', id: 1_000_001, textureId: 1, baseMipLevel: 5 })
    journal.record({ kind: 'createTextureView', id: 1_000_002, textureId: 1, baseMipLevel: 8 })

    journal.evict(op => op.kind === 'createTextureView' && (op.baseMipLevel ?? 0) >= 5)
    const ids = journal.entries()
      .filter(op => op.kind === 'createTextureView')
      .map(op => (op as { id: number }).id)
    expect(ids).toEqual([1_000_000]) // остался только view с baseMipLevel=2
  })

  // ── Task 61: JSON round-trip (worker migration) + compact prune ──────────────

  it('Task 61: record нормализует createBuffer.data из JSON round-trip (plain-object → Float32Array)', () => {
    // Сценарий worker migration: JSON.stringify(Float32Array) даёт
    // {"0":v0,"1":v1,...}, JSON.parse — plain object без .slice().
    // Регрессия: «Unhandled rejection: op.data.slice is not a function».
    const journal = createJournal()
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([1.5, 2.5, 3.5]) })

    const json = JSON.stringify(journal.snapshot().ops)
    const parsed = JSON.parse(json) as DeclOp[]

    // Parsed опс — plain object (сам JSON не хранит тип)
    const parsedBuf = parsed.find(op => op.kind === 'createBuffer') as { data: unknown }
    expect(parsedBuf.data instanceof Float32Array).toBe(false)

    // record() нормализует обратно в Float32Array
    const workerJournal = createJournal()
    for (const op of parsed) workerJournal.record(op)
    const restored = workerJournal.entries().find(op => op.kind === 'createBuffer') as { data: Float32Array }
    expect(restored.data instanceof Float32Array).toBe(true)
    expect(Array.from(restored.data)).toEqual([1.5, 2.5, 3.5])
  })

  it('Task 61: record нормализует createBuffer.data из number[]', () => {
    const journal = createJournal()
    journal.record({ kind: 'createBuffer', id: 1, data: [4, 5, 6] as unknown as Float32Array })
    const buf = journal.entries()[0] as { data: Float32Array }
    expect(buf.data instanceof Float32Array).toBe(true)
    expect(Array.from(buf.data)).toEqual([4, 5, 6])
  })

  it('Task 61: snapshot() не падает на журнале, собранном из JSON-round-trip опсов', () => {
    // Полный цикл: живой журнал → JSON → worker-журнал → snapshot снова.
    // Раньше второй snapshot падал: op.data.slice is not a function.
    const journal = createJournal()
    journal.record({ kind: 'createBuffer', id: 1, data: new Float32Array([9, 8, 7]) })
    journal.record({ kind: 'createTexture', id: 1, width: 32, height: 32 })

    const json = JSON.stringify(journal.snapshot().ops)
    const workerJournal = createJournal()
    for (const op of JSON.parse(json) as DeclOp[]) workerJournal.record(op)

    // Главный ассерт: второй snapshot не бросает и даёт корректную копию
    const snap2 = workerJournal.snapshot()
    expect(snap2.ops.length).toBe(2)
    const buf = snap2.ops.find(op => op.kind === 'createBuffer') as { data: Float32Array }
    expect(buf.data instanceof Float32Array).toBe(true)
    expect(Array.from(buf.data)).toEqual([9, 8, 7])
  })

  it('Task 61: compact убирает texImage2DFromSource уничтоженной текстуры', () => {
    // Сценарий: текстура создана, залита полным upload'ом, уничтожена.
    // Пара create+destroy уйдёт (существующее поведение), а зависимый
    // texImage2DFromSource обязан уйти тоже — иначе replay упадёт на
    // несуществующем textureId.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 5, width: 64, height: 64 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 5, sourceKind: 'ImageBitmap', flipY: false })
    journal.record({ kind: 'destroyTexture', id: 5 })

    journal.compact()
    expect(journal.entries()).toEqual([])
  })

  it('Task 61: compact сохраняет texImage2DFromSource живой текстуры', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 5, width: 64, height: 64 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 5, sourceKind: 'ImageBitmap', flipY: true })
    journal.record({ kind: 'createTexture', id: 6, width: 64, height: 64 })
    journal.record({ kind: 'destroyTexture', id: 6 })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'texImage2DFromSource'])
  })

  it('Task 61: compact убирает createTextureView и createTarget мёртвой текстуры (+ их destroy)', () => {
    // View/target на уничтоженной текстуре не восстанавливаются; их собственные
    // destroy-опсы тоже выкидываются (не оставляем сирот).
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 3, width: 64, height: 64, options: { mipLevels: 4 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 3, baseMipLevel: 1 })
    journal.record({ kind: 'createTarget', id: 10, textureId: 3, width: 64, height: 64, depth: false, color: [0, 0, 0, 1] })
    journal.record({ kind: 'destroyTextureView', id: 1_000_000 })
    journal.record({ kind: 'destroyTarget', id: 10 })
    journal.record({ kind: 'destroyTexture', id: 3 })

    journal.compact()
    expect(journal.entries()).toEqual([])
  })

  it('Task 61: compact сохраняет view/target живой текстуры', () => {
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 3, width: 64, height: 64, options: { mipLevels: 4 } })
    journal.record({ kind: 'createTextureView', id: 1_000_000, textureId: 3, baseMipLevel: 1, mipLevelCount: 2 })
    journal.record({ kind: 'createTarget', id: 11, textureId: 3, width: 64, height: 64, depth: false, color: [0, 0, 0, 1] })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'createTextureView', 'createTarget'])
  })

  it('Task 61: compact — destroy→create пересоздание текстуры убирает texImage мёртвой инкарнации', () => {
    // id переиспользован после destroy (пересоздание): выживает ПОСЛЕДНИЙ
    // create (новая инкарнация), а texImage2DFromSource стоял ДО него —
    // контент принадлежал мёртвой 32x32-инкарнации и не восстанавливается.
    // Иначе на replay загрузка шла бы ДО create текстуры.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 7, width: 32, height: 32 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 7, sourceKind: 'ImageBitmap', flipY: false })
    journal.record({ kind: 'destroyTexture', id: 7 })
    journal.record({ kind: 'createTexture', id: 7, width: 64, height: 64 })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture'])
    const tex = journal.entries()[0] as { width: number; height: number }
    expect(tex.width).toBe(64) // выжила новая инкарнация, не старая
  })

  it('Task 61: compact — повторная загрузка ПОСЛЕ пересоздания сохраняется', () => {
    // create → texImage → destroy → create → texImage: вторая загрузка стоит
    // после последнего create — она жива и воспроизводится на replay.
    const journal = createJournal()
    journal.record({ kind: 'createTexture', id: 7, width: 32, height: 32 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 7, sourceKind: 'ImageBitmap', flipY: false })
    journal.record({ kind: 'destroyTexture', id: 7 })
    journal.record({ kind: 'createTexture', id: 7, width: 64, height: 64 })
    journal.record({ kind: 'texImage2DFromSource', textureId: 7, sourceKind: 'ImageBitmap', flipY: true })

    journal.compact()
    const kinds = journal.entries().map(op => op.kind)
    expect(kinds).toEqual(['createTexture', 'texImage2DFromSource'])
  })
})
