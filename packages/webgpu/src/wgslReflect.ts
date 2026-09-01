// Рефлексия WGSL: юниформы из struct группы 0, атрибуты вершины, текстуры.

export interface WgslUniformInfo {
  readonly name: string
  /** Смещение в байтах внутри struct (std140-подобная раскладка). */
  readonly offset: number
  readonly size: number
  /** Исходный WGSL-тип поля (диагностика привязок). */
  readonly type?: string
}

export interface WgslAttributeInfo {
  readonly name: string
  readonly location: number
  readonly size: number
}

export interface WgslTextureInfo {
  readonly name: string
  readonly kind: 'texture_2d' | 'sampler'
}

export interface WgslReflection {
  readonly uniforms: readonly WgslUniformInfo[]
  readonly attributes: readonly WgslAttributeInfo[]
  readonly textures: readonly WgslTextureInfo[]
  readonly uniformBytes: number
}

/** std140-выравнивание WGSL-типов (упрощённое: mat4/vec4/vec3/vec2/f32). */
function alignOf(type: string): number {
  if (type.startsWith('mat4x4')) return 16
  if (type.startsWith('vec4')) return 16
  if (type.startsWith('vec3')) return 16
  if (type.startsWith('vec2')) return 8
  return 4
}

function sizeOf(type: string): number {
  if (type.startsWith('mat4x4')) return 64
  if (type.startsWith('vec4')) return 16
  if (type.startsWith('vec3')) return 12
  if (type.startsWith('vec2')) return 8
  return 4
}

export function reflectWgsl(wgsl: string): WgslReflection {
  return {
    uniforms: scanUniforms(wgsl),
    attributes: [...scanAttributes(wgsl)].sort(byLocation),
    textures: scanTextures(wgsl),
    uniformBytes: uniformBytes(scanUniforms(wgsl)),
  }
}

function scanUniforms(wgsl: string): WgslUniformInfo[] {
  // var<uniform> params : Params; → найти struct Params { ... }
  const varMatch = /@group\(0\)\s*@binding\(0\)\s*var<uniform>\s+(\w+)\s*:\s*(\w+)/.exec(wgsl)
  if (varMatch === null) return []
  const structName = varMatch[2]
  const structRe = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`)
  const structMatch = structRe.exec(wgsl)
  if (structMatch === null) return []
  const fields: WgslUniformInfo[] = []
  let cursor = 0
  const fieldRe = /(\w+)\s*:\s*([\w<>]+)\s*,/g
  for (const field of structMatch[1].matchAll(fieldRe)) {
    const type = field[2]
    cursor = align(cursor, alignOf(type))
    fields.push({ name: field[1], offset: cursor, size: sizeOf(type), type })
    cursor += sizeOf(type)
  }
  return fields
}

function scanAttributes(wgsl: string): WgslAttributeInfo[] {
  const found: WgslAttributeInfo[] = []
  // Только параметры вершинной точки входа: выходы VSOut не считаются.
  // Скобка параметров закрывается перед '->' (скобки @location не считаются)
  const vertexFn = /@vertex\s+fn\s+\w+\s*\(([\s\S]*?)\)\s*->/.exec(wgsl)
  if (vertexFn === null) return []
  // M5 (Task 73): скаляр f32 — тоже атрибут (feed-поля типа radius: float32).
  const re = /@location\((\d+)\)\s*(\w+)\s*:\s*(?:(vec2|vec3|vec4)<f32>|f32)/g
  for (const match of vertexFn[1].matchAll(re)) {
    const size = match[3] === undefined ? 1 : vecSize(match[3])
    found.push({ name: match[2], location: Number(match[1]), size })
  }
  return found
}

function scanTextures(wgsl: string): WgslTextureInfo[] {
  const found: WgslTextureInfo[] = []
  for (const match of wgsl.matchAll(/@group\(1\)[^\n]*var\s+(\w+)\s*:\s*(texture_2d<f32>|sampler)/g)) {
    found.push({ name: match[1], kind: match[2] === 'sampler' ? 'sampler' : 'texture_2d' })
  }
  return found
}

function uniformBytes(fields: readonly WgslUniformInfo[]): number {
  if (fields.length === 0) return 0
  const last = fields[fields.length - 1]
  return align(last.offset + last.size, 16)
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment
}

function vecSize(type: string): number {
  if (type === 'vec4') return 4
  if (type === 'vec3') return 3
  if (type === 'vec2') return 2
  return 1
}

function byLocation(a: WgslAttributeInfo, b: WgslAttributeInfo): number {
  return a.location - b.location
}
