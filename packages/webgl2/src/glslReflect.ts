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
  const scannedAttributes = [...scanAttributes(vertex)].sort(byLocation)
  const pinned = resolveAttribLocations(scannedAttributes)
  return {
    uniforms: [...scanUniforms(vertex), ...scanUniforms(fragment)],
    attributes: scannedAttributes.map((attr, i) => ({ ...attr, location: pinned[i] ?? attr.location })),
    samplers: [...scanUniforms(vertex), ...scanUniforms(fragment)]
      .filter(u => u.type === 'sampler2D')
      .map(u => u.name),
  }
}

function scanUniforms(source: string): UniformInfo[] {
  const found: UniformInfo[] = []
  // Array uniforms: `uniform mat4 u_bones[52];` — one arena slot of 16×52
  // floats; setUniformMatrix4fv/4fv upload the whole array in one call
  // (the location of `u_bones` names its first element).
  const re = /uniform\s+(mat4|vec4|vec3|vec2|float|int|sampler2D)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g
  for (const match of source.matchAll(re)) {
    const type = match[1] as UniformGlType
    const count = match[3] !== undefined ? Number(match[3]) : 1
    found.push({ name: match[2], type, size: SIZE[type] * count })
  }
  return found
}

function scanAttributes(source: string): AttributeInfo[] {
  const found: AttributeInfo[] = []
  // Comments first: a commented-out declaration must not become a real
  // attribute (the broader Task-194 pattern makes this matter — legacy
  // `attribute` lines live in old commented experiments).
  source = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  // Three input dialects, one pattern (Task 194):
  //   layout(location = N) in vec3 name;   — 300 es, the explicit slot
  //   in vec3 name;                        — 300 es, no slot (−1 → pinned)
  //   attribute vec3 name;                 — GLSL 100 (no #version = the
  //                                         100 dialect; WebGL2 compiles it)
  // The last two used to reflect as NOTHING — the command compiled with an
  // EMPTY attribute list, the vertex buffers never bound, and the draws
  // silently rasterized degenerate garbage (the shader linked fine, the
  // uniforms uploaded — zero errors, a pure blank). The `\b` guards against
  // keyword substrings (`sin`, `inline`); the location −1 entries are pinned
  // to free slots by resolveAttribLocations — realGL bindAttribLocation's
  // the same pin before the link, so the driver and the executor agree.
  const re = /(?:layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*)?\b(?:in|attribute)\s+(vec4|vec3|vec2|float)\s+(\w+)\s*;/g
  for (const match of source.matchAll(re)) {
    found.push({ name: match[3], location: match[1] !== undefined ? Number(match[1]) : -1, size: vecSize(match[2]) })
  }
  return found
}

/** Pins a concrete location to every −1 (unqualified) attribute: explicit
 *  layout locations stay, the rest take the FREE slots in declaration order
 *  (0, 1, 2… skipping the taken ones). Deterministic by construction — the
 *  same reflection feeds realGL's bindAttribLocation pin, so the driver's
 *  link-time assignment matches the executor's bind exactly (Task 194). */
export function resolveAttribLocations(attributes: readonly { location: number }[]): number[] {
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

function vecSize(type: string): number {
  if (type === 'vec4') return 4
  if (type === 'vec3') return 3
  if (type === 'vec2') return 2
  return 1
}

function byLocation(a: AttributeInfo, b: AttributeInfo): number {
  return a.location - b.location
}
