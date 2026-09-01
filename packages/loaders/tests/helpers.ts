/**
 * tests/helpers.ts — общие утилиты тестов @rune/loaders:
 *  - ParseContext-стаб (external-файлы, inflate, отмена);
 *  - fakeFetch с маршрутизацией, задержками, стримами и логом старта;
 *  - билдеры тестовых бинарников: GLB, FBX (u32/u64, zlib), HDR RGBE.
 */

import { inflateSync, deflateSync } from 'node:zlib'
import type { ParseContext, StreamSink } from '../src/core/types.ts'
import { defaultResolveUrl } from '../src/core/util.ts'

// ─── ParseContext-стаб ───────────────────────────────────────────────────────

export interface CtxOptions {
  sourceUrl?: string | null
  /** Относительный путь → байты (для resolveExternal). */
  external?: Record<string, Uint8Array>
  /** Выбрасывать при resolveExternal этих путях. */
  externalFail?: string[]
  signal?: AbortSignal
}

export function makeContext(options: CtxOptions = {}): ParseContext {
  const controller = new AbortController()
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort(options.signal.reason)
    else options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true })
  }
  return {
    sourceUrl: options.sourceUrl ?? null,
    byteLength: null,
    signal: controller.signal,
    reportProgress: () => {},
    resolveExternal: async (url: string): Promise<Uint8Array> => {
      const base = options.sourceUrl ?? 'http://test/loc/x'
      const abs = defaultResolveUrl(base, url)
      const dir = base.slice(0, base.lastIndexOf('/') + 1)
      const short = abs.startsWith(dir) && dir.length > 0 ? abs.slice(dir.length) : abs
      if ((options.externalFail ?? []).includes(short)) {
        throw new Error(`external fail: ${short}`)
      }
      const bytes = (options.external ?? {})[short]
      if (bytes === undefined) throw new Error(`no external route: ${short} (${url})`)
      return bytes
    },
    resolveUrl: (base, rel) => defaultResolveUrl(base, rel),
    inflate: async (bytes) => new Uint8Array(inflateSync(Buffer.from(bytes as never))),
    taskId: 1,
  }
}

/** Контекст с уже отменённым сигналом. */
export function makeAbortedContext(): ParseContext {
  const ctx = makeContext()
  const controller = new AbortController()
  controller.abort('test-abort')
  return { ...ctx, signal: controller.signal }
}

// ─── fakeFetch ───────────────────────────────────────────────────────────────

export interface Route {
  status?: number
  body?: Uint8Array | string
  headers?: Record<string, string>
  delayMs?: number
  /** Сколько раз этот маршрут отвечает успехом ДО первой ошибки/серии. */
  failFirst?: number
}

export interface FetchLog {
  calls: string[]
  starts: string[]
  active: number
  maxActive: number
}

export function createFetchLog(): FetchLog {
  return { calls: [], starts: [], active: 0, maxActive: 0 }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export function fakeFetch(routes: Record<string, Route>, log?: FetchLog): typeof fetch {
  const failCounters = new Map<string, number>()
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    log?.calls.push(url)
    const route = routes[url]
    if (route === undefined) {
      return new Response('not found', { status: 404 })
    }
    const signal = init?.signal
    if (signal?.aborted) {
      throw abortLike()
    }
    // успех до failFirst раз, дальше — 500 (если failFirst задан)
    if (route.failFirst !== undefined) {
      const n = (failCounters.get(url) ?? 0) + 1
      failCounters.set(url, n)
      if (n <= route.failFirst) return new Response('flaky', { status: 500 })
    }
    log?.starts.push(url)
    log && log.active++
    log && (log.maxActive = Math.max(log.maxActive, log.active))
    try {
    if ((route.delayMs ?? 0) > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(abortLike())
        }, { once: true })
      })
    }
      const body = route.body ?? new Uint8Array(0)
      const headers: Record<string, string> = { ...(route.headers ?? {}) }
      const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
      if (headers['content-length'] === undefined) {
        headers['content-length'] = String(bodyBytes.length)
      }
      return new Response(bodyBytes as unknown as BodyInit, { status: route.status ?? 200, headers })
    } finally {
      log && log.active--
    }
  }) as typeof fetch
}

function abortLike(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/** Response с телом-стримом, отдающим чанки с паузами. */
export function streamResponse(chunks: readonly number[][], chunkDelayMs = 5): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        await sleep(chunkDelayMs)
        controller.enqueue(new Uint8Array(chunk))
      }
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

// ─── билдер GLB ──────────────────────────────────────────────────────────────

export function buildGlb(json: unknown, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const binPad = (4 - (bin.length % 4)) % 4
  const hasBin = bin.length > 0
  const total =
    12 + 8 + jsonBytes.length + jsonPad + (hasBin ? 8 + bin.length + binPad : 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  let pos = 12
  dv.setUint32(pos, jsonBytes.length, true) // длина данных БЕЗ паддинга
  dv.setUint32(pos + 4, 0x4e4f534a, true)
  pos += 8
  out.set(jsonBytes, pos)
  pos += jsonBytes.length + jsonPad
  if (hasBin) {
    dv.setUint32(pos, bin.length, true) // длина данных БЕЗ паддинга
    dv.setUint32(pos + 4, 0x004e4942, true)
    pos += 8
    out.set(bin, pos)
  }
  return out
}

export function f32le(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < values.length; i++) dv.setFloat32(i * 4, values[i], true)
  return out
}

export function u16le(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < values.length; i++) dv.setUint16(i * 2, values[i], true)
  return out
}

export function u32le(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < values.length; i++) dv.setUint32(i * 4, values[i], true)
  return out
}

// ─── билдер FBX ──────────────────────────────────────────────────────────────

export type FbxPropInput =
  | { type: 'D' | 'F' | 'I' | 'L' | 'C'; value: number | bigint | boolean }
  | { type: 'S'; value: string }
  | { type: 'd' | 'i'; value: Float64Array | Int32Array | number[]; zlib?: boolean }

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function fbxPropBytes(prop: FbxPropInput): Uint8Array {
  if (prop.type === 'S') {
    const data = ascii(prop.value)
    const out = new Uint8Array(5 + data.length)
    new DataView(out.buffer).setUint32(1, data.length, true)
    out[0] = 83 // 'S'
    out.set(data, 5)
    return out
  }
  if (prop.type === 'd' || prop.type === 'i') {
    const values = prop.value instanceof Float64Array || prop.value instanceof Int32Array
      ? Array.from(prop.value)
      : (prop.value as number[])
    const compSize = prop.type === 'd' ? 8 : 4
    const raw = new Uint8Array(values.length * compSize)
    const dv = new DataView(raw.buffer)
    for (let i = 0; i < values.length; i++) {
      if (prop.type === 'd') dv.setFloat64(i * 8, values[i], true)
      else dv.setInt32(i * 4, values[i], true)
    }
    const useZlib = prop.zlib === true
    const payload = useZlib ? deflateSync(raw) : raw
    const out = new Uint8Array(13 + payload.length)
    const dvOut = new DataView(out.buffer)
    out[0] = prop.type.charCodeAt(0)
    dvOut.setUint32(1, values.length, true)
    dvOut.setUint32(5, useZlib ? 1 : 0, true)
    dvOut.setUint32(9, payload.length, true)
    out.set(payload, 13)
    return out
  }
  switch (prop.type) {
    case 'D': {
      const out = new Uint8Array(9)
      out[0] = 68
      new DataView(out.buffer).setFloat64(1, Number(prop.value), true)
      return out
    }
    case 'F': {
      const out = new Uint8Array(5)
      out[0] = 70
      new DataView(out.buffer).setFloat32(1, Number(prop.value), true)
      return out
    }
    case 'I': {
      const out = new Uint8Array(5)
      out[0] = 73
      new DataView(out.buffer).setInt32(1, Number(prop.value), true)
      return out
    }
    case 'L': {
      const out = new Uint8Array(9)
      out[0] = 76
      new DataView(out.buffer).setBigInt64(1, BigInt(prop.value), true)
      return out
    }
    case 'C': {
      const out = new Uint8Array(2)
      out[0] = 67
      out[1] = prop.value === true ? 1 : 0
      return out
    }
    default:
      throw new Error(`fbxPropBytes: неизвестный тип ${(prop as { type: string }).type}`)
  }
}

/** Спец-нода FBX: children === null → лист (без NULL-записи). */
export interface FbxNodeSpec {
  name: string
  props: readonly FbxPropInput[]
  children: readonly FbxNodeSpec[] | null
}

/** Спецификация FBX-ноды (endOffset проставит buildFbx layout-проходом). */
export function fbxNode(
  name: string,
  props: readonly FbxPropInput[],
  children: readonly FbxNodeSpec[] | null,
): FbxNodeSpec {
  return { name, props, children }
}

interface LaidOutNode extends FbxNodeSpec {
  start: number
  endOffset: number
  laidChildren: LaidOutNode[] | null
}

function propsLength(props: readonly FbxPropInput[]): number {
  return props.map(fbxPropBytes).reduce((a, b) => a + b.length, 0)
}

function sizeOf(node: FbxNodeSpec, headerSize: number, nullLen: number): number {
  const nameLen = node.name.length
  const childrenLen =
    node.children !== null ? node.children.reduce((a, c) => a + sizeOf(c, headerSize, nullLen), 0) + nullLen : 0
  return headerSize + nameLen + propsLength(node.props) + childrenLen
}

function layout(node: FbxNodeSpec, cursor: number, headerSize: number, nullLen: number): LaidOutNode {
  const size = sizeOf(node, headerSize, nullLen)
  const laid: LaidOutNode = {
    ...node,
    start: cursor,
    endOffset: cursor + size,
    laidChildren: null,
  }
  if (node.children !== null) {
    let childCursor = cursor + headerSize + node.name.length + propsLength(node.props)
    laid.laidChildren = node.children.map(child => {
      const laidChild = layout(child, childCursor, headerSize, nullLen)
      childCursor = laidChild.endOffset // NULL-запись — ОДНА после всех детей
      return laidChild
    })
  }
  return laid
}

function serialize(laid: LaidOutNode, out: Uint8Array, u64: boolean): void {
  const dv = new DataView(out.buffer)
  const nameBytes = ascii(laid.name)
  const propBytes = laid.props.map(fbxPropBytes)
  const propsLen = propBytes.reduce((a, b) => a + b.length, 0)
  let pos = laid.start
  if (u64) {
    dv.setBigUint64(pos, BigInt(laid.endOffset), true)
    dv.setBigUint64(pos + 8, BigInt(laid.props.length), true)
    dv.setBigUint64(pos + 16, BigInt(propsLen), true)
    dv.setUint8(pos + 24, nameBytes.length)
    pos += 25
  } else {
    dv.setUint32(pos, laid.endOffset, true)
    dv.setUint32(pos + 4, laid.props.length, true)
    dv.setUint32(pos + 8, propsLen, true)
    dv.setUint8(pos + 12, nameBytes.length)
    pos += 13
  }
  out.set(nameBytes, pos)
  pos += nameBytes.length
  for (const pb of propBytes) {
    out.set(pb, pos)
    pos += pb.length
  }
  if (laid.laidChildren !== null) {
    for (const child of laid.laidChildren) {
      serialize(child, out, u64)
      pos += child.endOffset - child.start
    }
  }
}

/** Собрать FBX-файл: заголовок + версия + топ-ноды + NULL. */
export function buildFbx(version: number, topNodes: readonly FbxNodeSpec[]): Uint8Array {
  const u64 = version >= 7500
  const headerSize = u64 ? 25 : 13
  const nullLen = u64 ? 25 : 13
  // топ-ноды идут подряд; ОДНА NULL-запись — в самом конце файла
  let cursor = 27
  const laid = topNodes.map(node => {
    const l = layout(node, cursor, headerSize, nullLen)
    cursor = l.endOffset
    return l
  })
  const total = cursor + nullLen
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  out.set(ascii('Kaydara FBX Binary  \x00\x1a\x00'), 0)
  dv.setUint32(23, version, true)
  for (const l of laid) serialize(l, out, u64)
  return out
}

// ─── билдер HDR (Radiance RGBE) ──────────────────────────────────────────────

/** HDR-файл с RLE-сканлайнами (new-style). rows — снизу вверх по GL? нет: как в файле (сверху вниз). */
export type Rgbe = readonly [number, number, number, number]

export function buildHdrRle(rows: readonly (readonly Rgbe[])[]): Uint8Array {
  const width = rows[0].length
  const height = rows.length
  const header = new TextEncoder().encode(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
  )
  const body: number[] = []
  for (const row of rows) {
    // new-style заголовок сканлайна: 2, 2, widthHi, widthLo
    body.push(2, 2, (width >> 8) & 0xff, width & 0xff)
    for (let c = 0; c < 4; c++) {
      // RLE: повтор value count раз (count = 128 + repeat)
      const values: number[] = []
      for (const pixel of row) values.push(pixel[c])
      // единственный ран со всеми значениями (literal)
      body.push(values.length)
      body.push(...values)
    }
  }
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(new Uint8Array(body), header.length)
  return out
}

/** HDR-файл с flat-сканлайнами (без RLE). */
export function buildHdrFlat(rows: readonly (readonly Rgbe[])[]): Uint8Array {
  const width = rows[0].length
  const height = rows.length
  const header = new TextEncoder().encode(
    `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`,
  )
  const body: number[] = []
  for (const row of rows) {
    for (const pixel of row) body.push(pixel[0], pixel[1], pixel[2], pixel[3])
  }
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(new Uint8Array(body), header.length)
  return out
}

// ─── прочее ──────────────────────────────────────────────────────────────────

/** Тестовый стриминговый парсер: считает чанки, отдаёт счётчик. */
export function makeCountingStreamParser(): {
  parser: import('../src/core/types.ts').Parser<{ pushes: number; bytes: number; parsed: boolean }>
  pushes: () => number
} {
  let pushes = 0
  let bytes = 0
  const parser = {
    kind: '__counting__',
    parse: (): { pushes: number; bytes: number; parsed: boolean } => {
      return { pushes, bytes, parsed: true }
    },
    streaming: (): StreamSink<{ pushes: number; bytes: number; parsed: boolean }> => ({
      push(chunk: Uint8Array): void {
        pushes++
        bytes += chunk.byteLength
      },
      finish(): { pushes: number; bytes: number; parsed: boolean } {
        return { pushes, bytes, parsed: false }
      },
    }),
  }
  return { parser, pushes: () => pushes }
}
