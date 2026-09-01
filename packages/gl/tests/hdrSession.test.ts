// Task 67: HDR-форматы через сессии — журнал, восстановление, residency.
//
// Контракт «одно и то же в живом режиме и при восстановлении»:
//  • facade.createTexture({format:'rgba16f'}) → texture.create-опс несёт
//    журнальное имя 'rgba16float' (единое для обоих бэкендов);
//  • restore(workingSet)/ensureResident пересоздают текстуру С тем же
//    форматом (raw.createTexture получает options.format='rgba16f' на GL /
//    format='rgba16float' на GPU);
//  • residencyStats/evictLRU считают HDR честно: rgba16float — 8 б/пиксель,
//    rgba32float — 16 (вытеснение HDR-текстуры освобождает 2×/4×).

import { describe, test, expect } from 'bun:test'
import { createResourceJournal } from '@rune/core'
import { createResourceSessionGL } from '../src/resourceSessionGL.ts'
import { createResourceSessionGPU } from '../src/resourceSessionGPU.ts'
import type { GLFacade, GLImageSource } from '@rune/webgl2'
import type { GPUFacade, GPUImageSource } from '@rune/webgpu'

const src = (w: number, h: number): { width: number; height: number } => ({ width: w, height: h })

interface GLCall { method: string; args: unknown[] }

function makeFakeGL(): { facade: GLFacade; calls: GLCall[] } {
  const calls: GLCall[] = []
  let nextTex = 1
  const rec = (method: string, ...args: unknown[]): void => { calls.push({ method, args }) }
  const facade = {
    createProgram: () => 1,
    useProgram: () => {},
    createBuffer: () => 1,
    bindVertexBuffer: () => {},
    setUniformMatrix4: () => {}, setUniform4fv: () => {}, setUniform3fv: () => {},
    setUniform2fv: () => {}, setUniform1f: () => {}, setUniform1i: () => {},
    createTexture: (w: number, h: number, o?: unknown) => { rec('createTexture', w, h, o); return nextTex++ },
    texSubImage2D: (t: number, x: number, y: number, w: number, h: number, b: Uint8Array) => rec('texSubImage2D', t, x, y, w, h, b),
    texImage2DFromSource: (t: number, s: GLImageSource, o?: unknown) => rec('texImage2DFromSource', t, s, o),
    texSubImage2DFromSource: (t: number, x: number, y: number, s: GLImageSource, o?: unknown) => rec('texSubImage2DFromSource', t, x, y, s, o),
    texImage2DLevel: (t: number, l: number, s: GLImageSource, o?: unknown) => rec('texImage2DLevel', t, l, s, o),
    bindTexture: (t: number, u: number) => rec('bindTexture', t, u),
    createTextureView: (t: number, o?: unknown) => { rec('createTextureView', t, o); return 1_000_000 },
    setViewport: () => {}, setDepthMode: () => {}, setCull: () => {},
    clear: () => {}, drawArrays: () => {},
    createTarget: (t: number, w: number, h: number, d: boolean, c: unknown) => { rec('createTarget', t, w, h, d, c); return 1 },
    bindTarget: (t: number, c: boolean) => rec('bindTarget', t, c),
    deleteTexture: (t: number) => rec('deleteTexture', t),
    deleteTarget: (t: number) => rec('deleteTarget', t),
    deleteProgram: () => {}, deleteBuffer: () => {}, deleteTextureView: (v: number) => rec('deleteTextureView', v),
  }
  return { facade: facade as unknown as GLFacade, calls }
}

function makeFakeGPU(): { facade: GPUFacade; calls: GLCall[] } {
  const calls: GLCall[] = []
  let nextTex = 1
  const rec = (method: string, ...args: unknown[]): void => { calls.push({ method, args }) }
  const facade = {
    configure: () => {}, resize: () => {},
    createTexture: (w: number, h: number, f?: string, o?: unknown) => { rec('createTexture', w, h, f, o); return nextTex++ },
    texSubImage2D: (t: number, x: number, y: number, w: number, h: number, b: Uint8Array) => rec('texSubImage2D', t, x, y, w, h, b),
    copyExternalImageToTexture: (t: number, s: GPUImageSource, dx: number, dy: number, cw: number, ch: number, fy?: boolean) =>
      rec('copyExternalImageToTexture', t, s, dx, dy, cw, ch, fy),
    copyExternalImageToTextureMip: (t: number, l: number, s: GPUImageSource, dx: number, dy: number, cw: number, ch: number, fy?: boolean) =>
      rec('copyExternalImageToTextureMip', t, l, s, dx, dy, cw, ch, fy),
    uploadUniforms: () => {}, ensurePipeline: () => {}, usePipeline: () => {},
    bindUniforms: () => {}, bindVertexBuffer: () => {}, bindTexture: (t: number) => rec('bindTexture', t),
    beginPass: () => {}, draw: () => {}, endPass: () => {}, submit: () => {},
    createTarget: (t: number, w: number, h: number, d: boolean, c: unknown) => { rec('createTarget', t, w, h, d, c); return 1 },
    bindTarget: (t: number, c: boolean) => rec('bindTarget', t, c),
    deleteTexture: (t: number) => rec('deleteTexture', t),
    deleteTarget: (t: number) => rec('deleteTarget', t),
    createTextureView: (t: number, o?: unknown) => { rec('createTextureView', t, o); return 1_000_000 },
    deleteTextureView: (v: number) => rec('deleteTextureView', v),
    dispose: () => {}, installTimer: () => {},
    adapter: null, device: null, preferredFormat: 'bgra8unorm' as GPUTextureFormat, timer: null,
  }
  return { facade: facade as unknown as GPUFacade, calls }
}

describe('Task 67 — HDR в журнале и восстановлении (GL)', () => {
  test('createTexture({format}) пишет texture.create с журнальным именем формата', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const id = s.facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    const op = j.entries().find(o => o.kind === 'texture.create')
    expect(op).toMatchObject({ kind: 'texture.create', id, width: 64, height: 64, format: 'rgba16float' })
    expect(op!.kind === 'texture.create' && op!.options).toEqual({ mipLevels: 4 })
  })

  test('restore(workingSet) пересоздаёт HDR-текстуру тем же форматом', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const hdr = s.facade.createTexture(128, 128, { mipLevels: 3, format: 'rgba16f' })
    s.facade.texImage2DFromSource(hdr, src(128, 128) as never, { flipY: false })
    j.compact()

    // Потеря → свежий фасад, soft reset только сцены.
    const { facade: gl2, calls } = makeFakeGL()
    const s2 = createResourceSessionGL(gl2, j)
    const report = s2.restore({ textureIds: [hdr] })
    expect(report.textureIds).toEqual([hdr])
    const create = calls.filter(c => c.method === 'createTexture')
    expect(create).toHaveLength(1)
    expect(create[0]!.args).toEqual([128, 128, { mipLevels: 3, format: 'rgba16f' }])
  })

  test('ensureResident лениво возвращает отложенную rgba32f-текстуру с форматом', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const scene = s.facade.createTexture(64, 64)
    const hdr = s.facade.createTexture(64, 64, { format: 'rgba32f' })
    s.facade.texImage2DFromSource(scene, src(64, 64) as never, { flipY: false })
    j.compact()

    const { facade: gl2, calls } = makeFakeGL()
    const s2 = createResourceSessionGL(gl2, j)
    s2.restore({ textureIds: [scene] }) // hdr — deferred
    calls.length = 0
    const report = s2.ensureResident(hdr)
    expect(report).not.toBeNull()
    const create = calls.filter(c => c.method === 'createTexture')
    expect(create[0]!.args).toEqual([64, 64, { format: 'rgba32f' }])
  })
})

describe('Task 67 — HDR в журнале и восстановлении (GPU)', () => {
  test('createTexture с форматом → опс + restore передаёт формат в raw-фасад', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGPU()
    const s = createResourceSessionGPU(facade, j)
    const id = s.facade.createTexture(64, 64, 'rgba16float', { mipLevels: 2 })
    expect(j.entries().find(o => o.kind === 'texture.create')).toMatchObject({ id, format: 'rgba16float' })
    s.facade.copyExternalImageToTexture(id, src(64, 64) as never, 0, 0, 64, 64, false)
    j.compact()

    const { facade: gpu2, calls } = makeFakeGPU()
    const s2 = createResourceSessionGPU(gpu2, j)
    s2.restore({ textureIds: [id] })
    const create = calls.filter(c => c.method === 'createTexture')
    expect(create[0]!.args).toEqual([64, 64, 'rgba16float', { mipLevels: 2 }])
  })
})

describe('Task 67 — HDR в residency/evictLRU', () => {
  test('GL: rgba16float весит 8 б/пиксель, rgba32f — 16 (residencyStats)', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    s.facade.createTexture(100, 100)                       // 40 000 байт
    s.facade.createTexture(100, 100, { format: 'rgba16f' }) // 80 000 байт
    s.facade.createTexture(100, 100, { format: 'rgba32f' }) // 160 000 байт
    const stats = s.residencyStats()
    expect(stats.totalBytes).toBe(40_000 + 80_000 + 160_000)
    const byBytes = [...stats.textures].sort((a, b) => a.bytes - b.bytes).map(t => t.bytes)
    expect(byBytes).toEqual([40_000, 80_000, 160_000])
  })

  test('GPU: HDR-оценка учитывает формат', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGPU()
    const s = createResourceSessionGPU(facade, j)
    s.facade.createTexture(100, 100, 'rgba8unorm')
    s.facade.createTexture(100, 100, 'rgba16float')
    s.facade.createTexture(100, 100, 'rgba32float')
    expect(s.residencyStats().totalBytes).toBe(40_000 + 80_000 + 160_000)
  })

  test('GL: evictLRU освобождает честные 2× байта для rgba16float', () => {
    const j = createResourceJournal()
    const { facade, calls } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const scene = s.facade.createTexture(100, 100)                    // 40 KB
    const hdr = s.facade.createTexture(100, 100, { format: 'rgba16f' }) // 80 KB
    s.facade.bindTexture(scene, 0) // сцена свежее — HDR уходит LRU-первой
    const report = s.evictLRU({ budgetBytes: 40_000, pinned: { textureIds: [scene] } })
    expect(report.textures).toEqual([hdr])
    expect(report.freedBytes).toBe(80_000)
    expect(report.residentBytes).toBe(40_000)
    // raw-вызов освобождения был, журнальных опсов — нет.
    expect(calls.some(c => c.method === 'deleteTexture')).toBe(true)
    expect(j.size).toBe(2) // 2 createTexture, вытеснение не пишет опсов
  })

  test('GL: вытесненная HDR-текстура возвращается ensureResident С форматом', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const scene = s.facade.createTexture(64, 64)
    const hdr = s.facade.createTexture(64, 64, { format: 'rgba16f' })
    s.facade.bindTexture(scene, 0)
    s.evictLRU({ budgetBytes: 64 * 64 * 4, pinned: { textureIds: [scene] } })

    const report = s.ensureResident(hdr)
    expect(report).not.toBeNull()
    expect(report!.textureIds).toEqual([hdr])
  })
})
