// Task 67: HDR texture formats (RGBA16F/RGBA32F) in realGL.
//
// Contract:
//  • createTexture({format:'rgba16f', mipLevels:N}) → texStorage2D c
//    internalFormat RGBA16F (0x881A); {format:'rgba32f'} → RGBA32F (0x8814 —
//    the GL registry value; 0x8816 was a Task 67 typo that survived the
//    mock tests until the Task 132 TF tier allocated a real rgba32f).
//  • The mutable path (mipLevels=1) is allocated with the format's
//    (internalFormat, uploadFormat, uploadType) triple: RGBA16F+RGBA+HALF_FLOAT etc.
//  • Uploads (texImage2DFromSource / texSubImage2DFromSource /
//    texImage2DLevel) WITHOUT explicit GLenums derive (format, type) from the
//    texture's STORAGE format: (RGBA, HALF_FLOAT) for rgba16f, (RGBA, FLOAT) for
//    rgba32f. A mismatched pair (RGBA, UNSIGNED_BYTE) → a silent
//    GL_INVALID_OPERATION — the same trap as Task 64, now for HDR.
//  • Filtering: rgba16f — LINEAR core; rgba32f without OES_texture_float_linear
//    degrades to NEAREST (the texture stays complete — not a black frame).

import { describe, test, expect } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'

// Spec-fixed GLenums for the asserts.
const RGBA8 = 0x8058
const RGBA16F = 0x881a
const RGBA32F = 0x8814 // the GL registry value (Task 132's enum fix)
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

/** Mock GL: records texStorage2D/texImage2D/texSubImage2D/texParameteri.
 *  floatLinear — controls OES_texture_float_linear (present/absent). */
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
      // Two WebGL2 overloads: (t, level, ifmt, w, h, border, fmt, type, null)
      // — allocation; (t, level, ifmt, fmt, type, source) — source upload.
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

describe('realGL Task 67: HDR storage formats', () => {
  test('rgba16f + mip-chain: texStorage2D with internalFormat RGBA16F', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    expect(rec.storage).toHaveLength(1)
    expect(rec.storage[0]).toEqual({ levels: 4, internalFormat: RGBA16F, w: 64, h: 64 })
  })

  test('rgba32f + mip-chain: texStorage2D with internalFormat RGBA32F', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 3, format: 'rgba32f' })
    expect(rec.storage[0]!.internalFormat).toBe(RGBA32F)
  })

  test('rgba16f mutable (mipLevels=1): texImage2D-null with RGBA16F/RGBA/HALF_FLOAT', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { format: 'rgba16f' })
    expect(rec.images).toHaveLength(1)
    expect(rec.images[0]!.internalFormat).toBe(RGBA16F)
    expect(rec.images[0]!.format).toBe(RGBA)
    expect(rec.images[0]!.type).toBe(HALF_FLOAT)
    expect(rec.images[0]!.source).toBeNull()
  })

  test('rgba32f mutable: allocation with the FLOAT type', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(32, 32, { format: 'rgba32f' })
    expect(rec.images[0]!.internalFormat).toBe(RGBA32F)
    expect(rec.images[0]!.type).toBe(FLOAT)
  })

  test('default without a format — the former RGBA8/UNSIGNED_BYTE (regression)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4 })
    expect(rec.storage[0]!.internalFormat).toBe(RGBA8)
    facade.createTexture(64, 64)
    expect(rec.images[0]!.internalFormat).toBe(RGBA8)
    expect(rec.images[0]!.type).toBe(UNSIGNED_BYTE)
  })
})

describe('realGL Task 67: auto-derivation of upload (format, type) from the storage format', () => {
  test('texImage2DFromSource on an rgba16f mip-chain → texSubImage2D with HALF_FLOAT', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    const source = { width: 64, height: 64 }
    facade.texImage2DFromSource(tex, source as never)
    // an immutable texture → texSubImage2D level=0 (the Task 64 contract),
    // but now with the (RGBA, HALF_FLOAT) pair — otherwise a silent INVALID_OPERATION.
    expect(rec.subs).toHaveLength(1)
    expect(rec.subs[0]).toMatchObject({ level: 0, x: 0, y: 0, format: RGBA, type: HALF_FLOAT })
  })

  test('texSubImage2DFromSource on rgba32f → FLOAT', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { format: 'rgba32f' })
    facade.texSubImage2DFromSource(tex, 0, 0, { width: 32, height: 32 } as never)
    expect(rec.subs[0]).toMatchObject({ format: RGBA, type: FLOAT })
  })

  test('texImage2DLevel on an rgba16f mip-chain → (RGBA, HALF_FLOAT) by default', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    facade.texImage2DLevel(tex, 2, { width: 16, height: 16 } as never)
    expect(rec.subs[0]).toMatchObject({ level: 2, format: RGBA, type: HALF_FLOAT })
  })

  test('texImage2DLevel: explicit GLenums override auto-derivation (Task 55 compatibility)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    // RGBA16F also accepts (RGBA, FLOAT) — a WebGPU-style explicit pass.
    facade.texImage2DLevel(tex, 1, { width: 32, height: 32 } as never, {
      internalFormat: RGBA16F, format: RGBA, type: FLOAT,
    })
    expect(rec.subs[0]).toMatchObject({ level: 1, format: RGBA, type: FLOAT })
  })

  test('a plain RGBA8 texture: uploads stay (RGBA, UNSIGNED_BYTE)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64)
    facade.texImage2DFromSource(tex, { width: 64, height: 64 } as never)
    expect(rec.images[0]).toMatchObject({ format: RGBA, type: UNSIGNED_BYTE })
  })
})

describe('realGL Task 67: filtering of float textures', () => {
  test('rgba16f — LINEAR core (even without OES_texture_float_linear)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba16f' })
    expect(rec.params.some(p => p.pname === TEXTURE_MIN_FILTER && p.value === LINEAR_MIPMAP_LINEAR)).toBe(true)
    expect(rec.params.some(p => p.pname === TEXTURE_MAG_FILTER && p.value === LINEAR)).toBe(true)
  })

  test('rgba32f without OES_texture_float_linear — NEAREST (complete, not black)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba32f' })
    expect(rec.params.some(p => p.pname === TEXTURE_MIN_FILTER && p.value === NEAREST_MIPMAP_NEAREST)).toBe(true)
    expect(rec.params.some(p => p.pname === TEXTURE_MAG_FILTER && p.value === NEAREST)).toBe(true)
  })

  test('rgba32f with OES_texture_float_linear — LINEAR', () => {
    const { gl, rec } = mockGL(true)
    const facade = createRealGL(gl)
    facade.createTexture(64, 64, { mipLevels: 4, format: 'rgba32f' })
    expect(rec.params.some(p => p.pname === TEXTURE_MIN_FILTER && p.value === LINEAR_MIPMAP_LINEAR)).toBe(true)
  })

  test('rgba32f without mip — NEAREST without the extension, LINEAR with it', () => {
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
