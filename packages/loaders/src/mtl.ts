/**
 * MTL loader — Wavefront .mtl materials.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRACT:
 *
 *   parseMtl(bytes)        — from the response body
 *   parseMtlText(text)     — from a ready string
 *
 *   OUTPUT: MtlModel — { kind: 'mtl', materials, get(name), stats }.
 *     Material: diffuse/ambient/specular (RGB), shininess (Ns),
 *     opacity (d; Tr = 1 - d), illum, textures map_Kd/map_Ks/map_d/
 *     map_Bump (bump/map_bump/map_norm). Names are deduplicated:
 *     spaces → '-' (as exporters do).
 *
 * Textures are NOT loaded here: map fields are paths/names; for the
 * bytes to ImageBitmap — @rune/loaders image (or AssetLoader by URI).
 * The parser is text-based (MTL files are small — streaming is not needed).
 */

import { clamp, nowMs } from './bytes.ts'

/** MTL material. */
export interface MtlMaterial {
  readonly name: string
  readonly diffuse: readonly number[]
  readonly ambient: readonly number[]
  readonly specular: readonly number[]
  readonly shininess: number
  readonly opacity: number
  readonly illum: number
  readonly mapKd: string | null
  readonly mapKs: string | null
  readonly mapD: string | null
  readonly mapBump: string | null
}

/** MTL statistics. */
export interface MtlStats {
  readonly materials: number
  readonly withMapKd: number
  readonly parseMs: number
}

/** Fully decoded MTL. */
export interface MtlModel {
  readonly kind: 'mtl'
  readonly materials: readonly MtlMaterial[]
  /** Find a material by name (for OBJ usemtl materials). */
  readonly get: (name: string) => MtlMaterial | undefined
  readonly stats: MtlStats
}

/** Default material (three.js MeshPhongMaterial values). */
function defaultMaterial(): Mutable<MtlMaterial> {
  return {
    name: '',
    diffuse: [0.64, 0.64, 0.64],
    ambient: [0.2, 0.2, 0.2],
    specular: [0.05, 0.05, 0.05],
    shininess: 30,
    opacity: 1,
    illum: 2,
    mapKd: null,
    mapKs: null,
    mapD: null,
    mapBump: null,
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Parse .mtl from a string. */
export function parseMtlText(text: string): MtlModel {
  const startedAt = nowMs()
  const materials: MtlMaterial[] = []
  let current: Mutable<MtlMaterial> | null = null
  const flush = (): void => {
    if (current !== null && current.name !== '') materials.push(Object.freeze({ ...current }))
  }
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue
    const spaceAt = line.indexOf(' ')
    const keyword = (spaceAt < 0 ? line : line.slice(0, spaceAt)).toLowerCase()
    const rest = (spaceAt < 0 ? '' : line.slice(spaceAt + 1)).trim()
    switch (keyword) {
      case 'newmtl':
        flush()
        current = defaultMaterial()
        current.name = rest.replace(/\s+/g, '-')
        break
      case 'kd':
      case 'ka':
      case 'ks': {
        if (current === null) break
        const rgb = parseVec3(rest)
        if (keyword === 'kd') current.diffuse = rgb
        else if (keyword === 'ka') current.ambient = rgb
        else current.specular = rgb
        break
      }
      case 'ns':
        if (current !== null) current.shininess = clamp(parseFloat(rest) || 0, 0, 1000)
        break
      case 'd':
        if (current !== null) current.opacity = clamp(parseFloat(rest) || 1, 0, 1)
        break
      case 'tr':
        // Tr — transparency (inverse of opacity)
        if (current !== null) current.opacity = clamp(1 - (parseFloat(rest) || 0), 0, 1)
        break
      case 'illum':
        if (current !== null) current.illum = Math.trunc(parseFloat(rest) || 0)
        break
      case 'map_kd':
        if (current !== null) current.mapKd = extractMapPath(rest)
        break
      case 'map_ks':
        if (current !== null) current.mapKs = extractMapPath(rest)
        break
      case 'map_d':
        if (current !== null) current.mapD = extractMapPath(rest)
        break
      case 'bump':
      case 'map_bump':
      case 'map_norm':
        if (current !== null) current.mapBump = extractMapPath(rest)
        break
      default:
        break
    }
  }
  flush()
  return {
    kind: 'mtl',
    materials,
    get: (name: string) => materials.find((m) => m.name === name),
    stats: {
      materials: materials.length,
      withMapKd: materials.filter((m) => m.mapKd !== null).length,
      parseMs: nowMs() - startedAt,
    },
  }
}

/** Parse .mtl from response bytes (UTF-8). */
export function parseMtl(input: string | Uint8Array): MtlModel {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return parseMtlText(new TextDecoder('utf-8').decode(bytes))
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** "0.1 0.2 0.3" → [0.1, 0.2, 0.3] (with NaN protection). */
function parseVec3(text: string): number[] {
  const parts = text.split(/\s+/).map(parseFloat)
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ]
}

/**
 * The texture path from "map_kd -s 1 1 1 -o 0 0 0 texture.png":
 * take the last non-option token (like three.js).
 */
function extractMapPath(text: string): string | null {
  const tokens = text.split(/\s+/).filter((t) => t !== '')
  if (tokens.length === 0) return null
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]
    if (token.startsWith('-')) break
    if (/^-?\d+(\.\d+)?$/.test(token) && i > 0) continue
    return token
  }
  return tokens[tokens.length - 1] ?? null
}

// ─── Task 88 bridge (AssetLibrary expects these names) ─────────────────────────────

/** MTL material library (AssetLibrary layer name). */
export type MtlLibrary = MtlModel

/** MTL from bytes (alias of parseMtl — the byte contract). */
export function parseMtlBytes(bytes: Uint8Array): MtlLibrary {
  return parseMtl(bytes)
}
