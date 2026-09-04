// Recording facade: the same operations, but as strings — the foundation of unit tests
// for call order on the tape paths (the lessons of incidents 36/37).
// Plus a raw state surface (enableDepthTest/depthFunc/…) — it is applied by the
// state program (state/stateProgram.ts) in both execution modes.

import type { GLFacade, GLImageSource } from './facade.ts'
import type { BlendEquation, BlendFactor, CullFace, DepthFunc, FrontFace } from './gl/facade.ts'
import type { StateProgramGL } from './gl/shadow.ts'

export interface RecordingGL {
  /** GLFacade + raw state surface: the recorder implements BOTH (see the header
   *  comment) — the type reflects this so state programs are accepted without casts. */
  readonly gl: GLFacade & StateProgramGL
  readonly calls: string[]
}

export function createRecordingGL(): RecordingGL {
  const calls: string[] = []
  let nextProgram = 1
  let nextBuffer = 1
  let nextTexture = 1
  let nextTarget = 1
  let nextTextureView = 1_000_000 // disjoint namespace with textureId (<1M)
  let currentTarget = 0

  const gl: GLFacade & {
    enableDepthTest(): void
    disableDepthTest(): void
    depthMask(enabled: boolean): void
    depthFunc(fn: DepthFunc): void
    enableBlend(): void
    disableBlend(): void
    blendFunc(src: BlendFactor, dst: BlendFactor): void
    blendEquation(eq: BlendEquation): void
    enableCull(): void
    disableCull(): void
    cullFace(face: CullFace): void
    frontFace(order: FrontFace): void
  } = {
    createProgram: (vertex, fragment) => {
      calls.push(`createProgram(vs:${vertex.length},fs:${fragment.length})`)
      return nextProgram++
    },
    useProgram: id => calls.push(`useProgram(${id})`),
    createBuffer: data => {
      calls.push(`createBuffer(${data.length})`)
      return nextBuffer++
    },
    updateBuffer: (bufferId, data, byteOffset = 0) =>
      calls.push(`updateBuffer(${bufferId},${data.length},${byteOffset})`),
    bindVertexBuffer: (bufferId, location, size, stride, byteOffset, divisor) => {
      // M5: feed interleaving — a stride@offset suffix; tight — without it.
      // Task 75: the instance divisor — an !i suffix (only when ≠ 0 — old
      // call records in tests stay unchanged).
      const interleave = stride !== undefined || byteOffset !== undefined
        ? `,${stride ?? 0}@${byteOffset ?? 0}`
        : ''
      const inst = divisor !== undefined && divisor > 0 ? ',!i' : ''
      calls.push(`bindVertexBuffer(${bufferId},${location},${size}${interleave}${inst})`)
    },
    setUniformMatrix4: (programId, name) => calls.push(`uniformMatrix4fv(${name})`),
    setUniform4fv: (programId, name) => calls.push(`uniform4fv(${name})`),
    setUniform3fv: (programId, name) => calls.push(`uniform3fv(${name})`),
    setUniform2fv: (programId, name) => calls.push(`uniform2fv(${name})`),
    setUniform1f: (programId, name, value) => calls.push(`uniform1f(${name},${roundValue(value)})`),
    setUniform1i: (programId, name, value) => calls.push(`uniform1i(${name},${value})`),
    createTexture: (width, height, options) => {
      const mipLevels = options?.mipLevels ?? 1
      const aniso = options?.maxAnisotropy
      const parts: string[] = []
      if (mipLevels > 1) parts.push(`mipLevels=${mipLevels}`)
      if (aniso !== undefined) parts.push(`aniso=${aniso}`)
      // Task 67: the storage format into the record (rgba16f/rgba32f — HDR textures).
      if (options?.format !== undefined && options.format !== 'rgba8') parts.push(options.format)
      if (parts.length > 0) {
        calls.push(`createTexture(${width},${height},${parts.join(',')})`)
      } else {
        calls.push(`createTexture(${width},${height})`)
      }
      return nextTexture++
    },
    texSubImage2D: (textureId, x, y, width, height) => calls.push(`texSubImage2D(${textureId},${x},${y},${width},${height})`),
    texImage2DFromSource: (textureId, source, options) => {
      const kind = describeSource(source)
      // flipY into the record: defaults to false (parity with realGL.texImage2DFromSource
      // and WebGPU copyExternalImageToTexture — both write source row 0 into texture
      // row 0). Tests may explicitly look for ",flipY=false" or ",flipY=true".
      const flipY = options?.flipY ?? false
      calls.push(`texImage2DFromSource(${textureId},${kind},flipY=${flipY})`)
    },
    texSubImage2DFromSource: (textureId, x, y, source, options) => {
      const kind = describeSource(source)
      const flipY = options?.flipY ?? false
      calls.push(`texSubImage2DFromSource(${textureId},${x},${y},${kind},flipY=${flipY})`)
    },
    texImage2DLevel: (textureId, level, source, options) => {
      const kind = describeSource(source)
      const flipY = options?.flipY ?? false
      const fmtParts: string[] = []
      if (options?.internalFormat !== undefined) fmtParts.push(`ifmt=0x${options.internalFormat.toString(16)}`)
      if (options?.format !== undefined) fmtParts.push(`fmt=0x${options.format.toString(16)}`)
      if (options?.type !== undefined) fmtParts.push(`type=0x${options.type.toString(16)}`)
      const fmtSuffix = fmtParts.length > 0 ? `,${fmtParts.join(',')}` : ''
      calls.push(`texImage2DLevel(${textureId},level=${level},${kind},flipY=${flipY}${fmtSuffix})`)
    },
    bindTexture: (textureOrViewId, unit) => calls.push(`bindTexture(${textureOrViewId},${unit})`),
    createTextureView: (textureId, options) => {
      const base = options?.baseMipLevel ?? 0
      const count = options?.mipLevelCount
      // Record format: `createTextureView(texId,mip=base+count)` or
      // `createTextureView(texId)` if base=0 and count is not passed (default view).
      // Word-boundary: we use `,mip=` so as not to confuse it with other suffixes.
      const hasOpts = base !== 0 || count !== undefined
      const optSuffix = hasOpts ? `,mip=${base}${count !== undefined ? `+${count}` : ''}` : ''
      calls.push(`createTextureView(${textureId}${optSuffix})`)
      // Return a fake viewId from the sub-view range (≥1M), like realGL.
      return nextTextureView++
    },
    deleteTextureView: viewId => calls.push(`deleteTextureView(${viewId})`),
    setViewport: (width, height) => calls.push(`setViewport(${width},${height})`),
    setDepthMode: (test, write) => calls.push(`setDepthMode(${test},${write})`),
    setCull: mode => calls.push(`setCull(${mode})`),
    // Task 75: pipeline blending (null/null = off).
    setBlend: (src, dst, equation) => calls.push(`setBlend(${src ?? 'off'},${dst ?? 'off'},${equation ?? 'add'})`),
    // Raw state surface (state programs, M2 legacy + real scenarios).
    enableDepthTest: () => calls.push('enableDepthTest'),
    disableDepthTest: () => calls.push('disableDepthTest'),
    depthMask: on => calls.push(`depthMask(${on})`),
    depthFunc: fn => calls.push(`depthFunc(${fn})`),
    enableBlend: () => calls.push('enableBlend'),
    disableBlend: () => calls.push('disableBlend'),
    blendFunc: (src, dst) => calls.push(`blendFunc(${src},${dst})`),
    blendEquation: (eq) => calls.push(`blendEquation(${eq})`),
    enableCull: () => calls.push('enableCull'),
    disableCull: () => calls.push('disableCull'),
    cullFace: face => calls.push(`cullFace(${face})`),
    frontFace: order => calls.push(`frontFace(${order})`),
    clear: (color, depth) => calls.push(`clear(${color.join(',')};${depth})`),
    drawArrays: (mode, first, count, instances) => calls.push(`drawArrays(${mode},${first},${count},${instances})`),
    createTarget: (textureId, width, height, depth) => {
      calls.push(`createTarget(${textureId},${width},${height}${depth ? ',depth' : ''})`)
      return nextTarget++
    },
    bindTarget: (targetId, clear) => {
      // Task 129: the CANVAS bind always goes through (realGL re-asserts
      // the viewport there — the bottom-left-corner heal); surfaces keep
      // the skip contract (a redundant bind of the same surface is a no-op).
      if (targetId !== 0 && targetId === currentTarget && !clear) return
      currentTarget = targetId
      calls.push(`bindTarget(${targetId},${clear ? 1 : 0})`)
    },
    deleteTexture: textureId => {
      currentTarget = 0
      calls.push(`deleteTexture(${textureId})`)
    },
    deleteTarget: targetId => {
      currentTarget = 0
      calls.push(`deleteTarget(${targetId})`)
    },
    // Task 80: readback — record the call; the GPU-less recorder returns an empty
    // array (the realGL contract's shape: Uint8Array, rows top-down).
    // The targetId 0 contract (the canvas is not readable) is mirrored: throw as in realGL.
    readTargetPixels: targetId => {
      if (targetId === 0) {
        throw new Error('rune: readTargetPixels(0) — the canvas cannot be read (parity with WebGPU: the presented texture lives for one frame). Read the SURFACE instead: renderer.surface(...) → capture/passes → surface.read()')
      }
      calls.push(`readTargetPixels(${targetId})`)
      return new Uint8Array(0)
    },
    deleteProgram: programId => calls.push(`deleteProgram(${programId})`),
    deleteBuffer: bufferId => calls.push(`deleteBuffer(${bufferId})`),
  }

  return { gl, calls }
}

/** Round a value for the call string: the value went through the f32 arena
 *  (fround); a raw print gives "0.800000011920929" — we round to 3 decimals
 *  (the same trick as in the legacy recorder gl/facade.ts). */
function roundValue(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** The source type name for the call string. */
function describeSource(source: GLImageSource): string {
  // 1. instanceof checks (if the global is available in the environment)
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) return 'ImageBitmap'
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) return 'OffscreenCanvas'
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) return 'HTMLCanvasElement'
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return 'HTMLVideoElement'
  // 2. Fallback: duck-typing by the presence of characteristic methods
  if (typeof source === 'object' && source !== null) {
    if ('getContext' in source) return 'OffscreenCanvas' // or HTMLCanvasElement, but in headless tests — Offscreen
    if ('close' in source && 'width' in source) return 'ImageBitmap' // ImageBitmap has close() and width/height
  }
  // 3. Last fallback — constructor.name (for mocks with .constructor)
  return (source as { constructor: { name: string } }).constructor?.name ?? 'unknown'
}
