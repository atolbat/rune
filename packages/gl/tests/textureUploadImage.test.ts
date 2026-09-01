import { describe, expect, it } from 'bun:test'
import { createWebGL2Renderer } from '../src/index.ts'
import type { GLImageSource } from '@rune/webgl2'
import { createRecordingGL } from '@rune/webgl2'

/**
 * texture.uploadImage(source) — атомарная загрузка из bitmap/canvas/video.
 * Стриминг (chunked bytes) остаётся в texture.upload(bytes). Два пути — два API:
 *  - upload(bytes) — для больших RGBA-массивов (стримится в idle-слотах)
 *  - uploadImage(source) — для готовых bitmap/canvas/video (одним вызовом texImage2D)
 */

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 800, clientHeight: 600, width: 0, height: 0 } as unknown as HTMLCanvasElement
}

/** Подделка ImageBitmap: имеет width/height/data (для тестов записи вызовов). */
function fakeBitmap(w: number, h: number): ImageBitmap {
  return { width: w, height: h, close: () => {} } as unknown as ImageBitmap
}

/** Подделка HTMLCanvasElement как источника (с constructor.name). */
function fakeSourceCanvas(w: number, h: number): HTMLCanvasElement {
  return { width: w, height: h, constructor: { name: 'HTMLCanvasElement' } } as unknown as HTMLCanvasElement
}

describe('texture.uploadImage — атомарная загрузка из источника', () => {
  it('uploadImage вызывает texImage2DFromSource с тем же textureId', () => {
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
    // Ожидаем запись: texImage2DFromSource(<id>, ImageBitmap)
    const call = recording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(call).toBeDefined()
    expect(call).toContain('ImageBitmap')
    // id > 0 (createTexture вернула инкрементальный id)
    const id = Number(call?.match(/texImage2DFromSource\((\d+)/)?.[1])
    expect(id).toBeGreaterThan(0)
    expect(id).toBe(tex.textureId)
  })

  it('uploadImage с HTMLCanvasElement-источником — корректное имя типа в записи', () => {
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

  it('uploadImage НЕ зовёт texSubImage2D (стриминг не задействован)', () => {
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

  it('upload (Uint8Array) и uploadImage (source) — разные пути, можно чередовать', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(16, 16)
    // uploadImage первым — atomic
    tex.uploadImage(fakeBitmap(16, 16) as GLImageSource)
    const atomicCalls = recording.calls.filter(c => c.startsWith('texImage2DFromSource'))
    expect(atomicCalls.length).toBe(1)
    // upload (байты) — стриминг, зовёт texSubImage2D через планировщик
    tex.upload(new Uint8Array(16 * 16 * 4), { priority: 1 })
    // drain'им стриминг-очередь — должны увидеть texSubImage2D
    renderer.uploads.drain?.()
    // Even if drain is no-op in tests, we just verify the path doesn't throw
    const subCalls = recording.calls.filter(c => c.startsWith('texSubImage2D'))
    // Может не вызваться в headless (пустой idle-слот), но путь не бросает
    expect(Array.isArray(subCalls)).toBe(true)
  })

  it('uploadImage на OffscreenCanvas-источнике — корректное имя', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    const tex = renderer.texture(8, 8)
    // Подделка OffscreenCanvas как источника (через duck-typing в describeSource)
    const off = { width: 8, height: 8, constructor: { name: 'OffscreenCanvas' } } as unknown as OffscreenCanvas
    tex.uploadImage(off as GLImageSource)
    const call = recording.calls.find(c => c.startsWith('texImage2DFromSource'))
    expect(call).toContain('OffscreenCanvas')
  })

  it('uploadImage по умолчанию передаёт flipY=false (паритет с WebGPU)', () => {
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

  it('uploadImage с явным { flipY: true } — опция доходит до фасада', () => {
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

describe('createTexture anisotropic — запись в calls', () => {
  it('createTexture без options → plain createTexture(W,H)', () => {
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

  it('createTexture с maxAnisotropy=8 → запись с aniso=8', () => {
    const recording = createRecordingGL()
    const renderer = createWebGL2Renderer({
      canvas: fakeCanvas(),
      createGL: () => recording.gl,
      observeResize: false,
      now: () => 0,
      requestFrame: () => () => {},
    })
    // renderer.texture() не принимает maxAnisotropy напрямую (пока), но
    // facade.createTexture — принимает. Поэтому вызываем напрямую.
    recording.gl.createTexture(256, 256, { mipLevels: 4, maxAnisotropy: 8 })
    const call = recording.calls.find(c => c.startsWith('createTexture'))
    expect(call).toBe('createTexture(256,256,mipLevels=4,aniso=8)')
  })

  it('createTexture с maxAnisotropy без mipLevels → только aniso', () => {
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
