import { describe, test, expect } from 'bun:test'
import { createResourceJournal, estimateTextureBytes } from '@rune/core'
import { createResourceSessionGL } from '../src/resourceSessionGL.ts'
import { createResourceSessionGPU } from '../src/resourceSessionGPU.ts'
import type { GLFacade, GLImageSource } from '@rune/webgl2'
import type { GPUFacade, GPUImageSource } from '@rune/webgpu'

/** Фейковый источник (ImageBitmap-подобный). */
const src = (w: number, h: number): { width: number; height: number; id: string } =>
  ({ width: w, height: h, id: `s${w}x${h}-${Math.random().toString(36).slice(2, 7)}` })

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

/** Raw-вызовы фасада данного метода. */
const callsOf = (calls: GLCall[], method: string): unknown[][] =>
  calls.filter(c => c.method === method).map(c => c.args)

// ─────────────────────────────────────────────────────────────────────────────

describe('resourceSession.evictLRU — LRU-вытеснение (GL)', () => {
  test('вытесняет LRU-первой, raw deleteTexture, журнал НЕ меняется', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const a = s.facade.createTexture(256, 256) // 256 KB, raw 1
    const b = s.facade.createTexture(256, 256) // 256 KB, raw 2
    const c = s.facade.createTexture(256, 256) // 256 KB, raw 3
    // Использования: B свежее всех, C не трогали после create, A — самый старый
    s.facade.bindTexture(b, 0)
    s.facade.bindTexture(a, 0) // A теперь свежее C
    const sizeBefore = j.size
    const opsBefore = JSON.stringify(j.entries())
    // Бюджет: 2 текстуры (512 KB) влезают, 3 (768 KB) — нет
    const rep = s.evictLRU({ budgetBytes: 512 * 1024 })
    // LRU = C (только create-touch) → вытеснен один
    expect(rep.textures).toEqual([c])
    expect(rep.freedBytes).toBe(256 * 256 * 4)
    expect(rep.residentBytes).toBe(512 * 1024) // A + B
    expect(rep.residentTextures).toEqual([a, b].sort((x, y) => x - y))
    // Raw deleteTexture вызван ровно для raw id C (3)
    expect(callsOf(calls, 'deleteTexture')).toEqual([[3]])
    // Журнал нетронут — ресурс жив декларацией (вытеснение ≠ уничтожение)
    expect(j.size).toBe(sizeBefore)
    expect(JSON.stringify(j.entries())).toBe(opsBefore)
    // Сессия больше не знает raw id C
    expect(s.rawId(c)).toBeUndefined()
    expect(s.rawId(a)).toBe(1)
    expect(s.rawId(b)).toBe(2)
  })

  test('bindTexture отмечает использование: сцена не вытесняется, свежая — вытесняется', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const scene = s.facade.createTexture(256, 256)
    const hidden = s.facade.createTexture(256, 256)
    // Сцена биндится КАЖДЫЙ кадр (автотач), hidden — один раз создан
    for (let frame = 0; frame < 10; frame++) s.facade.bindTexture(scene, 0)
    const rep = s.evictLRU({ budgetBytes: 256 * 256 * 4 }) // только одна влезает
    expect(rep.textures).toEqual([hidden])
    expect(rep.residentTextures).toEqual([scene])
  })

  test('pinned (рабочее множество) защищает текстуру даже без bind', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const scene = s.facade.createTexture(256, 256) // старая (никогда не биндилась)
    const fresh = s.facade.createTexture(256, 256)
    s.facade.bindTexture(fresh, 0) // свежая, но НЕ в сцене
    const rep = s.evictLRU({ budgetBytes: 256 * 256 * 4, pinned: { textureIds: [scene] } })
    // pinned неприкосновенен, несмотря на самый старый lastUse
    expect(rep.textures).toEqual([fresh])
    expect(rep.residentTextures).toEqual([scene])
  })

  test('замыкание: view и target вытесненной текстуры уходят вместе с ней', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const parent = s.facade.createTexture(64, 64, { mipLevels: 2 })
    const view = s.facade.createTextureView(parent, { baseMipLevel: 1, mipLevelCount: 1 })
    const target = s.facade.createTarget(parent, 64, 64, false, [0, 0, 0, 1])
    const other = s.facade.createTexture(64, 64)
    const rep = s.evictLRU({ budgetBytes: 64 * 64 * 4 }) // одна текстура влезает
    // LRU-порядок: parent (touch от create+view+target) vs other (create):
    // parent создан раньше → вытесняется parent вместе с view и target.
    expect(rep.textures).toEqual([parent])
    expect(rep.views).toEqual([view])
    expect(rep.targets).toEqual([target])
    // Raw-вызовы: view и target удалены ДО/вместе с текстурой
    expect(callsOf(calls, 'deleteTextureView').flat()).toContain(view - 1_000_000 + 1_000_000) // raw view id по стабильному не проверяем — ниже
    expect(s.rawId(view)).toBeUndefined()
    expect(s.rawId(target)).toBeUndefined()
    // other — резидентен
    expect(s.rawId(other)).toBeDefined()
  })

  test('ensureResident возвращает вытесненный ресурс С контентом, стабильный id тот же', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const a = s.facade.createTexture(64, 64)
    const source = src(64, 64)
    s.facade.texImage2DFromSource(a, source as never, { flipY: false })
    s.evictLRU({ budgetBytes: 0 }) // вытеснить всё
    expect(s.rawId(a)).toBeUndefined()
    const rep = s.ensureResident(a)
    expect(rep).not.toBeNull()
    expect(rep!.textureIds).toEqual([a]) // стабильный id совпадает
    expect(rep!.contentOps).toBe(1) // контент пере-залит
    expect(s.rawId(a)).toBeDefined()
    // createTexture появился ВТОРОЙ раз (новая инкарнация raw) + заливка
    expect(callsOf(calls, 'createTexture').length).toBe(2)
    expect(callsOf(calls, 'texImage2DFromSource').length).toBe(2)
  })

  test('после вытеснения deleteTexture убивает декларацию (не бросает), compact чистит пару', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const a = s.facade.createTexture(64, 64)
    s.evictLRU({ budgetBytes: 0 })
    // Явное удаление вытесненного: raw-вызова нет — только destroy-опс
    expect(() => s.facade.deleteTexture(a)).not.toThrow()
    const sizeBefore = j.size
    j.compact()
    expect(j.size).toBeLessThan(sizeBefore)
    expect(j.entries().some(op => op.kind === 'texture.create' && op.id === a)).toBe(false)
  })

  test('residencyStats: байты по размерам+mip, сортировка LRU, views/targets списком', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const flat = s.facade.createTexture(100, 100) // 40 000 байт
    const mips = s.facade.createTexture(100, 100, { mipLevels: 9 }) // ≈ ×4/3
    const view = s.facade.createTextureView(mips, { baseMipLevel: 0, mipLevelCount: 2 })
    s.facade.bindTexture(flat, 0) // flat теперь свежее
    const stats = s.residencyStats()
    expect(stats.textures.length).toBe(2)
    // LRU-порядок: mips использовался раньше flat
    expect(stats.textures[0]!.id).toBe(mips)
    expect(stats.textures[1]!.id).toBe(flat)
    expect(stats.textures[0]!.bytes).toBeGreaterThan(stats.textures[1]!.bytes)
    expect(stats.views).toEqual([view])
    expect(stats.totalBytes).toBe(stats.textures[0]!.bytes + stats.textures[1]!.bytes)
  })

  test('без бюджет-опций (по умолчанию ∞) — никого не вытесняет', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    s.facade.createTexture(256, 256)
    s.facade.createTexture(256, 256)
    const rep = s.evictLRU()
    expect(rep.textures).toEqual([])
    expect(rep.residentTextures.length).toBe(2)
  })

  test('restore(workingSet) чистит LRU-учёт мёртвой инкарнации: отложенное не «резидентно»', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const scene = s.facade.createTexture(64, 64)
    const hidden = s.facade.createTexture(64, 64)
    const source = src(64, 64)
    s.facade.texImage2DFromSource(scene, source as never, { flipY: false })
    // Потеря + soft reset: только сцена
    const rep = s.restore({ textureIds: [scene] })
    expect(rep.textureIds).toEqual([scene])
    expect(rep.deferred?.textures).toEqual([hidden])
    // Учёт честный: hidden НЕ резидентен (не претендует на память)
    const stats = s.residencyStats()
    expect(stats.textures.map(t => t.id)).toEqual([scene])
    // Вытеснять нечего: в памяти только сцена
    const ev = s.evictLRU({ budgetBytes: 0, pinned: { textureIds: [scene] } })
    expect(ev.textures).toEqual([])
  })
})

describe('resourceSession.evictLRU — LRU-вытеснение (GPU)', () => {
  test('паритет: LRU-вытеснение + журнал нетронут + ensureResident с контентом', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGPU()
    const s = createResourceSessionGPU(raw, j)
    const a = s.facade.createTexture(128, 128, 'rgba8unorm') // raw 1
    const b = s.facade.createTexture(128, 128, 'rgba8unorm') // raw 2
    const source = src(128, 128)
    s.facade.copyExternalImageToTexture(b, source as never, 0, 0, 128, 128, false)
    s.facade.bindTexture(a) // GPU bindTexture без unit: A свежее
    const sizeBefore = j.size
    const opsBefore = JSON.stringify(j.entries())
    // Бюджет под одну текстуру: LRU = B (create+copy, но bind не было после)
    const rep = s.evictLRU({ budgetBytes: 128 * 128 * 4 })
    expect(rep.textures).toEqual([b])
    expect(callsOf(calls, 'deleteTexture')).toEqual([[2]])
    expect(j.size).toBe(sizeBefore)
    expect(JSON.stringify(j.entries())).toBe(opsBefore)
    expect(s.rawId(b)).toBeUndefined()
    expect(s.rawId(a)).toBe(1)
    // Ленивый возврат с контентом
    const back = s.ensureResident(b)
    expect(back).not.toBeNull()
    expect(back!.textureIds).toEqual([b])
    expect(back!.contentOps).toBe(1)
    expect(s.rawId(b)).toBeDefined()
  })

  test('замыкание views на GPU: вытеснение текстуры убирает и view', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGPU()
    const s = createResourceSessionGPU(raw, j)
    const parent = s.facade.createTexture(64, 64, 'rgba8unorm', { mipLevels: 4 })
    const view = s.facade.createTextureView(parent, { baseMipLevel: 2, mipLevelCount: 2 })
    const rep = s.evictLRU({ budgetBytes: 0 })
    expect(rep.textures).toEqual([parent])
    expect(rep.views).toEqual([view])
    expect(s.rawId(view)).toBeUndefined()
  })

  test('bindTexture по view отмечает РОДИТЕЛЯ (view — алиас хранилища)', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGPU()
    const s = createResourceSessionGPU(raw, j)
    const t1 = s.facade.createTexture(64, 64, 'rgba8unorm', { mipLevels: 4 })
    const v1 = s.facade.createTextureView(t1, { baseMipLevel: 0, mipLevelCount: 2 })
    const t2 = s.facade.createTexture(64, 64, 'rgba8unorm')
    // Сэмплим через view t1 — это использование t1
    s.facade.bindTexture(v1)
    // Бюджет = оценка t1 (mip-chain 4 уровня ≈ 21728 байт): влезает только она
    const budget = estimateTextureBytes(64, 64, 4)
    const rep = s.evictLRU({ budgetBytes: budget })
    // t2 — LRU (после create не использовался), t1 свежее через view
    expect(rep.textures).toEqual([t2])
    expect(rep.residentTextures).toEqual([t1])
  })
})
