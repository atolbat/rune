import type { UniformType } from '../uniforms/layout.ts'

/** Uniform from WGSL: struct field name, type, block group and binding. */
export interface WgslUniformInfo {
  readonly name: string
  readonly type: UniformType
  readonly group: number
  readonly binding: number
}

/** Texture or sampler from WGSL. */
export interface WgslTextureInfo {
  readonly name: string
  readonly type: UniformType
  readonly group: number
  readonly binding: number
}

/** Vertex input attribute: name and @location. */
export interface WgslAttributeInfo {
  readonly name: string
  readonly location: number
}

/** Entry points found in the source. */
export interface WgslEntryPoints {
  readonly vertex: string | null
  readonly fragment: string | null
  readonly compute: string | null
}

/** Reflection result of a WGSL source. */
export interface WgslReflection {
  readonly uniforms: readonly WgslUniformInfo[]
  readonly textures: readonly WgslTextureInfo[]
  readonly attributes: readonly WgslAttributeInfo[]
  readonly entries: WgslEntryPoints
}

/** WGSL reflection cache: shader source is the key, parsing happens once. */
const reflectionCache = new Map<string, WgslReflection>()
const CACHE_LIMIT = 512

/** Reflects WGSL: structs, var bindings, @location inputs, entry points (with cache). */
export function reflectWgsl(source: string): WgslReflection {
  const cached = reflectionCache.get(source)
  if (cached !== undefined) return cached
  const reflection = parseWgsl(source)
  if (reflectionCache.size < CACHE_LIMIT) reflectionCache.set(source, reflection)
  return reflection
}

function parseWgsl(source: string): WgslReflection {
  const cleaned = stripComments(source)
  const structs = collectStructs(cleaned)
  const vars = collectVars(cleaned)
  return {
    uniforms: expandUniformVars(vars, structs),
    textures: collectTextures(vars),
    attributes: collectAttributes(cleaned),
    entries: collectEntries(cleaned),
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

interface StructField {
  readonly name: string
  readonly type: UniformType
}

function collectStructs(source: string): Map<string, StructField[]> {
  const structs = new Map<string, StructField[]>()
  for (const match of source.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    structs.set(match[1], parseStructFields(match[2]))
  }
  return structs
}

function parseStructFields(body: string): StructField[] {
  const fields: StructField[] = []
  for (const raw of body.split(',')) {
    const field = matchField(raw.trim())
    if (field !== null) fields.push(field)
  }
  return fields
}

function matchField(text: string): StructField | null {
  const match = /^(\w+)\s*:\s*([\w<>]+)$/.exec(text)
  if (match === null) return null
  const type = wgslTypeToAbi(match[2])
  if (type === null) return null
  return { name: match[1], type }
}

/** Maps a WGSL type name to a Uniform ABI type (null — not a uniform field). */
function wgslTypeToAbi(wgslType: string): UniformType | null {
  const mapped = WGSL_TYPE_MAP[wgslType]
  return mapped ?? null
}

const WGSL_TYPE_MAP: Record<string, UniformType> = {
  f32: 'float', i32: 'int', u32: 'uint', bool: 'bool',
  'vec2<f32>': 'vec2', 'vec3<f32>': 'vec3', 'vec4<f32>': 'vec4',
  'vec2<i32>': 'ivec2', 'vec3<i32>': 'ivec3', 'vec4<i32>': 'ivec4',
  'vec2<u32>': 'uvec2', 'vec3<u32>': 'uvec3', 'vec4<u32>': 'uvec4',
  'vec2<bool>': 'bvec2', 'vec3<bool>': 'bvec3', 'vec4<bool>': 'bvec4',
  'mat2x2<f32>': 'mat2', 'mat3x3<f32>': 'mat3', 'mat4x4<f32>': 'mat4',
  'texture_2d<f32>': 'sampler2D', 'texture_cube<f32>': 'samplerCube',
  'texture_2d_array<f32>': 'sampler2DArray', 'texture_depth_2d': 'sampler2D',
  'texture_external': 'sampler2D',
}

interface VarBinding {
  readonly name: string
  readonly type: string
  readonly group: number
  readonly binding: number
  readonly isUniform: boolean
}

function collectVars(source: string): VarBinding[] {
  const vars: VarBinding[] = []
  const pattern = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<(\w+)>)?\s+(\w+)\s*:\s*([\w<>]+)/g
  for (const match of source.matchAll(pattern)) {
    vars.push({
      group: Number(match[1]),
      binding: Number(match[2]),
      isUniform: match[3] === 'uniform',
      name: match[4],
      type: match[5],
    })
  }
  return vars
}

function expandUniformVars(vars: readonly VarBinding[], structs: Map<string, StructField[]>): WgslUniformInfo[] {
  const uniforms: WgslUniformInfo[] = []
  for (const binding of vars) {
    if (!binding.isUniform) continue
    const fields = structs.get(binding.type)
    if (fields === undefined) continue
    pushStructFields(uniforms, fields, binding)
  }
  return uniforms
}

function pushStructFields(out: WgslUniformInfo[], fields: readonly StructField[], binding: VarBinding): void {
  for (const field of fields) {
    out.push({ name: field.name, type: field.type, group: binding.group, binding: binding.binding })
  }
}

function collectTextures(vars: readonly VarBinding[]): WgslTextureInfo[] {
  const textures: WgslTextureInfo[] = []
  for (const binding of vars) {
    if (binding.isUniform) continue
    const type = wgslTypeToAbi(binding.type)
    if (type === null || !isTextureType(type)) continue
    textures.push({ name: binding.name, type, group: binding.group, binding: binding.binding })
  }
  return textures
}

function isTextureType(type: UniformType): boolean {
  return type === 'sampler2D' || type === 'samplerCube' || type === 'sampler2DArray'
}

function collectAttributes(source: string): WgslAttributeInfo[] {
  const attributes: WgslAttributeInfo[] = []
  const vertexFn = matchVertexFn(source)
  if (vertexFn === null) return attributes
  for (const param of splitParams(vertexFn)) {
    const attribute = matchLocationParam(param)
    if (attribute !== null) attributes.push(attribute)
  }
  return attributes
}

function matchVertexFn(source: string): string | null {
  // params contain parentheses in @location(n); matches lazily up to `) ->` or `) {`
  const match = /@vertex\s+fn\s+\w+\s*\(([\s\S]*?)\)\s*(?:->|\{)/.exec(source)
  return match === null ? null : match[1]
}

function splitParams(params: string): string[] {
  return params.split(',').map(part => part.trim()).filter(part => part.length > 0)
}

function matchLocationParam(param: string): WgslAttributeInfo | null {
  const match = /^@location\((\d+)\)\s+(\w+)\s*:/.exec(param)
  if (match === null) return null
  return { name: match[2], location: Number(match[1]) }
}

function collectEntries(source: string): WgslEntryPoints {
  return {
    vertex: matchEntry(source, 'vertex'),
    fragment: matchEntry(source, 'fragment'),
    compute: matchEntry(source, 'compute'),
  }
}

function matchEntry(source: string, stage: string): string | null {
  const match = new RegExp(`@${stage}[\\s\\S]{0,80}?fn\\s+(\\w+)`).exec(source)
  return match === null ? null : match[1]
}
