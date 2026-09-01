import type { GLFacade, DepthFunc, CullFace, FrontFace, BlendFactor, PrimitiveKind } from './facade.ts'

/**
 * Настоящий фасад поверх WebGL2RenderingContext.
 * Компилирует шейдеры лениво, кэширует uniform locations по имени,
 * вершинные буферы — по id. Ошибки шейдеров — с логом компиляции.
 */
export function createRealGL(gl: WebGL2RenderingContext): GLFacade {
  const programs = new Map<number, WebGLProgram>()
  const locations = new Map<number, Map<string, WebGLUniformLocation | null>>()
  const buffers = new Map<number, WebGLBuffer>()
  const textures = new Map<number, WebGLTexture>()
  let nextBufferId = 1
  let activeProgram = 0

  return {
    ensureProgram: (programId, vertexSource, fragmentSource) => {
      if (programs.has(programId)) return
      programs.set(programId, compileProgram(gl, vertexSource, fragmentSource))
    },
    enableDepthTest: () => gl.enable(gl.DEPTH_TEST),
    disableDepthTest: () => gl.disable(gl.DEPTH_TEST),
    depthMask: enabled => gl.depthMask(enabled),
    depthFunc: fn => gl.depthFunc(DEPTH_FUNCS[fn]),
    enableBlend: () => gl.enable(gl.BLEND),
    disableBlend: () => gl.disable(gl.BLEND),
    blendFunc: (src, dst) => gl.blendFunc(BLEND_FACTORS[src], BLEND_FACTORS[dst]),
    enableCull: () => gl.enable(gl.CULL_FACE),
    disableCull: () => gl.disable(gl.CULL_FACE),
    cullFace: face => gl.cullFace(face === 'back' ? gl.BACK : gl.FRONT),
    frontFace: order => gl.frontFace(order === 'ccw' ? gl.CCW : gl.CW),
    useProgram: programId => {
      activeProgram = programId
      const program = requireProgram(programs, programId)
      gl.useProgram(program)
    },
    uniform1f: (name, x) => withLocation(gl, locations, programs, activeProgram, name, loc => gl.uniform1f(loc, x)),
    uniform2f: (name, x, y) => withLocation(gl, locations, programs, activeProgram, name, loc => gl.uniform2f(loc, x, y)),
    uniform3f: (name, x, y, z) => withLocation(gl, locations, programs, activeProgram, name, loc => gl.uniform3f(loc, x, y, z)),
    uniform4f: (name, x, y, z, w) => withLocation(gl, locations, programs, activeProgram, name, loc => gl.uniform4f(loc, x, y, z, w)),
    uniformMatrix4fv: (name, matrix) =>
      withLocation(gl, locations, programs, activeProgram, name, loc => gl.uniformMatrix4fv(loc, false, matrix)),
    createVertexBuffer: data => {
      const id = nextBufferId++
      buffers.set(id, uploadBuffer(gl, data))
      return id
    },
    bindAttribute: (location, bufferId, size) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, requireBuffer(buffers, bufferId))
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0)
    },
    setViewport: (width, height) => gl.viewport(0, 0, width, height),
    createTexture: (width, height) => {
      const id = nextBufferId++
      const texture = gl.createTexture()
      if (texture === null) throw new Error('rune: createTexture вернул null')
      textures.set(id, texture)
      gl.bindTexture(gl.TEXTURE_2D, texture)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return id
    },
    texSubImage2D: (textureId, x, y, width, height, bytes) => {
      gl.bindTexture(gl.TEXTURE_2D, requireTexture(textures, textureId))
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
    },
    bindTexture: (textureId, unit, samplerName) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, requireTexture(textures, textureId))
      withLocation(gl, locations, programs, activeProgram, samplerName, loc => gl.uniform1i(loc, unit))
    },
    bufferSubData: () => { throw new Error('rune: coalesced-стратегия требует UBO — не входит в MVP куба') },
    bindBufferRange: () => { throw new Error('rune: coalesced-стратегия требует UBO — не входит в MVP куба') },
    clear: (r, g, b, a, depth) => clearTargets(gl, r, g, b, a, depth),
    drawArrays: (mode, first, count, instances) =>
      instances > 1
        ? gl.drawArraysInstanced(PRIMITIVE_MODES[mode], first, count, instances)
        : gl.drawArrays(PRIMITIVE_MODES[mode], first, count),
  }
}

const DEPTH_FUNCS: Record<DepthFunc, number> = {
  never: 0x0200, less: 0x0201, equal: 0x0202, lequal: 0x0203,
  greater: 0x0204, notequal: 0x0205, gequal: 0x0206, always: 0x0207,
}

const BLEND_FACTORS: Record<BlendFactor, number> = {
  zero: 0, one: 1,
  'src-color': 0x0300, 'one-minus-src-color': 0x0301,
  'src-alpha': 0x0302, 'one-minus-src-alpha': 0x0303,
  'dst-color': 0x0306, 'one-minus-dst-color': 0x0307,
}

const PRIMITIVE_MODES: Record<PrimitiveKind, number> = {
  triangles: 0x0004, 'triangle-strip': 0x0005, lines: 0x0001, points: 0x0000,
}

function compileProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
  const program = gl.createProgram()
  if (program === null) throw new Error('rune: createProgram вернул null')
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`rune: ошибка линковки программы: ${gl.getProgramInfoLog(program)}`)
  }
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  return program
}

function compileShader(gl: WebGL2RenderingContext, kind: number, source: string): WebGLShader {
  const shader = gl.createShader(kind)
  if (shader === null) throw new Error('rune: createShader вернул null')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const stage = kind === gl.VERTEX_SHADER ? 'вершинного' : 'фрагментного'
    throw new Error(`rune: ошибка компиляции ${stage} шейдера:\n${gl.getShaderInfoLog(shader)}`)
  }
  return shader
}

function withLocation(
  gl: WebGL2RenderingContext,
  locations: Map<number, Map<string, WebGLUniformLocation | null>>,
  programs: Map<number, WebGLProgram>,
  programId: number,
  name: string,
  apply: (location: WebGLUniformLocation) => void,
): void {
  const location = resolveLocation(gl, locations, programs, programId, name)
  if (location !== null) apply(location)
}

function resolveLocation(
  gl: WebGL2RenderingContext,
  locations: Map<number, Map<string, WebGLUniformLocation | null>>,
  programs: Map<number, WebGLProgram>,
  programId: number,
  name: string,
): WebGLUniformLocation | null {
  const perProgram = locations.get(programId) ?? new Map<string, WebGLUniformLocation | null>()
  if (perProgram.size === 0) locations.set(programId, perProgram)
  if (!perProgram.has(name)) {
    perProgram.set(name, gl.getUniformLocation(requireProgram(programs, programId), name))
  }
  return perProgram.get(name) ?? null
}

function uploadBuffer(gl: WebGL2RenderingContext, data: Float32Array): WebGLBuffer {
  const buffer = gl.createBuffer()
  if (buffer === null) throw new Error('rune: createBuffer вернул null')
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  return buffer
}

function clearTargets(gl: WebGL2RenderingContext, r: number, g: number, b: number, a: number, depth: number | null): void {
  gl.clearColor(r, g, b, a)
  if (depth !== null) {
    gl.clearDepth(depth)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    return
  }
  gl.clear(gl.COLOR_BUFFER_BIT)
}

function requireProgram(programs: Map<number, WebGLProgram>, programId: number): WebGLProgram {
  const program = programs.get(programId)
  if (program === undefined) throw new Error(`rune: программа ${programId} не скомпилирована (ensureProgram не вызван)`)
  return program
}

function requireBuffer(buffers: Map<number, WebGLBuffer>, bufferId: number): WebGLBuffer {
  const buffer = buffers.get(bufferId)
  if (buffer === undefined) throw new Error(`rune: буфер ${bufferId} не создан`)
  return buffer
}

function requireTexture(textures: Map<number, WebGLTexture>, textureId: number): WebGLTexture {
  const texture = textures.get(textureId)
  if (texture === undefined) throw new Error(`rune: текстура ${textureId} не создана`)
  return texture
}
