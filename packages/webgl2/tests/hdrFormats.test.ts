// Task 67: HDR-форматы текстур (RGBA16F/RGBA32F) в realGL.
//
// Контракт:
//  • createTexture({format:'rgba16f', mipLevels:N}) → texStorage2D c
//    internalFormat RGBA16F (0x881A); {format:'rgba32f'} → RGBA32F (0x8816).
//  • Mutable-путь (mipLevels=1) аллоцируется парой (internalFormat,
//    uploadFormat, uploadType) формата: RGBA16F+RGBA+HALF_FLOAT и т.д.
//  • Загрузки (texImage2DFromSource / texSubImage2DFromSource /
//    texImage2DLevel) БЕЗ явных GLenum выводят (format, type) из формата
//    ХРАНЕНИЯ текстуры: (RGBA, HALF_FLOAT) для rgba16f, (RGBA, FLOAT) для
//    rgba32f. Несогласованная пара (RGBA, UNSIGNED_BYTE) → молчаливый
//    GL_INVALID_OPERATION — та же ловушка, что Task 64, теперь для HDR.
//  • Фильтрация: rgba16f — LINEAR core; rgba32f без OES_texture_float_linear
//    деградирует до NEAREST (текстура остаётся complete — не чёрный кадр).

import { describe, test, expect } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'

// Спек-фиксированные GLenum для ассертов.
const RGBA8 = 0x8058
const RGBA16F = 0x881a
const RGBA32F = 0x8816
const RGBA = 0x1908
const UNSIGNED_BYTE = 0x1401
const HALF_FLOAT = 0x140b
const FLOAT = 0x1406
const NEAREST = 0x2600
const LINEAR = 0x2601
const LINEAR_MIPMAP_LINEAR = 0x2703
const NEAREST_MIPMAP_NEAREST = 0x2700
const TEXTURE_MIN_FILTER = 0x2801
const TEXTURE_MAG_FILTER = 0x2800

interface GLRecorder {
  readonly calls: string[]
  readonly storage: Array<{ levels: number; internalFormat: number; w: number; h: number }>
  readonly images: Array<{ level: number; internalFormat: number; format: number; type: number; source: unknown }>
  readonly subs: Array<{ level: number; x: number; y: number; format: number; type: number; source: unknown }>
  readonly params: Array<{ pname: number; value: number }>
}

/** Mock-GL: записывает texStorage2D/texImage2D/texSubImage2D/texParameteri.
 *  floatLinear — управляет OES_texture_float_linear (есть/нет). */
function mockGL(floatLinear: boolean): { gl: WebGL2RenderingContext; rec: GLRecorder } {
  const calls: string[] = []
  const storage: GLRecorder['storage'] = []
  const images: GLRecorder['images'] = []
  const subs: GLRecorder['subs'] = []
  const params: GLRecorder['params'] = []
  const gl = {
    TEXTURE_2D: 3553,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MAX_LEVEL: 0x813d,
    createTexture: () => ({}),
    bindTexture: () => {},
    texStorage2D: (_t: number, levels: number, internalFormat: number, w: number, h: number) => {
      calls.push(`texStorage2D(${levels},0x${internalFormat.toString(16)},${w},${h})`)
      storage.push({ levels, internalFormat, w, h })
    },
    texImage2D: (...args: unknown[]) => {
      // Две перегрузки WebGL2: (t, level, ifmt, w, h, border, fmt, type, null)
      // — аллокация; (t, level, ifmt, fmt, type, source) — загрузка источника.
      if (args.length === 6) {
        const [t, level, internalFormat, format, type, source] = args as [number, number, number, number, number, unknown]
        calls.push(`texImage2D(${level},0x${internalFormat.toString(16)},0x${format.toString(16)},0x${type.toString(16)},src)`)
        void t
        images.push({ level, internalFormat, format, type, source })
      } else {
        const [t, level, internalFormat, w, h, , format, type, source] = args as [number, number, number, number, number, number, number, number, unknown]
        calls.push(`texImage2D(${level},0x${internalFormat.toString(16)},${w},${h},0x${format.toString(16)},0x${type.toString(16)})`)
        void t
        images.push({ level, internalFormat, format, type, source })
      }
    },
    texSubImage2D: (
      _t: number, level: number, x: number, y: number,
      format: number, type: number, source: unknown,
    ) => {
      calls.push(`texSubImage2D(${level},${x},${y},0x${format.toString(16)},0x${type.toString(16)})`)
      subs.push({ level, x, y, format, type, source })
    },
    texParameteri: (_t: number, pname: number, value: number) => {
      calls.push(`texParameteri(0x${pname.toString(16)},0x${value.toString(16)})`)
      params.push({ pname, value })
    },
    texParameterf: () => {},
    getExtension: (name: string) =>
      name === 'OES_texture_float_linear' && floatLinear ? {} : null,
    getParameter: () => 1,
  } as unknown as WebGL2RenderingContext
  return { gl, rec: { calls, storage, images, subs, params } }
}

describe('realGL Task 67: HDR-форматы хранения', () => {
  test('rgba16f + mip-chain: texStorage2D с internalFormat RGBA16F', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    expect(rec.storage).toHaveLength(1)
    expect(rec.storage[0]).toEqual({ levels: 4, internalFormat: RGBA16F, w: 64, h: 64 })
  })

  test('rgba32f + mip-chain: texStorage2D с internalFormat RGBA32F', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 3, format: 'rgba32f' })
    expect(rec.storage[0]!.internalFormat).toBe(RGBA32F)
  })

  test('rgba16f mutable (mipLevels=1): texImage2D-null с RGBA16F/RGBA/HALF_FLOAT', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { format: 'rgba16f' })
    expect(rec.images).toHaveLength(1)
    expect(rec.images[0]!.internalFormat).toBe(RGBA16F)
    expect(rec.images[0]!.format).toBe(RGBA)
    expect(rec.images[0]!.type).toBe(HALF_FLOAT)
    expect(rec.images[0]!.source).toBeNull()
  })

  test('rgba32f mutable: аллокация с FLOAT-типом', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(32, 32, { format: 'rgba32f' })
    expect(rec.images[0]!.internalFormat).toBe(RGBA32F)
    expect(rec.images[0]!.type).toBe(FLOAT)
  })

  test('дефолт без формата — прежний RGBA8/UNSIGNED_BYTE (регрессия)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4 })
    expect(rec.storage[0]!.internalFormat).toBe(RGBA8)
    facade.createTexture(64, 64)
    expect(rec.images[0]!.internalFormat).toBe(RGBA8)
    expect(rec.images[0]!.type).toBe(UNSIGNED_BYTE)
  })
})

describe('realGL Task 67: авто-вывод (format, type) загрузок из формата хранения', () => {
  test('texImage2DFromSource на rgba16f mip-chain → texSubImage2D с HALF_FLOAT', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    const source = { width: 64, height: 64 }
    facade.texImage2DFromSource(tex, source as never)
    // immutable-текстура → texSubImage2D level=0 (контракт Task 64),
    // но теперь с парой (RGBA, HALF_FLOAT) — иначе молчаливый INVALID_OPERATION.
    expect(rec.subs).toHaveLength(1)
    expect(rec.subs[0]).toMatchObject({ level: 0, x: 0, y: 0, format: RGBA, type: HALF_FLOAT })
  })

  test('texSubImage2DFromSource на rgba32f → FLOAT', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { format: 'rgba32f' })
    facade.texSubImage2DFromSource(tex, 0, 0, { width: 32, height: 32 } as never)
    expect(rec.subs[0]).toMatchObject({ format: RGBA, type: FLOAT })
  })

  test('texImage2DLevel на rgba16f mip-chain → (RGBA, HALF_FLOAT) по умолчанию', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    facade.texImage2DLevel(tex, 2, { width: 16, height: 16 } as never)
    expect(rec.subs[0]).toMatchObject({ level: 2, format: RGBA, type: HALF_FLOAT })
  })

  test('texImage2DLevel: явные GLenum перекрывают авто-вывод (Task 55 совместимость)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    // RGBA16F принимает и (RGBA, FLOAT) — WebGPU-style явная передача.
    facade.texImage2DLevel(tex, 1, { width: 32, height: 32 } as never, {
      internalFormat: RGBA16F, format: RGBA, type: FLOAT,
    })
    expect(rec.subs[0]).toMatchObject({ level: 1, format: RGBA, type: FLOAT })
  })

  test('обычная RGBA8-текстура: загрузки остаются (RGBA, UNSIGNED_BYTE)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64)
    facade.texImage2DFromSource(tex, { width: 64, height: 64 } as never)
    expect(rec.images[0]).toMatchObject({ format: RGBA, type: UNSIGNED_BYTE })
  })
})

describe('realGL Task 67: фильтрация float-текстур', () => {
  test('rgba16f — LINEAR core (даже без OES_texture_float_linear)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    expect(rec.params.some(p => p.pname === TEXTURE_MIN_FILTER && p.value === LINEAR_MIPMAP_LINEAR)).toBe(true)
    expect(rec.params.some(p => p.pname === TEXTURE_MAG_FILTER && p.value === LINEAR)).toBe(true)
  })

  test('rgba32f без OES_texture_float_linear — NEAREST (complete, не чёрный)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba32f' })
    expect(rec.params.some(p => p.pname === TEXTURE_MIN_FILTER && p.value === NEAREST_MIPMAP_NEAREST)).toBe(true)
    expect(rec.params.some(p => p.pname === TEXTURE_MAG_FILTER && p.value === NEAREST)).toBe(true)
  })

  test('rgba32f с OES_texture_float_linear — LINEAR', () => {
    const { gl, rec } = mockGL(true)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba32f' })
    expect(rec.params.some(p => p.pname === TEXTURE_MIN_FILTER && p.value === LINEAR_MIPMAP_LINEAR)).toBe(true)
  })

  test('rgba32f без mip — NEAREST без расширения, LINEAR с ним', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { format: 'rgba32f' })
    expect(rec.params.some(p => p.pname === TEXTURE_MIN_FILTER && p.value === NEAREST)).toBe(true)
    const { gl: gl2, rec: rec2 } = mockGL(true)
    const facade2 = createRealGL(gl2)
    facade2.createTexture(64, 64, { format: 'rgba32f' })
    expect(rec2.params.some(p => p.pname === TEXTURE_MIN_FILTER && p.value === LINEAR)).toBe(true)
  })
})
