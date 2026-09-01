import { describe, test, expect } from 'bun:test'
import { createResourceJournal, selectResidentOps } from '../src/journal/resourceJournal.ts'
import type { ResOp } from '../src/journal/resourceJournal.ts'

/** Фейковый источник пикселей (ImageBitmap-подобный, без DOM). */
function fakeSource(w = 64, h = 64): { width: number; height: number; tag: string } {
  return { width: w, height: h, tag: `src-${Math.random().toString(36).slice(2, 8)}` }
}

describe('ResourceJournal v2 — базовый контракт', () => {
  test('record/replay/entries/size: append-only в порядке записи', () => {
    const j = createResourceJournal()
    const ref = j.storeSource(fakeSource(), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 1, width: 256, height: 256 })
    j.record({ kind: 'texture.update', id: 1, x: 0, y: 0, w: 64, h: 64, content: ref, flipY: false })
    expect(j.size).toBe(2)
    const applied: ResOp[] = []
    j.replay(op => applied.push(op))
    expect(applied.map(op => op.kind)).toEqual(['texture.create', 'texture.update'])
    expect(applied[1]).toMatchObject({ x: 0, y: 0, w: 64, h: 64 })
  })

  test('ContentStore: storeSource/getSource/attachSource/isSourceAlive', () => {
    const j = createResourceJournal()
    const src = fakeSource()
    const ref = j.storeSource(src, 'ImageBitmap', 64, 64)
    expect(ref).toMatchObject({ ref: 1, kind: 'ImageBitmap', width: 64, height: 64 })
    expect(j.getSource(ref.ref)).toBe(src)
    expect(j.isSourceAlive(ref.ref)).toBe(true)
    expect(j.getSource(999)).toBe(null)
    expect(j.isSourceAlive(999)).toBe(false)
    // worker migration: пере-регистрация под существующий ref
    const migrated = fakeSource()
    j.attachSource(ref.ref, migrated)
    expect(j.getSource(ref.ref)).toBe(migrated)
    // второй источник получает следующий ref
    const ref2 = j.storeSource(fakeSource(), 'OffscreenCanvas', 32, 32)
    expect(ref2.ref).toBe(2)
  })

  test('snapshot: ops клонируются, манифест контента с kind/размерами', () => {
    const j = createResourceJournal()
    const ref = j.storeSource(fakeSource(64, 64), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 1, width: 128, height: 128 })
    j.record({ kind: 'texture.write', id: 1, content: ref, flipY: true })
    const snap = j.snapshot()
    expect(snap.ops).toHaveLength(2)
    expect(snap.ops[1]).toMatchObject({ kind: 'texture.write', flipY: true })
    // snapshot — глубокая копия опсов: мутация снапшота не трогает журнал
    ;(snap.ops[1] as { flipY: boolean }).flipY = false
    expect(j.entries()[1]).toMatchObject({ flipY: true })
    expect(snap.content).toContainEqual({ ref: 1, kind: 'ImageBitmap', width: 64, height: 64 })
  })

  test('maxTextureId/maxViewId/maxTargetId: сидирование счётчиков стабильных id', () => {
    const j = createResourceJournal()
    expect(j.maxTextureId()).toBe(0)
    expect(j.maxViewId()).toBe(1_000_000 - 1)
    j.record({ kind: 'texture.create', id: 4, width: 64, height: 64 })
    j.record({ kind: 'texture.create', id: 7, width: 64, height: 64 })
    j.record({ kind: 'view.create', id: 1_000_005, textureId: 4 })
    j.record({ kind: 'target.create', id: 2, textureId: 4, width: 64, height: 64, depth: false, color: [0, 0, 0, 1] })
    expect(j.maxTextureId()).toBe(7)
    expect(j.maxViewId()).toBe(1_000_005)
    expect(j.maxTargetId()).toBe(2)
  })

  test('evict/reset: обычная семантика', () => {
    const j = createResourceJournal()
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'texture.create', id: 2, width: 64, height: 64 })
    j.evict(op => op.kind === 'texture.create' && op.id === 1)
    expect(j.size).toBe(1)
    j.reset()
    expect(j.size).toBe(0)
  })
})

describe('ResourceJournal v2 — compact: пары и висячие ссылки', () => {
  test('create→destroy пара удаляется целиком', () => {
    const j = createResourceJournal()
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'texture.destroy', id: 1 })
    j.record({ kind: 'texture.create', id: 2, width: 64, height: 64 })
    j.compact()
    expect(j.size).toBe(1)
    expect(j.entries()[0]).toMatchObject({ kind: 'texture.create', id: 2 })
  })

  test('контент-опсы уничтоженной текстуры выбрасываются (вместе с парой)', () => {
    const j = createResourceJournal()
    const ref = j.storeSource(fakeSource(), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 1, width: 256, height: 256 })
    j.record({ kind: 'texture.update', id: 1, x: 0, y: 0, w: 64, h: 64, content: ref, flipY: false })
    j.record({ kind: 'texture.destroy', id: 1 })
    j.compact()
    expect(j.size).toBe(0)
  })

  test('view/target мёртвой текстуры: create и их destroy выбрасываются (без сирот)', () => {
    const j = createResourceJournal()
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'view.create', id: 1_000_001, textureId: 1 })
    j.record({ kind: 'target.create', id: 1, textureId: 1, width: 64, height: 64, depth: false, color: [0, 0, 0, 1] })
    j.record({ kind: 'texture.destroy', id: 1 })
    j.record({ kind: 'view.destroy', id: 1_000_001 })
    j.record({ kind: 'target.destroy', id: 1 })
    j.compact()
    expect(j.size).toBe(0)
  })

  test('view/target живой текстуры переживают compact', () => {
    const j = createResourceJournal()
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'view.create', id: 1_000_001, textureId: 1 })
    j.record({ kind: 'target.create', id: 1, textureId: 1, width: 64, height: 64, depth: false, color: [0, 0, 0, 1] })
    j.compact()
    expect(j.size).toBe(3)
  })

  test('пересоздание id: контент мёртвой инкарнации удаляется, новой — выживает', () => {
    const j = createResourceJournal()
    const dead = j.storeSource(fakeSource(), 'ImageBitmap', 64, 64)
    const alive = j.storeSource(fakeSource(), 'ImageBitmap', 128, 128)
    j.record({ kind: 'texture.create', id: 5, width: 64, height: 64 })
    j.record({ kind: 'texture.write', id: 5, content: dead, flipY: false })
    j.record({ kind: 'texture.destroy', id: 5 })
    j.record({ kind: 'texture.create', id: 5, width: 128, height: 128 })
    j.record({ kind: 'texture.write', id: 5, content: alive, flipY: false })
    j.compact()
    // выживает: create(новый) + write(alive); create(старый)+write(dead)+destroy удалены
    expect(j.size).toBe(2)
    expect(j.entries()[0]).toMatchObject({ kind: 'texture.create', id: 5, width: 128 })
    expect(j.entries()[1]).toMatchObject({ kind: 'texture.write', content: { ref: alive.ref } })
  })
})

describe('ResourceJournal v2 — compact: коалесцинг контента', () => {
  test('texture.write поглощает все предыдущие write/update той же текстуры', () => {
    const j = createResourceJournal()
    const ref1 = j.storeSource(fakeSource(64, 64), 'ImageBitmap', 64, 64)
    const ref2 = j.storeSource(fakeSource(256, 256), 'ImageBitmap', 256, 256)
    j.record({ kind: 'texture.create', id: 1, width: 256, height: 256 })
    j.record({ kind: 'texture.update', id: 1, x: 0, y: 0, w: 64, h: 64, content: ref1, flipY: false })
    j.record({ kind: 'texture.update', id: 1, x: 64, y: 0, w: 64, h: 64, content: ref1, flipY: false })
    j.record({ kind: 'texture.write', id: 1, content: ref2, flipY: false })
    j.compact()
    const contentOps = j.entries().filter(op => op.kind !== 'texture.create')
    expect(contentOps).toHaveLength(1)
    expect(contentOps[0]).toMatchObject({ kind: 'texture.write', content: { ref: ref2.ref } })
  })

  test('повторный update того же rect — выживает последний (last-write-wins)', () => {
    const j = createResourceJournal()
    const refA = j.storeSource(fakeSource(), 'ImageBitmap', 64, 64)
    const refB = j.storeSource(fakeSource(), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 1, width: 256, height: 256 })
    j.record({ kind: 'texture.update', id: 1, x: 0, y: 0, w: 64, h: 64, content: refA, flipY: false })
    j.record({ kind: 'texture.update', id: 1, x: 0, y: 0, w: 64, h: 64, content: refB, flipY: false })
    j.record({ kind: 'texture.update', id: 1, x: 64, y: 0, w: 64, h: 64, content: refA, flipY: false })
    j.compact()
    const updates = j.entries().filter(op => op.kind === 'texture.update')
    expect(updates).toHaveLength(2)
    expect(updates[0]).toMatchObject({ content: { ref: refB.ref } }) // (0,0) — последний = B
    expect(updates[1]).toMatchObject({ x: 64, content: { ref: refA.ref } }) // (64,0) — не тронут
  })

  test('writeMip: одинаковый level — последний; write НЕ поглощает writeMip', () => {
    const j = createResourceJournal()
    const refFull = j.storeSource(fakeSource(256, 256), 'ImageBitmap', 256, 256)
    const refMip1a = j.storeSource(fakeSource(128, 128), 'ImageBitmap', 128, 128)
    const refMip1b = j.storeSource(fakeSource(128, 128), 'ImageBitmap', 128, 128)
    const refMip2 = j.storeSource(fakeSource(64, 64), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 1, width: 256, height: 256, options: { mipLevels: 9 } })
    j.record({ kind: 'texture.writeMip', id: 1, level: 1, content: refMip1a, flipY: false })
    j.record({ kind: 'texture.writeMip', id: 1, level: 1, content: refMip1b, flipY: false })
    j.record({ kind: 'texture.writeMip', id: 1, level: 2, content: refMip2, flipY: false })
    j.record({ kind: 'texture.write', id: 1, content: refFull, flipY: false })
    j.compact()
    // write поглотил все texture.write/update, но writeMip — НЕТ (другие уровни)
    const mips = j.entries().filter(op => op.kind === 'texture.writeMip')
    expect(mips).toHaveLength(2)
    expect(mips[0]).toMatchObject({ level: 1, content: { ref: refMip1b.ref } })
    expect(mips[1]).toMatchObject({ level: 2, content: { ref: refMip2.ref } })
    expect(j.entries().some(op => op.kind === 'texture.write')).toBe(true)
  })
})

describe('ResourceJournal v2 — Task 65: selectResidentOps (soft reset)', () => {
  test('textureIds: create + контент выбранной текстуры; остальное — deferred', () => {
    const j = createResourceJournal()
    const refScene = j.storeSource(fakeSource(256, 256), 'ImageBitmap', 256, 256)
    const refHidden = j.storeSource(fakeSource(128, 128), 'ImageBitmap', 128, 128)
    j.record({ kind: 'texture.create', id: 1, width: 256, height: 256 })
    j.record({ kind: 'texture.write', id: 1, content: refScene, flipY: false })
    j.record({ kind: 'texture.create', id: 2, width: 128, height: 128 })
    j.record({ kind: 'texture.update', id: 2, x: 0, y: 0, w: 64, h: 64, content: refHidden, flipY: false })
    const sel = selectResidentOps(j.entries(), { textureIds: [1] })
    expect(sel.ops).toHaveLength(2)
    expect(sel.ops[0]).toMatchObject({ kind: 'texture.create', id: 1 })
    expect(sel.ops[1]).toMatchObject({ kind: 'texture.write', id: 1 })
    expect(sel.deferredTextures).toEqual([2])
    expect(sel.deferredViews).toEqual([])
    expect(sel.deferredTargets).toEqual([])
  })

  test('viewIds: замыкание тянет parent-текстуру и ЕЁ контент (view без пикселей бессмыслен)', () => {
    const j = createResourceJournal()
    const refBase = j.storeSource(fakeSource(256, 256), 'ImageBitmap', 256, 256)
    const refMip = j.storeSource(fakeSource(16, 16), 'ImageBitmap', 16, 16)
    j.record({ kind: 'texture.create', id: 7, width: 256, height: 256, options: { mipLevels: 9 } })
    j.record({ kind: 'texture.write', id: 7, content: refBase, flipY: false })
    j.record({ kind: 'texture.writeMip', id: 7, level: 4, content: refMip, flipY: false })
    j.record({ kind: 'view.create', id: 1_000_000, textureId: 7, baseMipLevel: 4, mipLevelCount: 3 })
    const sel = selectResidentOps(j.entries(), { viewIds: [1_000_000] })
    expect(sel.ops.map(o => o.kind)).toEqual(['texture.create', 'texture.write', 'texture.writeMip', 'view.create'])
    expect(sel.deferredTextures).toEqual([])
    expect(sel.deferredViews).toEqual([])
  })

  test('targetIds: parent create БЕЗ контента (target перезапишется рендером)', () => {
    const j = createResourceJournal()
    const ref = j.storeSource(fakeSource(64, 64), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 3, width: 64, height: 64 })
    j.record({ kind: 'texture.write', id: 3, content: ref, flipY: false })
    j.record({ kind: 'target.create', id: 1, textureId: 3, width: 64, height: 64, depth: false, color: [0, 0, 0, 1] })
    const sel = selectResidentOps(j.entries(), { targetIds: [1] })
    expect(sel.ops.map(o => o.kind)).toEqual(['texture.create', 'target.create'])
    expect(sel.deferredTextures).toEqual([])
  })

  test('view на НЕ выбранной текстуре — deferred; parent выбранной текстуры view не тянет', () => {
    const j = createResourceJournal()
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'texture.create', id: 2, width: 64, height: 64 })
    j.record({ kind: 'view.create', id: 1_000_000, textureId: 2 })
    // Держим только текстуру 1: view на текстуре 2 — отложен.
    const sel = selectResidentOps(j.entries(), { textureIds: [1] })
    expect(sel.ops.map(o => o.kind)).toEqual(['texture.create'])
    expect(sel.deferredTextures).toEqual([2])
    expect(sel.deferredViews).toEqual([1_000_000])
  })

  test('пустое рабочее множество → ops пуст, всё живое deferred (чистый soft reset)', () => {
    const j = createResourceJournal()
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'texture.create', id: 2, width: 64, height: 64 })
    j.record({ kind: 'view.create', id: 1_000_000, textureId: 1 })
    const sel = selectResidentOps(j.entries(), {})
    expect(sel.ops).toHaveLength(0)
    expect(sel.deferredTextures).toEqual([1, 2])
    expect(sel.deferredViews).toEqual([1_000_000])
  })

  test('мёртвая инкарнация: контент до destroy→create НЕ выбирается (семантика compact)', () => {
    const j = createResourceJournal()
    const refDead = j.storeSource(fakeSource(32, 32), 'ImageBitmap', 32, 32)
    const refAlive = j.storeSource(fakeSource(64, 64), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 5, width: 32, height: 32 })
    j.record({ kind: 'texture.write', id: 5, content: refDead, flipY: false })
    j.record({ kind: 'texture.destroy', id: 5 })
    j.record({ kind: 'texture.create', id: 5, width: 64, height: 64 })
    j.record({ kind: 'texture.write', id: 5, content: refAlive, flipY: false })
    const sel = selectResidentOps(j.entries(), { textureIds: [5] })
    expect(sel.ops).toHaveLength(2)
    expect(sel.ops[1]).toMatchObject({ kind: 'texture.write', content: { ref: refAlive.ref } })
  })
})

describe('ResourceJournal v2 — Task 65: ContentStore GC в compact()', () => {
  test('источники уничтоженных текстур освобождаются (CPU-память не течёт)', () => {
    const j = createResourceJournal()
    const refA = j.storeSource(fakeSource(64, 64), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'texture.write', id: 1, content: refA, flipY: false })
    j.record({ kind: 'texture.destroy', id: 1 })
    j.compact()
    expect(j.size).toBe(0)
    expect(j.getSource(refA.ref)).toBeNull()
  })

  test('живые источники НЕ трогаются; поглощённые write-ом — освобождаются', () => {
    const j = createResourceJournal()
    const refOld = j.storeSource(fakeSource(32, 32), 'ImageBitmap', 32, 32)
    const refNew = j.storeSource(fakeSource(64, 64), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'texture.update', id: 1, x: 0, y: 0, w: 32, h: 32, content: refOld, flipY: false })
    j.record({ kind: 'texture.write', id: 1, content: refNew, flipY: false })
    j.compact()
    expect(j.getSource(refNew.ref)).not.toBeNull()
    expect(j.getSource(refOld.ref)).toBeNull() // поглощён полным write
  })

  test('ref-счётчик монотонный: после GC новые ref не коллидируют со старыми', () => {
    const j = createResourceJournal()
    const refA = j.storeSource(fakeSource(), 'ImageBitmap', 64, 64)
    j.record({ kind: 'texture.create', id: 1, width: 64, height: 64 })
    j.record({ kind: 'texture.write', id: 1, content: refA, flipY: false })
    j.record({ kind: 'texture.destroy', id: 1 })
    j.compact() // refA удалён, sources пуст
    const refB = j.storeSource(fakeSource(), 'ImageBitmap', 64, 64)
    expect(refB.ref).toBeGreaterThan(refA.ref) // не 1 (иначе перезаписал бы)
    j.record({ kind: 'texture.create', id: 2, width: 64, height: 64 })
    j.record({ kind: 'texture.write', id: 2, content: refB, flipY: false })
    expect(j.getSource(refB.ref)).not.toBeNull()
  })
})
