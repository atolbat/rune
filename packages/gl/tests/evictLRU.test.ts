import { describe, test, expect } from 'bun:test'
import { createResourceJournal, estimateTextureBytes } from '@rune/core'
import { createResourceSessionGL } from '../src/resourceSessionGL.ts'
import { createResourceSessionGPU } from '../src/resourceSessionGPU.ts'
import type { GLFacade, GLImageSource } from '@rune/webgl2'
import type { GPUFacade, GPUImageSource } from '@rune/webgpu'

/** Fake source (ImageBitmap-like). */
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

/** Raw facade calls of the given method. */
const callsOf = (calls: GLCall[], method: string): unknown[][] =>
  calls.filter(c => c.method === method).map(c => c.args)

// ─────────────────────────────────────────────────────────────────────────────

describe('resourceSession.evictLRU — LRU eviction (GL)', () => {
  test('evicts the LRU-first one, raw deleteTexture, the journal is NOT changed', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const a = s.facade.createTexture(256, 256) // 256 KB, raw 1
    const b = s.facade.createTexture(256, 256) // 256 KB, raw 2
    const c = s.facade.createTexture(256, 256) // 256 KB, raw 3
    // Usage: B is the freshest, C was not touched after create, A is the oldest
    s.facade.bindTexture(b, 0)
    s.facade.bindTexture(a, 0) // A is now fresher than C
    const sizeBefore = j.size
    const opsBefore = JSON.stringify(j.entries())
    // Budget: 2 textures (512 KB) fit, 3 (768 KB) do not
    const rep = s.evictLRU({ budgetBytes: 512 * 1024 })
    // LRU = C (create-touch only) → one evicted
    expect(rep.textures).toEqual([c])
    expect(rep.freedBytes).toBe(256 * 256 * 4)
    expect(rep.residentBytes).toBe(512 * 1024) // A + B
    expect(rep.residentTextures).toEqual([a, b].sort((x, y) => x - y))
    // Raw deleteTexture called exactly for raw id C (3)
    expect(callsOf(calls, 'deleteTexture')).toEqual([[3]])
    // The journal is untouched — the resource lives via its declaration (eviction ≠ destruction)
    expect(j.size).toBe(sizeBefore)
    expect(JSON.stringify(j.entries())).toBe(opsBefore)
    // The session no longer knows raw id C
    expect(s.rawId(c)).toBeUndefined()
    expect(s.rawId(a)).toBe(1)
    expect(s.rawId(b)).toBe(2)
  })

  test('bindTexture marks usage: the scene is not evicted, the fresh one is', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const scene = s.facade.createTexture(256, 256)
    const hidden = s.facade.createTexture(256, 256)
    // The scene is bound EVERY frame (auto-touch), hidden was created once
    for (let frame = 0; frame < 10; frame++) s.facade.bindTexture(scene, 0)
    const rep = s.evictLRU({ budgetBytes: 256 * 256 * 4 }) // only one fits
    expect(rep.textures).toEqual([hidden])
    expect(rep.residentTextures).toEqual([scene])
  })

  test('pinned (working set) protects a texture even without bind', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const scene = s.facade.createTexture(256, 256) // old (never bound)
    const fresh = s.facade.createTexture(256, 256)
    s.facade.bindTexture(fresh, 0) // fresh, but NOT in the scene
    const rep = s.evictLRU({ budgetBytes: 256 * 256 * 4, pinned: { textureIds: [scene] } })
    // pinned is untouchable, despite the oldest lastUse
    expect(rep.textures).toEqual([fresh])
    expect(rep.residentTextures).toEqual([scene])
  })

  test('closure: the view and target of an evicted texture go with it', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const parent = s.facade.createTexture(64, 64, { mipLevels: 2 })
    const view = s.facade.createTextureView(parent, { baseMipLevel: 1, mipLevelCount: 1 })
    const target = s.facade.createTarget(parent, 64, 64, false, [0, 0, 0, 1])
    const other = s.facade.createTexture(64, 64)
    const rep = s.evictLRU({ budgetBytes: 64 * 64 * 4 }) // one texture fits
    // LRU order: parent (touch from create+view+target) vs other (create):
    // parent was created earlier → parent is evicted together with its view and target.
    expect(rep.textures).toEqual([parent])
    expect(rep.views).toEqual([view])
    expect(rep.targets).toEqual([target])
    // Raw calls: the view and target are deleted BEFORE/together with the texture
    expect(callsOf(calls, 'deleteTextureView').flat()).toContain(view - 1_000_000 + 1_000_000) // the raw view id is not checked via the stable one — see below
    expect(s.rawId(view)).toBeUndefined()
    expect(s.rawId(target)).toBeUndefined()
    // other is resident
    expect(s.rawId(other)).toBeDefined()
  })

  test('ensureResident brings back the evicted resource WITH its content, the stable id is the same', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const a = s.facade.createTexture(64, 64)
    const source = src(64, 64)
    s.facade.texImage2DFromSource(a, source as never, { flipY: false })
    s.evictLRU({ budgetBytes: 0 }) // evict everything
    expect(s.rawId(a)).toBeUndefined()
    const rep = s.ensureResident(a)
    expect(rep).not.toBeNull()
    expect(rep!.textureIds).toEqual([a]) // the stable id matches
    expect(rep!.contentOps).toBe(1) // the content is re-uploaded
    expect(s.rawId(a)).toBeDefined()
    // createTexture appeared a SECOND time (a new raw incarnation) + upload
    expect(callsOf(calls, 'createTexture').length).toBe(2)
    expect(callsOf(calls, 'texImage2DFromSource').length).toBe(2)
  })

  test('after eviction deleteTexture kills the declaration (does not throw), compact cleans the pair', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const a = s.facade.createTexture(64, 64)
    s.evictLRU({ budgetBytes: 0 })
    // Explicit deletion of the evicted one: no raw call — only a destroy op
    expect(() => s.facade.deleteTexture(a)).not.toThrow()
    const sizeBefore = j.size
    j.compact()
    expect(j.size).toBeLessThan(sizeBefore)
    expect(j.entries().some(op => op.kind === 'texture.create' && op.id === a)).toBe(false)
  })

  test('residencyStats: bytes by size+mip, LRU order, views/targets as a list', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const flat = s.facade.createTexture(100, 100) // 40 000 bytes
    const mips = s.facade.createTexture(100, 100, { mipLevels: 9 }) // ≈ ×4/3
    const view = s.facade.createTextureView(mips, { baseMipLevel: 0, mipLevelCount: 2 })
    s.facade.bindTexture(flat, 0) // flat is now fresher
    const stats = s.residencyStats()
    expect(stats.textures.length).toBe(2)
    // LRU order: mips was used earlier than flat
    expect(stats.textures[0]!.id).toBe(mips)
    expect(stats.textures[1]!.id).toBe(flat)
    expect(stats.textures[0]!.bytes).toBeGreaterThan(stats.textures[1]!.bytes)
    expect(stats.views).toEqual([view])
    expect(stats.totalBytes).toBe(stats.textures[0]!.bytes + stats.textures[1]!.bytes)
  })

  test('without budget options (default ∞) — evicts nobody', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    s.facade.createTexture(256, 256)
    s.facade.createTexture(256, 256)
    const rep = s.evictLRU()
    expect(rep.textures).toEqual([])
    expect(rep.residentTextures.length).toBe(2)
  })

  test('restore(workingSet) clears the LRU accounting of the dead incarnation: deferred is not "resident"', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGL()
    const s = createResourceSessionGL(raw, j)
    const scene = s.facade.createTexture(64, 64)
    const hidden = s.facade.createTexture(64, 64)
    const source = src(64, 64)
    s.facade.texImage2DFromSource(scene, source as never, { flipY: false })
    // Loss + soft reset: the scene only
    const rep = s.restore({ textureIds: [scene] })
    expect(rep.textureIds).toEqual([scene])
    expect(rep.deferred?.textures).toEqual([hidden])
    // Honest accounting: hidden is NOT resident (does not claim memory)
    const stats = s.residencyStats()
    expect(stats.textures.map(t => t.id)).toEqual([scene])
    // Nothing to evict: only the scene is in memory
    const ev = s.evictLRU({ budgetBytes: 0, pinned: { textureIds: [scene] } })
    expect(ev.textures).toEqual([])
  })
})

describe('resourceSession.evictLRU — LRU eviction (GPU)', () => {
  test('parity: LRU eviction + the journal untouched + ensureResident with content', () => {
    const j = createResourceJournal()
    const { facade: raw, calls } = makeFakeGPU()
    const s = createResourceSessionGPU(raw, j)
    const a = s.facade.createTexture(128, 128, 'rgba8unorm') // raw 1
    const b = s.facade.createTexture(128, 128, 'rgba8unorm') // raw 2
    const source = src(128, 128)
    s.facade.copyExternalImageToTexture(b, source as never, 0, 0, 128, 128, false)
    s.facade.bindTexture(a) // GPU bindTexture without a unit: A is fresher
    const sizeBefore = j.size
    const opsBefore = JSON.stringify(j.entries())
    // Budget for one texture: LRU = B (create+copy, but no bind afterwards)
    const rep = s.evictLRU({ budgetBytes: 128 * 128 * 4 })
    expect(rep.textures).toEqual([b])
    expect(callsOf(calls, 'deleteTexture')).toEqual([[2]])
    expect(j.size).toBe(sizeBefore)
    expect(JSON.stringify(j.entries())).toBe(opsBefore)
    expect(s.rawId(b)).toBeUndefined()
    expect(s.rawId(a)).toBe(1)
    // Lazy bring-back with content
    const back = s.ensureResident(b)
    expect(back).not.toBeNull()
    expect(back!.textureIds).toEqual([b])
    expect(back!.contentOps).toBe(1)
    expect(s.rawId(b)).toBeDefined()
  })

  test('views closure on GPU: evicting the texture removes the view too', () => {
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

  test('bindTexture on a view marks the PARENT (a view is a storage alias)', () => {
    const j = createResourceJournal()
    const { facade: raw } = makeFakeGPU()
    const s = createResourceSessionGPU(raw, j)
    const t1 = s.facade.createTexture(64, 64, 'rgba8unorm', { mipLevels: 4 })
    const v1 = s.facade.createTextureView(t1, { baseMipLevel: 0, mipLevelCount: 2 })
    const t2 = s.facade.createTexture(64, 64, 'rgba8unorm')
    // We sample through view t1 — this is a use of t1
    s.facade.bindTexture(v1)
    // Budget = the t1 estimate (a 4-level mip-chain ≈ 21728 bytes): only it fits
    const budget = estimateTextureBytes(64, 64, 4)
    const rep = s.evictLRU({ budgetBytes: budget })
    // t2 is LRU (not used after create), t1 is fresher via the view
    expect(rep.textures).toEqual([t2])
    expect(rep.residentTextures).toEqual([t1])
  })
})
