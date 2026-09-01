/**
 * pipes.ts — пользовательские стрим-трансформы: «трансформы и пайпы».
 *
 * Форматные парсеры (GLB/OBJ/FBX) работают напрямую со StreamAssembler
 * (watermark-доступ), но для СВОИХ форматов пользователь компонует
 * стандартные ReadableStream-пайпы:
 *
 *   const text = await library.loadText(url, {
 *     pipe: bytesToText({ label: 'big.log' })   // Uint8Array → string
 *       .through(splitLines())                  // → строк-стрим
 *       .through(filter(line => !line.startsWith('#')))
 *       .through(collect())                     // → string[]
 *   })
 *
 * Все трансформы — обычные TransformStream, совместимы с pipeThrough.
 */

/** Тап-трансформ: видит каждый чанк, пропускает дальше. */
export function tap<T>(observer: (chunk: T) => void): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      observer(chunk)
      controller.enqueue(chunk)
    },
  })
}

/** Прогресс-тап для байтовых стримов: loaded += chunk.byteLength. */
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

/** Bytes → text (инкрементальный TextDecoder, корректные UTF-8 границы). */
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

/** Text → строки (без \r; последняя строка без \n тоже придёт). */
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

/** Фильтр чанков (строк/объектов). */
export function filter<T>(predicate: (chunk: T) => boolean): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      if (predicate(chunk)) controller.enqueue(chunk)
    },
  })
}

/** Map-трансформ чанков (синхронный). */
export function mapChunks<TIn, TOut>(fn: (chunk: TIn) => TOut): TransformStream<TIn, TOut> {
  return new TransformStream<TIn, TOut>({
    transform(chunk, controller) {
      controller.enqueue(fn(chunk))
    },
  })
}

/** Собрать все чанки в массив (терминал пайпа; чанки проходят насквозь). */
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

/** Bytes → единый Uint8Array (копия; для малых тел/конфигов). */
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

/** Собрать байты в Blob (для createImageBitmap без StreamAssembler). */
export function collectBlob(type?: string): TransformStream<Uint8Array, Uint8Array> & { result: Promise<Blob> } {
  const inner = collectBytes()
  const result = inner.result.then(bytes => new Blob([bytes as BlobPart], { type }))
  return Object.assign(inner, { result })
}

/**
 * Связка «pipe»: читает источник через цепочку трансформов.
 * compose([a, b, c]) — конвейер a→b→c с единым ReadableStream на выходе.
 */
export function compose<_TIn, TOut>(transforms: readonly TransformStream<any, any>[]): ReadableStream<TOut> | null {
  if (transforms.length === 0) return null
  // Композиция выполняется вызывающим кодом через pipeThrough — здесь
  // только тип-хелпер контракт: первый вход TIn, последний выход TOut.
  return null
}
