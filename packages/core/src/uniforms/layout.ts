/** Типы юниформов GLSL/WGSL, поддерживаемые Uniform ABI (M2). */
export type UniformType =
  | 'float' | 'int' | 'uint' | 'bool'
  | 'vec2' | 'vec3' | 'vec4'
  | 'ivec2' | 'ivec3' | 'ivec4'
  | 'uvec2' | 'uvec3' | 'uvec4'
  | 'bvec2' | 'bvec3' | 'bvec4'
  | 'mat2' | 'mat3' | 'mat4'
  | 'sampler2D' | 'samplerCube' | 'sampler2DArray'

/** Правила размещения: выравнивание, размер, семейство представления. */
export interface UniformLayoutInfo {
  readonly align: number
  readonly size: number
  readonly kind: 'f32' | 'i32'
}

const IVEC2: UniformLayoutInfo = { align: 8, size: 8, kind: 'i32' }
const IVEC3: UniformLayoutInfo = { align: 16, size: 12, kind: 'i32' }
const IVEC4: UniformLayoutInfo = { align: 16, size: 16, kind: 'i32' }

const TABLE: Record<UniformType, UniformLayoutInfo> = {
  float: { align: 4, size: 4, kind: 'f32' },
  int: { align: 4, size: 4, kind: 'i32' },
  uint: { align: 4, size: 4, kind: 'i32' },
  bool: { align: 4, size: 4, kind: 'i32' },
  vec2: { align: 8, size: 8, kind: 'f32' },
  vec3: { align: 16, size: 12, kind: 'f32' },
  vec4: { align: 16, size: 16, kind: 'f32' },
  ivec2: IVEC2, ivec3: IVEC3, ivec4: IVEC4,
  uvec2: IVEC2, uvec3: IVEC3, uvec4: IVEC4,
  bvec2: IVEC2, bvec3: IVEC3, bvec4: IVEC4,
  mat2: { align: 16, size: 32, kind: 'f32' },
  mat3: { align: 16, size: 48, kind: 'f32' },
  mat4: { align: 16, size: 64, kind: 'f32' },
  sampler2D: { align: 4, size: 4, kind: 'i32' },
  samplerCube: { align: 4, size: 4, kind: 'i32' },
  sampler2DArray: { align: 4, size: 4, kind: 'i32' },
}

/** Отдаёт правила std140-размещения для типа юниформа. */
export function uniformLayout(type: UniformType): UniformLayoutInfo {
  return TABLE[type]
}

/** Округляет смещение вверх до выравнивания. */
export function alignUp(offset: number, align: number): number {
  return (offset + align - 1) & -align
}

/** Является ли тип юниформа известным ABI. */
export function isUniformType(text: string): text is UniformType {
  return text in TABLE
}
