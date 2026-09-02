import { isUniformType } from '../uniforms/layout.ts'
import type { UniformType } from '../uniforms/layout.ts'

/** Uniform from reflection: name, type, array length. */
export interface UniformInfo {
  readonly name: string
  readonly type: UniformType
  readonly arrayLength: number
}

/** Vertex shader attribute: name and location (−1 — not specified in source). */
export interface AttributeInfo {
  readonly name: string
  readonly location: number
}

/** Reflection result of a GLSL 300 es source pair. */
export interface GlslReflection {
  readonly uniforms: readonly UniformInfo[]
  readonly attributes: readonly AttributeInfo[]
}

/** Reflection cache: sources repeat from command to command — parse once. */
const reflectionCache = new Map<string, GlslReflection>()
const CACHE_LIMIT = 512

/** Reflects a shader pair: uniform union + vertex attributes (with cache). */
export function reflectGlsl(vertexSource: string, fragmentSource: string): GlslReflection {
  const key = `${vertexSource}\u0000${fragmentSource}`
  const cached = reflectionCache.get(key)
  if (cached !== undefined) return cached
  const reflection = parseGlsl(vertexSource, fragmentSource)
  remember(key, reflection)
  return reflection
}

function remember(key: string, reflection: GlslReflection): void {
  if (reflectionCache.size >= CACHE_LIMIT) return
  reflectionCache.set(key, reflection)
}

function parseGlsl(vertexSource: string, fragmentSource: string): GlslReflection {
  const uniforms = new Map<string, UniformInfo>()
  collectUniforms(vertexSource, uniforms)
  collectUniforms(fragmentSource, uniforms)
  const attributes = collectAttributes(vertexSource)
  return { uniforms: [...uniforms.values()], attributes }
}

function collectUniforms(source: string, into: Map<string, UniformInfo>): void {
  const lines = stripComments(source).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isInterfaceBlock(line)) { i = skipBlock(lines, i); continue }
    const found = matchUniform(line)
    if (found !== null && !into.has(found.name)) into.set(found.name, found)
  }
}

function collectAttributes(source: string): AttributeInfo[] {
  const found: AttributeInfo[] = []
  for (const line of stripComments(source).split('\n')) {
    const attribute = matchAttribute(line)
    if (attribute !== null) found.push(attribute)
  }
  return found
}

function isInterfaceBlock(line: string): boolean {
  return /^\s*uniform\s+\w+\s*\{/.test(line)
}

function skipBlock(lines: string[], start: number): number {
  let i = start
  while (i < lines.length && !/\}\s*(\w+\s*)?;/.test(lines[i])) i++
  return i
}

function matchUniform(line: string): UniformInfo | null {
  const match = /^\s*uniform\s+(\w+)\s+(\w+)(?:\s*\[\s*(\d+)\s*\])?\s*;/.exec(line)
  if (match === null) return null
  const type = match[1]
  if (!isUniformType(type)) return null
  return { name: match[2], type, arrayLength: match[3] !== undefined ? Number(match[3]) : 1 }
}

function matchAttribute(line: string): AttributeInfo | null {
  const match = /^\s*(?:layout\(\s*location\s*=\s*(\d+)\s*\)\s*)?in\s+(\w+)\s+(\w+)\s*;/.exec(line)
  if (match === null) return null
  return { name: match[3], location: match[1] !== undefined ? Number(match[1]) : -1 }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}
