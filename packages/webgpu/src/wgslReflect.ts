// WGSL reflection: uniforms from the group-0 struct, vertex attributes, textures.

export interface WgslUniformInfo {
  readonly name: string
  /** Offset in bytes within the struct (std140-like layout). */
  readonly offset: number
  readonly size: number
  /** The field's original WGSL type (binding diagnostics). */
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
  /** The DECLARED @binding(N) of the group-1 resource. -1 — the declaration
   *  carried no @binding attribute (invalid WGSL anyway — the callers fall
   *  back to the legacy sequential layout). Task 126: the materials reserve
   *  tex@1, nrm@2, mat@3, mr@4, depth@5 — a sequential 1..N layout breaks
   *  any material whose set is not a prefix (SOFT_PARTICLES: 1 + 5). */
  readonly binding: number
}

export interface WgslReflection {
  readonly uniforms: readonly WgslUniformInfo[]
  readonly attributes: readonly WgslAttributeInfo[]
  readonly textures: readonly WgslTextureInfo[]
  readonly uniformBytes: number
}

/** std140 alignment of WGSL types (simplified: mat4/vec4/vec3/vec2/f32 + arrays). */
function alignOf(type: string): number {
  const arr = arrayOf(type)
  // An array is aligned like its element (std140).
  return alignOfBase(arr !== null ? arr.elem : type)
}

function alignOfBase(type: string): number {
  if (type.startsWith('mat4x4')) return 16
  if (type.startsWith('vec4')) return 16
  if (type.startsWith('vec3')) return 16
  if (type.startsWith('vec2')) return 8
  return 4
}

function sizeOf(type: string): number {
  const arr = arrayOf(type)
  if (arr !== null) {
    // std140 array stride: roundUp(elementSize, elementAlignment)
    const elemSize = sizeOfBase(arr.elem)
    const stride = Math.ceil(elemSize / alignOfBase(arr.elem)) * alignOfBase(arr.elem)
    return stride * arr.count
  }
  return sizeOfBase(type)
}

function sizeOfBase(type: string): number {
  if (type.startsWith('mat4x4')) return 64
  if (type.startsWith('vec4')) return 16
  if (type.startsWith('vec3')) return 12
  if (type.startsWith('vec2')) return 8
  return 4
}

/** `array<mat4x4<f32>, 67>` → { elem: 'mat4x4<f32>', count: 67 }; null — not an array. */
function arrayOf(type: string): { elem: string; count: number } | null {
  const match = /^array\s*<\s*(mat4x4|vec4|vec3|vec2|f32)\s*(?:<\s*f32\s*>)?\s*,\s*(\d+)\s*>$/.exec(type.trim())
  if (match === null) return null
  return { elem: match[1] === 'f32' ? 'f32' : `${match[1]}<f32>`, count: Number(match[2]) }
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
  // var<uniform> params : Params; → find struct Params { ... }
  const varMatch = /@group\(0\)\s*@binding\(0\)\s*var<uniform>\s+(\w+)\s*:\s*(\w+)/.exec(wgsl)
  if (varMatch === null) return []
  const structName = varMatch[2]
  const structRe = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`)
  const structMatch = structRe.exec(wgsl)
  if (structMatch === null) return []
  const fields: WgslUniformInfo[] = []
  let cursor = 0
  for (const raw of splitStructFields(structMatch[1])) {
    // `name : type` — the type may be `array<mat4x4<f32>, 67>` (contains
    // commas/spaces, splitStructFields keeps it intact).
    const normalized = raw.trim().replace(/\s+/g, ' ')
    const field = /^(\w+)\s*:\s*(.+)$/.exec(normalized)
    if (field === null) continue
    const type = field[2].trim().replace(/,\s*$/, '')
    cursor = align(cursor, alignOf(type))
    fields.push({ name: field[1], offset: cursor, size: sizeOf(type), type })
    cursor += sizeOf(type)
  }
  return fields
}

/** Struct body → field strings, split on TOP-LEVEL commas only (<> depth 0).
 *  A naive `body.split(',')` would cut `array<mat4x4<f32>, 67>` in half. */
function splitStructFields(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '<') depth++
    else if (ch === '>') depth--
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim() !== '') out.push(current)
  return out
}

function scanAttributes(wgsl: string): WgslAttributeInfo[] {
  const found: WgslAttributeInfo[] = []
  // Only the vertex entry point's parameters: VSOut outputs are not counted.
  // The parameter parenthesis closes before '->' (the @location parens are not counted)
  const vertexFn = /@vertex\s+fn\s+\w+\s*\(([\s\S]*?)\)\s*->/.exec(wgsl)
  if (vertexFn === null) return []
  // M5 (Task 73): a scalar f32 is also an attribute (feed fields like radius: float32).
  const re = /@location\((\d+)\)\s*(\w+)\s*:\s*(?:(vec2|vec3|vec4)<f32>|f32)/g
  for (const match of vertexFn[1].matchAll(re)) {
    const size = match[3] === undefined ? 1 : vecSize(match[3])
    found.push({ name: match[2], location: Number(match[1]), size })
  }
  return found
}

function scanTextures(wgsl: string): WgslTextureInfo[] {
  const found: WgslTextureInfo[] = []
  for (const match of wgsl.matchAll(/@group\(1\)[^\n;]*var\s+(\w+)\s*:\s*(texture_2d<f32>|sampler)/g)) {
    // The DECLARED @binding(N), extracted from the same declaration segment
    // (the attribute order inside one var statement is free in WGSL).
    const bMatch = /@binding\((\d+)\)/.exec(match[0])
    found.push({
      name: match[1],
      kind: match[2] === 'sampler' ? 'sampler' : 'texture_2d',
      binding: bMatch !== null ? Number(bMatch[1]) : -1,
    })
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
