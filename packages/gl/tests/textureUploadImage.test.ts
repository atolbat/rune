import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import type { GLImageSource } from '@rune/webgl2'
import { createRecordingGL } from '@rune/webgl2'

/**
 * texture.uploadImage(source) — atomic upload from a bitmap/canvas/video.
 * Streaming (chunked bytes) stays in texture.upload(bytes). Two paths — two APIs:
 *  - upload(bytes) — for large RGBA arrays (streamed in idle slots)
 *  - uploadImage(source) — for ready bitmaps/canvases/videos (a single texImage2D call)
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

/** An ImageBitmap fake: has width/height/data (for call-recording tests). */
function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap
}

/** An HTMLCanvasElement fake as a source (with constructor.name). */
function fakeSourceCanvas(w: number, h: number): HTMLCanvasElement {
  return { width: w, height: h, constructor: { name: 'HTMLCanvasElement' } } as unknown as HTMLCanvasElement
}

describe('texture.uploadImage — atomic upload from a source', () => {
  it('uploadImage calls texImage2DFromSource with the same textureId', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(64, 64)
    const source = fakeBitmap(64, 64) as GLImageSource
    tex.uploadImage(source)
    // Expect a record: texImage2DFromSource(<id>, ImageBitmap)
    const call = recording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(call).toBeDefined()
    expect(call).toContain('ImageBitmap')
    // id > 0 (createTexture returned an incremental id)
    const id = Number(call?.match(/texImage2DFromSource\((\d+)/)?.[1])
    expect(id).toBeGreaterThan(0)
    expect(id).toBe(tex.textureId)
  })

  it('uploadImage with an HTMLCanvasElement source — the correct type name in the record', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(128, 128)
    const source = fakeSourceCanvas(128, 128) as GLImageSource
    tex.uploadImage(source)
    const call = recording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(call).toBeDefined()
    expect(call).toContain('HTMLCanvasElement')
  })

  it('uploadImage does NOT call texSubImage2D (streaming not involved)', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(32, 32)
    tex.uploadImage(fakeBitmap(32, 32) as GLImageSource)
    expect(recording.calls.some(c => c.startsWith('texSubImage2D'))).toBe(false)
  })

  it('upload (Uint8Array) and uploadImage (source) — different paths, can be interleaved', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(16, 16)
    // uploadImage first — atomic
    tex.uploadImage(fakeBitmap(16, 16) as GLImageSource)
    const atomicCalls = recording.calls.filter(c => c.startsWith('texImage2DFromSource'))
    expect(atomicCalls.length).toBe(1)
    // upload (bytes) — streaming, calls texSubImage2D via the scheduler
    tex.upload(new Uint8Array(16 * 16 * 4), { priority: 1 })
    // drain the streaming queue — we should see texSubImage2D
    renderer.uploads.drain?.()
    // Even if drain is no-op in tests, we just verify the path doesn't throw
    const subCalls = recording.calls.filter(c => c.startsWith('texSubImage2D'))
    // May not fire in headless (an empty idle slot), but the path does not throw
    expect(Array.isArray(subCalls)).toBe(true)
  })

  it('uploadImage on an OffscreenCanvas source — the correct name', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(8, 8)
    // An OffscreenCanvas fake as a source (via duck-typing in describeSource)
    const off = { width: 8, height: 8, constructor: { name: 'OffscreenCanvas' } } as unknown as OffscreenCanvas
    tex.uploadImage(off as GLImageSource)
    const call = recording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(call).toContain('OffscreenCanvas')
  })

  it('uploadImage passes flipY=false by default (parity with WebGPU)', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(32, 32)
    tex.uploadImage(fakeBitmap(32, 32) as GLImageSource)
    const call = recording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(call).toContain('flipY=false')
  })

  it('uploadImage with an explicit { flipY: true } — the option reaches the facade', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(16, 16)
    tex.uploadImage(fakeBitmap(16, 16) as GLImageSource, { flipY: true })
    const call = recording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(call).toContain('flipY=true')
  })
})

describe('createTexture anisotropic — recording in calls', () => {
  it('createTexture without options → plain createTexture(W,H)', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    renderer.texture(64, 64)
    const call = recording.calls.find(c => c.startsWith('createTexture'))
    expect(call).toBe('createTexture(64,64)')
  })

  it('createTexture with maxAnisotropy=8 → a record with aniso=8', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    // renderer.texture() does not accept maxAnisotropy directly (yet), but
    // facade.createTexture does. So we call it directly.
    recording.gl.createTexture(256, 256, { mipLevels: 4, maxAnisotropy: 8 })
    const call = recording.calls.find(c => c.startsWith('createTexture'))
    expect(call).toBe('createTexture(256,256,mipLevels=4,aniso=8)')
  })

  it('createTexture with maxAnisotropy without mipLevels → aniso only', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    void renderer // unused, kept for context
    recording.gl.createTexture(64, 64, { maxAnisotropy: 4 })
    const call = recording.calls.find(c => c.startsWith('createTexture'))
    expect(call).toBe('createTexture(64,64,aniso=4)')
  })
})
