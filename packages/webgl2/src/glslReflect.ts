// GLSL reflection: attributes (location) and uniforms (name → type) from sources.

export interface AttributeInfo {
  readonly name: string
  readonly location: number
  readonly size: number
}

export interface UniformInfo {
  readonly name: string
  readonly type: UniformGlType
  readonly size: number
}

export type UniformGlType = 'mat4' | 'vec4' | 'vec3' | 'vec2' | 'float' | 'int' | 'sampler2D'

export interface GlslReflection {
  readonly uniforms: readonly UniformInfo[]
  readonly attributes: readonly AttributeInfo[]
  readonly samplers: readonly string[]
}

const SIZE: Record<UniformGlType, number> = {
  mat4: 16,
  vec4: 4,
  vec3: 3,
  vec2: 2,
  float: 1,
  int: 1,
  sampler2D: 1,
}

export function reflectGlsl(vertex: string, fragment: string): GlslReflection {
  return {
    uniforms: [...scanUniforms(vertex), ...scanUniforms(fragment)],
    attributes: [...scanAttributes(vertex)].sort(byLocation),
    samplers: [...scanUniforms(vertex), ...scanUniforms(fragment)]
      .filter(u => u.type === 'sampler2D')
      .map(u => u.name),
  }
}

function scanUniforms(source: string): UniformInfo[] {
  const found: UniformInfo[] = []
  const re = /uniform\s+(mat4|vec4|vec3|vec2|float|int|sampler2D)\s+(\w+)\s*;/g
  for (const match of source.matchAll(re)) {
    const type = match[1] as UniformGlType
    found.push({ name: match[2], type, size: SIZE[type] })
  }
  return found
}

function scanAttributes(source: string): AttributeInfo[] {
  const found: AttributeInfo[] = []
  const re = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(vec4|vec3|vec2|float)\s+(\w+)\s*;/g
  for (const match of source.matchAll(re)) {
    found.push({ name: match[3], location: Number(match[1]), size: vecSize(match[2]) })
  }
  return found
}

function vecSize(type: string): number {
  if (type === 'vec4') return 4
  if (type === 'vec3') return 3
  if (type === 'vec2') return 2
  return 1
}

function byLocation(a: AttributeInfo, b: AttributeInfo): number {
  return a.location - b.location
}
