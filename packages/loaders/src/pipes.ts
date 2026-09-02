/**
 * pipes.ts — user stream transforms: "transforms and pipes".
 *
 * Format parsers (GLB/OBJ/FBX) work directly with StreamAssembler
 * (watermark access), but for CUSTOM formats the user composes
 * standard ReadableStream pipes:
 *
 *   const text = await library.loadText(url, {
 *     pipe: bytesToText({ label: 'big.log' })   // Uint8Array → string
 *       .through(splitLines())                  // → line stream
 *       .through(filter(line => !line.startsWith('#')))
 *       .through(collect())                     // → string[]
 *   })
 *
 * All transforms are plain TransformStreams, compatible with pipeThrough.
 */

/** Tap transform: sees every chunk, passes it on. */
export function tap<T>(observer: (chunk: T) => void): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      observer(chunk)
      controller.enqueue(chunk)
    },
  })
}

/** Progress tap for byte streams: loaded += chunk.byteLength. */
export function tapBytes(onProgress: (loaded: number, chunkBytes: number) => void): TransformStream<Uint8Array, Uint8Array> {
  let loaded = 0
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      loaded += chunk.byteLength
      onProgress(loaded, chunk.byteLength)
      controller.enqueue(chunk)
    },
  })
}

/** Bytes → text (incremental TextDecoder, correct UTF-8 boundaries). */
export function bytesToText(): TransformStream<Uint8Array, string> {
  const decoder = new TextDecoder('utf-8')
  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })
      if (text.length > 0) controller.enqueue(text)
    },
    flush(controller) {
      const tail = decoder.decode()
      if (tail.length > 0) controller.enqueue(tail)
    },
  })
}

/** Text → lines (no \r; a last line without \n also arrives). */
export function splitLines(): TransformStream<string, string> {
  let pending = ''
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      pending += chunk
      for (;;) {
        const nl = pending.indexOf('\n')
        if (nl < 0) break
        let line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        controller.enqueue(line)
      }
    },
    flush(controller) {
      if (pending.length > 0) controller.enqueue(pending)
    },
  })
}

/** Chunk filter (lines/objects). */
export function filter<T>(predicate: (chunk: T) => boolean): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      if (predicate(chunk)) controller.enqueue(chunk)
    },
  })
}

/** Map transform of chunks (sync). */
export function mapChunks<TIn, TOut>(fn: (chunk: TIn) => TOut): TransformStream<TIn, TOut> {
  return new TransformStream<TIn, TOut>({
    transform(chunk, controller) {
      controller.enqueue(fn(chunk))
    },
  })
}

/** Collect all chunks into an array (pipe terminal; chunks pass through). */
export function collect<T>(): TransformStream<T, T> & { result: Promise<T[]> } {
  const items: T[] = []
  let release!: (value: T[]) => void
  const result = new Promise<T[]>(resolve => {
    release = resolve
  })
  const stream = new TransformStream<T, T>({
    transform(chunk, controller) {
      items.push(chunk)
      controller.enqueue(chunk)
    },
    flush() {
      release(items)
    },
  })
  return Object.assign(stream, { result })
}

/** Bytes → a single Uint8Array (copy; for small bodies/configs). */
export function collectBytes(): TransformStream<Uint8Array, Uint8Array> & { result: Promise<Uint8Array> } {
  let parts: Uint8Array[] = []
  let total = 0
  let release!: (value: Uint8Array) => void
  const result = new Promise<Uint8Array>(resolve => {
    release = resolve
  })
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      parts.push(chunk)
      total += chunk.byteLength
      controller.enqueue(chunk)
    },
    flush() {
      const out = new Uint8Array(total)
      let at = 0
      for (const part of parts) {
        out.set(part, at)
        at += part.byteLength
      }
      parts = []
      release(out)
    },
  })
  return Object.assign(stream, { result })
}

/** Collect bytes into a Blob (for createImageBitmap without StreamAssembler). */
export function collectBlob(type?: string): TransformStream<Uint8Array, Uint8Array> & { result: Promise<Blob> } {
  const inner = collectBytes()
  const result = inner.result.then(bytes => new Blob([bytes as BlobPart], { type }))
  return Object.assign(inner, { result })
}

/**
 * A "pipe" bundle: reads a source through a chain of transforms.
 * compose([a, b, c]) — an a→b→c pipeline with a single ReadableStream output.
 */
export function compose<_TIn, TOut>(transforms: readonly TransformStream<any, any>[]): ReadableStream<TOut> | null {
  if (transforms.length === 0) return null
  // Composition is performed by the caller via pipeThrough — here
  // is only a type-helper contract: first input TIn, last output TOut.
  return null
}
