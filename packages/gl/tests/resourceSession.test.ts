import { describe, test, expect } from 'bun:test'
import { createResourceJournal } from '@rune/core'
import { createResourceSessionGL } from '../src/resourceSessionGL.ts'
import { createResourceSessionGPU } from '../src/resourceSessionGPU.ts'
import type { GLFacade, GLImageSource } from '@rune/webgl2'
import type { GPUFacade, GPUImageSource } from '@rune/webgpu'

/** Фейковый источник (ImageBitmap-подобный). */
const src = (w: number, h: number): { width: number; height: number; id: string } =>
  ({ width: w, height: h, id: `s${w}x${h}-${Math.random().toString(36).slice(2, 7)}` })

// ─── Fake GLFacade: пишет все вызовы в лог, id — монотонный счётчик ─────────

interface GLCall { method: string; args: unknown[] }

function makeFakeGL(): { facade: GLFacade; calls: GLCall[] } {
  const calls: GLCall[] = []
  let nextTex = 1
  let nextView = 1_000_000
  let nextTarget = 1
  const rec = (method: string, ...args: unknown[]): void => { calls.push({ method, args }) }
  const facade = {
    createProgram: (v: string, f: string) => { rec('createProgram', v, f); return 1 },
    useProgram: (id: number) => rec('useProgram', id),
    createBuffer: (data: Float32Array) => { rec('createBuffer', data); return 1 },
    bindVertexBuffer: (b: number, l: number, s: number) => rec('bindVertexBuffer', b, l, s),
    setUniformMatrix4: (p: number, n: string, v: Float32Array) => rec('setUniformMatrix4', p, n, v),
    setUniform4fv: (p: number, n: string, v: Float32Array) => rec('setUniform4fv', p, n, v),
    setUniform3fv: (p: number, n: string, v: Float32Array) => rec('setUniform3fv', p, n, v),
    setUniform2fv: (p: number, n: string, v: Float32Array) => rec('setUniform2fv', p, n, v),
    setUniform1f: (p: number, n: string, v: number) => rec('setUniform1f', p, n, v),
    setUniform1i: (p: number, n: string, v: number) => rec('setUniform1i', p, n, v),
    createTexture: (w: number, h: number, o?: unknown) => { rec('createTexture', w, h, o); return nextTex++ },
    texSubImage2D: (t: number, x: number, y: number, w: number, h: number, b: Uint8Array) => rec('texSubImage2D', t, x, y, w, h, b),
    texImage2DFromSource: (t: number, s: GLImageSource, o?: unknown) => rec('texImage2DFromSource', t, s, o),
    texSubImage2DFromSource: (t: number, x: number, y: number, s: GLImageSource, o?: unknown) => rec('texSubImage2DFromSource', t, x, y, s, o),
    texImage2DLevel: (t: number, l: number, s: GLImageSource, o?: unknown) => rec('texImage2DLevel', t, l, s, o),
    bindTexture: (t: number, u: number) => rec('bindTexture', t, u),
    createTextureView: (t: number, o?: unknown) => { rec('createTextureView', t, o); return nextView++ },
    setViewport: (w: number, h: number) => rec('setViewport', w, h),
    setDepthMode: (t: string, w: boolean) => rec('setDepthMode', t, w),
    setCull: (m: string) => rec('setCull', m),
    clear: (c: unknown, d: unknown) => rec('clear', c, d),
    drawArrays: (m: string, f: number, c: number, i: number) => rec('drawArrays', m, f, c, i),
    createTarget: (t: number, w: number, h: number, d: boolean, c: unknown) => { rec('createTarget', t, w, h, d, c); return nextTarget++ },
    bindTarget: (t: number, c: boolean) => rec('bindTarget', t, c),
    deleteTexture: (t: number) => rec('deleteTexture', t),
    deleteTarget: (t: number) => rec('deleteTarget', t),
    deleteProgram: (p: number) => rec('deleteProgram', p),
    deleteBuffer: (b: number) => rec('deleteBuffer', b),
    deleteTextureView: (v: number) => rec('deleteTextureView', v),
  }
  return { facade: facade as unknown as GLFacade, calls }
}

// ─── Fake GPUFacade ──────────────────────────────────────────────────────────

function makeFakeGPU(): { facade: GPUFacade; calls: GLCall[] } {
  const calls: GLCall[] = []
  let nextTex = 1
  let nextView = 1_000_000
  let nextTarget = 1
  const rec = (method: string, ...args: unknown[]): void => { calls.push({ method, args }) }
  const facade = {
    configure: (w: number, h: number) => rec('configure', w, h),
    resize: (w: number, h: number) => rec('resize', w, h),
    createTexture: (w: number, h: number, f?: string, o?: unknown) => { rec('createTexture', w, h, f, o); return nextTex++ },
    texSubImage2D: (t: number, x: number, y: number, w: number, h: number, b: Uint8Array) => rec('texSubImage2D', t, x, y, w, h, b),
    copyExternalImageToTexture: (t: number, s: GPUImageSource, dx: number, dy: number, cw: number, ch: number, fy?: boolean) =>
      rec('copyExternalImageToTexture', t, s, dx, dy, cw, ch, fy),
    copyExternalImageToTextureMip: (t: number, l: number, s: GPUImageSource, dx: number, dy: number, cw: number, ch: number, fy?: boolean) =>
      rec('copyExternalImageToTextureMip', t, l, s, dx, dy, cw, ch, fy),
    uploadUniforms: (o: number, d: Uint8Array) => rec('uploadUniforms', o, d),
    ensurePipeline: (p: number, w: string, a: readonly number[], t: boolean) => rec('ensurePipeline', p, w, a, t),
    usePipeline: (p: number) => rec('usePipeline', p),
    bindUniforms: (o: number) => rec('bindUniforms', o),
    bindVertexBuffer: (s: number, d: Float32Array, size: number) => rec('bindVertexBuffer', s, d, size),
    bindTexture: (t: number) => rec('bindTexture', t),
    beginPass: (c: number) => rec('beginPass', c),
    draw: (c: number, i: number) => rec('draw', c, i),
    endPass: () => rec('endPass'),
    submit: () => rec('submit'),
    createTarget: (t: number, w: number, h: number, d: boolean, c: unknown) => { rec('createTarget', t, w, h, d, c); return nextTarget++ },
    bindTarget: (t: number, c: boolean) => rec('bindTarget', t, c),
    deleteTexture: (t: number) => rec('deleteTexture', t),
    deleteTarget: (t: number) => rec('deleteTarget', t),
    createTextureView: (t: number, o?: unknown) => { rec('createTextureView', t, o); return nextView++ },
    deleteTextureView: (v: number) => rec('deleteTextureView', v),
    dispose: () => rec('dispose'),
    installTimer: (h: unknown) => { rec('installTimer', h); return null },
    get adapter() { return null },
    get device() { return null },
    get preferredFormat() { return 'bgra8unorm' as GPUTextureFormat },
    get timer() { return null },
  }
  return { facade: facade as unknown as GPUFacade, calls }
}

describe('resourceSessionGL — стабильные id и журналирование', () => {
  test('createTexture возвращает стабильные id; журнал получает texture.create', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const session = createResourceSessionGL(facade, j)
    const t1 = session.facade.createTexture(256, 256)
    const t2 = session.facade.createTexture(64, 64)
    expect(t1).toBe(1)
    expect(t2).toBe(2)
    expect(j.entries()[0]).toMatchObject({ kind: 'texture.create', id: 1, width: 256, height: 256 })
  })

  test('texSubImage2DFromSource журналируется как texture.update с ContentRef', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const t = s.facade.createTexture(256, 256)
    const source = src(64, 64)
    s.facade.texSubImage2DFromSource(t, 10, 20, source as never, { flipY: false })
    const op = j.entries()[1]!
    expect(op).toMatchObject({ kind: 'texture.update', id: t, x: 10, y: 20, w: 64, h: 64, flipY: false })
    expect(j.getSource((op as { content: { ref: number } }).content.ref)).toBe(source)
  })

  test('id-трансляция: facade получает RAW id, приложение — стабильный', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const t1 = s.facade.createTexture(64, 64) // raw 1
    s.facade.deleteTexture(t1)                // raw 1 удалён
    const t2 = s.facade.createTexture(64, 64) // стабильный 2, raw 2
    expect(t2).toBe(2)
    const source = src(64, 64)
    s.facade.texSubImage2DFromSource(t2, 0, 0, source as never)
    // последний вызов получил raw id = 2 (правильная текстура!)
    const last = calls[calls.length - 1]!
    expect(last.method).toBe('texSubImage2DFromSource')
    expect(last.args[0]).toBe(2)
  })

  test('programs/buffers — pass-through raw id, журнал их НЕ хранит', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const p = s.facade.createProgram('vs', 'fs')
    const b = s.facade.createBuffer(new Float32Array([1, 2, 3]))
    expect(p).toBe(1)
    expect(b).toBe(1)
    expect(j.entries().every(op => op.kind !== 'texture.create')).toBe(true)
    expect(j.size).toBe(0)
  })
})

describe('resourceSessionGL — restore (регрессия пользователя: дырки в id)', () => {
  test('после create/delete/create + compact restore даёт ТЕ ЖЕ стабильные id и правильные raw-маппинги', () => {
    // Сценарий из баг-репорта: журнал имеет ДЫРКИ (id 3 уничтожен),
    // replay v1 выдавал плотный ряд 1,2,3,4 и «НЕ СОВПАДАЮТ».
    const j = createResourceJournal()
    const fake1 = makeFakeGL()
    const s1 = createResourceSessionGL(fake1.facade, j)
    const t1 = s1.facade.createTexture(256, 256) // стабильный 1
    const t2 = s1.facade.createTexture(64, 64)   // стабильный 2
    const t3 = s1.facade.createTexture(64, 64)   // стабильный 3 (будет уничтожен)
    const t4 = s1.facade.createTexture(128, 128) // стабильный 4 — ДЫРКА после delete t3
    const tileA = src(64, 64)
    const tileB = src(64, 64)
    s1.facade.texSubImage2DFromSource(t2, 0, 0, tileA as never)
    s1.facade.texSubImage2DFromSource(t2, 64, 0, tileB as never)
    s1.facade.deleteTexture(t3) // дырка в стабильных id
    void t1; void t4

    // Потеря устройства: compact + restore на СВЕЖЕМ фасаде (та же сессия
    // имитируется новой обёрткой над новым raw-фасадом).
    j.compact()
    const fake2 = makeFakeGL()
    const s2 = createResourceSessionGL(fake2.facade, j)
    const report = s2.restore()

    // Стабильные id живых текстур — ТЕ ЖЕ (по построению, не «повезло»)
    expect(report.textureIds).toEqual([1, 2, 4])
    // Контент пере-залит: 2 sub-image вызова на raw id текстуры 2
    const subs = fake2.calls.filter(c => c.method === 'texSubImage2DFromSource')
    expect(subs).toHaveLength(2)
    expect(subs[0]!.args[0]).toBe(s2.mapping.get(2))
    expect(subs[0]!.args[1]).toBe(0)
    expect(subs[1]!.args[1]).toBe(64)
    // Источники — те же объекты из ContentStore
    expect(subs[0]!.args[3]).toBe(tileA)
    expect(subs[1]!.args[3]).toBe(tileB)
    expect(report.contentOps).toBe(2)
    expect(report.skipped).toBe(0)
  })

  test('texture.write / writeMip / view.create / target.create восстанавливаются', () => {
    const j = createResourceJournal()
    const fake1 = makeFakeGL()
    const s1 = createResourceSessionGL(fake1.facade, j)
    const t = s1.facade.createTexture(256, 256, { mipLevels: 9 })
    const full = src(256, 256)
    const mip1 = src(128, 128)
    s1.facade.texImage2DFromSource(t, full as never, { flipY: true })
    s1.facade.texImage2DLevel(t, 1, mip1 as never)
    const v = s1.facade.createTextureView(t, { baseMipLevel: 1, mipLevelCount: 2 })
    const tgt = s1.facade.createTarget(t, 256, 256, false, [0, 0, 0, 1])
    void v; void tgt

    j.compact()
    const fake2 = makeFakeGL()
    const s2 = createResourceSessionGL(fake2.facade, j)
    const report = s2.restore()
    expect(report.textureIds).toEqual([t])
    expect(report.viewIds.length).toBe(1)
    expect(report.targetIds.length).toBe(1)
    expect(report.contentOps).toBe(2) // write + writeMip
    // write пришёл с flipY=true (сохранён в опсе)
    const write = fake2.calls.find(c => c.method === 'texImage2DFromSource')!
    expect(write.args[2]).toEqual({ flipY: true })
    // view создан на ПРАВИЛЬНУЮ текстуру (raw id = mapping t)
    const view = fake2.calls.find(c => c.method === 'createTextureView')!
    expect(view.args[0]).toBe(s2.mapping.get(t))
  })

  test('мёртвый источник (закрытый битмап-подобный) — опс пропускается, restore не падает', () => {
    const j = createResourceJournal()
    const fake1 = makeFakeGL()
    const s1 = createResourceSessionGL(fake1.facade, j)
    const t = s1.facade.createTexture(64, 64)
    const dead = { width: 0, height: 0 } // «закрытый» ImageBitmap
    s1.facade.texSubImage2DFromSource(t, 0, 0, dead as never)

    const fake2 = makeFakeGL()
    const s2 = createResourceSessionGL(fake2.facade, j)
    const report = s2.restore()
    expect(report.skipped).toBe(1)
    expect(report.contentOps).toBe(0)
  })
})

describe('resourceSessionGPU — стабильные id, полнота копии, restore', () => {
  test('полная копия → texture.write; sub-region → texture.update', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGPU()
    const s = createResourceSessionGPU(raw, j)
    const t = s.facade.createTexture(256, 256, 'rgba8unorm')
    const full = src(256, 256)
    const tile = src(64, 64)
    s.facade.copyExternalImageToTexture(t, full as never, 0, 0, 256, 256, false)
    s.facade.copyExternalImageToTexture(t, tile as never, 64, 0, 64, 64, true)
    const kinds = j.entries().map(op => op.kind)
    expect(kinds).toEqual(['texture.create', 'texture.write', 'texture.update'])
    const upd = j.entries()[2]!
    expect(upd).toMatchObject({ kind: 'texture.update', x: 64, y: 0, w: 64, h: 64, flipY: true })
  })

  test('restore: id стабильны, контент залит с правильными координатами и raw id', () => {
    const j = createResourceJournal()
    const fake1 = makeFakeGPU()
    const s1 = createResourceSessionGPU(fake1.facade, j)
    const tA = s1.facade.createTexture(256, 256, 'rgba8unorm')
    const tB = s1.facade.createTexture(64, 64, 'rgba8unorm')
    s1.facade.deleteTexture(tA) // дырка
    const tile = src(64, 64)
    s1.facade.copyExternalImageToTexture(tB, tile as never, 0, 0, 64, 64, false)

    j.compact()
    const fake2 = makeFakeGPU()
    const s2 = createResourceSessionGPU(fake2.facade, j)
    const report = s2.restore()
    expect(report.textureIds).toEqual([tB])
    expect(report.contentOps).toBe(1)
    const copy = fake2.calls.find(c => c.method === 'copyExternalImageToTexture')!
    expect(copy.args[0]).toBe(s2.mapping.get(tB))
    expect(copy.args[3]).toBe(0) // dstX
    expect(copy.args[5]).toBe(64) // copyWidth
    expect(copy.args[6]).toBe(false) // flipY из опса (сохранён при записи)
  })

  test('writeMip восстанавливается через copyExternalImageToTextureMip', () => {
    const j = createResourceJournal()
    const fake1 = makeFakeGPU()
    const s1 = createResourceSessionGPU(fake1.facade, j)
    const t = s1.facade.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    const mip1 = src(128, 128)
    s1.facade.copyExternalImageToTextureMip(t, 1, mip1 as never, 0, 0, 128, 128, false)

    const fake2 = makeFakeGPU()
    const s2 = createResourceSessionGPU(fake2.facade, j)
    const report = s2.restore()
    expect(report.contentOps).toBe(1)
    const mip = fake2.calls.find(c => c.method === 'copyExternalImageToTextureMip')!
    expect(mip.args[1]).toBe(1) // mipLevel
    expect(mip.args[0]).toBe(s2.mapping.get(t))
  })

  test('bindTexture транслирует и textureId, и viewId (namespace ≥1M)', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGPU()
    const s = createResourceSessionGPU(raw, j)
    const t = s.facade.createTexture(64, 64, 'rgba8unorm', { mipLevels: 4 })
    const rawT = s.mapping.get(t)!
    const v = s.facade.createTextureView(t, { baseMipLevel: 1 })
    const rawV = s.rawId(v)
    s.facade.bindTexture(t)
    s.facade.bindTexture(v)
    const binds = calls.filter(c => c.method === 'bindTexture')
    expect(binds[0]!.args[0]).toBe(rawT)
    expect(binds[1]!.args[0]).toBe(rawV)
    expect(rawV).toBeDefined()
  })
})

describe('resourceSession — сидирование счётчиков из журнала', () => {
  test('новая сессия не переиспользует стабильные id из журнала', () => {
    const j = createResourceJournal()
    const fake1 = makeFakeGL()
    const s1 = createResourceSessionGL(fake1.facade, j)
    s1.facade.createTexture(64, 64) // стабильный 1
    s1.facade.createTexture(64, 64) // стабильный 2

    // Re-init: НОВАЯ сессия над свежим raw-фасадом, тот же журнал.
    // До restore() приложение создаёт текстуру — id должен быть 3, не 1.
    const fake2 = makeFakeGL()
    const s2 = createResourceSessionGL(fake2.facade, j)
    const t3 = s2.facade.createTexture(64, 64)
    expect(t3).toBe(3)
  })
})

// ─── Task 65: soft reset (restore(workingSet)) + ленивая резидентность ──────

describe('Task 65 — restore(workingSet): soft reset только сцены', () => {
  test('GL: восстанавливает только рабочее множество, остальное — deferred', () => {
    const j = createResourceJournal()
    const { facade, calls } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    // Сцена: текстура 1 с контентом; скрытый ресурс: текстура 2 с контентом.
    const scene = s.facade.createTexture(256, 256)
    s.facade.texImage2DFromSource(scene, src(256, 256) as never, { flipY: false })
    const hidden = s.facade.createTexture(128, 128)
    s.facade.texImage2DFromSource(hidden, src(128, 128) as never, { flipY: false })
    j.compact()

    // Потеря устройства → свежая сессия (новый fake-фасад), soft reset.
    const { facade: gl2, calls: calls2 } = makeFakeGL()
    const s2 = createResourceSessionGL(gl2, j)
    const report = s2.restore({ textureIds: [scene] })
    expect(report.textureIds).toEqual([scene])
    expect(report.contentOps).toBe(1)
    expect(report.deferred).toBeDefined()
    expect(report.deferred!.textures).toEqual([hidden])
    // На фасаде создана ТОЛЬКО одна текстура (сцена): create-вызовов — 1.
    const creates = calls2.filter(c => c.method === 'createTexture')
    expect(creates).toHaveLength(1)
    expect(creates[0]!.args).toEqual([256, 256, undefined])
    // Контент сцены пере-залит (texImage2DFromSource), контент hidden — НЕТ.
    expect(calls2.filter(c => c.method === 'texImage2DFromSource')).toHaveLength(1)
    void calls
  })

  test('GL: ensureResident лениво возвращает отложенный ресурс с контентом', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const scene = s.facade.createTexture(256, 256)
    const hidden = s.facade.createTexture(128, 128)
    s.facade.texImage2DFromSource(hidden, src(128, 128) as never, { flipY: false })
    j.compact()

    const { facade: gl2, calls: calls2 } = makeFakeGL()
    const s2 = createResourceSessionGL(gl2, j)
    const report = s2.restore({ textureIds: [scene] })
    expect(report.deferred!.textures).toEqual([hidden])
    expect(s2.rawId(hidden)).toBeUndefined() // не резидентен

    const lazy = s2.ensureResident(hidden)
    expect(lazy).not.toBeNull()
    expect(lazy!.textureIds).toEqual([hidden])
    expect(lazy!.contentOps).toBe(1) // контент вернулся вместе с текстурой
    expect(s2.rawId(hidden)).toBeDefined() // теперь резидентен

    // Идемпотентно: повторный вызов — no-op (null), без дублей на фасаде.
    const again = s2.ensureResident(hidden)
    expect(again).toBeNull()
    // createTexture на фасаде: сцены НЕ было (empty workingSet в этом тесте не
    // применяется — restore получил scene), поэтому ровно 2: scene + hidden.
    expect(calls2.filter(c => c.method === 'createTexture')).toHaveLength(2)
  })

  test('GL: ensureResident(viewId) тянет parent-текстуру и её mip-контент', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const parent = s.facade.createTexture(256, 256, { mipLevels: 9 })
    s.facade.texImage2DFromSource(parent, src(256, 256) as never, { flipY: false })
    s.facade.texImage2DLevel(parent, 4, src(16, 16) as never, { flipY: false })
    const view = s.facade.createTextureView(parent, { baseMipLevel: 4, mipLevelCount: 3 })
    j.compact()

    // Soft reset БЕЗ view: parent отложен вместе с контентом.
    const { facade: gl2, calls: calls2 } = makeFakeGL()
    const s2 = createResourceSessionGL(gl2, j)
    const report = s2.restore({})
    expect(report.opsReplayed).toBe(0)
    expect(report.deferred!.textures).toEqual([parent])
    expect(report.deferred!.views).toEqual([view])

    // Ленивый возврат view: parent create + write + writeMip + view.create.
    const lazy = s2.ensureResident(view)
    expect(lazy).not.toBeNull()
    expect(lazy!.textureIds).toEqual([parent])
    expect(lazy!.viewIds).toEqual([view])
    expect(lazy!.contentOps).toBe(2)
    expect(s2.rawId(view)).toBeDefined()
    expect(calls2.filter(c => c.method === 'createTextureView')).toHaveLength(1)
  })

  test('GPU: восстанавливает только рабочее множество + ленивый ensureResident', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGPU()
    const s = createResourceSessionGPU(facade, j)
    const scene = s.facade.createTexture(256, 256, 'rgba8unorm')
    s.facade.copyExternalImageToTexture(scene, src(256, 256) as never, 0, 0, 256, 256, false)
    const hidden = s.facade.createTexture(128, 128, 'rgba8unorm')
    s.facade.copyExternalImageToTexture(hidden, src(128, 128) as never, 0, 0, 128, 128, false)
    j.compact()

    const { facade: gpu2, calls: calls2 } = makeFakeGPU()
    const s2 = createResourceSessionGPU(gpu2, j)
    const report = s2.restore({ textureIds: [scene] })
    expect(report.textureIds).toEqual([scene])
    expect(report.contentOps).toBe(1)
    expect(report.deferred!.textures).toEqual([hidden])
    expect(calls2.filter(c => c.method === 'createTexture')).toHaveLength(1)

    const lazy = s2.ensureResident(hidden)
    expect(lazy).not.toBeNull()
    expect(lazy!.textureIds).toEqual([hidden])
    expect(lazy!.contentOps).toBe(1)
    expect(s2.ensureResident(hidden)).toBeNull() // идемпотентно
  })

  test('GPU: view-сцена через workingSet (parent+контент+view одним restore)', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGPU()
    const s = createResourceSessionGPU(facade, j)
    const parent = s.facade.createTexture(256, 256, 'rgba8unorm', { mipLevels: 9 })
    s.facade.copyExternalImageToTexture(parent, src(256, 256) as never, 0, 0, 256, 256, false)
    s.facade.copyExternalImageToTextureMip(parent, 4, src(16, 16) as never, 0, 0, 16, 16, false)
    const view = s.facade.createTextureView(parent, { baseMipLevel: 4, mipLevelCount: 2 })
    j.compact()

    const { facade: gpu2, calls: calls2 } = makeFakeGPU()
    const s2 = createResourceSessionGPU(gpu2, j)
    const report = s2.restore({ viewIds: [view] })
    expect(report.textureIds).toEqual([parent])
    expect(report.viewIds).toEqual([view])
    expect(report.contentOps).toBe(2) // base + mip 4
    expect(report.deferred!.textures).toEqual([])
    expect(calls2.filter(c => c.method === 'copyExternalImageToTextureMip')).toHaveLength(1)
  })
})

describe('Task 65 — dispose отложенного (нерезидентного) ресурса', () => {
  test('GL: deleteTexture отложенной текстуры не бросает и убивает декларацию', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const tex = s.facade.createTexture(64, 64)
    s.facade.texImage2DFromSource(tex, src(64, 64) as never, { flipY: false })
    j.compact()

    // Soft reset без этой текстуры → отложена.
    const { facade: gl2 } = makeFakeGL()
    const s2 = createResourceSessionGL(gl2, j)
    const report = s2.restore({})
    expect(report.deferred!.textures).toEqual([tex])

    // Dispose отложенной: НЕ бросает (raw-вызова нет), destroy пишется.
    expect(() => s2.facade.deleteTexture(tex)).not.toThrow()
    expect(j.entries().some(op => op.kind === 'texture.destroy' && op.id === tex)).toBe(true)
    // compact вычищает пару create→destroy — журнал пуст, ContentStore чист.
    j.compact()
    expect(j.size).toBe(0)
  })

  test('GPU: deleteTextureView отложенного view — только декларация', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGPU()
    const s = createResourceSessionGPU(facade, j)
    const parent = s.facade.createTexture(64, 64, 'rgba8unorm')
    const view = s.facade.createTextureView(parent, { baseMipLevel: 0 })
    j.compact()

    const { facade: gpu2 } = makeFakeGPU()
    const s2 = createResourceSessionGPU(gpu2, j)
    const report = s2.restore({ textureIds: [parent] }) // view НЕ в рабочем множестве
    expect(report.deferred!.views).toEqual([view])
    expect(() => s2.facade.deleteTextureView(view)).not.toThrow()
    j.compact()
    // view.create + view.destroy пара вычищена; parent create жив.
    expect(j.entries().map(o => o.kind)).toEqual(['texture.create'])
  })
})
