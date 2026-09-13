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
  const scanned = collectAttributes(vertexSource)
  const pinned = resolveAttribLocations(scanned)
  return { uniforms: [...uniforms.values()], attributes: scanned.map((a, i) => ({ ...a, location: pinned[i] ?? a.location })) }
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

/** Assigns a concrete attribute location to every declared vertex input.
 *  Sources WITHOUT layout qualifiers (GLSL 100 `attribute`, or bare 300 es
 *  `in`) reflect as location −1 — the driver assigns those arbitrarily at
 *  link time. rune pins them deterministically instead: explicit layout
 *  locations are kept, the rest take the FREE slots in declaration order
 *  (0, 1, 2… skipping the taken ones). realGL's createProgram calls
 *  gl.bindAttribLocation with THE SAME assignment before linking (Task 194:
 *  a GLSL-100 source used to reflect ZERO attributes — the command compiled
 *  with an empty attribute list, the vertex buffers never bound, and the
 *  draws silently rasterized degenerate garbage while the shader itself
 *  compiled fine — WebGL2 accepts both dialects). */
export function resolveAttribLocations(attributes: readonly AttributeInfo[]): number[] {
  const resolved = attributes.map(a => a.location)
  const taken = new Set<number>()
  for (const l of resolved) if (l >= 0) taken.add(l)
  let next = 0
  for (let i = 0; i < resolved.length; i++) {
    if ((resolved[i] ?? -1) >= 0) continue
    while (taken.has(next)) next++
    resolved[i] = next
    taken.add(next)
  }
  return resolved
}

function matchAttribute(line: string): AttributeInfo | null {
  const match = /^\s*(?:layout\(\s*location\s*=\s*(\d+)\s*\)\s*)?in\s+(\w+)\s+(\w+)\s*;/.exec(line)
  if (match !== null) return { name: match[3], location: match[1] !== undefined ? Number(match[1]) : -1 }
  // GLSL 100 vertex inputs (`attribute vec3 position;`) — legal in WebGL2
  // (no #version directive = the 100 dialect); the reflection must see them
  // or the command compiles attribute-less (the Task-194 silent blank).
  const legacy = /^\s*attribute\s+(\w+)\s+(\w+)\s*;/.exec(line)
  if (legacy !== null) return { name: legacy[2], location: -1 }
  return null
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}
