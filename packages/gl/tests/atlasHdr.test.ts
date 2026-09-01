// Task 70: HDR-атлас — путь атласа (pack → uploadSubImage → журнал → recovery)
// с форматом хранения rgba16float. Закрывает последний разрыв формата из
// Task 67 («атласный packing в HDR-формате — kit.createAtlas остаётся RGBA8»):
// kit-атлас формат-агностичен (Texture-носитель создаётся с format), а
// ContentRef-механика журнала не зависит от формата — эти тесты фиксируют
// контракт «одно и то же в живом режиме и при восстановлении» для атласа:
//   • текстура атласа создаётся rgba16f → texture.create.format='rgba16float';
//   • база (uploadImage) журналируется texture.write, тайлы (atlas.upload)
//     — texture.update с ContentRef на источник;
//   • restore(workingSet) пересоздаёт HDR-атлас ТЕМ ЖЕ форматом и пере-заливает
//     базу + все тайлы теми же raw-вызовами, что и живой путь;
//   • residencyStats весит атлас честно (8 б/пиксель = 2× от RGBA8);
//   • UV-регионы view() не зависят от формата.

import { describe, test, expect } from 'bun:test'
import { createResourceJournal } from '@rune/core'
import { createResourceSessionGL } from '../src/resourceSessionGL.ts'
import { createResourceSessionGPU } from '../src/resourceSessionGPU.ts'
import { createAtlas } from '@rune/kit'
import type { AtlasTexture } from '@rune/kit'
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

/** Адаптер session-фасада под контракт kit.AtlasTexture — тот же переход,
 *  что делает webgl2Renderer.makeTextureHandle (uploadSubImage →
 *  texSubImage2DFromSource) и renderer.makeGpuTextureHandle (→
 *  copyExternalImageToTexture). Атлас НЕ знает, RGBA8 он или HDR. */
function glAtlasTexture(
  session: ReturnType<typeof createResourceSessionGL>,
  textureId: number,
  w: number,
  h: number,
): AtlasTexture {
  return {
    textureId, width: w, height: h,
    uploadSubImage: (x, y, source, options) =>
      session.facade.texSubImage2DFromSource(textureId, x, y, source as GLImageSource, options),
    dispose: () => session.facade.deleteTexture(textureId),
  }
}

function gpuAtlasTexture(
  session: ReturnType<typeof createResourceSessionGPU>,
  textureId: number,
  w: number,
  h: number,
): AtlasTexture {
  return {
    textureId, width: w, height: h,
    uploadSubImage: (x, y, source) => {
      const s = source as { width: number; height: number }
      session.facade.copyExternalImageToTexture(textureId, source as GPUImageSource, x, y, s.width, s.height, false)
    },
    dispose: () => session.facade.deleteTexture(textureId),
  }
}

const TILES = [
  { id: 'grass', w: 64, h: 64 },
  { id: 'stone', w: 64, h: 64 },
  { id: 'water', w: 64, h: 64 },
  { id: 'sand', w: 64, h: 64 },
] as const

describe('Task 70 — HDR-атлас rgba16f (GL: журнал + восстановление)', () => {
  test('pack/upload журналирует texture.create.format + texture.write + texture.update ×4', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const texId = s.facade.createTexture(256, 256, { format: 'rgba16f' })

    // База атласа (uploadImage на renderer-handle → texImage2DFromSource).
    s.facade.texImage2DFromSource(texId, src(256, 256) as never, { flipY: false })

    // Атлас поверх HDR-текстуры: pack + тайлы.
    const atlas = createAtlas(glAtlasTexture(s, texId, 256, 256), { packer: { algorithm: 'maxrects', padding: 1 } })
    const slots = atlas.pack(TILES.map(t => ({ id: t.id, w: t.w, h: t.h })))
    expect(slots).not.toBeNull()
    for (const slot of slots!) {
      atlas.upload(slot, src(64, 64), { flipY: false })
    }

    const entries = j.entries()
    expect(entries.filter(o => o.kind === 'texture.create')).toEqual([
      expect.objectContaining({ id: texId, width: 256, height: 256, format: 'rgba16float' }),
    ])
    expect(entries.filter(o => o.kind === 'texture.write')).toHaveLength(1)
    expect(entries.filter(o => o.kind === 'texture.update')).toHaveLength(4)
  })

  test('restore пересоздаёт HDR-атлас тем же форматом и пере-заливает базу + все тайлы', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const texId = s.facade.createTexture(256, 256, { format: 'rgba16f' })
    s.facade.texImage2DFromSource(texId, src(256, 256) as never, { flipY: false })
    const atlas = createAtlas(glAtlasTexture(s, texId, 256, 256), { packer: { algorithm: 'maxrects', padding: 1 } })
    const slots = atlas.pack(TILES.map(t => ({ id: t.id, w: t.w, h: t.h })))!
    const liveUploads = slots.map(slot => [slot.x, slot.y] as const)
    for (const slot of slots) atlas.upload(slot, src(64, 64), { flipY: false })
    j.compact()

    // Потеря устройства → свежий фасад, soft reset только с атласом.
    const { facade: gl2, calls } = makeFakeGL()
    const s2 = createResourceSessionGL(gl2, j)
    const report = s2.restore({ textureIds: [texId] })
    expect(report.textureIds).toEqual([texId])

    // ТЕМ ЖЕ форматом (rgba16f → texStorage2D RGBA16F в realGL). Дефолтный
    // mipLevels=1 в опсах не хранится — реплей воспроизводит его дефолтом.
    const create = calls.filter(c => c.method === 'createTexture')
    expect(create).toHaveLength(1)
    expect(create[0]!.args).toEqual([256, 256, { format: 'rgba16f' }])

    // Контент: база + все тайлы — те же raw-вызовы, что и живой путь.
    expect(calls.filter(c => c.method === 'texImage2DFromSource')).toHaveLength(1)
    const updates = calls.filter(c => c.method === 'texSubImage2DFromSource')
    expect(updates).toHaveLength(4)
    const replayUploads = updates.map(c => [c.args[1], c.args[2]] as const)
    expect(replayUploads).toEqual(liveUploads)
  })

  test('residencyStats весит HDR-атлас честно (8 б/пиксель = 2× от RGBA8)', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    s.facade.createTexture(256, 256, { format: 'rgba16f' }) // 512 КБ
    expect(s.residencyStats().totalBytes).toBe(256 * 256 * 8)
  })

  test('view() атласа: UV-регионы не зависят от формата', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const texId = s.facade.createTexture(256, 256, { format: 'rgba16f' })
    const atlas = createAtlas(glAtlasTexture(s, texId, 256, 256), { packer: { algorithm: 'maxrects', padding: 1 } })
    const slots = atlas.pack([{ id: 'a', w: 128, h: 64 }])!
    const view = atlas.view('a')
    expect(view.textureId).toBe(texId)
    expect(view.width).toBe(128)
    expect(view.height).toBe(64)
    expect([...view.uvOffset]).toEqual([slots[0]!.x / 256, slots[0]!.y / 256])
    expect([...view.uvScale]).toEqual([128 / 256, 64 / 256])
  })
})

describe('Task 70 — HDR-атлас rgba16float (GPU: журнал + восстановление)', () => {
  test('pack/upload → журнал с форматом; restore переигрывает create + copyExternalImageToTexture ×5', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGPU()
    const s = createResourceSessionGPU(facade, j)
    const texId = s.facade.createTexture(256, 256, 'rgba16float')

    // База: полная загрузка → texture.write.
    s.facade.copyExternalImageToTexture(texId, src(256, 256) as never, 0, 0, 256, 256, false)
    // Атлас: sub-region загрузки → texture.update ×4.
    const atlas = createAtlas(gpuAtlasTexture(s, texId, 256, 256), { packer: { algorithm: 'maxrects', padding: 1 } })
    const slots = atlas.pack(TILES.map(t => ({ id: t.id, w: t.w, h: t.h })))!
    const liveRects = slots.map(slot => [slot.x, slot.y, 64, 64] as const)
    for (const slot of slots) atlas.upload(slot, src(64, 64))
    j.compact()

    const entries = j.entries()
    expect(entries.filter(o => o.kind === 'texture.create')).toEqual([
      expect.objectContaining({ id: texId, format: 'rgba16float' }),
    ])
    expect(entries.filter(o => o.kind === 'texture.write')).toHaveLength(1)
    expect(entries.filter(o => o.kind === 'texture.update')).toHaveLength(4)

    // Потеря устройства → свежий фасад.
    const { facade: gpu2, calls } = makeFakeGPU()
    const s2 = createResourceSessionGPU(gpu2, j)
    const report = s2.restore({ textureIds: [texId] })
    expect(report.textureIds).toEqual([texId])

    const create = calls.filter(c => c.method === 'createTexture')
    // options не записаны в опс (дефолты) → реплей вызывает без них.
    expect(create[0]!.args).toEqual([256, 256, 'rgba16float', undefined])

    // База + тайлы пере-литы теми же прямоугольниками.
    const copies = calls.filter(c => c.method === 'copyExternalImageToTexture')
    expect(copies).toHaveLength(5)
    expect(copies[0]!.args.slice(2, 6)).toEqual([0, 0, 256, 256])
    const replayRects = copies.slice(1).map(c => c.args.slice(2, 6) as unknown as readonly number[])
    expect(replayRects).toEqual(liveRects)

    // HDR-вес атласа в residency (8 б/пиксель).
    expect(s2.residencyStats().totalBytes).toBe(256 * 256 * 8)
  })
})
