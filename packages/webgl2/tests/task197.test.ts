// Task 197: the Hi-Z common-ground contracts on WebGL2 — the r32f data
// plane (the twin of WebGPU's r32float storage tile) + the depthBits axis
// of createTarget (the parity anchor for GPU cull passes).
//
// Contract:
//  • createTexture({format:'r32f'}) — R32F (0x822E) allocation: immutable
//    texStorage2D / mutable texImage2D-null with the (RED, FLOAT) upload
//    pair (0x1903 / 0x1406). One f32 per texel — the pyramid's storage.
//  • r32f filters pin to NEAREST — a DATA format: linear filtering of R32F
//    rides OES_texture_float_linear, and a pyramid sampling its own texels
//    must not depend on an optional extension (unlike rgba32f, which
//    DEGRADES to NEAREST only when the extension is absent, r32f is
//    NEAREST even when it is present).
//  • Uploads derive (RED, FLOAT) from the storage format: texSubImage2D
//    (a Float32Array view — Uint8Array-over-float-bits would be
//    INVALID_OPERATION on strict drivers) and texSubImage2DBuffer (the
//    TF-output → pyramid-texel GPU→GPU channel).
//  • createTarget depthBits: absent → DEPTH_COMPONENT16 (the historical
//    default — every existing call site unchanged); 24 →
//    DEPTH_COMPONENT24 (WebGPU depth24plus parity); 32 →
//    DEPTH_COMPONENT32F (a FLOAT depth buffer — the attachment stores the
//    exact f32 z the fragment computes; the cull-vs-attachment
//    quantization gap disappears).
//  • recordingGL: depthBits rides the call record (`,d24` / `,d32` after
//    the depth flag); absent — the historical string, byte-identical.

import { describe, test, expect } from 'bun:test'
import { createRealGL } from '../src/realGL.ts'
import { createRecordingGL } from '../src/recordingGL.ts'

// Spec-fixed GLenums for the asserts.
const R32F = 0x822e
const RED = 0x1903
const FLOAT = 0x1406
const NEAREST = 0x2600
const NEAREST_MIPMAP_NEAREST = 0x2700
const TEXTURE_MIN_FILTER = 0x2801
const TEXTURE_MAG_FILTER = 0x2800
const DEPTH_COMPONENT16 = 33189
const DEPTH_COMPONENT24 = 33190
const DEPTH_COMPONENT32F = 36012
const FRAMEBUFFER_COMPLETE = 36053

interface Rec {
  readonly calls: string[]
  readonly storage: Array<{ levels: number; internalFormat: number; w: number; h: number }>
  readonly images: Array<{ level: number; internalFormat: number; format: number; type: number; source: unknown }>
  readonly subs: Array<{ level: number; x: number; y: number; format: number; type: number; source: unknown }>
  readonly rbs: Array<number>
}

/** Mock GL: records texture allocation/upload + renderbuffer storage.
 *  floatLinear — OES_texture_float_linear present/absent.
 *  fbComplete — the createTarget completeness verdict. */
function mockGL(floatLinear: boolean, fbComplete = true): { gl: WebGL2RenderingContext; rec: Rec } {
  const calls: string[] = []
  const storage: Rec['storage'] = []
  const images: Rec['images'] = []
  const subs: Rec['subs'] = []
  const rbs: number[] = []
  const gl = {
    TEXTURE_2D: 3553,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    CLAMP_TO_EDGE: 0x812f,
    TEXTURE_MAX_LEVEL: 0x813d,
    FRAMEBUFFER: 36009,
    FRAMEBUFFER_COMPLETE: 36053,
    COLOR_ATTACHMENT0: 36064,
    DEPTH_ATTACHMENT: 36096,
    RENDERBUFFER: 36161,
    DEPTH_COMPONENT16: 33189,
    DEPTH_COMPONENT24: 33190,
    DEPTH_COMPONENT32F: 36012,
    PIXEL_UNPACK_BUFFER: 0x88ec,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 35044,
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    createTexture: () => ({}),
    bindTexture: () => {},
    activeTexture: () => {},
    texStorage2D: (_t: number, levels: number, internalFormat: number, w: number, h: number) => {
      storage.push({ levels, internalFormat, w, h })
    },
    texImage2D: (...args: unknown[]) => {
      // Allocation overload: (t, level, ifmt, w, h, border, fmt, type, null).
      const [t, level, internalFormat, , , , format, type, source] = args as [number, number, number, number, number, number, number, number, unknown]
      images.push({ level, internalFormat, format, type, source })
      void t
    },
    texSubImage2D: (
      _t: number, level: number, x: number, y: number,
      _w: number, _h: number, format: number, type: number, source: unknown,
    ) => {
      subs.push({ level, x, y, format, type, source })
    },
    texParameteri: (_t: number, pname: number, value: number) => {
      calls.push(`texParameteri(0x${pname.toString(16)},0x${value.toString(16)})`)
    },
    texParameterf: () => {},
    getExtension: (name: string) =>
      name === 'OES_texture_float_linear' && floatLinear ? {} : null,
    getParameter: () => 4096,
    isContextLost: () => false,
    getError: () => 0,
    createFramebuffer: () => ({}),
    deleteFramebuffer: () => {},
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    createRenderbuffer: () => ({}),
    deleteRenderbuffer: () => {},
    bindRenderbuffer: () => {},
    renderbufferStorage: (_target: number, internalFormat: number) => {
      rbs.push(internalFormat)
    },
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => (fbComplete ? FRAMEBUFFER_COMPLETE : 36059),
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => {},
    pixelStorei: () => {},
    viewport: () => {},
  } as unknown as WebGL2RenderingContext
  return { gl, rec: { calls, storage, images, subs, rbs } }
}

describe('realGL Task 197: the r32f data plane', () => {
  test('immutable (mip-chain): texStorage2D with internalFormat R32F', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(480, 270, { mipLevels: 4, format: 'r32f' })
    expect(rec.storage).toHaveLength(1)
    expect(rec.storage[0]).toEqual({ levels: 4, internalFormat: R32F, w: 480, h: 270 })
  })

  test('mutable (mipLevels=1): texImage2D-null with R32F/RED/FLOAT', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    facade.createTexture(480, 270, { format: 'r32f' })
    expect(rec.images).toHaveLength(1)
    expect(rec.images[0]!.internalFormat).toBe(R32F)
    expect(rec.images[0]!.format).toBe(RED)
    expect(rec.images[0]!.type).toBe(FLOAT)
    expect(rec.images[0]!.source).toBeNull()
  })

  test('filters pin to NEAREST — even with OES_texture_float_linear present (a data format, not a color)', () => {
    for (const floatLinear of [false, true]) {
      const { gl, rec } = mockGL(floatLinear)
      const facade = createRealGL(gl)
      facade.createTexture(480, 270, { mipLevels: 2, format: 'r32f' })
      facade.createTexture(480, 270, { format: 'r32f' })
      expect(rec.calls).toContain(`texParameteri(0x${TEXTURE_MIN_FILTER.toString(16)},0x${NEAREST_MIPMAP_NEAREST.toString(16)})`)
      expect(rec.calls).toContain(`texParameteri(0x${TEXTURE_MAG_FILTER.toString(16)},0x${NEAREST.toString(16)})`)
      // The mutable path: NEAREST min too (no mip chain).
      const minFilters = rec.calls.filter(c => c.startsWith(`texParameteri(0x${TEXTURE_MIN_FILTER.toString(16)}`)).map(c => c.split(',')[1]!.replace(')', ''))
      expect(minFilters.every(v => v === `0x${NEAREST_MIPMAP_NEAREST.toString(16)}` || v === `0x${NEAREST.toString(16)}`)).toBe(true)
    }
  })

  test('texSubImage2D: (RED, FLOAT) derived from the storage format', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(8, 4, { format: 'r32f' })
    facade.texSubImage2D(tex, 0, 0, 8, 4, new Float32Array(32))
    expect(rec.subs).toHaveLength(1)
    expect(rec.subs[0]!.format).toBe(RED)
    expect(rec.subs[0]!.type).toBe(FLOAT)
  })

  test('texSubImage2DBuffer: the TF output → pyramid-texel channel rides (RED, FLOAT)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(8, 4, { format: 'r32f' })
    const buf = facade.createBuffer(new Float32Array(32), 'dynamic')
    facade.texSubImage2DBuffer(tex, 0, 0, 8, 4, buf)
    expect(rec.subs).toHaveLength(1)
    expect(rec.subs[0]!.format).toBe(RED)
    expect(rec.subs[0]!.type).toBe(FLOAT)
  })
})

describe('realGL Task 197: createTarget depthBits (the parity axis)', () => {
  test('absent — DEPTH_COMPONENT16, the historical default', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64)
    facade.createTarget(tex, 64, 64, true, [0, 0, 0, 1])
    expect(rec.rbs).toEqual([DEPTH_COMPONENT16])
  })

  test('24 — DEPTH_COMPONENT24 (WebGPU depth24plus parity)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64)
    facade.createTarget(tex, 64, 64, true, [0, 0, 0, 1], 24)
    expect(rec.rbs).toEqual([DEPTH_COMPONENT24])
  })

  test('32 — DEPTH_COMPONENT32F (a float depth buffer: the exact-f32 parity anchor)', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64)
    facade.createTarget(tex, 64, 64, true, [0, 0, 0, 1], 32)
    expect(rec.rbs).toEqual([DEPTH_COMPONENT32F])
  })

  test('depth=false — no renderbuffer at all, depthBits irrelevant', () => {
    const { gl, rec } = mockGL(false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64)
    facade.createTarget(tex, 64, 64, false, [0, 0, 0, 1], 32)
    expect(rec.rbs).toEqual([])
  })

  test('an incomplete FBO still throws loudly (the capability probe)', () => {
    const { gl } = mockGL(false, false)
    const facade = createRealGL(gl)
    const tex = facade.createTexture(64, 64, { format: 'r32f' })
    expect(() => facade.createTarget(tex, 64, 64, true, [0, 0, 0, 1], 32)).toThrow(/incomplete/)
  })
})

describe('recordingGL Task 197: the depthBits record', () => {
  test('absent — the historical string, byte-identical', () => {
    const recording = createRecordingGL()
    recording.gl.createTexture(64, 64)
    recording.gl.createTarget(1, 64, 64, true, [0, 0, 0, 1])
    expect(recording.calls).toContain('createTarget(1,64,64,depth)')
  })

  test('24/32 ride the record after the depth flag', () => {
    const recording = createRecordingGL()
    recording.gl.createTexture(64, 64)
    recording.gl.createTarget(1, 64, 64, true, [0, 0, 0, 1], 24)
    recording.gl.createTarget(1, 64, 64, true, [0, 0, 0, 1], 32)
    expect(recording.calls).toContain('createTarget(1,64,64,depth,d24)')
    expect(recording.calls).toContain('createTarget(1,64,64,depth,d32)')
  })
})
