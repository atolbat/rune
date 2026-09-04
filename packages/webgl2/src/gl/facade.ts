export type DepthFunc = 'never' | 'less' | 'equal' | 'lequal' | 'greater' | 'notequal' | 'gequal' | 'always'
export type CullFace = 'back' | 'front'
export type FrontFace = 'ccw' | 'cw'
export type BlendFactor =
  | 'zero' | 'one' | 'src-color' | 'one-minus-src-color'
  | 'src-alpha' | 'one-minus-src-alpha' | 'dst-color' | 'one-minus-dst-color'
  | 'dst-alpha' | 'one-minus-dst-alpha' | 'src-alpha-saturated'
/** The blend equation (the custom-blending feature): how the
 *  scaled source and destination combine. 'add' is the default (the
 *  classic transparency/additive); 'max'/'subtract' make the
 *  CustomBlending demos. WebGPU's GPUBlendOperation names map 1:1. */
export type BlendEquation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max'
export type PrimitiveKind = 'triangles' | 'triangle-strip' | 'lines' | 'points'

/**
 * The minimal set of rune GL calls (WebGL2).
 * Uniforms — by name of the active program: the facade itself caches locations.
 */
export interface GLFacade {
  /** Lazy compilation: maps a registry id to a real program. */
  ensureProgram(programId: number, vertexSource: string, fragmentSource: string): void
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
  useProgram(programId: number): void
  uniform1f(name: string, x: number): void
  uniform2f(name: string, x: number, y: number): void
  uniform3f(name: string, x: number, y: number, z: number): void
  uniform4f(name: string, x: number, y: number, z: number, w: number): void
  uniformMatrix4fv(name: string, matrix: Float32Array): void
  /** Creates a vertex buffer from data; returns an id. */
  createVertexBuffer(data: Float32Array): number
  /** Binds an attribute: buffer + vertexAttribPointer(location, size). */
  bindAttribute(location: number, bufferId: number, size: number): void
  /** Sets the viewport in backing-store pixels (resize). */
  setViewport(width: number, height: number): void
  /** Creates an empty RGBA8 texture of the given size; returns an id. */
  createTexture(width: number, height: number): number
  /** Uploads a tile into the texture (streaming). */
  texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array): void
  /** Binds a texture to a unit; the sampler uniform is set by name of the active program. */
  bindTexture(textureId: number, unit: number, samplerName: string): void
  bufferSubData(offset: number, bytes: Uint8Array): void
  bindBufferRange(offset: number, size: number): void
  clear(r: number, g: number, b: number, a: number, depth: number | null): void
  drawArrays(mode: PrimitiveKind, first: number, count: number, instances: number): void
}

/** Recorder: writes call names — exact sequences in tests. */
export function createRecordingGL(): { gl: GLFacade; calls: string[] } {
  const calls: string[] = []
  return { gl: recordEveryCall(calls), calls }
}

function recordEveryCall(calls: string[]): GLFacade {
  let nextBuffer = 0
  return {
    ensureProgram: () => {}, // compilation is preparation, not a frame
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
    useProgram: p => calls.push(`useProgram(${p})`),
    uniform1f: (name, x) => calls.push(`uniform1f(${name},${round(x)})`),
    uniform2f: (name, x, y) => calls.push(`uniform2f(${name},${round(x)},${round(y)})`),
    uniform3f: (name, x, y, z) => calls.push(`uniform3f(${name},${round(x)},${round(y)},${round(z)})`),
    uniform4f: (name, x, y, z, w) => calls.push(`uniform4f(${name},${round(x)},${round(y)},${round(z)},${round(w)})`),
    uniformMatrix4fv: (name, m) => calls.push(`uniformMatrix4fv(${name},${round(m[0])})`),
    createVertexBuffer: () => nextBuffer++,
    bindAttribute: (loc, buf, size) => calls.push(`bindAttribute(${loc},${buf},${size})`),
    setViewport: (w, h) => calls.push(`setViewport(${w},${h})`),
    createTexture: () => nextBuffer++,
    texSubImage2D: (tex, x, y, w, h, bytes) => calls.push(`texSubImage2D(${tex},${x},${y},${w},${h},${bytes.byteLength})`),
    bindTexture: (tex, unit, name) => calls.push(`bindTexture(${tex},${unit},${name})`),
    bufferSubData: (offset, bytes) => calls.push(`bufferSubData(${offset},${bytes.byteLength})`),
    bindBufferRange: (offset, size) => calls.push(`bindBufferRange(${offset},${size})`),
    clear: (r, g, b, a, depth) => calls.push(`clear(${round(r)},${round(g)},${round(b)},${round(a)},${depth === null ? 'null' : round(depth)})`),
    drawArrays: (mode, first, count, instances) => calls.push(`drawArrays(${mode},${first},${count},${instances})`),
  }
}

/** Counting facade for benchmarks: zero work, only increments. */
/**
 * Counting facade of the current generation (root facade.ts): zero work,
 * only increments. Plus the raw state surface of the legacy facade —
 * state programs (stateProgram.ts) run on top of the same counter.
 */
export function createCountingGL(): CountingGLFacade {
  let totalCalls = 0
  const bump = (): void => { totalCalls++ }
  let nextId = 0
  const alloc = (): number => nextId++
  return {
    // Current surface (root GLFacade) — the executor's path.
    createProgram: alloc,
    useProgram: bump,
    createBuffer: alloc,
    updateBuffer: bump,
    bindVertexBuffer: bump,
    setUniformMatrix4: bump, setUniform4fv: bump, setUniform3fv: bump, setUniform2fv: bump,
    setUniform1f: bump, setUniform1i: bump,
    createTexture: alloc,
    texSubImage2D: bump,
    texImage2DFromSource: bump,
    texSubImage2DFromSource: bump,
    texImage2DLevel: bump,
    bindTexture: bump,
    createTextureView: alloc,
    deleteTextureView: bump,
    setViewport: bump,
    setDepthMode: bump,
    setCull: bump,
    // Task 75: pipeline blending — the executor's state cache calls it even
    // for blend-less pipelines (first command initializes `off`).
    setBlend: bump,
    clear: bump,
    drawArrays: bump,
    createTarget: alloc,
    bindTarget: bump,
    deleteTexture: bump,
    deleteTarget: bump,
    deleteProgram: bump,
    deleteBuffer: bump,
    // Legacy state surface (state programs, M2).
    ensureProgram: () => {}, // preparation does not count as a frame
    enableDepthTest: bump, disableDepthTest: bump, depthMask: bump, depthFunc: bump,
    enableBlend: bump, disableBlend: bump, blendFunc: bump, blendEquation: bump,
    enableCull: bump, disableCull: bump, cullFace: bump, frontFace: bump,
    uniform1f: bump, uniform2f: bump, uniform3f: bump, uniform4f: bump, uniformMatrix4fv: bump,
    createVertexBuffer: alloc,
    bindAttribute: bump,
    bufferSubData: bump, bindBufferRange: bump,
    get totalCalls() { return totalCalls },
  }
}

/** Counting facade: current surface + legacy state + totalCalls. */
export interface CountingGLFacade {
  // Root GLFacade (current generation)
  createProgram(vertex: string, fragment: string): number
  useProgram(programId: number): void
  createBuffer(data: Float32Array): number
  updateBuffer(bufferId: number, data: Float32Array, byteOffset?: number): void
  bindVertexBuffer(bufferId: number, location: number, size: number, stride?: number, byteOffset?: number): void
  setUniformMatrix4(programId: number, name: string, values: Float32Array): void
  setUniform4fv(programId: number, name: string, values: Float32Array): void
  setUniform3fv(programId: number, name: string, values: Float32Array): void
  setUniform2fv(programId: number, name: string, values: Float32Array): void
  setUniform1f(programId: number, name: string, value: number): void
  setUniform1i(programId: number, name: string, value: number): void
  createTexture(width: number, height: number, options?: unknown): number
  texSubImage2D(textureId: number, x: number, y: number, width: number, height: number, bytes: Uint8Array): void
  texImage2DFromSource(textureId: number, source: unknown, options?: unknown): void
  texSubImage2DFromSource(textureId: number, x: number, y: number, source: unknown, options?: unknown): void
  texImage2DLevel(textureId: number, level: number, source: unknown, options?: unknown): void
  bindTexture(textureOrViewId: number, unit: number): void
  createTextureView(textureId: number, options?: unknown): number
  deleteTextureView(viewId: number): void
  setViewport(width: number, height: number): void
  setDepthMode(test: string, write: boolean): void
  setCull(mode: string): void
  setBlend(src: string | null, dst: string | null, equation?: string): void
  clear(color: readonly number[], depth: number | null): void
  drawArrays(mode: string, first: number, count: number, instances: number): void
  createTarget(textureId: number, width: number, height: number, depth: boolean, color?: unknown): number
  bindTarget(targetId: number, clear: boolean): void
  deleteTexture(textureId: number): void
  deleteTarget(targetId: number): void
  deleteProgram(programId: number): void
  deleteBuffer(bufferId: number): void
  // Legacy state surface
  ensureProgram(programId: number, vertexSource: string, fragmentSource: string): void
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
  uniform1f(name: string, x: number): void
  uniform2f(name: string, x: number, y: number): void
  uniform3f(name: string, x: number, y: number, z: number): void
  uniform4f(name: string, x: number, y: number, z: number, w: number): void
  uniformMatrix4fv(name: string, matrix: Float32Array): void
  createVertexBuffer(data: Float32Array): number
  bindAttribute(location: number, bufferId: number, size: number): void
  bufferSubData(offset: number, bytes: Uint8Array): void
  bindBufferRange(offset: number, size: number): void
  readonly totalCalls: number
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
