/**
 * OBJ loader — потоковый парсер с нулевой аллокацией строк.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * КОНТРАКТ:
 *
 *   parseObj(assembler, options) → ObjModel
 *
 *   ВХОД:   Assembler над стримящимся телом .obj.
 *   ВЫХОД:  ObjModel — { kind, positions, normals, uvs, vertexCount,
 *     groups, mtllib, stats }. Данные — плотные TypedArray в
 *     expanded-форме (вершина = углы полигонов, готово к отрисовке).
 *     groups — спаны [vertexStart, vertexCount) по o/g/usemtl.
 *     mtllib — имя файла материалов (грузить отдельно MTL-парсером).
 *
 * ПОЧЕМУ ПОТОК: OBJ в десятки мегабайт (сканы, CAD-экспорты) —
 * парсинг построчный и начинает с первого чанка, не ждёт EOF.
 * Прогресс — по ratio полученных байтов, счётчики живые (строки/треугольники).
 *
 * ЧТО ПОДДЕРЖИВАЕТСЯ: v/vt/vn/f (v, v/t, v//n, v/t/n; отрицательные
 * индексы — относительные), o/g (группы), usemtl, mtllib, comments (#),
 * CRLF/LF. Полигоны → веерная триангуляция. Нормали: если vn нет —
 * плоские нормали из cross-продукта треугольника.
 * НЕ парсится (сознательно): точки/линии (p/l), smooth groups,
 *-polymesh free-form (curves/surfaces), инлайн-параметры. Строки
 * с неизвестным ключевым словом пропускаются молча — как three.js.
 */

import { CHAR, isWhitespace, parseDecimal, asciiDecode, nowMs } from './bytes.ts'
import type { Assembler } from './assembler.ts'
import type { GltfPhase } from './gltf.ts'

/** Общий вид фазы прогресса. */
export type OnObjPhase = (phase: GltfPhase) => void

/** Спан группы (o/g/usemtl) в expanded-вершинах. */
export interface ObjGroup {
  readonly name: string
  readonly material: string | null
  readonly vertexStart: number
  readonly vertexCount: number
}

/** Статистика парсинга OBJ. */
export interface ObjStats {
  readonly vertices: number
  readonly triangles: number
  readonly parseMs: number
  readonly lines: number
}

/** Полностью декодированный OBJ. */
export interface ObjModel {
  readonly kind: 'obj'
  readonly positions: Float32Array
  readonly normals: Float32Array
  readonly uvs: Float32Array | null
  readonly vertexCount: number
  readonly groups: readonly ObjGroup[]
  readonly mtllib: string | null
  readonly stats: ObjStats
}

export interface ObjParseOptions {
  readonly onPhase?: OnObjPhase
}

// ─── Растущие массивы ────────────────────────────────────────────────────────

/** Float32-строитель с амортизированным ростом (push3/push2). */
class FloatBuilder {
  data: Float32Array
  count = 0

  constructor(capacity: number) {
    this.data = new Float32Array(capacity)
  }

  push3(a: number, b: number, c: number): void {
    this.ensure(3)
    this.data[this.count++] = a
    this.data[this.count++] = b
    this.data[this.count++] = c
  }

  push2(a: number, b: number): void {
    this.ensure(2)
    this.data[this.count++] = a
    this.data[this.count++] = b
  }

  private ensure(extra: number): void {
    if (this.count + extra <= this.data.length) return
    let capacity = this.data.length * 2
    while (capacity < this.count + extra) capacity *= 2
    const grown = new Float32Array(capacity)
    grown.set(this.data.subarray(0, this.count), 0)
    this.data = grown
  }
}

/** Int32-строитель углов полигонов (v/t/n тройками). */
class CornerBuilder {
  data: Int32Array
  count = 0

  constructor(capacity: number) {
    this.data = new Int32Array(capacity * 3)
  }

  push(v: number, t: number, n: number): number {
    if (this.count * 3 + 3 > this.data.length) {
      let capacity = this.data.length * 2
      while (capacity < (this.count + 1) * 3) capacity *= 2
      const grown = new Int32Array(capacity)
      grown.set(this.data)
      this.data = grown
    }
    const at = this.count * 3
    this.data[at] = v
    this.data[at + 1] = t
    this.data[at + 2] = n
    return this.count++
  }
}

/** Токен-сканер строки OBJ (байты → срезы, без строк). */
class TokenScanner {
  private readonly bytes: Uint8Array
  private readonly end: number
  private at: number

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes
    this.end = end
    let at = start
    while (at < end && isWhitespace(bytes[at])) at++
    this.at = at
  }

  nextToken(): Uint8Array | null {
    if (this.at >= this.end) return null
    const start = this.at
    while (this.at < this.end && !isWhitespace(this.bytes[this.at])) this.at++
    const tokenEnd = this.at
    while (this.at < this.end && isWhitespace(this.bytes[this.at])) this.at++
    return this.bytes.subarray(start, tokenEnd)
  }

  nextFloat(): number {
    const token = this.nextToken()
    return token === null ? NaN : parseDecimal(token, 0, token.length)
  }
}

// ─── Парсер ──────────────────────────────────────────────────────────────────

interface ObjBuilderOptions {
  expectedBytes?: number
  onPhase?: OnObjPhase
}

/** Накопитель OBJ: кормится чанками, отдаёт модель на finish(). */
class ObjParser {
  private positions = new FloatBuilder(4096)
  private normals = new FloatBuilder(4096)
  private uvs = new FloatBuilder(1024)
  private corners = new CornerBuilder(1024)
  private groups: ObjGroup[] = []
  private groupVertexStart = 0
  private currentName = 'default'
  private currentMaterial: string | null = null
  private tail: Uint8Array = new Uint8Array(0)
  private lines = 0
  private hasNormals = false
  private hasUvs = false
  private received = 0
  private readonly onPhase?: OnObjPhase
  private readonly expectedBytes?: number
  private mtllib: string | null = null

  constructor(options: ObjBuilderOptions = {}) {
    this.expectedBytes = options.expectedBytes
    this.onPhase = options.onPhase
  }

  /** Скормить очередной чанк; парсятся только ЦЕЛЫЕ строки. */
  feed(chunk: Uint8Array): void {
    if (this.tail.length > 0) {
      const merged = new Uint8Array(this.tail.length + chunk.length)
      merged.set(this.tail, 0)
      merged.set(chunk, this.tail.length)
      chunk = merged
    }
    this.received += chunk.length
    let lineStart = 0
    for (let i = 0; i < chunk.length; i++)
      if (chunk[i] === CHAR.LF) {
        let lineEnd = i
        if (lineEnd > lineStart && chunk[lineEnd - 1] === CHAR.CR) lineEnd--
        if (lineEnd > lineStart) this.parseLine(chunk, lineStart, lineEnd)
        lineStart = i + 1
      }
    this.tail = chunk.subarray(lineStart)
    if (this.onPhase !== undefined && this.expectedBytes !== undefined && this.expectedBytes > 0)
      this.onPhase({
        stage: 'lines',
        ratio: Math.min(0.9, this.received / this.expectedBytes),
        detail: `${this.lines} строк · ${Math.floor(this.corners.count / 3)} тр.`,
      })
  }

  /** Финал: хвост, закрытие группы, разворот в плоские массивы. */
  finish(): ObjModel {
    const startedAt = nowMs()
    if (this.tail.length > 0) {
      let end = this.tail.length
      if (end > 0 && this.tail[end - 1] === CHAR.CR) end--
      if (end > 0) this.parseLine(this.tail, 0, end)
      this.tail = new Uint8Array(0)
    }
    this.closeGroup()

    const cornerCount = this.corners.count
    const cornerData = this.corners.data
    const positions = new Float32Array(cornerCount * 3)
    const normals = new Float32Array(cornerCount * 3)
    const uvs = this.hasUvs ? new Float32Array(cornerCount * 2) : null
    const rawPositions = this.positions.data
    const rawNormals = this.normals.data
    const rawUvs = this.uvs.data
    for (let corner = 0; corner < cornerCount; corner++) {
      const at = corner * 3
      const positionIndex = (cornerData[at] - 1) * 3
      positions[corner * 3] = rawPositions[positionIndex]
      positions[corner * 3 + 1] = rawPositions[positionIndex + 1]
      positions[corner * 3 + 2] = rawPositions[positionIndex + 2]
      if (this.hasNormals && cornerData[at + 2] > 0) {
        const normalIndex = (cornerData[at + 2] - 1) * 3
        normals[corner * 3] = rawNormals[normalIndex]
        normals[corner * 3 + 1] = rawNormals[normalIndex + 1]
        normals[corner * 3 + 2] = rawNormals[normalIndex + 2]
      }
      if (uvs !== null && cornerData[at + 1] > 0) {
        const uvIndex = (cornerData[at + 1] - 1) * 2
        uvs[corner * 2] = rawUvs[uvIndex]
        uvs[corner * 2 + 1] = rawUvs[uvIndex + 1]
      }
    }

    // Нормалей не было: плоские нормали из треугольников
    if (!this.hasNormals)
      for (let corner = 0; corner + 2 < cornerCount; corner += 3) {
        const ax = positions[corner * 3]
        const ay = positions[corner * 3 + 1]
        const az = positions[corner * 3 + 2]
        const bx = positions[corner * 3 + 3]
        const by = positions[corner * 3 + 4]
        const bz = positions[corner * 3 + 5]
        const cx = positions[corner * 3 + 6]
        const cy = positions[corner * 3 + 7]
        const cz = positions[corner * 3 + 8]
        const ux = bx - ax
        const uy = by - ay
        const uz = bz - az
        const vx = cx - ax
        const vy = cy - ay
        const vz = cz - az
        let nx = uy * vz - uz * vy
        let ny = uz * vx - ux * vz
        let nz = ux * vy - uy * vx
        const length = Math.hypot(nx, ny, nz)
        if (length > 1e-12) {
          nx /= length
          ny /= length
          nz /= length
        } else {
          nx = 0
          ny = 0
          nz = 1
        }
        for (let v = 0; v < 3; v++) {
          normals[corner * 3 + v * 3] = nx
          normals[corner * 3 + v * 3 + 1] = ny
          normals[corner * 3 + v * 3 + 2] = nz
        }
      }

    const elapsed = nowMs() - startedAt
    return {
      kind: 'obj',
      positions,
      normals,
      uvs,
      vertexCount: cornerCount,
      groups: this.groups,
      mtllib: this.mtllib,
      stats: {
        vertices: this.positions.count / 3,
        triangles: cornerCount / 3,
        parseMs: elapsed,
        lines: this.lines,
      },
    }
  }

  private parseLine(bytes: Uint8Array, start: number, end: number): void {
    this.lines++
    let at = start
    while (at < end && isWhitespace(bytes[at])) at++
    if (at >= end) return
    const keywordStart = at
    while (at < end && !isWhitespace(bytes[at])) at++
    const keywordEnd = at
    const keywordLength = keywordEnd - keywordStart
    const first = bytes[keywordStart]
    if (first === 118 /* 'v' */) {
      if (keywordLength === 1) {
        const scanner = new TokenScanner(bytes, keywordEnd, end)
        this.positions.push3(scanner.nextFloat(), scanner.nextFloat(), scanner.nextFloat())
      } else if (bytes[keywordStart + 1] === 110 /* 'n' */ && keywordLength === 2) {
        const scanner = new TokenScanner(bytes, keywordEnd, end)
        this.normals.push3(scanner.nextFloat(), scanner.nextFloat(), scanner.nextFloat())
        this.hasNormals = true
      } else if (bytes[keywordStart + 1] === 116 /* 't' */ && keywordLength === 2) {
        const scanner = new TokenScanner(bytes, keywordEnd, end)
        this.uvs.push2(scanner.nextFloat(), scanner.nextFloat())
        this.hasUvs = true
      }
      return
    }
    if (first === 102 /* 'f' */) {
      this.parseFace(bytes, keywordEnd, end)
      return
    }
    if (first === 111 /* 'o' */ || first === 103 /* 'g' */) {
      this.closeGroup()
      this.currentName = asciiDecode(bytes, keywordEnd, end - keywordEnd).trim() || 'default'
      this.groupVertexStart = this.corners.count
      return
    }
    if (first === 117 /* 'u' */ && keywordLength === 6) {
      this.closeGroup()
      this.currentMaterial = asciiDecode(bytes, keywordEnd, end - keywordEnd).trim() || null
      this.groupVertexStart = this.corners.count
      return
    }
    if (first === 109 /* 'm' */ && keywordLength === 6) {
      this.mtllib = asciiDecode(bytes, keywordEnd, end - keywordEnd).trim() || null
      return
    }
  }

  private parseFace(bytes: Uint8Array, start: number, end: number): void {
    const scanner = new TokenScanner(bytes, start, end)
    const firstToken = scanner.nextToken()
    if (firstToken === null) return
    const firstCorner = this.parseCorner(firstToken)
    if (firstCorner === null) return
    let previous: { v: number; t: number; n: number } | null = null
    for (;;) {
      const token = scanner.nextToken()
      if (token === null) break
      const corner = this.parseCorner(token)
      if (corner === null) break
      // Веерная триангуляция: (первый, предыдущий, текущий)
      if (previous !== null) {
        this.corners.push(firstCorner.v, firstCorner.t, firstCorner.n)
        this.corners.push(previous.v, previous.t, previous.n)
        this.corners.push(corner.v, corner.t, corner.n)
      }
      previous = corner
    }
  }

  /** Угол «v», «v/t», «v//n», «v/t/n». */
  private parseCorner(token: Uint8Array): { v: number; t: number; n: number } | null {
    let slash = 0
    while (slash < token.length && token[slash] !== CHAR.SLASH) slash++
    const vertex = this.resolveIndex(parseDecimal(token, 0, slash), this.positions.count / 3)
    if (vertex === 0) return null
    let texcoord = 0
    let normal = 0
    if (slash < token.length) {
      const secondStart = slash + 1
      let secondEnd = secondStart
      while (secondEnd < token.length && token[secondEnd] !== CHAR.SLASH) secondEnd++
      if (secondEnd > secondStart)
        texcoord = this.resolveIndex(parseDecimal(token, secondStart, secondEnd), this.uvs.count / 2)
      if (secondEnd < token.length) {
        const thirdStart = secondEnd + 1
        if (thirdStart < token.length)
          normal = this.resolveIndex(parseDecimal(token, thirdStart, token.length), this.normals.count / 3)
      }
    }
    return { v: vertex, t: texcoord, n: normal }
  }

  /** OBJ-индексация: 1-based; отрицательный — от текущего конца; 0 — мусор. */
  private resolveIndex(raw: number, count: number): number {
    if (!Number.isFinite(raw)) return 0
    const index = Math.trunc(raw)
    if (index >= 1) return index
    if (index <= -1) return count + 1 + index
    return 0
  }

  private closeGroup(): void {
    const vertexCount = this.corners.count - this.groupVertexStart
    if (vertexCount <= 0) return
    const last = this.groups[this.groups.length - 1]
    if (
      last !== undefined &&
      last.name === this.currentName &&
      last.material === this.currentMaterial &&
      last.vertexStart + last.vertexCount === this.groupVertexStart
    ) {
      // Слияние соседних спанов одной группы/материала
      this.groups[this.groups.length - 1] = {
        ...last,
        vertexCount: last.vertexCount + vertexCount,
      }
      return
    }
    this.groups.push({
      name: this.currentName,
      material: this.currentMaterial,
      vertexStart: this.groupVertexStart,
      vertexCount,
    })
  }
}

// ─── Потоковый вход ──────────────────────────────────────────────────────────

/**
 * Парсинг OBJ поверх стриминга: кормит ObjParser по мере роста
 * watermark, ждёт либо конца потока, либо новых диапазонов.
 */
export async function parseObj(assembler: Assembler, options: ObjParseOptions = {}): Promise<ObjModel> {
  const parser = new ObjParser({ expectedBytes: assembler.total, onPhase: options.onPhase })
  let fed = 0
  for (;;) {
    if (assembler.watermark > fed) {
      parser.feed(assembler.slice(fed, assembler.watermark - fed))
      fed = assembler.watermark
    }
    if (assembler.isDone) break
    await Promise.race([assembler.completion, rangeArrival(assembler, fed)])
  }
  if (assembler.watermark > fed) parser.feed(assembler.slice(fed, assembler.watermark - fed))
  return parser.finish()
}

/** Резолвится, когда watermark превысит threshold. */
function rangeArrival(assembler: Assembler, threshold: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = assembler.onRange((watermark) => {
      if (watermark > threshold) {
        unsubscribe()
        resolve()
      }
    })
  })
}

// ─── Мост Task 88: имя стрим-парсера для AssetLibrary ───────────────────────

/** Стрим-парсинг OBJ (алиас parseObj — тот же watermark-контракт). */
export const parseObjStream = parseObj
