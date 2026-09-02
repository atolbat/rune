// Task 70: HDR atlas — the atlas path (pack → uploadSubImage → journal → recovery)
// with the rgba16float storage format. Closes the last format gap from
// Task 67 ("atlas packing in an HDR format — kit.createAtlas stays RGBA8"):
// the kit atlas is format-agnostic (the Texture carrier is created with format), and
// the journal's ContentRef mechanics do not depend on the format — these tests pin down
// the "same thing in live mode and on recovery" contract for the atlas:
//   • the atlas texture is created rgba16f → texture.create.format='rgba16float';
//   • the base (uploadImage) is journaled as texture.write, tiles (atlas.upload)
//     — texture.update with a ContentRef to the source;
//   • restore(workingSet) recreates the HDR atlas with THE SAME format and re-uploads
//     the base + all tiles with the same raw calls as the live path;
//   • residencyStats weighs the atlas honestly (8 bytes/pixel = 2× of RGBA8);
//   • UV regions of view() do not depend on the format.

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

/** Adapts the session facade to the kit.AtlasTexture contract — the same transition
 *  webgl2Renderer.makeTextureHandle makes (uploadSubImage →
 *  texSubImage2DFromSource) and renderer.makeGpuTextureHandle (→
 *  copyExternalImageToTexture). The atlas does NOT know whether it is RGBA8 or HDR. */
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

describe('Task 70 — HDR atlas rgba16f (GL: journal + recovery)', () => {
  test('pack/upload journals texture.create.format + texture.write + texture.update ×4', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    const texId = s.facade.createTexture(256, 256, { format: 'rgba16f' })

    // Atlas base (uploadImage on a renderer-handle → texImage2DFromSource).
    s.facade.texImage2DFromSource(texId, src(256, 256) as never, { flipY: false })

    // Atlas on top of an HDR texture: pack + tiles.
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

  test('restore recreates the HDR atlas with the same format and re-uploads the base + all tiles', () => {
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

    // Device loss → a fresh facade, soft reset with the atlas only.
    const { facade: gl2, calls } = makeFakeGL()
    const s2 = createResourceSessionGL(gl2, j)
    const report = s2.restore({ textureIds: [texId] })
    expect(report.textureIds).toEqual([texId])

    // With THE SAME format (rgba16f → texStorage2D RGBA16F in realGL). The default
    // mipLevels=1 is not stored in the op — replay reproduces it by default.
    const create = calls.filter(c => c.method === 'createTexture')
    expect(create).toHaveLength(1)
    expect(create[0]!.args).toEqual([256, 256, { format: 'rgba16f' }])

    // Content: base + all tiles — the same raw calls as the live path.
    expect(calls.filter(c => c.method === 'texImage2DFromSource')).toHaveLength(1)
    const updates = calls.filter(c => c.method === 'texSubImage2DFromSource')
    expect(updates).toHaveLength(4)
    const replayUploads = updates.map(c => [c.args[1], c.args[2]] as const)
    expect(replayUploads).toEqual(liveUploads)
  })

  test('residencyStats weighs the HDR atlas honestly (8 bytes/pixel = 2× of RGBA8)', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGL()
    const s = createResourceSessionGL(facade, j)
    s.facade.createTexture(256, 256, { format: 'rgba16f' }) // 512 KB
    expect(s.residencyStats().totalBytes).toBe(256 * 256 * 8)
  })

  test('atlas view(): UV regions do not depend on the format', () => {
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

describe('Task 70 — HDR atlas rgba16float (GPU: journal + recovery)', () => {
  test('pack/upload → journal with the format; restore replays create + copyExternalImageToTexture ×5', () => {
    const j = createResourceJournal()
    const { facade } = makeFakeGPU()
    const s = createResourceSessionGPU(facade, j)
    const texId = s.facade.createTexture(256, 256, 'rgba16float')

    // Base: a full upload → texture.write.
    s.facade.copyExternalImageToTexture(texId, src(256, 256) as never, 0, 0, 256, 256, false)
    // Atlas: sub-region uploads → texture.update ×4.
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

    // Device loss → a fresh facade.
    const { facade: gpu2, calls } = makeFakeGPU()
    const s2 = createResourceSessionGPU(gpu2, j)
    const report = s2.restore({ textureIds: [texId] })
    expect(report.textureIds).toEqual([texId])

    const create = calls.filter(c => c.method === 'createTexture')
    // options are not recorded in the op (defaults) → replay calls without them.
    expect(create[0]!.args).toEqual([256, 256, 'rgba16float', undefined])

    // Base + tiles are re-uploaded with the same rectangles.
    const copies = calls.filter(c => c.method === 'copyExternalImageToTexture')
    expect(copies).toHaveLength(5)
    expect(copies[0]!.args.slice(2, 6)).toEqual([0, 0, 256, 256])
    const replayRects = copies.slice(1).map(c => c.args.slice(2, 6) as unknown as readonly number[])
    expect(replayRects).toEqual(liveRects)

    // The atlas's HDR weight in residency (8 bytes/pixel).
    expect(s2.residencyStats().totalBytes).toBe(256 * 256 * 8)
  })
})
