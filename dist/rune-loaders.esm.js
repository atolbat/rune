// packages/loaders/src/assembler.ts
function signalAbortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("загрузка отменена", "AbortError");
}
function toAbortError(reason) {
  if (reason instanceof Error)
    return reason;
  return new DOMException(typeof reason === "string" ? reason : "загрузка отменена", "AbortError");
}
function isAbortError(error) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

class Assembler {
  total;
  failure;
  buffer;
  received = 0;
  finished = false;
  waiters = [];
  rangeListeners = [];
  completion;
  releaseCompletion;
  rejectCompletion;
  reader = null;
  constructor(body, options = {}) {
    this.total = options.total;
    this.buffer = new Uint8Array(options.total ?? 1048576);
    this.completion = new Promise((resolve, reject) => {
      this.releaseCompletion = resolve;
      this.rejectCompletion = reject;
    });
    this.completion.catch(() => {});
    const signal = options.signal;
    if (signal !== undefined && signal.aborted) {
      this.fail(signalAbortError(signal));
      return;
    }
    signal?.addEventListener("abort", () => {
      this.reader?.cancel().catch(() => {});
      this.fail(signalAbortError(signal));
    }, { once: true });
    this.pump(body, options.onBytes).catch((err) => this.fail(err));
  }
  get watermark() {
    return this.received;
  }
  get isDone() {
    return this.finished;
  }
  rangeReady(offset, length) {
    return this.received >= offset + length;
  }
  async waitFor(bytes) {
    if (this.received >= bytes || this.finished)
      return;
    await new Promise((resolve, reject) => {
      this.waiters.push({ bytes, resolve, reject });
    });
  }
  onRange(listener) {
    this.rangeListeners.push(listener);
    return () => {
      const idx = this.rangeListeners.indexOf(listener);
      if (idx >= 0)
        this.rangeListeners.splice(idx, 1);
    };
  }
  slice(offset, length) {
    if (this.received < offset + length)
      throw new Error(`range [${offset}, ${offset + length}) не получен (watermark ${this.received})`);
    return this.buffer.slice(offset, offset + length);
  }
  prefixView(length) {
    if (this.received < length)
      throw new Error(`prefix ${length} не получен (watermark ${this.received})`);
    return new Uint8Array(this.buffer.buffer, 0, length);
  }
  fullView() {
    if (!this.finished)
      throw new Error("тело ещё не получено полностью");
    return new Uint8Array(this.buffer.buffer, 0, this.received);
  }
  async pump(body, onBytes) {
    const reader = body.getReader();
    this.reader = reader;
    for (;; ) {
      const { done, value } = await reader.read();
      if (value !== undefined && value.byteLength > 0) {
        this.ensureCapacity(this.received + value.byteLength);
        this.buffer.set(value, this.received);
        this.received += value.byteLength;
        if (onBytes !== undefined)
          onBytes(this.received, this.total ?? 0);
        this.drainWaiters();
        for (const listener of [...this.rangeListeners])
          listener(this.received);
      }
      if (done)
        break;
    }
    this.finished = true;
    this.drainWaiters();
    for (const listener of [...this.rangeListeners])
      listener(this.received);
    this.releaseCompletion();
  }
  ensureCapacity(needed) {
    if (needed <= this.buffer.byteLength)
      return;
    let capacity = Math.max(this.buffer.byteLength, 1048576);
    while (capacity < needed)
      capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.received), 0);
    this.buffer = grown;
  }
  drainWaiters() {
    for (let i = this.waiters.length - 1;i >= 0; i--) {
      const waiter = this.waiters[i];
      if (this.received >= waiter.bytes || this.finished) {
        this.waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }
  fail(error) {
    if (this.finished)
      return;
    this.finished = true;
    this.failure = error;
    for (const waiter of [...this.waiters])
      waiter.reject(error);
    this.waiters.length = 0;
    this.rejectCompletion(error);
  }
}
var nextJobId = 1;
function allocJobId() {
  return nextJobId++;
}

class FetchScheduler {
  maxConcurrent;
  maxBytesInFlight;
  queue = [];
  running = new Map;
  weights = new Map;
  bytesInFlight = 0;
  paused = false;
  started = 0;
  finished = 0;
  drainListeners = new Set;
  constructor(options = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.maxBytesInFlight = Math.max(1, options.maxBytesInFlight ?? 67108864);
  }
  submit(job) {
    this.queue.push(job);
    this.sortQueue();
    this.pump();
  }
  setPriority(job, priority) {
    if (job.priority === priority)
      return false;
    job.priority = priority;
    const inQueue = this.queue.includes(job);
    if (inQueue)
      this.sortQueue();
    this.pump();
    return inQueue;
  }
  cancel(job, reason) {
    const idx = this.queue.indexOf(job);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      job.onCancelledBeforeStart?.(reason);
      this.notifyDrain();
      return true;
    }
    const entry = this.running.get(job.id);
    if (entry !== undefined) {
      entry.controller.abort(new DOMException(reason ?? "загрузка отменена", "AbortError"));
      return true;
    }
    return false;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.pump();
  }
  get isPaused() {
    return this.paused;
  }
  setBytesQuota(maxBytes) {
    this.maxBytesInFlight = Math.max(1, maxBytes);
    this.pump();
  }
  updateWeight(job) {
    if (!this.running.has(job.id))
      return;
    const previous = this.weights.get(job.id);
    const updated = Math.max(1, job.weight());
    if (previous === updated)
      return;
    this.weights.set(job.id, updated);
    this.bytesInFlight += updated - (previous ?? updated);
    if (this.bytesInFlight < 0)
      this.bytesInFlight = 0;
    this.pump();
  }
  setConcurrency(maxConcurrent) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.pump();
  }
  stats() {
    return {
      running: this.running.size,
      queued: this.queue.length,
      bytesInFlight: this.bytesInFlight,
      maxConcurrent: this.maxConcurrent,
      maxBytesInFlight: this.maxBytesInFlight,
      started: this.started,
      finished: this.finished
    };
  }
  onDrain(listener) {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }
  notifyDrain() {
    if (this.queue.length === 0 && this.running.size === 0)
      for (const listener of [...this.drainListeners])
        listener();
  }
  sortQueue() {
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }
  pump() {
    if (this.paused)
      return;
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue[0];
      if (job === undefined)
        break;
      const weight = Math.max(1, job.weight());
      if (this.running.size > 0 && this.bytesInFlight + weight > this.maxBytesInFlight)
        break;
      this.queue.shift();
      const controller = new AbortController;
      this.running.set(job.id, { job, controller });
      this.weights.set(job.id, weight);
      this.bytesInFlight += weight;
      this.started++;
      job.start(controller.signal).then(() => this.finish(job.id, undefined), (error) => this.finish(job.id, error));
    }
  }
  finish(jobId, _error) {
    const entry = this.running.get(jobId);
    if (entry === undefined)
      return;
    this.running.delete(jobId);
    const weight = this.weights.get(jobId) ?? Math.max(1, entry.job.weight());
    this.weights.delete(jobId);
    this.bytesInFlight -= weight;
    if (this.bytesInFlight < 0)
      this.bytesInFlight = 0;
    this.finished++;
    this.pump();
    this.notifyDrain();
  }
}
async function fetchStreaming(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = Math.max(0, options.retries ?? 1);
  const connectTimeoutMs = options.connectTimeoutMs ?? 30000;
  let lastError = null;
  for (let attempt = 0;attempt <= retries; attempt++) {
    if (options.signal?.aborted)
      throw signalAbortError(options.signal);
    const controller = new AbortController;
    const clearTimer = connectTimeoutTimer(controller, connectTimeoutMs, options.signal);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      clearTimer();
      chainAbort(options.signal, controller);
      if (!response.ok || response.body === null) {
        const retryable = response.status >= 500 || response.status === 429;
        lastError = new TypeError(`HTTP ${response.status} ${response.statusText} — ${url}`);
        if (retryable && attempt < retries) {
          await backoffDelay(attempt, options.signal);
          continue;
        }
        throw lastError;
      }
      const contentLengthHeader = response.headers.get("content-length");
      const headerValue = contentLengthHeader !== null ? Number(contentLengthHeader) : undefined;
      const assembler = new Assembler(response.body, {
        total: Number.isFinite(headerValue) ? headerValue : undefined,
        signal: options.signal,
        onBytes: options.onBytes
      });
      return { url, contentLength: assembler.total, assembler, done: assembler.completion };
    } catch (error) {
      clearTimer();
      if (isAbortError(error))
        throw error;
      lastError = error;
      if (attempt < retries) {
        await backoffDelay(attempt, options.signal);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error(`источник недоступен: ${url}`);
}
function connectTimeoutTimer(controller, ms, _external) {
  const timer = setTimeout(() => {
    controller.abort(new DOMException("таймаут соединения", "TimeoutError"));
  }, ms);
  return () => clearTimeout(timer);
}
function chainAbort(external, controller) {
  if (external === undefined)
    return;
  if (external.aborted) {
    controller.abort(signalAbortError(external));
    return;
  }
  external.addEventListener("abort", () => {
    controller.abort(signalAbortError(external));
  }, { once: true });
}
async function backoffDelay(attempt, signal) {
  const delay = Math.min(4000, 250 * 2 ** attempt);
  await sleepAbortable(delay, signal);
}
function sleepAbortable(ms, signal) {
  if (signal?.aborted)
    return Promise.reject(signalAbortError(signal));
  return new Promise((resolve, reject) => {
    const external = signal;
    const timer = setTimeout(() => {
      external?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signalAbortError(external));
    };
    external?.addEventListener("abort", onAbort, { once: true });
  });
}
async function inflateDeflate(compressed) {
  if (typeof DecompressionStream > "u")
    throw new Error("DecompressionStream недоступен — бинарный FBX с zlib-сжатием не поддерживается в этой среде");
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const chunks = [];
  let total = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (value !== undefined) {
      chunks.push(value);
      total += value.byteLength;
    }
    if (done)
      break;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
// packages/loaders/src/bytes.ts
var CHAR = {
  CR: 13,
  LF: 10,
  SPACE: 32,
  TAB: 9,
  HASH: 35,
  SLASH: 47,
  MINUS: 45,
  PLUS: 43,
  DOT: 46,
  EXP_E: 101,
  EXP_EU: 69,
  DIGIT_0: 48,
  DIGIT_9: 57
};
function isWhitespace(byte) {
  return byte === CHAR.SPACE || byte === CHAR.TAB || byte === CHAR.CR || byte === CHAR.LF;
}
function asciiDecode(bytes, start, length) {
  let out = "";
  const CHUNK = 8192;
  for (let at = start;at < start + length; at += CHUNK) {
    const end = Math.min(at + CHUNK, start + length);
    out += String.fromCharCode(...bytes.subarray(at, end));
  }
  return out;
}
function parseDecimal(bytes, start, end) {
  if (start >= end)
    return NaN;
  let at = start;
  let negative = false;
  const first = bytes[at];
  if (first === CHAR.MINUS) {
    negative = true;
    at++;
  } else if (first === CHAR.PLUS) {
    at++;
  }
  let intPart = 0;
  let fracDigits = 0;
  let fracCount = 0;
  let expDigits = 0;
  let expSign = 1;
  let sawDigit = false;
  let sawDot = false;
  let sawExp = false;
  for (;at < end; at++) {
    const b = bytes[at];
    if (b >= CHAR.DIGIT_0 && b <= CHAR.DIGIT_9) {
      sawDigit = true;
      if (sawExp) {
        expDigits = expDigits * 10 + (b - CHAR.DIGIT_0);
      } else if (sawDot) {
        fracDigits = fracDigits * 10 + (b - CHAR.DIGIT_0);
        fracCount++;
      } else {
        intPart = intPart * 10 + (b - CHAR.DIGIT_0);
      }
    } else if (b === CHAR.DOT && !sawDot && !sawExp) {
      sawDot = true;
    } else if ((b === CHAR.EXP_E || b === CHAR.EXP_EU) && !sawExp && sawDigit) {
      sawExp = true;
      if (at + 1 < end && (bytes[at + 1] === CHAR.MINUS || bytes[at + 1] === CHAR.PLUS)) {
        if (bytes[at + 1] === CHAR.MINUS)
          expSign = -1;
        at++;
      }
    } else {
      break;
    }
  }
  if (!sawDigit)
    return NaN;
  let value = intPart;
  if (fracCount > 0)
    value += fracDigits / 10 ** fracCount;
  const exponent = expSign * expDigits;
  if (exponent !== 0)
    value *= 10 ** exponent;
  return negative ? -value : value;
}
function align4(n) {
  const rest = n % 4;
  return rest === 0 ? n : n + 4 - rest;
}
function nowMs() {
  return typeof performance < "u" ? performance.now() : Date.now();
}
function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// packages/loaders/src/gltf.ts
var GLB_MAGIC = 1179937895;
var GLB_CHUNK_JSON = 1313821514;
var GLB_CHUNK_BIN = 5130562;
var COMPONENT_FLOAT = 5126;
var COMPONENT_UNSIGNED_INT = 5125;
var COMPONENT_UNSIGNED_SHORT = 5123;
var UNSUPPORTED_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_texture_basisu"
]);
var COMPONENT_SIZE = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4
};
var TYPE_COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16
};
function isGltfJson(bytes) {
  return bytes.length >= 4 && asciiDecode(bytes, 0, 4) === "glTF";
}
async function parseGlb(assembler, options = {}) {
  const startedAt = nowMs();
  const onPhase = options.onPhase ?? (() => {});
  let zeroCopyCount = 0;
  await assembler.waitFor(20);
  const header = new DataView(assembler.slice(0, 20).buffer);
  if (header.getUint32(0, true) !== GLB_MAGIC)
    throw new Error("не GLB: магик не glTF");
  const version = header.getUint32(4, true);
  if (version !== 2)
    throw new Error(`GLB версии ${version} не поддерживается (только 2)`);
  const declaredTotal = header.getUint32(8, true);
  const jsonLength = header.getUint32(12, true);
  if (header.getUint32(16, true) !== GLB_CHUNK_JSON)
    throw new Error("GLB: первый чанк не JSON");
  onPhase({ stage: "json", ratio: 0.05, detail: `${formatBytesRounded(jsonLength)} JSON` });
  await assembler.waitFor(20 + jsonLength);
  const jsonText = new TextDecoder("utf-8").decode(assembler.slice(20, jsonLength));
  const json = JSON.parse(jsonText);
  assertRequiredExtensions(json, options.dracoDecoder);
  const binHeaderOffset = 20 + align4(jsonLength);
  let binLength = 0;
  let binStart = -1;
  if (assembler.total === undefined) {
    await assembler.completion;
    if (assembler.watermark > binHeaderOffset + 8) {
      const binHeader = new DataView(assembler.slice(binHeaderOffset, 8).buffer);
      binLength = binHeader.getUint32(0, true);
      binStart = binHeader.getUint32(4, true) === GLB_CHUNK_BIN ? binHeaderOffset + 8 : -1;
    }
  } else if (binHeaderOffset + 8 <= assembler.total) {
    await assembler.waitFor(binHeaderOffset + 8);
    const binHeader = new DataView(assembler.slice(binHeaderOffset, 8).buffer);
    binLength = binHeader.getUint32(0, true);
    binStart = binHeader.getUint32(4, true) === GLB_CHUNK_BIN ? binHeaderOffset + 8 : -1;
  }
  const totalKnown = assembler.total !== undefined;
  onPhase({
    stage: "bin",
    ratio: 0.15,
    detail: binStart >= 0 ? `BIN ${formatBytesRounded(binLength)}` : "без BIN-чанка"
  });
  const binReady = (length) => binStart < 0 ? assembler.isDone : assembler.watermark - binStart >= length;
  const waitBin = async (length) => {
    if (binStart < 0 || binReady(length))
      return;
    await assembler.waitFor(binStart + length);
  };
  const binSource = {
    ready: (offset, length) => binReady(offset + length),
    wait: (offset, length) => waitBin(offset + length),
    view: (offset, length) => {
      if (binStart < 0)
        throw new Error("GLB без BIN-чанка: буферы должны быть внешними uri");
      if (!binReady(offset + length))
        throw new Error(`BIN-диапазон [${offset}, ${offset + length}) не получен`);
      if (totalKnown) {
        zeroCopyCount++;
        return new Uint8Array(assembler.prefixView(assembler.watermark).buffer, binStart + offset, length);
      }
      return assembler.slice(binStart + offset, length);
    },
    onRange: (listener) => assembler.onRange((watermark) => listener(Math.max(0, watermark - binStart))),
    zeroCopy: () => {
      zeroCopyCount++;
    }
  };
  const model = await parseGltfDocument(json, {
    buffers: [binSource],
    phase: onPhase,
    signal: options.signal,
    createBitmap: options.createBitmap,
    dracoDecoder: options.dracoDecoder
  });
  await assembler.completion;
  if (assembler.total !== undefined && assembler.watermark !== declaredTotal)
    throw new Error(`GLB неполный: ${assembler.watermark} из ${declaredTotal} байт`);
  return withStats(model, "glb", {
    jsonBytes: jsonLength,
    binBytes: binStart >= 0 ? binLength : 0,
    parseMs: nowMs() - startedAt,
    zeroCopyViews: zeroCopyCount
  });
}
async function parseGltfJson(text, external, options = {}) {
  const startedAt = nowMs();
  const onPhase = options.onPhase ?? (() => {});
  const json = JSON.parse(text);
  assertRequiredExtensions(json, options.dracoDecoder);
  onPhase({
    stage: "buffers",
    ratio: 0.1,
    detail: `${json.buffers?.length ?? 0} внешних буферов`
  });
  const externals = [];
  for (const buffer of json.buffers ?? [])
    externals.push(await external.loadExternal(buffer.uri ?? ""));
  const sources = externals.map((bytes) => ({
    ready: () => true,
    wait: async () => {},
    view: (offset, length) => bytes.subarray(offset, offset + length),
    onRange: () => () => {},
    zeroCopy: () => {}
  }));
  const model = await parseGltfDocument(json, {
    buffers: sources,
    phase: onPhase,
    signal: options.signal,
    createBitmap: options.createBitmap,
    dracoDecoder: options.dracoDecoder,
    loadImageBytes: (uri) => external.loadExternal(uri)
  });
  return withStats(model, "gltf", {
    jsonBytes: text.length,
    binBytes: externals.reduce((sum, b) => sum + b.byteLength, 0),
    parseMs: nowMs() - startedAt,
    zeroCopyViews: 0
  });
}
async function parseGltfDocument(json, ctx) {
  const accessors = json.accessors ?? [];
  const bufferViews = json.bufferViews ?? [];
  const textureSource = (index) => {
    if (index === undefined || json.textures === undefined)
      return { image: null, sampler: null };
    const texture = json.textures[index];
    if (texture === undefined)
      return { image: null, sampler: null };
    return {
      image: texture.source ?? texture.extensions?.EXT_texture_webp?.source ?? texture.extensions?.EXT_texture_avif?.source ?? null,
      sampler: texture.sampler ?? null
    };
  };
  const materials = (json.materials ?? []).map((m) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const factor = pbr.baseColorFactor ?? [1, 1, 1, 1];
    return {
      name: m.name ?? "",
      baseColorFactor: [factor[0] ?? 1, factor[1] ?? 1, factor[2] ?? 1, factor[3] ?? 1],
      metallicFactor: pbr.metallicFactor ?? 1,
      roughnessFactor: pbr.roughnessFactor ?? 1,
      baseColorImage: textureSource(pbr.baseColorTexture?.index).image,
      mrImage: textureSource(pbr.metallicRoughnessTexture?.index).image,
      normalImage: textureSource(m.normalTexture?.index).image,
      occlusionImage: textureSource(m.occlusionTexture?.index).image,
      emissiveImage: textureSource(m.emissiveTexture?.index).image,
      emissiveFactor: [...m.emissiveFactor ?? [0, 0, 0]],
      alphaMode: m.alphaMode ?? "OPAQUE",
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: m.doubleSided ?? false,
      unlit: m.extensions?.KHR_materials_unlit !== undefined
    };
  });
  const createBitmap = ctx.createBitmap ?? (typeof createImageBitmap === "function" ? (bytes, mime, opts) => createImageBitmap(new Blob([bytes], { type: mime }), opts ?? { premultiplyAlpha: "none" }) : undefined);
  const imageBitmaps = [];
  const images = [];
  const rawImages = json.images ?? [];
  for (let imageIndex = 0;imageIndex < rawImages.length; imageIndex++) {
    const raw = rawImages[imageIndex];
    const name = raw.name ?? `image-${imageIndex}`;
    const mimeType = raw.mimeType ?? "image/png";
    let bytes = new Uint8Array(0);
    let resolveBitmap;
    let rejectBitmap;
    const bitmap = new Promise((resolve, reject) => {
      resolveBitmap = resolve;
      rejectBitmap = reject;
    });
    const samplerIndex = findSamplerForImage(json, imageIndex);
    const rawSampler = samplerIndex !== null ? json.samplers?.[samplerIndex] : undefined;
    const image = {
      name,
      mimeType,
      get bytes() {
        return bytes;
      },
      bitmap,
      sampler: rawSampler !== undefined ? {
        magFilter: rawSampler.magFilter ?? 9729,
        minFilter: rawSampler.minFilter ?? 9987,
        wrapS: rawSampler.wrapS ?? 10497,
        wrapT: rawSampler.wrapT ?? 10497
      } : null
    };
    images.push(image);
    imageBitmaps.push(bitmap.then(() => {}, () => {}));
    const startDecode = () => {
      try {
        if (createBitmap === undefined) {
          rejectBitmap(new Error("createImageBitmap недоступен в этой среде"));
          return;
        }
        createBitmap(bytes, mimeType).then(resolveBitmap, rejectBitmap);
      } catch (error) {
        rejectBitmap(error);
      }
    };
    if (raw.bufferView !== undefined) {
      const view = bufferViews[raw.bufferView];
      if (view === undefined) {
        rejectBitmap(new Error(`image ${name}: bufferView ${raw.bufferView} не найден`));
        continue;
      }
      const byteOffset = view.byteOffset ?? 0;
      const byteLength = view.byteLength;
      const source = ctx.buffers[view.buffer ?? 0];
      if (source === undefined) {
        rejectBitmap(new Error(`image ${name}: буфер ${view.buffer ?? 0} не найден`));
        continue;
      }
      if (source.ready(byteOffset, byteLength)) {
        bytes = source.view(byteOffset, byteLength);
        startDecode();
      } else {
        const unsubscribe = source.onRange((available) => {
          if (available >= byteOffset + byteLength) {
            unsubscribe();
            try {
              bytes = source.view(byteOffset, byteLength);
              startDecode();
            } catch (error) {
              rejectBitmap(error);
            }
          }
        });
      }
    } else if (raw.uri !== undefined && ctx.loadImageBytes !== undefined) {
      try {
        bytes = await ctx.loadImageBytes(raw.uri);
        startDecode();
      } catch (error) {
        rejectBitmap(error);
      }
    } else {
      rejectBitmap(new Error(`image ${name}: нет ни bufferView, ни загрузчика uri`));
    }
  }
  const plans = [];
  const rawMeshes = json.meshes ?? [];
  for (let meshIndex = 0;meshIndex < rawMeshes.length; meshIndex++)
    for (const primitive of rawMeshes[meshIndex].primitives) {
      let minOffset = Number.POSITIVE_INFINITY;
      const dracoView = primitive.extensions?.KHR_draco_mesh_compression?.bufferView;
      if (dracoView !== undefined) {
        const view = bufferViews[dracoView];
        if (view !== undefined)
          minOffset = Math.min(minOffset, view.byteOffset ?? 0);
      }
      const consider = (accessorIndex) => {
        if (accessorIndex === undefined)
          return;
        const accessor = accessors[accessorIndex];
        if (accessor?.bufferView === undefined)
          return;
        const view = bufferViews[accessor.bufferView];
        if (view === undefined)
          return;
        minOffset = Math.min(minOffset, (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0));
      };
      consider(primitive.attributes.POSITION);
      consider(primitive.attributes.NORMAL);
      consider(primitive.attributes.TEXCOORD_0);
      consider(primitive.indices);
      plans.push({ meshIndex, primitive, minOffset: Number.isFinite(minOffset) ? minOffset : 0 });
    }
  plans.sort((a, b) => a.minOffset - b.minOffset);
  const primitivesPerMesh = rawMeshes.map(() => []);
  let parsedCount = 0;
  for (const plan of plans) {
    throwIfAborted(ctx.signal);
    const { primitive } = plan;
    let positions;
    let normals;
    let uvs;
    let indices;
    const draco = primitive.extensions?.KHR_draco_mesh_compression;
    if (draco !== undefined) {
      if (ctx.dracoDecoder === undefined)
        throw new Error("примитив сжат KHR_draco_mesh_compression, но декодер не передан " + "(GltfParseOptions.dracoDecoder) — сжатая геометрия не читается");
      const view = bufferViews[draco.bufferView];
      if (view === undefined)
        throw new Error(`Draco: bufferView ${draco.bufferView} не найден`);
      const source = ctx.buffers[view.buffer ?? 0];
      if (source === undefined)
        throw new Error(`Draco: буфер ${view.buffer ?? 0} не найден`);
      const byteOffset = view.byteOffset ?? 0;
      await source.wait(byteOffset, view.byteLength);
      const dracoBytes = source.view(byteOffset, view.byteLength);
      const decoded = await ctx.dracoDecoder(dracoBytes, draco.attributes ?? {});
      positions = decoded.positions;
      normals = decoded.normals;
      uvs = decoded.uvs;
      indices = decoded.indices;
    } else {
      positions = await readFloatAttribute(primitive.attributes.POSITION, "POSITION", accessors, bufferViews, ctx);
      normals = primitive.attributes.NORMAL !== undefined ? await readFloatAttribute(primitive.attributes.NORMAL, "NORMAL", accessors, bufferViews, ctx) : null;
      uvs = primitive.attributes.TEXCOORD_0 !== undefined ? await readFloatAttribute(primitive.attributes.TEXCOORD_0, "TEXCOORD_0", accessors, bufferViews, ctx) : null;
      indices = primitive.indices !== undefined ? await readIndices(primitive.indices, accessors, bufferViews, ctx) : null;
    }
    const positionAccessor = primitive.attributes.POSITION !== undefined ? accessors[primitive.attributes.POSITION] : undefined;
    primitivesPerMesh[plan.meshIndex].push({
      positions,
      normals,
      uvs,
      indices,
      material: primitive.material ?? null,
      vertexCount: positions.length / 3,
      bounds: computeBounds(positionAccessor, positions)
    });
    parsedCount++;
    ctx.phase({
      stage: "geometry",
      ratio: 0.2 + 0.75 * (parsedCount / plans.length),
      detail: `${parsedCount}/${plans.length} примитивов`
    });
  }
  ctx.phase({ stage: "geometry", ratio: 0.95, detail: `${parsedCount} примитивов` });
  const meshes = rawMeshes.map((mesh, index) => ({
    name: mesh.name ?? `mesh-${index}`,
    primitives: primitivesPerMesh[index] ?? []
  }));
  const nodes = (json.nodes ?? []).map((node, index) => ({
    name: node.name ?? `node-${index}`,
    children: node.children ?? [],
    mesh: node.mesh ?? null,
    matrix: node.matrix ?? null,
    translation: node.translation ?? null,
    rotation: node.rotation ?? null,
    scale: node.scale ?? null
  }));
  const sceneIndex = json.scene ?? 0;
  const sceneRoots = json.scenes?.[sceneIndex]?.nodes ?? [];
  return {
    json,
    meshes,
    materials,
    images,
    nodes,
    sceneRoots,
    whenImagesDecoded: async () => {
      await Promise.all(imageBitmaps);
    }
  };
}
async function readFloatAttribute(accessorIndex, semantic, accessors, bufferViews, ctx) {
  if (accessorIndex === undefined)
    throw new Error(`примитив без атрибута ${semantic}`);
  const accessor = accessors[accessorIndex];
  if (accessor === undefined)
    throw new Error(`аксессор ${semantic} #${accessorIndex} не найден`);
  const numComponents = TYPE_COMPONENTS[accessor.type] ?? 0;
  if (numComponents === 0)
    throw new Error(`аксессор ${semantic}: тип ${accessor.type} не векторный`);
  if (accessor.sparse !== undefined)
    throw new Error(`аксессор ${semantic}: sparse не поддерживается`);
  const count = accessor.count;
  if (accessor.bufferView === undefined)
    return new Float32Array(count * numComponents);
  const view = bufferViews[accessor.bufferView];
  if (view === undefined)
    throw new Error(`bufferView ${accessor.bufferView} не найден (${semantic})`);
  const source = ctx.buffers[view.buffer ?? 0];
  if (source === undefined)
    throw new Error(`буфер ${view.buffer ?? 0} не найден (${semantic})`);
  const componentType = accessor.componentType;
  const componentSize = COMPONENT_SIZE[componentType] ?? 0;
  if (componentSize === 0)
    throw new Error(`componentType ${componentType} не поддержан (${semantic})`);
  const byteStride = view.byteStride ?? 0;
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const tightBytes = count * numComponents * componentSize;
  const spanBytes = byteStride > 0 ? (count - 1) * byteStride + numComponents * componentSize : tightBytes;
  await source.wait(byteOffset, spanBytes);
  const view8 = source.view(byteOffset, spanBytes);
  if (byteStride === 0 && componentType === COMPONENT_FLOAT && view8.byteOffset % 4 === 0)
    return source.zeroCopy(), new Float32Array(view8.buffer, view8.byteOffset, count * numComponents);
  if (componentType === COMPONENT_FLOAT && byteStride > 0 && byteStride % 4 === 0 && view8.byteOffset % 4 === 0) {
    const strided = new Float32Array(view8.buffer, view8.byteOffset, view8.byteLength / 4);
    const packed = new Float32Array(count * numComponents);
    const strideComponents = byteStride / 4;
    for (let vertex = 0;vertex < count; vertex++)
      packed.set(strided.subarray(vertex * strideComponents, vertex * strideComponents + numComponents), vertex * numComponents);
    return packed;
  }
  const dataView = new DataView(view8.buffer, view8.byteOffset, view8.byteLength);
  const out = new Float32Array(count * numComponents);
  const normalized = accessor.normalized ?? false;
  const rowBytes = byteStride > 0 ? byteStride : numComponents * componentSize;
  let outAt = 0;
  for (let vertex = 0;vertex < count; vertex++) {
    const rowStart = vertex * rowBytes;
    for (let component = 0;component < numComponents; component++) {
      const at = rowStart + component * componentSize;
      let value;
      switch (componentType) {
        case 5126:
          value = dataView.getFloat32(at, true);
          break;
        case 5125:
          value = dataView.getUint32(at, true);
          break;
        case 5123:
          value = dataView.getUint16(at, true);
          if (normalized)
            value /= 65535;
          break;
        case 5122:
          value = dataView.getInt16(at, true);
          if (normalized)
            value = Math.max(value / 32767, -1);
          break;
        case 5121:
          value = view8[at];
          if (normalized)
            value /= 255;
          break;
        case 5120:
          value = dataView.getInt8(at);
          if (normalized)
            value = Math.max(value / 127, -1);
          break;
        default:
          throw new Error(`componentType ${componentType} не поддержан`);
      }
      out[outAt++] = value;
    }
  }
  return out;
}
async function readIndices(accessorIndex, accessors, bufferViews, ctx) {
  const accessor = accessors[accessorIndex];
  if (accessor === undefined)
    throw new Error(`аксессор indices #${accessorIndex} не найден`);
  if (accessor.type !== "SCALAR")
    throw new Error("indices: тип не SCALAR");
  const count = accessor.count;
  if (accessor.bufferView === undefined)
    return new Uint16Array(0);
  const view = bufferViews[accessor.bufferView];
  if (view === undefined)
    throw new Error(`bufferView ${accessor.bufferView} не найден (indices)`);
  const source = ctx.buffers[view.buffer ?? 0];
  if (source === undefined)
    throw new Error(`буфер ${view.buffer ?? 0} не найден (indices)`);
  const componentSize = COMPONENT_SIZE[accessor.componentType] ?? 0;
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const byteLength = count * componentSize;
  await source.wait(byteOffset, byteLength);
  const view8 = source.view(byteOffset, byteLength);
  if (accessor.componentType === COMPONENT_UNSIGNED_SHORT && view8.byteOffset % 2 === 0)
    return source.zeroCopy(), new Uint16Array(view8.buffer, view8.byteOffset, count);
  if (accessor.componentType === COMPONENT_UNSIGNED_INT && view8.byteOffset % 4 === 0)
    return source.zeroCopy(), new Uint32Array(view8.buffer, view8.byteOffset, count);
  const dataView = new DataView(view8.buffer, view8.byteOffset, view8.byteLength);
  if (accessor.componentType === COMPONENT_UNSIGNED_SHORT) {
    const out = new Uint16Array(count);
    for (let i = 0;i < count; i++)
      out[i] = dataView.getUint16(i * 2, true);
    return out;
  }
  if (accessor.componentType === COMPONENT_UNSIGNED_INT) {
    const out = new Uint32Array(count);
    for (let i = 0;i < count; i++)
      out[i] = dataView.getUint32(i * 4, true);
    return out;
  }
  throw new Error(`indices componentType ${accessor.componentType} не поддержан`);
}
function computeBounds(accessor, positions) {
  if (accessor?.min !== undefined && accessor.min.length >= 3) {
    const max2 = accessor.max ?? [0, 0, 0];
    return { min: [...accessor.min.slice(0, 3)], max: [...max2.slice(0, 3)] };
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0;i < positions.length; i += 3)
    for (let axis = 0;axis < 3; axis++) {
      const value = positions[i + axis];
      if (value < min[axis])
        min[axis] = value;
      if (value > max[axis])
        max[axis] = value;
    }
  if (!Number.isFinite(min[0]))
    return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}
function findSamplerForImage(json, imageIndex) {
  for (const texture of json.textures ?? [])
    if ((texture.source ?? texture.extensions?.EXT_texture_webp?.source ?? texture.extensions?.EXT_texture_avif?.source) === imageIndex)
      return texture.sampler ?? null;
  return null;
}
function assertRequiredExtensions(json, dracoDecoder) {
  for (const extension of json.extensionsRequired ?? []) {
    if (extension === "KHR_draco_mesh_compression" && dracoDecoder !== undefined)
      continue;
    if (UNSUPPORTED_EXTENSIONS.has(extension))
      throw new Error(`glTF требует ${extension} — ${extension === "KHR_draco_mesh_compression" ? "декодер не передан (GltfParseOptions.dracoDecoder)" : "сжатие геометрии/текстур не поддерживается парсером (поддерживается EXT_texture_webp — нативно браузером)"}`);
  }
}
function throwIfAborted(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new DOMException("парсинг отменён", "AbortError");
}
function withStats(model, kind, input) {
  let vertices = 0;
  let triangles = 0;
  let primitives = 0;
  for (const mesh of model.meshes)
    for (const primitive of mesh.primitives) {
      vertices += primitive.vertexCount;
      triangles += primitive.indices !== null ? primitive.indices.length / 3 : primitive.vertexCount / 3;
      primitives++;
    }
  return {
    ...model,
    kind,
    stats: {
      jsonBytes: input.jsonBytes,
      binBytes: input.binBytes,
      vertices,
      triangles,
      primitives,
      images: model.images.length,
      parseMs: input.parseMs,
      zeroCopyViews: input.zeroCopyViews
    }
  };
}
function formatBytesRounded(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function looksLikeGlb(bytes) {
  return bytes.length >= 4 && bytes[0] === 103 && bytes[1] === 108 && bytes[2] === 84 && bytes[3] === 70;
}
// packages/loaders/src/obj.ts
class FloatBuilder {
  data;
  count = 0;
  constructor(capacity) {
    this.data = new Float32Array(capacity);
  }
  push3(a, b, c) {
    this.ensure(3);
    this.data[this.count++] = a;
    this.data[this.count++] = b;
    this.data[this.count++] = c;
  }
  push2(a, b) {
    this.ensure(2);
    this.data[this.count++] = a;
    this.data[this.count++] = b;
  }
  ensure(extra) {
    if (this.count + extra <= this.data.length)
      return;
    let capacity = this.data.length * 2;
    while (capacity < this.count + extra)
      capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(this.data.subarray(0, this.count), 0);
    this.data = grown;
  }
}

class CornerBuilder {
  data;
  count = 0;
  constructor(capacity) {
    this.data = new Int32Array(capacity * 3);
  }
  push(v, t, n) {
    if (this.count * 3 + 3 > this.data.length) {
      let capacity = this.data.length * 2;
      while (capacity < (this.count + 1) * 3)
        capacity *= 2;
      const grown = new Int32Array(capacity);
      grown.set(this.data);
      this.data = grown;
    }
    const at = this.count * 3;
    this.data[at] = v;
    this.data[at + 1] = t;
    this.data[at + 2] = n;
    return this.count++;
  }
}

class TokenScanner {
  bytes;
  end;
  at;
  constructor(bytes, start, end) {
    this.bytes = bytes;
    this.end = end;
    let at = start;
    while (at < end && isWhitespace(bytes[at]))
      at++;
    this.at = at;
  }
  nextToken() {
    if (this.at >= this.end)
      return null;
    const start = this.at;
    while (this.at < this.end && !isWhitespace(this.bytes[this.at]))
      this.at++;
    const tokenEnd = this.at;
    while (this.at < this.end && isWhitespace(this.bytes[this.at]))
      this.at++;
    return this.bytes.subarray(start, tokenEnd);
  }
  nextFloat() {
    const token = this.nextToken();
    return token === null ? NaN : parseDecimal(token, 0, token.length);
  }
}

class ObjParser {
  positions = new FloatBuilder(4096);
  normals = new FloatBuilder(4096);
  uvs = new FloatBuilder(1024);
  corners = new CornerBuilder(1024);
  groups = [];
  groupVertexStart = 0;
  currentName = "default";
  currentMaterial = null;
  tail = new Uint8Array(0);
  lines = 0;
  hasNormals = false;
  hasUvs = false;
  received = 0;
  onPhase;
  expectedBytes;
  mtllib = null;
  constructor(options = {}) {
    this.expectedBytes = options.expectedBytes;
    this.onPhase = options.onPhase;
  }
  feed(chunk) {
    if (this.tail.length > 0) {
      const merged = new Uint8Array(this.tail.length + chunk.length);
      merged.set(this.tail, 0);
      merged.set(chunk, this.tail.length);
      chunk = merged;
    }
    this.received += chunk.length;
    let lineStart = 0;
    for (let i = 0;i < chunk.length; i++)
      if (chunk[i] === CHAR.LF) {
        let lineEnd = i;
        if (lineEnd > lineStart && chunk[lineEnd - 1] === CHAR.CR)
          lineEnd--;
        if (lineEnd > lineStart)
          this.parseLine(chunk, lineStart, lineEnd);
        lineStart = i + 1;
      }
    this.tail = chunk.subarray(lineStart);
    if (this.onPhase !== undefined && this.expectedBytes !== undefined && this.expectedBytes > 0)
      this.onPhase({
        stage: "lines",
        ratio: Math.min(0.9, this.received / this.expectedBytes),
        detail: `${this.lines} строк · ${Math.floor(this.corners.count / 3)} тр.`
      });
  }
  finish() {
    const startedAt = nowMs();
    if (this.tail.length > 0) {
      let end = this.tail.length;
      if (end > 0 && this.tail[end - 1] === CHAR.CR)
        end--;
      if (end > 0)
        this.parseLine(this.tail, 0, end);
      this.tail = new Uint8Array(0);
    }
    this.closeGroup();
    const cornerCount = this.corners.count;
    const cornerData = this.corners.data;
    const positions = new Float32Array(cornerCount * 3);
    const normals = new Float32Array(cornerCount * 3);
    const uvs = this.hasUvs ? new Float32Array(cornerCount * 2) : null;
    const rawPositions = this.positions.data;
    const rawNormals = this.normals.data;
    const rawUvs = this.uvs.data;
    for (let corner = 0;corner < cornerCount; corner++) {
      const at = corner * 3;
      const positionIndex = (cornerData[at] - 1) * 3;
      positions[corner * 3] = rawPositions[positionIndex];
      positions[corner * 3 + 1] = rawPositions[positionIndex + 1];
      positions[corner * 3 + 2] = rawPositions[positionIndex + 2];
      if (this.hasNormals && cornerData[at + 2] > 0) {
        const normalIndex = (cornerData[at + 2] - 1) * 3;
        normals[corner * 3] = rawNormals[normalIndex];
        normals[corner * 3 + 1] = rawNormals[normalIndex + 1];
        normals[corner * 3 + 2] = rawNormals[normalIndex + 2];
      }
      if (uvs !== null && cornerData[at + 1] > 0) {
        const uvIndex = (cornerData[at + 1] - 1) * 2;
        uvs[corner * 2] = rawUvs[uvIndex];
        uvs[corner * 2 + 1] = rawUvs[uvIndex + 1];
      }
    }
    if (!this.hasNormals)
      for (let corner = 0;corner + 2 < cornerCount; corner += 3) {
        const ax = positions[corner * 3];
        const ay = positions[corner * 3 + 1];
        const az = positions[corner * 3 + 2];
        const bx = positions[corner * 3 + 3];
        const by = positions[corner * 3 + 4];
        const bz = positions[corner * 3 + 5];
        const cx = positions[corner * 3 + 6];
        const cy = positions[corner * 3 + 7];
        const cz = positions[corner * 3 + 8];
        const ux = bx - ax;
        const uy = by - ay;
        const uz = bz - az;
        const vx = cx - ax;
        const vy = cy - ay;
        const vz = cz - az;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        if (length > 0.000000000001) {
          nx /= length;
          ny /= length;
          nz /= length;
        } else {
          nx = 0;
          ny = 0;
          nz = 1;
        }
        for (let v = 0;v < 3; v++) {
          normals[corner * 3 + v * 3] = nx;
          normals[corner * 3 + v * 3 + 1] = ny;
          normals[corner * 3 + v * 3 + 2] = nz;
        }
      }
    const elapsed = nowMs() - startedAt;
    return {
      kind: "obj",
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
        lines: this.lines
      }
    };
  }
  parseLine(bytes, start, end) {
    this.lines++;
    let at = start;
    while (at < end && isWhitespace(bytes[at]))
      at++;
    if (at >= end)
      return;
    const keywordStart = at;
    while (at < end && !isWhitespace(bytes[at]))
      at++;
    const keywordEnd = at;
    const keywordLength = keywordEnd - keywordStart;
    const first = bytes[keywordStart];
    if (first === 118) {
      if (keywordLength === 1) {
        const scanner = new TokenScanner(bytes, keywordEnd, end);
        this.positions.push3(scanner.nextFloat(), scanner.nextFloat(), scanner.nextFloat());
      } else if (bytes[keywordStart + 1] === 110 && keywordLength === 2) {
        const scanner = new TokenScanner(bytes, keywordEnd, end);
        this.normals.push3(scanner.nextFloat(), scanner.nextFloat(), scanner.nextFloat());
        this.hasNormals = true;
      } else if (bytes[keywordStart + 1] === 116 && keywordLength === 2) {
        const scanner = new TokenScanner(bytes, keywordEnd, end);
        this.uvs.push2(scanner.nextFloat(), scanner.nextFloat());
        this.hasUvs = true;
      }
      return;
    }
    if (first === 102) {
      this.parseFace(bytes, keywordEnd, end);
      return;
    }
    if (first === 111 || first === 103) {
      this.closeGroup();
      this.currentName = asciiDecode(bytes, keywordEnd, end - keywordEnd).trim() || "default";
      this.groupVertexStart = this.corners.count;
      return;
    }
    if (first === 117 && keywordLength === 6) {
      this.closeGroup();
      this.currentMaterial = asciiDecode(bytes, keywordEnd, end - keywordEnd).trim() || null;
      this.groupVertexStart = this.corners.count;
      return;
    }
    if (first === 109 && keywordLength === 6) {
      this.mtllib = asciiDecode(bytes, keywordEnd, end - keywordEnd).trim() || null;
      return;
    }
  }
  parseFace(bytes, start, end) {
    const scanner = new TokenScanner(bytes, start, end);
    const firstToken = scanner.nextToken();
    if (firstToken === null)
      return;
    const firstCorner = this.parseCorner(firstToken);
    if (firstCorner === null)
      return;
    let previous = null;
    for (;; ) {
      const token = scanner.nextToken();
      if (token === null)
        break;
      const corner = this.parseCorner(token);
      if (corner === null)
        break;
      if (previous !== null) {
        this.corners.push(firstCorner.v, firstCorner.t, firstCorner.n);
        this.corners.push(previous.v, previous.t, previous.n);
        this.corners.push(corner.v, corner.t, corner.n);
      }
      previous = corner;
    }
  }
  parseCorner(token) {
    let slash = 0;
    while (slash < token.length && token[slash] !== CHAR.SLASH)
      slash++;
    const vertex = this.resolveIndex(parseDecimal(token, 0, slash), this.positions.count / 3);
    if (vertex === 0)
      return null;
    let texcoord = 0;
    let normal = 0;
    if (slash < token.length) {
      const secondStart = slash + 1;
      let secondEnd = secondStart;
      while (secondEnd < token.length && token[secondEnd] !== CHAR.SLASH)
        secondEnd++;
      if (secondEnd > secondStart)
        texcoord = this.resolveIndex(parseDecimal(token, secondStart, secondEnd), this.uvs.count / 2);
      if (secondEnd < token.length) {
        const thirdStart = secondEnd + 1;
        if (thirdStart < token.length)
          normal = this.resolveIndex(parseDecimal(token, thirdStart, token.length), this.normals.count / 3);
      }
    }
    return { v: vertex, t: texcoord, n: normal };
  }
  resolveIndex(raw, count) {
    if (!Number.isFinite(raw))
      return 0;
    const index = Math.trunc(raw);
    if (index >= 1)
      return index;
    if (index <= -1)
      return count + 1 + index;
    return 0;
  }
  closeGroup() {
    const vertexCount = this.corners.count - this.groupVertexStart;
    if (vertexCount <= 0)
      return;
    const last = this.groups[this.groups.length - 1];
    if (last !== undefined && last.name === this.currentName && last.material === this.currentMaterial && last.vertexStart + last.vertexCount === this.groupVertexStart) {
      this.groups[this.groups.length - 1] = {
        ...last,
        vertexCount: last.vertexCount + vertexCount
      };
      return;
    }
    this.groups.push({
      name: this.currentName,
      material: this.currentMaterial,
      vertexStart: this.groupVertexStart,
      vertexCount
    });
  }
}
async function parseObj(assembler, options = {}) {
  const parser = new ObjParser({ expectedBytes: assembler.total, onPhase: options.onPhase });
  let fed = 0;
  for (;; ) {
    if (assembler.watermark > fed) {
      parser.feed(assembler.slice(fed, assembler.watermark - fed));
      fed = assembler.watermark;
    }
    if (assembler.isDone)
      break;
    await Promise.race([assembler.completion, rangeArrival(assembler, fed)]);
  }
  if (assembler.watermark > fed)
    parser.feed(assembler.slice(fed, assembler.watermark - fed));
  return parser.finish();
}
function rangeArrival(assembler, threshold) {
  return new Promise((resolve) => {
    const unsubscribe = assembler.onRange((watermark) => {
      if (watermark > threshold) {
        unsubscribe();
        resolve();
      }
    });
  });
}
var parseObjStream = parseObj;
// packages/loaders/src/mtl.ts
function defaultMaterial() {
  return {
    name: "",
    diffuse: [0.64, 0.64, 0.64],
    ambient: [0.2, 0.2, 0.2],
    specular: [0.05, 0.05, 0.05],
    shininess: 30,
    opacity: 1,
    illum: 2,
    mapKd: null,
    mapKs: null,
    mapD: null,
    mapBump: null
  };
}
function parseMtlText(text) {
  const startedAt = nowMs();
  const materials = [];
  let current = null;
  const flush = () => {
    if (current !== null && current.name !== "")
      materials.push(Object.freeze({ ...current }));
  };
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "")
      continue;
    const spaceAt = line.indexOf(" ");
    const keyword = (spaceAt < 0 ? line : line.slice(0, spaceAt)).toLowerCase();
    const rest = (spaceAt < 0 ? "" : line.slice(spaceAt + 1)).trim();
    switch (keyword) {
      case "newmtl":
        flush();
        current = defaultMaterial();
        current.name = rest.replace(/\s+/g, "-");
        break;
      case "kd":
      case "ka":
      case "ks": {
        if (current === null)
          break;
        const rgb = parseVec3(rest);
        if (keyword === "kd")
          current.diffuse = rgb;
        else if (keyword === "ka")
          current.ambient = rgb;
        else
          current.specular = rgb;
        break;
      }
      case "ns":
        if (current !== null)
          current.shininess = clamp(parseFloat(rest) || 0, 0, 1000);
        break;
      case "d":
        if (current !== null)
          current.opacity = clamp(parseFloat(rest) || 1, 0, 1);
        break;
      case "tr":
        if (current !== null)
          current.opacity = clamp(1 - (parseFloat(rest) || 0), 0, 1);
        break;
      case "illum":
        if (current !== null)
          current.illum = Math.trunc(parseFloat(rest) || 0);
        break;
      case "map_kd":
        if (current !== null)
          current.mapKd = extractMapPath(rest);
        break;
      case "map_ks":
        if (current !== null)
          current.mapKs = extractMapPath(rest);
        break;
      case "map_d":
        if (current !== null)
          current.mapD = extractMapPath(rest);
        break;
      case "bump":
      case "map_bump":
      case "map_norm":
        if (current !== null)
          current.mapBump = extractMapPath(rest);
        break;
      default:
        break;
    }
  }
  flush();
  return {
    kind: "mtl",
    materials,
    get: (name) => materials.find((m) => m.name === name),
    stats: {
      materials: materials.length,
      withMapKd: materials.filter((m) => m.mapKd !== null).length,
      parseMs: nowMs() - startedAt
    }
  };
}
function parseMtl(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return parseMtlText(new TextDecoder("utf-8").decode(bytes));
}
function parseVec3(text) {
  const parts = text.split(/\s+/).map(parseFloat);
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0
  ];
}
function extractMapPath(text) {
  const tokens = text.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0)
    return null;
  for (let i = tokens.length - 1;i >= 0; i--) {
    const token = tokens[i];
    if (token.startsWith("-"))
      break;
    if (/^-?\d+(\.\d+)?$/.test(token) && i > 0)
      continue;
    return token;
  }
  return tokens[tokens.length - 1] ?? null;
}
function parseMtlBytes(bytes) {
  return parseMtl(bytes);
}
// packages/loaders/src/fbx.ts
async function parseFBX(buffer) {
  const doc = new FbxDocumentReader(buffer);
  await doc.readTree();
  return doc.extract();
}
var KTIME_PER_SECOND = 46186158000;
var MAGIC = "Kaydara FBX Binary  ";

class FbxDocumentReader {
  bytes;
  view;
  utf8 = new TextDecoder;
  cursor = 0;
  v64;
  root = [];
  byId = new Map;
  children = new Map;
  parents = new Map;
  connProps = new Map;
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    if (this.bytes.length < 32) {
      throw new SyntaxError("parseFBX: буфер слишком мал для FBX-заголовка");
    }
    const magic = this.utf8.decode(this.bytes.subarray(0, 20));
    if (magic.startsWith("Kaydara FBX ASCII")) {
      throw new SyntaxError("parseFBX: ASCII-FBX не поддерживается (нужен бинарный «Kaydara FBX Binary») — экспортируйте Binary FBX");
    }
    if (magic !== MAGIC) {
      throw new SyntaxError(`parseFBX: не FBX Binary (магия: ${JSON.stringify(magic.slice(0, 16))}…)`);
    }
    const version = this.view.getUint32(23, true);
    if (version < 7000 || version > 7999) {
      throw new SyntaxError(`parseFBX: неподдерживаемая версия FBX ${version} (ожидается 7.1–7.7)`);
    }
    this.v64 = version >= 7500;
    this.cursor = 27;
  }
  async readTree() {
    while (this.cursor < this.bytes.length) {
      const node = this.readNode();
      if (node === null)
        break;
      this.root.push(node);
    }
    if (this.root.length === 0)
      throw new SyntaxError("parseFBX: пустое дерево узлов (битый файл?)");
    await Promise.resolve();
  }
  headerSize() {
    return this.v64 ? 25 : 13;
  }
  readU32() {
    const v = this.view.getUint32(this.cursor, true);
    this.cursor += 4;
    return v;
  }
  readU64() {
    const v = Number(this.view.getBigUint64(this.cursor, true));
    this.cursor += 8;
    return v;
  }
  readNode() {
    const start = this.cursor;
    const endOffset = this.v64 ? this.readU64() : this.readU32();
    const numProps = this.v64 ? this.readU64() : this.readU32();
    const propLen = this.v64 ? this.readU64() : this.readU32();
    const nameLen = this.bytes[this.cursor];
    this.cursor += 1;
    if (endOffset === 0 && numProps === 0 && propLen === 0 && nameLen === 0)
      return null;
    if (endOffset <= start || endOffset > this.bytes.length) {
      throw new RangeError(`parseFBX: узел с битым endOffset=${endOffset} @${start} (файл обрезан?)`);
    }
    const name = this.utf8.decode(this.bytes.subarray(this.cursor, this.cursor + nameLen));
    this.cursor += nameLen;
    const props = [];
    for (let i = 0;i < numProps; i++)
      props.push(this.readProp(name));
    const children = [];
    if (this.cursor < endOffset) {
      for (;; ) {
        if (this.cursor + this.headerSize() > endOffset)
          break;
        const c = this.readNode();
        if (c === null)
          break;
        children.push(c);
      }
    }
    this.cursor = endOffset;
    return { name, props, children };
  }
  readProp(nodeName) {
    const type = String.fromCharCode(this.bytes[this.cursor]);
    this.cursor += 1;
    switch (type) {
      case "Y": {
        const v = this.view.getInt16(this.cursor, true);
        this.cursor += 2;
        return v;
      }
      case "C": {
        const v = this.bytes[this.cursor] !== 0;
        this.cursor += 1;
        return v;
      }
      case "I": {
        const v = this.view.getInt32(this.cursor, true);
        this.cursor += 4;
        return v;
      }
      case "F": {
        const v = this.view.getFloat32(this.cursor, true);
        this.cursor += 4;
        return v;
      }
      case "D": {
        const v = this.view.getFloat64(this.cursor, true);
        this.cursor += 8;
        return v;
      }
      case "L": {
        const v = Number(this.view.getBigInt64(this.cursor, true));
        this.cursor += 8;
        return v;
      }
      case "S":
      case "R": {
        const len = this.readU32();
        const raw = this.bytes.subarray(this.cursor, this.cursor + len);
        this.cursor += len;
        if (type === "S") {
          return this.utf8.decode(raw);
        }
        return raw;
      }
      case "f":
      case "d":
      case "i":
      case "l":
      case "b": {
        const len = this.readU32();
        const enc = this.readU32();
        const comp = this.readU32();
        const start = this.cursor;
        this.cursor += comp;
        const kind = type === "d" ? "f64" : type === "f" ? "f32" : type === "i" ? "i32" : type === "l" ? "i64" : "bytes";
        return this.lazyArray(kind, len, enc, start, comp, nodeName);
      }
      default:
        throw new SyntaxError(`parseFBX: неизвестный тип свойства '${type}' в узле «${nodeName}» @${this.cursor - 1}`);
    }
  }
  lazyArray(kind, len, enc, start, comp, nodeName) {
    return new LazyArrayImpl(kind, len, async () => {
      const raw = this.bytes.subarray(start, start + comp);
      if (enc === 0) {
        if (raw.length < len * scalarOf(kind)) {
          throw new RangeError(`parseFBX: массив узла «${nodeName}» обрезан (${raw.length} байт < ${len * scalarOf(kind)})`);
        }
        return raw;
      }
      if (enc !== 1) {
        throw new SyntaxError(`parseFBX: массив узла «${nodeName}» с неизвестной кодировкой ${enc}`);
      }
      if (typeof DecompressionStream === "undefined") {
        throw new SyntaxError("parseFBX: окружение без DecompressionStream — zlib-массивы недоступны");
      }
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate"));
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      if (out.length < len * scalarOf(kind)) {
        throw new SyntaxError(`parseFBX: распаковка узла «${nodeName}» дала ${out.length} байт, ожидается ≥ ${len * scalarOf(kind)}`);
      }
      return out;
    });
  }
  async extract() {
    const objects = this.find("Objects");
    const connections = this.find("Connections");
    if (objects === undefined)
      throw new SyntaxError("parseFBX: нет узла Objects");
    this.indexObjects(objects);
    if (connections !== undefined)
      this.indexConnections(connections);
    const skeleton = await this.extractSkeleton(objects);
    setSkeletonJoints(skeleton.joints);
    const meshes = await this.extractMeshes(objects, skeleton);
    const clips = await this.extractClips(objects);
    return { meshes, skeleton, clips };
  }
  find(name) {
    return this.root.find((n) => n.name === name);
  }
  findClusterBoneName(o) {
    const viaConn = this.parentOf(this.objId(o), "Model");
    if (viaConn !== undefined)
      return this.objName(viaConn);
    const rawName = this.objName(o);
    return rawName.length > 0 ? rawName : undefined;
  }
  objType(o) {
    return splitNameType(o).type;
  }
  objName(o) {
    return splitNameType(o).name;
  }
  objId(o) {
    return Number(o.props[0]);
  }
  indexObjects(objects) {
    for (const o of objects.children) {
      const id = this.objId(o);
      if (!Number.isFinite(id))
        continue;
      this.byId.set(id, o);
    }
  }
  indexConnections(connections) {
    for (const c of connections.children) {
      if (c.name !== "C")
        continue;
      const p = c.props;
      const kind = String(p[0] ?? "");
      if (kind !== "OO" && kind !== "OP" && kind !== "PO" && kind !== "PP")
        continue;
      const src = Number(p[1]);
      const dst = Number(p[2]);
      const prop = p.length > 3 ? String(p[3]) : "";
      const ch = this.children.get(dst);
      if (ch === undefined)
        this.children.set(dst, [src]);
      else
        ch.push(src);
      const pa = this.parents.get(src);
      if (pa === undefined)
        this.parents.set(src, [dst]);
      else
        pa.push(dst);
      if (prop !== "")
        this.connProps.set(`${src}>${dst}`, prop);
    }
  }
  childrenOf(id, type) {
    const out = [];
    for (const cid of this.children.get(id) ?? []) {
      const o = this.byId.get(cid);
      if (o === undefined)
        continue;
      if (type === undefined || this.objType(o) === type)
        out.push(o);
    }
    return out;
  }
  parentOf(id, type) {
    for (const pid of this.parents.get(id) ?? []) {
      const o = this.byId.get(pid);
      if (o === undefined)
        continue;
      if (type === undefined || this.objType(o) === type)
        return o;
    }
    return;
  }
  async extractSkeleton(objects) {
    const boneNodes = [];
    for (const o of objects.children) {
      if (this.objType(o) !== "Model")
        continue;
      const sub = String(o.props[2] ?? "");
      if (sub === "LimbNode" || sub === "Limb" || sub === "Root" || sub === "Null")
        boneNodes.push(o);
    }
    const parentOfNode = new Map;
    for (const b of boneNodes)
      parentOfNode.set(b, this.parentOf(this.objId(b), "Model"));
    const ordered = [];
    const placed = new Set;
    const visit = (b) => {
      if (placed.has(b))
        return;
      placed.add(b);
      const parent = parentOfNode.get(b);
      if (parent !== undefined && parentOfNode.has(parent))
        visit(parent);
      ordered.push(b);
    };
    for (const b of boneNodes)
      visit(b);
    const indexOf = new Map;
    ordered.forEach((b, i) => indexOf.set(b, i));
    const boneNodeByName = new Map;
    for (const b of ordered)
      boneNodeByName.set(this.objName(b), b);
    const invBind = new Map;
    for (const o of objects.children) {
      if (this.objType(o) !== "SubDeformer")
        continue;
      const boneName = this.findClusterBoneName(o);
      const bone = boneName !== undefined ? boneNodeByName.get(strippedClusterName(boneName)) : undefined;
      if (bone === undefined)
        continue;
      const tl = await propArray(o, "TransformLink");
      if (tl === undefined)
        continue;
      invBind.set(indexOf.get(bone), invert4(tl));
    }
    const joints = ordered.map((b, i) => {
      const p70 = b.children.find((c) => c.name === "Properties70");
      const rest = readRestPose(p70);
      const parent = parentOfNode.get(b);
      return {
        name: this.objName(b),
        parent: parent !== undefined && indexOf.has(parent) ? indexOf.get(parent) : -1,
        restT: rest.t,
        restQ: rest.q,
        restS: rest.s,
        invBind: invBind.get(i)
      };
    });
    return { joints };
  }
  async extractMeshes(objects, skeleton) {
    const meshes = [];
    for (const g of objects.children) {
      if (this.objType(g) !== "Geometry")
        continue;
      const verticesProp = g.children.find((c) => c.name === "Vertices")?.props[0];
      const polygonProp = g.children.find((c) => c.name === "PolygonVertexIndex")?.props[0];
      if (!(verticesProp instanceof LazyArrayImplCheck) || !(polygonProp instanceof LazyArrayImplCheck))
        continue;
      const vertices = await verticesProp.f64();
      const polygonIndex = await polygonProp.i32();
      const vertexCount = vertices.length / 3;
      const normals = await this.readNormals(g, polygonIndex, vertices);
      const { indices } = triangulate(polygonIndex);
      const skin = await this.readSkin(g, objects, skeleton);
      meshes.push({
        name: this.objName(g),
        vertexCount,
        positions: f32From(vertices),
        normals,
        indices,
        skin
      });
    }
    return meshes;
  }
  async readNormals(g, polygonIndex, vertices) {
    const vertexCount = vertices.length / 3;
    let normalNode;
    for (const ch of g.children) {
      if (ch.name === "LayerElementNormal") {
        normalNode = ch;
        break;
      }
    }
    if (normalNode === undefined) {
      for (const layer of g.children.filter((c) => c.name === "Layer")) {
        for (const le of layer.children.filter((c) => c.name === "LayerElement")) {
          const t = le.children.find((c) => c.name === "Type")?.props[0];
          if (String(t) === "LayerElementNormal") {
            normalNode = le.children.find((c) => c.name === "TypedIndex") ? le : normalNode;
          }
        }
      }
    }
    const fallback = () => computeNormals(vertices, polygonIndex);
    if (normalNode === undefined)
      return fallback();
    const mapping = String(normalNode.children.find((c) => c.name === "MappingInformationType")?.props[0] ?? "");
    const reference = String(normalNode.children.find((c) => c.name === "ReferenceInformationType")?.props[0] ?? "");
    const normalsProp = normalNode.children.find((c) => c.name === "Normals")?.props[0];
    if (!(normalsProp instanceof LazyArrayImplCheck))
      return fallback();
    const rawNormals = await normalsProp.f64();
    const out = new Float32Array(vertexCount * 3);
    if (mapping === "ByVertice" || mapping === "ByVertex") {
      if (reference !== "Direct")
        return fallback();
      for (let i = 0;i < vertexCount * 3; i++)
        out[i] = rawNormals[i] ?? 0;
      return out;
    }
    if (mapping === "ByPolygonVertex") {
      if (reference === "Direct") {
        for (let pvi = 0;pvi < polygonIndex.length; pvi++) {
          const vi = polygonIndex[pvi] < 0 ? ~polygonIndex[pvi] : polygonIndex[pvi];
          out[vi * 3] += rawNormals[pvi * 3] ?? 0;
          out[vi * 3 + 1] += rawNormals[pvi * 3 + 1] ?? 0;
          out[vi * 3 + 2] += rawNormals[pvi * 3 + 2] ?? 0;
        }
      } else if (reference === "IndexToDirect") {
        const indexProp = normalNode.children.find((c) => c.name === "NormalsIndex")?.props[0] ?? normalNode.children.find((c) => c.name === "Index")?.props[0];
        if (!(indexProp instanceof LazyArrayImplCheck))
          return fallback();
        const normalIndex = await indexProp.i32();
        for (let pvi = 0;pvi < polygonIndex.length; pvi++) {
          const vi = polygonIndex[pvi] < 0 ? ~polygonIndex[pvi] : polygonIndex[pvi];
          const ni = normalIndex[pvi] ?? 0;
          out[vi * 3] += rawNormals[ni * 3] ?? 0;
          out[vi * 3 + 1] += rawNormals[ni * 3 + 1] ?? 0;
          out[vi * 3 + 2] += rawNormals[ni * 3 + 2] ?? 0;
        }
      } else {
        return fallback();
      }
      for (let v = 0;v < vertexCount; v++) {
        const x = out[v * 3], y = out[v * 3 + 1], z = out[v * 3 + 2];
        const len = Math.hypot(x, y, z);
        if (len > 0.000000001) {
          out[v * 3] /= len;
          out[v * 3 + 1] /= len;
          out[v * 3 + 2] /= len;
        }
      }
      return out;
    }
    return fallback();
  }
  async readSkin(g, objects, skeleton) {
    const geomId = this.objId(g);
    let skinDeformer;
    for (const o of objects.children) {
      if (this.objType(o) !== "Deformer")
        continue;
      if (String(o.props[2] ?? "") !== "Skin")
        continue;
      if (this.parents.get(this.objId(o))?.includes(geomId)) {
        skinDeformer = o;
        break;
      }
    }
    if (skinDeformer === undefined)
      return;
    const verticesProp = g.children.find((c) => c.name === "Vertices")?.props[0];
    if (!(verticesProp instanceof LazyArrayImplCheck))
      return;
    const vertexCount = (await verticesProp.f64()).length / 3;
    const jointNameToIndex = new Map;
    skeleton.joints.forEach((j, i) => jointNameToIndex.set(j.name, i));
    const jointIndices = new Uint16Array(vertexCount * 4);
    const jointWeights = new Float32Array(vertexCount * 4);
    const weightAcc = new Float64Array(vertexCount * 4);
    const jointAcc = new Uint16Array(vertexCount * 4);
    for (const cluster of this.childrenOf(this.objId(skinDeformer), "SubDeformer")) {
      const boneName = this.findClusterBoneName(cluster);
      const joint = boneName !== undefined ? jointNameToIndex.get(strippedClusterName(boneName)) : undefined;
      if (joint === undefined)
        continue;
      const indexesProp = cluster.children.find((c) => c.name === "Indexes")?.props[0];
      const weightsProp = cluster.children.find((c) => c.name === "Weights")?.props[0];
      if (!(indexesProp instanceof LazyArrayImplCheck) || !(weightsProp instanceof LazyArrayImplCheck))
        continue;
      const indexes = await indexesProp.i32();
      const weights = await weightsProp.f64();
      for (let i = 0;i < indexes.length; i++) {
        const vi = indexes[i];
        const w = weights[i];
        if (w <= 0)
          continue;
        let slot = -1;
        for (let s = 0;s < 4; s++) {
          if (weightAcc[vi * 4 + s] === 0) {
            slot = s;
            break;
          }
          if (weightAcc[vi * 4 + s] < w) {
            slot = s;
            break;
          }
        }
        if (slot === -1)
          continue;
        for (let s = 3;s > slot; s--) {
          weightAcc[vi * 4 + s] = weightAcc[vi * 4 + s - 1];
          jointAcc[vi * 4 + s] = jointAcc[vi * 4 + s - 1];
        }
        weightAcc[vi * 4 + slot] = w;
        jointAcc[vi * 4 + slot] = joint;
      }
    }
    for (let v = 0;v < vertexCount; v++) {
      let sum = 0;
      for (let s = 0;s < 4; s++)
        sum += weightAcc[v * 4 + s];
      if (sum > 0.000000001) {
        for (let s = 0;s < 4; s++)
          jointWeights[v * 4 + s] = weightAcc[v * 4 + s] / sum;
      } else {
        jointIndices[v * 4] = 0;
      }
      for (let s = 0;s < 4; s++)
        jointIndices[v * 4 + s] = jointAcc[v * 4 + s];
    }
    return { jointIndices, jointWeights };
  }
  async extractClips(objects) {
    const clips = [];
    for (const stack of objects.children) {
      if (this.objType(stack) !== "AnimStack")
        continue;
      const curveNodes = [];
      for (const layer of this.childrenOf(this.objId(stack), "AnimLayer")) {
        for (const cn of this.childrenOf(this.objId(layer), "AnimCurveNode"))
          curveNodes.push(cn);
      }
      if (curveNodes.length === 0)
        continue;
      const pendingT = [];
      const pendingR = [];
      let duration = 0;
      for (const cn of curveNodes) {
        const cnId = this.objId(cn);
        const bone = this.parentOf(cnId, "Model");
        if (bone === undefined)
          continue;
        const target = this.connProps.get(`${cnId}>${this.objId(bone)}`) ?? "";
        const isTranslation = target.includes("Translation");
        const isRotation = target.includes("Rotation");
        if (!isTranslation && !isRotation)
          continue;
        const curves = { x: undefined, y: undefined, z: undefined };
        for (const child of this.childrenOf(cnId, "AnimCurve")) {
          const axis = this.connProps.get(`${this.objId(child)}>${cnId}`);
          if (axis === undefined)
            continue;
          const key = axis.endsWith("|X") ? "x" : axis.endsWith("|Y") ? "y" : axis.endsWith("|Z") ? "z" : undefined;
          if (key === undefined)
            continue;
          const keyTime = await propArray(child, "KeyTime");
          const keyValue = await propArray(child, "KeyValueFloat");
          if (keyTime === undefined || keyValue === undefined)
            continue;
          const times2 = new Float64Array(keyTime.length);
          for (let i = 0;i < keyTime.length; i++)
            times2[i] = keyTime[i] / KTIME_PER_SECOND;
          curves[key] = { times: times2, values: f32From(keyValue) };
          const last = times2.length > 0 ? times2[times2.length - 1] : 0;
          if (last > duration)
            duration = last;
        }
        if (curves.x === undefined && curves.y === undefined && curves.z === undefined)
          continue;
        const keySet = new Set;
        for (const axis of ["x", "y", "z"]) {
          if (curves[axis] !== undefined)
            for (const t of curves[axis].times)
              keySet.add(t);
        }
        const times = Float32Array.from([...keySet].sort((a, b) => a - b));
        const boneName = this.objName(bone);
        if (isTranslation) {
          const values = new Float32Array(times.length * 3);
          for (let k = 0;k < times.length; k++) {
            const sampled = sampleAxes(curves, times[k]);
            values[k * 3] = sampled[0];
            values[k * 3 + 1] = sampled[1];
            values[k * 3 + 2] = sampled[2];
          }
          pendingT.push({ boneName, times, values });
        } else {
          const quats = new Float32Array(times.length * 4);
          const deg = [0, 0, 0];
          for (let k = 0;k < times.length; k++) {
            const sampled = sampleAxes(curves, times[k]);
            deg[0] = sampled[0];
            deg[1] = sampled[1];
            deg[2] = sampled[2];
            quatFromEulerXYZ(deg, quats, k * 4);
          }
          pendingR.push({ boneName, times, quats });
        }
      }
      if (pendingT.length === 0 && pendingR.length === 0)
        continue;
      const indexByName = new Map;
      for (const [i, j] of skeletonJoints.entries())
        indexByName.set(j.name, i);
      const tracksT = pendingT.map((p) => ({ joint: indexByName.get(p.boneName) ?? -1, times: p.times, values: p.values }));
      const tracksR = pendingR.map((p) => ({ joint: indexByName.get(p.boneName) ?? -1, times: p.times, quats: p.quats }));
      clips.push({ name: this.objName(stack), duration, tracksT, tracksR });
    }
    return clips;
  }
}
function scalarOf(kind) {
  switch (kind) {
    case "f64":
    case "i64":
      return 8;
    case "f32":
    case "i32":
      return 4;
    default:
      return 1;
  }
}

class LazyArrayImplCheck {
  __lazy = true;
}

class LazyArrayImpl extends LazyArrayImplCheck {
  doInflate;
  kind;
  length;
  cache = null;
  inflight = null;
  constructor(kind, len, doInflate) {
    super();
    this.doInflate = doInflate;
    this.kind = kind;
    this.length = len;
  }
  async raw() {
    if (this.cache !== null)
      return this.cache;
    if (this.inflight === null)
      this.inflight = this.doInflate();
    const out = await this.inflight;
    if (this.cache === null)
      this.cache = out;
    return out;
  }
  async aligned(scalar) {
    const b = await this.raw();
    if (b.byteOffset % scalar === 0 && b.length >= this.length * scalar)
      return b;
    const copy = new Uint8Array(this.length * scalar);
    copy.set(b.subarray(0, copy.length));
    return copy;
  }
  async f64() {
    const a = await this.aligned(8);
    return new Float64Array(a.buffer, a.byteOffset, this.length);
  }
  async f32() {
    const a = await this.aligned(4);
    return new Float32Array(a.buffer, a.byteOffset, this.length);
  }
  async i32() {
    const a = await this.aligned(4);
    return new Int32Array(a.buffer, a.byteOffset, this.length);
  }
}
function splitNameType(o) {
  const raw = String(o.props[1] ?? "");
  const sep = raw.indexOf("\x00\x01");
  if (sep < 0)
    return { name: raw, type: "" };
  return { name: raw.slice(0, sep), type: raw.slice(sep + 2) };
}
function p70Values(p70, name) {
  if (p70 === undefined)
    return;
  for (const p of p70.children) {
    if (p.name !== "P")
      continue;
    const props = p.props;
    if (String(props[0]) === name)
      return props.slice(4).map(Number);
  }
  return;
}
function readRestPose(p70) {
  const t = p70Values(p70, "Lcl Translation") ?? [0, 0, 0];
  const r = p70Values(p70, "Lcl Rotation") ?? [0, 0, 0];
  const s = p70Values(p70, "Lcl Scaling") ?? [1, 1, 1];
  const q = [0, 0, 0, 1];
  quatFromEulerXYZ([r[0] * DEG2RAD, r[1] * DEG2RAD, r[2] * DEG2RAD], q, 0);
  return { t: [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0], q, s: [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1] };
}
async function propArray(node, childName) {
  const prop = node.children.find((c) => c.name === childName)?.props[0];
  if (prop === undefined)
    return;
  if (prop instanceof LazyArrayImplCheck) {
    const lazy = prop;
    if (lazy.kind === "i64") {
      const b = await lazy.raw();
      const out = new Float64Array(lazy.length);
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      for (let i = 0;i < lazy.length; i++)
        out[i] = Number(dv.getBigInt64(i * 8, true));
      return out;
    }
    return lazy.f64();
  }
  if (prop instanceof Float64Array)
    return prop;
  if (prop instanceof Float32Array)
    return Float64Array.from(prop);
  if (prop instanceof Int32Array)
    return Float64Array.from(prop);
  return;
}
function strippedClusterName(name) {
  return name.startsWith("Cluster ") ? name.slice("Cluster ".length) : name;
}
var DEG2RAD = Math.PI / 180;
function quatFromEulerXYZ(euler, out, off) {
  const x = euler[0] / 2, y = euler[1] / 2, z = euler[2] / 2;
  const sx = Math.sin(x), cx = Math.cos(x);
  const sy = Math.sin(y), cy = Math.cos(y);
  const sz = Math.sin(z), cz = Math.cos(z);
  out[off] = sx * cy * cz + cx * sy * sz;
  out[off + 1] = cx * sy * cz - sx * cy * sz;
  out[off + 2] = cx * cy * sz + sx * sy * cz;
  out[off + 3] = cx * cy * cz - sx * sy * sz;
}
function invert4(m) {
  const out = new Float32Array(16);
  const inv = new Float64Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (det === 0)
    return out;
  det = 1 / det;
  for (let i = 0;i < 16; i++)
    out[i] = inv[i] * det;
  return out;
}
function f32From(src) {
  if (src instanceof Float32Array)
    return src;
  const out = new Float32Array(src.length);
  for (let i = 0;i < src.length; i++)
    out[i] = src[i];
  return out;
}
function triangulate(polygonIndex) {
  const indices = [];
  let polyStart = 0;
  for (let i = 0;i < polygonIndex.length; i++) {
    const v = polygonIndex[i];
    if (v < 0) {
      const last = ~v;
      const len = i - polyStart + 1;
      const v0 = polygonIndex[polyStart];
      for (let k = 1;k < len - 1; k++) {
        indices.push(v0, polygonIndex[polyStart + k], polygonIndex[polyStart + k + 1]);
      }
      polyStart = i + 1;
    }
  }
  return { indices: Uint32Array.from(indices) };
}
function computeNormals(vertices, polygonIndex) {
  const count = vertices.length / 3;
  const out = new Float32Array(count * 3);
  let polyStart = 0;
  for (let i = 0;i < polygonIndex.length; i++) {
    const v = polygonIndex[i];
    if (v >= 0)
      continue;
    const len = i - polyStart + 1;
    if (len >= 3) {
      const a = polygonIndex[polyStart] * 3;
      const b = polygonIndex[polyStart + 1] * 3;
      const c = polygonIndex[polyStart + len - 1] * 3;
      const ux = vertices[b] - vertices[a], uy = vertices[b + 1] - vertices[a + 1], uz = vertices[b + 2] - vertices[a + 2];
      const vx = vertices[c] - vertices[a], vy = vertices[c + 1] - vertices[a + 1], vz = vertices[c + 2] - vertices[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (let k = 0;k < len; k++) {
        const vi = polygonIndex[polyStart + k] * 3;
        out[vi] += nx;
        out[vi + 1] += ny;
        out[vi + 2] += nz;
      }
    }
    polyStart = i + 1;
  }
  for (let v = 0;v < count; v++) {
    const len = Math.hypot(out[v * 3], out[v * 3 + 1], out[v * 3 + 2]);
    if (len > 0.000000001) {
      out[v * 3] /= len;
      out[v * 3 + 1] /= len;
      out[v * 3 + 2] /= len;
    }
  }
  return out;
}
function sampleAxes(curves, t) {
  const out = [0, 0, 0];
  const axes = ["x", "y", "z"];
  for (let a = 0;a < 3; a++) {
    const curve = curves[axes[a]];
    if (curve === undefined)
      continue;
    const { times, values } = curve;
    if (times.length === 0)
      continue;
    let i = 0;
    while (i < times.length - 1 && times[i + 1] <= t)
      i++;
    out[a] = values[i] ?? 0;
  }
  return out;
}
var skeletonJoints = [];
function setSkeletonJoints(joints) {
  skeletonJoints = joints;
}
function looksLikeFbxBinary(bytes) {
  const magic = "Kaydara FBX Binary";
  if (bytes.length < magic.length)
    return false;
  for (let i = 0;i < magic.length; i++) {
    if (bytes[i] !== magic.charCodeAt(i))
      return false;
  }
  return true;
}
async function parseFbx(data, options = {}) {
  if (options.signal?.aborted) {
    throw new DOMException("загрузка отменена", "AbortError");
  }
  options.onPhase?.({ stage: "parse", ratio: 0.1, detail: "FBX: полный буфер получен" });
  const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const model = await parseFBX(buffer);
  options.onPhase?.({ stage: "parse", ratio: 0.9, detail: "FBX: дерево разобрано" });
  return model;
}
// packages/loaders/src/image.ts
var defaultCreateBitmap = typeof createImageBitmap === "function" ? (bytes, mimeType, options) => createImageBitmap(new Blob([bytes], { type: mimeType }), options ?? { premultiplyAlpha: "none" }) : undefined;
async function parseImage(assembler, options = {}) {
  const onPhase = options.onPhase ?? (() => {});
  await assembler.completion;
  onPhase({ stage: "decode", ratio: 0.9, detail: `${assembler.watermark} байт` });
  const bytes = assembler.fullView();
  const createBitmap = options.createBitmap ?? defaultCreateBitmap;
  if (createBitmap === undefined)
    throw new Error("createImageBitmap недоступен в этой среде (нужен браузер или инъекция)");
  const mimeType = sniffImageMime(bytes);
  const bitmap = await createBitmap(bytes, mimeType, options.imageBitmapOptions);
  onPhase({ stage: "decode", ratio: 1, detail: `${bitmap.width}×${bitmap.height}` });
  return {
    kind: "image",
    bitmap,
    width: bitmap.width,
    height: bitmap.height,
    byteLength: bytes.byteLength
  };
}
function sniffImageMime(bytes) {
  if (bytes.length >= 12) {
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      return "image/jpeg";
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
      return "image/png";
    if (bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70)
      return "image/webp";
    if (bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80)
      return "image/webp";
    if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70)
      return "image/gif";
    if (bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112 && bytes[8] === 97 && bytes[9] === 118 && bytes[10] === 105 && (bytes[11] === 102 || bytes[11] === 115))
      return "image/avif";
    if (bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112 && bytes[8] === 109 && bytes[9] === 105 && bytes[10] === 102 && bytes[11] === 49)
      return "image/avif";
  }
  if (bytes.length >= 6) {
    if (bytes[0] === 58 && bytes[1] === 41)
      return "image/avif";
    if (bytes[0] === 70 && bytes[1] === 76 && bytes[2] === 73 && bytes[3] === 70)
      return "image/flif";
  }
  return "application/octet-stream";
}
// packages/loaders/src/config.ts
var configParsers = new Map([
  ["json", (bytes) => JSON.parse(decodeUtf8(bytes))],
  ["zml", parseZml],
  ["txt", (bytes) => decodeUtf8(bytes)],
  ["ini", parseIni]
]);
function registerConfigParser(extension, parser) {
  configParsers.set(extension.toLowerCase(), parser);
}
function configParserOf(extension) {
  return configParsers.get(extension.toLowerCase());
}
async function parseConfig(assembler, extension, options = {}) {
  const parser = configParserOf(extension);
  if (parser === undefined)
    throw new Error(`нет парсера конфигов «${extension}» — подключите registerConfigParser('${extension}', fn)`);
  await assembler.completion;
  options.onPhase?.({ stage: "parse", ratio: 0.5, detail: extension });
  const result = await parser(assembler.fullView());
  options.onPhase?.({ stage: "parse", ratio: 1, detail: extension });
  return result;
}
function decodeUtf8(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}
function isSectionArray(value) {
  if (!Array.isArray(value) || value.length === 0)
    return false;
  const first = value[0];
  return typeof first === "object" && first !== null && "key" in first;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseZml(bytes) {
  const root = {};
  const stack = [{ indent: -1, children: root }];
  let at = 0;
  const length = bytes.length;
  while (at < length) {
    let lineEnd = at;
    while (lineEnd < length && bytes[lineEnd] !== CHAR.LF)
      lineEnd++;
    let contentEnd = lineEnd;
    if (contentEnd > at && bytes[contentEnd - 1] === CHAR.CR)
      contentEnd--;
    let indent = 0;
    let cursor = at;
    while (cursor < contentEnd && bytes[cursor] === CHAR.SPACE) {
      indent++;
      cursor++;
    }
    if (cursor >= contentEnd || bytes[cursor] === CHAR.HASH) {
      at = lineEnd + 1;
      continue;
    }
    const keyStart = cursor;
    while (cursor < contentEnd && !isWhitespace(bytes[cursor]))
      cursor++;
    const key = decodeUtf8(bytes.subarray(keyStart, cursor));
    const values = [];
    while (cursor < contentEnd) {
      while (cursor < contentEnd && isWhitespace(bytes[cursor]))
        cursor++;
      if (cursor >= contentEnd)
        break;
      const valueStart = cursor;
      while (cursor < contentEnd && !isWhitespace(bytes[cursor]))
        cursor++;
      values.push(parseZmlValue(bytes, valueStart, cursor));
    }
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent)
      stack.pop();
    const siblings = stack[stack.length - 1].children;
    const existing = siblings[key];
    if (values.length === 0) {
      const section = {};
      if (existing === undefined)
        siblings[key] = section;
      else if (isPlainObject(existing))
        siblings[key] = [existing, { key, values: [], children: section }];
      else if (isSectionArray(existing))
        existing.push({ key, values: [], children: section });
      else
        siblings[key] = section;
      stack.push({ indent, children: section });
    } else if (values.length === 1) {
      const value = values[0];
      if (existing === undefined)
        siblings[key] = value;
      else if (Array.isArray(existing) && !isSectionArray(existing))
        existing.push(value);
      else if (typeof existing === "number" && typeof value === "number")
        siblings[key] = [existing, value];
      else
        siblings[key] = value;
    } else {
      siblings[key] = values.map((v) => v);
    }
    at = lineEnd + 1;
  }
  return root;
}
function parseZmlValue(bytes, start, end) {
  const raw = decodeUtf8(bytes.subarray(start, end));
  if (raw.length >= 2 && raw.charCodeAt(0) === 34 && raw.charCodeAt(raw.length - 1) === 34)
    return raw.slice(1, -1);
  if (raw === "true")
    return true;
  if (raw === "false")
    return false;
  const numeric = parseDecimal(bytes, start, end);
  if (Number.isFinite(numeric))
    return numeric;
  return raw;
}
function parseIni(bytes) {
  const root = { "": {} };
  let section = "";
  let at = 0;
  const length = bytes.length;
  while (at < length) {
    let lineEnd = at;
    while (lineEnd < length && bytes[lineEnd] !== CHAR.LF)
      lineEnd++;
    let contentEnd = lineEnd;
    if (contentEnd > at && bytes[contentEnd - 1] === CHAR.CR)
      contentEnd--;
    let cursor = at;
    while (cursor < contentEnd && isWhitespace(bytes[cursor]))
      cursor++;
    if (cursor >= contentEnd || bytes[cursor] === CHAR.HASH || bytes[cursor] === 59) {
      at = lineEnd + 1;
      continue;
    }
    if (bytes[cursor] === 91) {
      const start = cursor + 1;
      let end = start;
      while (end < contentEnd && bytes[end] !== 93)
        end++;
      section = decodeUtf8(bytes.subarray(start, end));
      root[section] ??= {};
    } else {
      const keyStart = cursor;
      let keyEnd = cursor;
      while (keyEnd < contentEnd && bytes[keyEnd] !== 61)
        keyEnd++;
      let keyEndTrimmed = keyEnd;
      while (keyEndTrimmed > keyStart && isWhitespace(bytes[keyEndTrimmed - 1]))
        keyEndTrimmed--;
      const key = decodeUtf8(bytes.subarray(keyStart, keyEndTrimmed));
      let valueStart = keyEnd < contentEnd ? keyEnd + 1 : contentEnd;
      while (valueStart < contentEnd && isWhitespace(bytes[valueStart]))
        valueStart++;
      let valueEnd = contentEnd;
      while (valueEnd > valueStart && isWhitespace(bytes[valueEnd - 1]))
        valueEnd--;
      (root[section] ??= {})[key] = parseZmlValue(bytes, valueStart, valueEnd);
    }
    at = lineEnd + 1;
  }
  return root;
}
function parseTextBytes(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
// packages/loaders/src/core/errors.ts
class LoadError extends Error {
  code;
  status;
  cause;
  url;
  constructor(code, message, options = {}) {
    super(message);
    this.name = "LoadError";
    this.code = code;
    this.status = options.status ?? null;
    this.cause = options.cause ?? null;
    this.url = options.url ?? null;
  }
}

class ParseError extends LoadError {
  offset;
  constructor(message, offset = -1, url) {
    super("parse", offset >= 0 ? `${message} (at byte ${offset})` : message, { url });
    this.name = "ParseError";
    this.offset = offset;
  }
}

class UnsupportedError extends LoadError {
  constructor(message, url) {
    super("unsupported", message, { url });
    this.name = "UnsupportedError";
  }
}
function abortError(reason) {
  const err = new Error(reason ?? "The operation was aborted");
  err.name = "AbortError";
  return err;
}
function isAbortError2(err) {
  return typeof err === "object" && err !== null && err.name === "AbortError";
}
function throwIfAborted2(signal, what) {
  if (signal.aborted) {
    const reason = typeof signal.reason === "string" ? signal.reason : undefined;
    throw abortError(`${what}: ${reason ?? "aborted"}`);
  }
}

// packages/loaders/src/core/util.ts
class GrowableBytes {
  buf;
  len = 0;
  chunkCount = 0;
  constructor(initialCapacity = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
  }
  get length() {
    return this.len;
  }
  push(chunk) {
    this.ensure(chunk.length);
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    return this.len;
  }
  view() {
    return this.buf.subarray(0, this.len);
  }
  take() {
    const out = this.buf.slice(0, this.len);
    this.len = 0;
    return out;
  }
  ensure(additional) {
    const need = this.len + additional;
    if (need <= this.buf.length)
      return;
    let cap = this.buf.length;
    while (cap < need)
      cap = cap < 1024 ? 1024 : cap * 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
}
function parseFastFloat(bytes, start, end) {
  let i = start;
  while (i < end && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 13))
    i++;
  let sign = 1;
  if (i < end && (bytes[i] === 45 || bytes[i] === 43)) {
    if (bytes[i] === 45)
      sign = -1;
    i++;
  }
  let intPart = 0;
  let sawDigit = false;
  while (i < end) {
    const c = bytes[i];
    if (c >= 48 && c <= 57) {
      intPart = intPart * 10 + (c - 48);
      sawDigit = true;
      i++;
    } else
      break;
  }
  let frac = 0;
  let fracScale = 1;
  let sawFracDigit = false;
  if (i < end && bytes[i] === 46) {
    i++;
    while (i < end) {
      const c = bytes[i];
      if (c >= 48 && c <= 57) {
        frac = frac * 10 + (c - 48);
        fracScale *= 10;
        sawFracDigit = true;
        i++;
      } else
        break;
    }
  }
  if (!sawDigit && !sawFracDigit)
    return { value: NaN, next: start };
  let value = sign * (intPart + (sawFracDigit ? frac / fracScale : 0));
  if (i < end && (bytes[i] === 101 || bytes[i] === 69)) {
    let j = i + 1;
    let esign = 1;
    if (j < end && (bytes[j] === 45 || bytes[j] === 43)) {
      if (bytes[j] === 45)
        esign = -1;
      j++;
    }
    let exp = 0;
    let sawExpDigit = false;
    while (j < end) {
      const c = bytes[j];
      if (c >= 48 && c <= 57) {
        exp = exp * 10 + (c - 48);
        sawExpDigit = true;
        j++;
      } else
        break;
    }
    if (sawExpDigit) {
      value *= Math.pow(10, esign * Math.min(exp, 308));
      i = j;
    }
  }
  return { value, next: i };
}
function parseFastInt(bytes, start, end) {
  let i = start;
  while (i < end && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 13))
    i++;
  let sign = 1;
  if (i < end && (bytes[i] === 45 || bytes[i] === 43)) {
    if (bytes[i] === 45)
      sign = -1;
    i++;
  }
  let v = 0;
  let saw = false;
  while (i < end) {
    const c = bytes[i];
    if (c >= 48 && c <= 57) {
      v = v * 10 + (c - 48);
      saw = true;
      i++;
    } else
      break;
  }
  return { value: saw ? sign * v : NaN, next: saw ? i : start };
}
function asciiFromBytes(bytes, start = 0, end = bytes.length) {
  let out = "";
  const CHUNK = 4096;
  for (let i = start;i < end; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, end)));
  }
  return out;
}
function bytesEqualAscii(bytes, start, end, ascii) {
  if (end - start !== ascii.length)
    return false;
  for (let i = 0;i < ascii.length; i++) {
    if (bytes[start + i] !== ascii.charCodeAt(i))
      return false;
  }
  return true;
}
var B64_TABLE = (() => {
  const t = new Int8Array(256).fill(-1);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0;i < alphabet.length; i++)
    t[alphabet.charCodeAt(i)] = i;
  return t;
})();
function base64Decode(text) {
  let len = 0;
  for (let i = 0;i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13)
      continue;
    len++;
  }
  let padding = 0;
  if (len % 4 === 0 && text.endsWith("=="))
    padding = 2;
  else if (len % 4 === 0 && text.endsWith("="))
    padding = 1;
  const outLen = len / 4 * 3 - padding;
  const out = new Uint8Array(outLen);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0;i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13)
      continue;
    if (code === 61)
      continue;
    const v = B64_TABLE[code];
    if (v < 0)
      throw new Error(`base64Decode: invalid char ${String.fromCharCode(code)}`);
    acc = acc << 6 | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < outLen)
        out[o++] = acc >>> bits & 255;
    }
  }
  return out;
}
var defaultResolveUrl = (base, rel) => {
  if (base === null)
    return rel;
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
};
var defaultInflate = typeof DecompressionStream === "function" ? async (bytes) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
} : null;
var defaultDecodeImage = (bytes, mimeType, options) => {
  const fn = globalThis.createImageBitmap;
  if (typeof fn !== "function") {
    return Promise.reject(new UnsupportedError("createImageBitmap недоступен на этой платформе — передайте decodeImage"));
  }
  return fn(new Blob([bytes], mimeType ? { type: mimeType } : undefined), {
    premultiplyAlpha: options.premultiplyAlpha ?? "default",
    colorSpaceConversion: options.colorSpaceConversion ?? "default",
    imageOrientation: options.imageOrientation ?? "none",
    ...options.resizeWidth !== undefined ? { resizeWidth: options.resizeWidth } : {},
    ...options.resizeHeight !== undefined ? { resizeHeight: options.resizeHeight } : {},
    ...options.resizeQuality !== undefined ? { resizeQuality: options.resizeQuality } : {}
  }).then((bitmap) => bitmap);
};
function resolvePlatformCaps(overrides = {}) {
  return {
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    resolveUrl: overrides.resolveUrl ?? defaultResolveUrl,
    inflate: overrides.inflate !== undefined ? overrides.inflate : defaultInflate,
    decodeImage: overrides.decodeImage !== undefined ? overrides.decodeImage : defaultDecodeImage
  };
}
function sniffKind(bytes, url) {
  if (bytes.length >= 4) {
    const m = bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3];
    if (bytes[0] === 103 && bytes[1] === 108 && bytes[2] === 84 && bytes[3] === 70)
      return { kind: "glb", mimeType: "model/gltf-binary" };
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
      return { kind: "image", mimeType: "image/png" };
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      return { kind: "image", mimeType: "image/jpeg" };
    if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70)
      return { kind: "image", mimeType: "image/gif" };
    if (m === 1380533830 && bytes[8] === 87 && bytes[9] === 69)
      return { kind: "image", mimeType: "image/webp" };
    if (bytes[0] === 66 && bytes[1] === 77)
      return { kind: "image", mimeType: "image/bmp" };
    if (m === 529205248 || m === 529205256)
      return { kind: "gzip", mimeType: "application/gzip" };
  }
  if (bytes.length >= 20 && bytesEqualAscii(bytes, 0, 18, "Kaydara FBX Binary")) {
    return { kind: "fbx", mimeType: "application/octet-stream" };
  }
  if (bytes.length >= 10 && (bytesEqualAscii(bytes, 0, 10, "#?RADIANCE") || bytesEqualAscii(bytes, 0, 5, "#?RGBE"))) {
    return { kind: "hdr", mimeType: "image/vnd.radiance" };
  }
  if (url !== null && url !== undefined) {
    const ext = extensionOf(url);
    if (ext !== null) {
      switch (ext) {
        case "obj":
          return { kind: "obj", mimeType: null };
        case "mtl":
          return { kind: "mtl", mimeType: null };
        case "gltf":
          return { kind: "gltf", mimeType: "model/gltf+json" };
        case "json":
          return { kind: "json", mimeType: "application/json" };
        case "zml":
        case "xml":
          return { kind: "zml", mimeType: "text/xml" };
        case "txt":
        case "text":
          return { kind: "text", mimeType: "text/plain" };
        case "hdr":
          return { kind: "hdr", mimeType: "image/vnd.radiance" };
        case "png":
          return { kind: "image", mimeType: "image/png" };
        case "jpg":
        case "jpeg":
          return { kind: "image", mimeType: "image/jpeg" };
        case "webp":
          return { kind: "image", mimeType: "image/webp" };
        case "ktx2":
          return { kind: "image", mimeType: "image/ktx2" };
      }
    }
  }
  return { kind: null, mimeType: null };
}
function extensionOf(url) {
  try {
    const clean = url.split("?")[0].split("#")[0];
    const slash = clean.lastIndexOf("/");
    const dot = clean.lastIndexOf(".");
    if (dot <= slash)
      return null;
    return clean.slice(dot + 1).toLowerCase();
  } catch {
    return null;
  }
}
function parseDataUri(uri) {
  if (!uri.startsWith("data:"))
    return null;
  const comma = uri.indexOf(",");
  if (comma < 0)
    return null;
  const meta = uri.slice(5, comma);
  const isBase64 = meta.endsWith(";base64");
  const mimeType = isBase64 ? meta.slice(0, -7) : meta.length > 0 ? meta : null;
  const payload = uri.slice(comma + 1);
  if (isBase64)
    return { mimeType, bytes: base64Decode(payload) };
  const text = decodeURIComponent(payload);
  const bytes = new Uint8Array(text.length);
  for (let i = 0;i < text.length; i++)
    bytes[i] = text.charCodeAt(i) & 255;
  return { mimeType, bytes };
}
// packages/loaders/src/formats/mesh.ts
function meshStatsOf(meshes, materials, images, nodes, animations) {
  let vertices = 0;
  let triangles = 0;
  for (const m of meshes) {
    vertices += m.positions.length / 3;
    const indexCount = m.indices !== null ? m.indices.length : m.positions.length / 3;
    triangles += Math.floor(indexCount / 3);
  }
  return {
    meshes: meshes.length,
    vertices,
    triangles,
    materials: materials.length,
    images: images.length,
    nodes: nodes.length,
    animations: animations.length
  };
}

// packages/loaders/src/formats/gltf.ts
var GLB_MAGIC2 = 1179937895;
var CHUNK_JSON = 1313821514;
var CHUNK_BIN = 5130562;
function isGlbMagic(bytes) {
  return bytes.length >= 4 && bytes[0] === 103 && bytes[1] === 108 && bytes[2] === 84 && bytes[3] === 70;
}
function parseGlbContainer(bytes, ctx) {
  const url = ctx?.sourceUrl ?? null;
  if (bytes.length < 12)
    throw new ParseError("GLB: файл короче заголовка", 0, url);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== GLB_MAGIC2)
    throw new ParseError("GLB: неверная магика", 0, url);
  const version = dv.getUint32(4, true);
  if (version !== 1 && version !== 2) {
    throw new ParseError(`GLB: версия ${version} не поддерживается (нужна 2)`, 4, url);
  }
  let pos = 12;
  let gltf = null;
  let bin = null;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos, true);
    const type = dv.getUint32(pos + 4, true);
    const dataStart = pos + 8;
    if (dataStart + len > bytes.length) {
      throw new ParseError("GLB: чанк вылезает за конец файла", pos, url);
    }
    if (type === CHUNK_JSON) {
      const jsonText = new TextDecoder("utf-8").decode(bytes.subarray(dataStart, dataStart + len));
      try {
        gltf = JSON.parse(jsonText);
      } catch (err) {
        throw new ParseError(`GLB: битый JSON-чанк: ${err.message}`, dataStart, url);
      }
    } else if (type === CHUNK_BIN) {
      bin = bytes.subarray(dataStart, dataStart + len);
    }
    const padded = len + 3 & ~3;
    pos = dataStart + padded;
  }
  if (gltf === null)
    throw new ParseError("GLB: нет JSON-чанка", 0, url);
  return { gltf, bin };
}
var COMPONENTS = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16
};
function componentSize(componentType) {
  switch (componentType) {
    case 5120:
    case 5121:
      return 1;
    case 5122:
    case 5123:
      return 2;
    case 5125:
    case 5126:
      return 4;
    default:
      throw new ParseError(`accessor: неизвестный componentType ${componentType}`);
  }
}
function makeRaw(componentType, length) {
  switch (componentType) {
    case 5120:
      return new Int8Array(length);
    case 5121:
      return new Uint8Array(length);
    case 5122:
      return new Int16Array(length);
    case 5123:
      return new Uint16Array(length);
    case 5125:
      return new Uint32Array(length);
    case 5126:
      return new Float32Array(length);
    default:
      throw new ParseError(`accessor: неизвестный componentType ${componentType}`);
  }
}
function typedView(componentType, buffer, byteOffset, length) {
  switch (componentType) {
    case 5126:
      return byteOffset % 4 === 0 ? new Float32Array(buffer, byteOffset, length) : null;
    case 5125:
      return byteOffset % 4 === 0 ? new Uint32Array(buffer, byteOffset, length) : null;
    case 5123:
      return byteOffset % 2 === 0 ? new Uint16Array(buffer, byteOffset, length) : null;
    case 5122:
      return byteOffset % 2 === 0 ? new Int16Array(buffer, byteOffset, length) : null;
    case 5121:
      return new Uint8Array(buffer, byteOffset, length);
    case 5120:
      return new Int8Array(buffer, byteOffset, length);
    default:
      return null;
  }
}
function readElements(bytes, byteOffset, byteStride, compSize, count, comps, componentType, ctx) {
  const total = count * comps;
  const tight = byteStride === 0 || byteStride === comps * compSize;
  if (tight) {
    const need = total * compSize;
    if (byteOffset + need > bytes.length) {
      throw new ParseError("accessor: данные за границей bufferView");
    }
    const view = typedView(componentType, bytes.buffer, bytes.byteOffset + byteOffset, total);
    if (view !== null)
      return view;
    const out2 = makeRaw(componentType, total);
    new Uint8Array(out2.buffer, out2.byteOffset, need).set(bytes.subarray(byteOffset, byteOffset + need));
    return out2;
  }
  const out = makeRaw(componentType, total);
  const dvSrc = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let v = 0;v < count; v++) {
    if ((v & 1023) === 0 && v > 0)
      throwIfAborted2(ctx.signal, "gltf parse");
    const src = byteOffset + v * byteStride;
    for (let c = 0;c < comps; c++) {
      const at = src + c * compSize;
      if (at + compSize > bytes.length)
        throw new ParseError("accessor: данные за границей bufferView");
      const i = v * comps + c;
      switch (componentType) {
        case 5126:
          out[i] = dvSrc.getFloat32(at, true);
          break;
        case 5125:
          out[i] = dvSrc.getUint32(at, true);
          break;
        case 5123:
          out[i] = dvSrc.getUint16(at, true);
          break;
        case 5122:
          out[i] = dvSrc.getInt16(at, true);
          break;
        case 5121:
          out[i] = bytes[at];
          break;
        case 5120:
          out[i] = bytes[at] - 256 > 0 ? bytes[at] - 256 : bytes[at] << 24 >> 24;
          break;
        default:
          throw new ParseError(`accessor: componentType ${componentType}?`);
      }
    }
  }
  return out;
}
function decodeAccessor(gltf, accIndex, buffers, ctx) {
  const accessors = gltf.accessors ?? [];
  const acc = accessors[accIndex];
  const url = ctx.sourceUrl;
  if (acc === undefined)
    throw new ParseError(`accessor ${accIndex}: нет в gltf`, -1, url);
  const comps = COMPONENTS[acc.type];
  if (comps === undefined)
    throw new ParseError(`accessor: тип ${acc.type} не поддерживается`, -1, url);
  throwIfAborted2(ctx.signal, "gltf parse");
  const count = acc.count;
  const compSize = componentSize(acc.componentType);
  const total = count * comps;
  let raw;
  if (acc.bufferView === undefined) {
    raw = makeRaw(acc.componentType, total);
  } else {
    const bv = (gltf.bufferViews ?? [])[acc.bufferView];
    if (bv === undefined)
      throw new ParseError(`bufferView ${acc.bufferView}: нет в gltf`, -1, url);
    const buffer = buffers[bv.buffer];
    if (buffer === undefined)
      throw new ParseError(`buffer ${bv.buffer}: не загружен`, -1, url);
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    raw = readElements(buffer, byteOffset, bv.byteStride ?? 0, compSize, count, comps, acc.componentType, ctx);
  }
  if (acc.sparse !== undefined) {
    const sparse = acc.sparse;
    const idxBv = (gltf.bufferViews ?? [])[sparse.indices.bufferView];
    const valBv = (gltf.bufferViews ?? [])[sparse.values.bufferView];
    if (idxBv === undefined || valBv === undefined)
      throw new ParseError("sparse: нет bufferView", -1, url);
    const idxBuffer = buffers[idxBv.buffer];
    const valBuffer = buffers[valBv.buffer];
    if (idxBuffer === undefined || valBuffer === undefined)
      throw new ParseError("sparse: буфер не загружен", -1, url);
    const idxCompSize = componentSize(sparse.indices.componentType);
    const idxRaw = readElements(idxBuffer, (idxBv.byteOffset ?? 0) + (sparse.indices.byteOffset ?? 0), idxBv.byteStride ?? 0, idxCompSize, sparse.count, 1, sparse.indices.componentType, ctx);
    const valRaw = readElements(valBuffer, (valBv.byteOffset ?? 0) + (sparse.values.byteOffset ?? 0), valBv.byteStride ?? 0, compSize, sparse.count, comps, acc.componentType, ctx);
    for (let i = 0;i < sparse.count; i++) {
      const vertexIndex = idxRaw[i];
      if (vertexIndex >= count)
        throw new ParseError("sparse: индекс вне count", -1, url);
      for (let c = 0;c < comps; c++) {
        raw[vertexIndex * comps + c] = valRaw[i * comps + c];
      }
    }
  }
  let f32 = null;
  if (acc.componentType === 5126) {
    f32 = raw;
  } else if (acc.normalized === true) {
    const divisor = acc.componentType === 5121 ? 255 : acc.componentType === 5120 ? 127 : acc.componentType === 5123 ? 65535 : acc.componentType === 5122 ? 32767 : 1;
    const out = new Float32Array(total);
    for (let i = 0;i < total; i++)
      out[i] = raw[i] / divisor;
    f32 = out;
  }
  let indices = null;
  if (acc.componentType === 5125 || acc.componentType === 5123) {
    if (raw instanceof Uint32Array)
      indices = raw;
    else if (raw instanceof Uint16Array) {
      indices = new Uint32Array(total);
      for (let i = 0;i < total; i++)
        indices[i] = raw[i];
    }
  }
  if (ctx.signal.aborted && count > 0)
    throwIfAborted2(ctx.signal, "gltf parse");
  return { count, comps, raw, f32, indices };
}
var MODE_MAP = {
  0: "points",
  1: "lines",
  2: "line-strip",
  3: "line-strip",
  4: "triangles",
  5: "triangle-strip",
  6: "triangle-fan"
};
async function loadBuffers(gltf, bin, ctx) {
  const declared = gltf.buffers ?? [];
  const out = [];
  for (let i = 0;i < declared.length; i++) {
    const buf = declared[i];
    const uri = buf.uri;
    if (uri === undefined) {
      if (i === 0 && bin !== null) {
        out.push(bin);
        continue;
      }
      throw new ParseError(`buffer ${i}: нет uri и это не GLB BIN`, -1, ctx.sourceUrl);
    }
    if (uri.startsWith("data:")) {
      const parsed = parseDataUri(uri);
      if (parsed === null)
        throw new ParseError(`buffer ${i}: битый data: URI`, -1, ctx.sourceUrl);
      out.push(parsed.bytes);
      continue;
    }
    out.push(await ctx.resolveExternal(uri));
  }
  return out;
}
function buildMeshDocument(gltf, buffers, ctx) {
  const url = ctx.sourceUrl;
  const images = (gltf.images ?? []).map((img) => {
    if (img.bufferView !== undefined) {
      const bv = (gltf.bufferViews ?? [])[img.bufferView];
      if (bv === undefined)
        throw new ParseError(`image: bufferView ${img.bufferView} нет`, -1, url);
      const buffer = buffers[bv.buffer];
      if (buffer === undefined)
        throw new ParseError("image: буфер не загружен", -1, url);
      const off = bv.byteOffset ?? 0;
      return {
        name: img.name ?? null,
        mimeType: img.mimeType ?? null,
        bytes: buffer.subarray(off, off + bv.byteLength),
        uri: null
      };
    }
    if (img.uri !== undefined) {
      if (img.uri.startsWith("data:")) {
        const parsed = parseDataUri(img.uri);
        if (parsed !== null) {
          return { name: img.name ?? null, mimeType: parsed.mimeType ?? img.mimeType ?? null, bytes: parsed.bytes, uri: null };
        }
      }
      return { name: img.name ?? null, mimeType: img.mimeType ?? null, bytes: null, uri: img.uri };
    }
    return { name: img.name ?? null, mimeType: img.mimeType ?? null, bytes: null, uri: null };
  });
  const samplers = (gltf.samplers ?? []).map((s) => ({
    magFilter: s.magFilter ?? null,
    minFilter: s.minFilter ?? null,
    wrapS: s.wrapS ?? 10497,
    wrapT: s.wrapT ?? 10497
  }));
  const textureInfo = (info) => {
    if (info === undefined)
      return null;
    const tex = (gltf.textures ?? [])[info.index];
    if (tex === undefined)
      return null;
    const ext = tex.extensions;
    const source = ext?.["EXT_texture_webp"]?.source ?? ext?.["KHR_texture_basisu"]?.source ?? tex.source;
    if (source === undefined)
      return null;
    return { image: source, texCoord: info.texCoord ?? 0, sampler: tex.sampler ?? null };
  };
  const materials = (gltf.materials ?? []).map((m) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const bc = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const em = m.emissiveFactor ?? [0, 0, 0];
    const emissiveStrength = typeof m.extensions?.["KHR_materials_emissive_strength"]?.["emissiveStrength"] === "number" ? m.extensions["KHR_materials_emissive_strength"]["emissiveStrength"] : 1;
    return {
      name: m.name ?? null,
      baseColor: [bc[0], bc[1], bc[2], bc[3] ?? 1],
      metallic: pbr.metallicFactor ?? 1,
      roughness: pbr.roughnessFactor ?? 1,
      emissive: [em[0] ?? 0, em[1] ?? 0, em[2] ?? 0],
      emissiveStrength,
      normalScale: m.normalTexture?.scale ?? 1,
      occlusionStrength: m.occlusionTexture?.strength ?? 1,
      alphaMode: m.alphaMode === "MASK" ? "mask" : m.alphaMode === "BLEND" ? "blend" : "opaque",
      alphaCutoff: m.alphaCutoff ?? 0.5,
      doubleSided: m.doubleSided ?? false,
      baseColorTexture: textureInfo(pbr.baseColorTexture),
      metallicRoughnessTexture: textureInfo(pbr.metallicRoughnessTexture),
      normalTexture: textureInfo(m.normalTexture),
      emissiveTexture: textureInfo(m.emissiveTexture),
      occlusionTexture: textureInfo(m.occlusionTexture),
      source: "gltf"
    };
  });
  const meshes = [];
  const meshNames = [];
  const meshSpans = [];
  for (const mesh of gltf.meshes ?? []) {
    const start = meshes.length;
    for (const prim of mesh.primitives ?? []) {
      const ext = prim.extensions ?? {};
      if (ext["KHR_draco_mesh_compression"] !== undefined) {
        throw new UnsupportedError("glTF: меш сжат KHR_draco_mesh_compression — прогоните через конвертер или подключите Draco-декодер отдельным transform", url);
      }
      if (prim.targets !== undefined && prim.targets.length > 0) {
        throw new UnsupportedError("glTF: morph targets не поддерживаются в v1", url);
      }
      if (ext["EXT_mesh_gpu_instancing"] !== undefined) {
        throw new UnsupportedError("glTF: EXT_mesh_gpu_instancing не поддерживается в v1", url);
      }
      const attrs = prim.attributes ?? {};
      const positionIndex = attrs["POSITION"];
      if (positionIndex === undefined) {
        throw new ParseError("glTF: примитив без POSITION", -1, url);
      }
      const position = decodeAccessor(gltf, positionIndex, buffers, ctx);
      if (position.f32 === null)
        throw new ParseError("glTF: POSITION не float/normalized", -1, url);
      const readF32 = (key) => {
        const idx = attrs[key];
        if (idx === undefined)
          return null;
        const acc = decodeAccessor(gltf, idx, buffers, ctx);
        return acc.f32;
      };
      const positions = position.f32;
      const normals = readF32("NORMAL");
      const uvs = readF32("TEXCOORD_0");
      const uvs2 = readF32("TEXCOORD_1");
      const tangents = readF32("TANGENT");
      let colors = null;
      const colorIndex = attrs["COLOR_0"];
      if (colorIndex !== undefined) {
        const acc = decodeAccessor(gltf, colorIndex, buffers, ctx);
        const vc = acc.comps;
        if (acc.f32 !== null) {
          colors = new Uint8Array(acc.count * 4);
          for (let i = 0;i < acc.count; i++) {
            colors[i * 4] = floatToU8(acc.f32[i * vc]);
            colors[i * 4 + 1] = floatToU8(acc.f32[i * vc + 1] ?? 1);
            colors[i * 4 + 2] = floatToU8(acc.f32[i * vc + 2] ?? 1);
            colors[i * 4 + 3] = vc >= 4 ? floatToU8(acc.f32[i * 4 + 3]) : 255;
          }
        } else {
          const raw = acc.raw;
          colors = new Uint8Array(acc.count * 4);
          for (let i = 0;i < acc.count; i++) {
            colors[i * 4] = raw[i * vc];
            colors[i * 4 + 1] = raw[i * vc + 1] ?? 255;
            colors[i * 4 + 2] = raw[i * vc + 2] ?? 255;
            colors[i * 4 + 3] = vc >= 4 ? raw[i * 4 + 3] : 255;
          }
        }
      }
      const jointsIndex = attrs["JOINTS_0"];
      let joints = null;
      if (jointsIndex !== undefined) {
        const acc = decodeAccessor(gltf, jointsIndex, buffers, ctx);
        joints = new Uint16Array(acc.count * 4);
        const raw = acc.raw;
        const jc = acc.comps;
        for (let i = 0;i < acc.count * 4; i++) {
          joints[i] = raw[Math.floor(i / 4) * jc + i % 4] ?? 0;
        }
      }
      const weightsIndex = attrs["WEIGHTS_0"];
      let weights = null;
      if (weightsIndex !== undefined) {
        const acc = decodeAccessor(gltf, weightsIndex, buffers, ctx);
        weights = acc.f32;
      }
      let indices = null;
      if (prim.indices !== undefined) {
        const acc = decodeAccessor(gltf, prim.indices, buffers, ctx);
        if (acc.indices === null) {
          const raw = acc.raw;
          indices = new Uint32Array(acc.count);
          for (let i = 0;i < acc.count; i++)
            indices[i] = raw[i];
        } else {
          indices = acc.indices;
        }
      }
      const materialIndex = prim.material ?? -1;
      const count = indices !== null ? indices.length : positions.length / 3;
      const submeshes = [
        { material: materialIndex, name: mesh.name ?? null, offset: 0, count }
      ];
      meshes.push({
        positions,
        normals,
        uvs,
        uvs2,
        tangents,
        colors,
        joints,
        weights,
        indices,
        mode: MODE_MAP[prim.mode ?? 4] ?? "triangles",
        submeshes
      });
      meshNames.push(mesh.name ?? null);
    }
    meshSpans.push([start, meshes.length - start]);
  }
  const gltfNodes = gltf.nodes ?? [];
  const nodes = gltfNodes.map((n) => {
    let matrix = null;
    if (n.matrix !== undefined && n.matrix.length === 16) {
      matrix = new Float32Array(n.matrix);
    }
    let primitives = [];
    if (n.mesh !== undefined) {
      const span = meshSpans[n.mesh];
      if (span !== undefined) {
        primitives = Array.from({ length: span[1] }, (_, i) => span[0] + i);
      }
    }
    return {
      name: n.name ?? null,
      translation: [n.translation?.[0] ?? 0, n.translation?.[1] ?? 0, n.translation?.[2] ?? 0],
      rotation: [n.rotation?.[0] ?? 0, n.rotation?.[1] ?? 0, n.rotation?.[2] ?? 0, n.rotation?.[3] ?? 1],
      scale: [n.scale?.[0] ?? 1, n.scale?.[1] ?? 1, n.scale?.[2] ?? 1],
      matrix,
      primitives,
      skin: n.skin ?? -1,
      children: [...n.children ?? []]
    };
  });
  const scenes = (gltf.scenes ?? []).map((s) => [...s.nodes ?? []]);
  const defaultScene = gltf.scene ?? 0;
  const sceneRoots = scenes.length > 0 ? [scenes[Math.min(defaultScene, scenes.length - 1)]] : gltfNodes.length > 0 ? [gltfNodes.map((_, i) => i).filter((i) => !gltfNodes.some((n) => (n.children ?? []).includes(i)))] : [];
  const skins = (gltf.skins ?? []).map((s) => {
    let ibm = null;
    if (s.inverseBindMatrices !== undefined) {
      const acc = decodeAccessor(gltf, s.inverseBindMatrices, buffers, ctx);
      if (acc.f32 === null || acc.comps !== 16) {
        throw new ParseError("skin: inverseBindMatrices не MAT4/float", -1, url);
      }
      ibm = acc.f32;
    }
    return { name: s.name ?? null, joints: [...s.joints], inverseBindMatrices: ibm };
  });
  const animations = (gltf.animations ?? []).map((a) => {
    const channels = [];
    let duration = 0;
    for (const ch of a.channels ?? []) {
      const sampler = a.samplers?.[ch.sampler];
      if (sampler === undefined)
        continue;
      const path = ch.target.path;
      if (path !== "translation" && path !== "rotation" && path !== "scale" && path !== "weights")
        continue;
      const input = decodeAccessor(gltf, sampler.input, buffers, ctx);
      if (input.f32 === null)
        continue;
      const output = decodeAccessor(gltf, sampler.output, buffers, ctx);
      if (output.f32 === null)
        continue;
      if (input.count > 0)
        duration = Math.max(duration, input.f32[input.count - 1]);
      channels.push({
        node: ch.target.node ?? -1,
        path,
        times: input.f32,
        values: output.f32,
        interpolation: sampler.interpolation === "STEP" ? "step" : sampler.interpolation === "CUBICSPLINE" ? "cubicspline" : "linear"
      });
    }
    return { name: a.name ?? null, duration, channels };
  });
  return {
    source: "gltf",
    meshNames,
    meshes,
    materials,
    images,
    samplers,
    nodes,
    scenes: sceneRoots,
    skins,
    animations,
    stats: meshStatsOf(meshes, materials, images, nodes, animations)
  };
}
function floatToU8(v) {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
async function parseGlb2(bytes, ctx) {
  const container = parseGlbContainer(bytes, ctx);
  const buffers = await loadBuffers(container.gltf, container.bin, ctx);
  return buildMeshDocument(container.gltf, buffers, ctx);
}
async function parseGltfJsonBytes(bytes, ctx) {
  const url = ctx.sourceUrl;
  let gltf;
  try {
    gltf = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch (err) {
    throw new ParseError(`glTF: битый JSON: ${err.message}`, 0, url);
  }
  const buffers = await loadBuffers(gltf, null, ctx);
  return buildMeshDocument(gltf, buffers, ctx);
}
var gltfParser = {
  kind: "gltf",
  extensions: [".gltf", ".glb"],
  async parse(input) {
    const bytes = input.bytes;
    if (isGlbMagic(bytes))
      return parseGlb2(bytes, input.ctx);
    return parseGltfJsonBytes(bytes, input.ctx);
  },
  streaming(ctx) {
    return new GlbStreamSink(ctx);
  }
};

class GlbStreamSink {
  ctx;
  acc = new GrowableBytes(1 << 16);
  json = null;
  jsonDone = false;
  finished = false;
  constructor(ctx) {
    this.ctx = ctx;
  }
  push(chunk) {
    if (this.finished)
      return;
    this.acc.push(chunk);
    this.tryAdvance();
  }
  tryAdvance() {
    const view = this.acc.view();
    const dv = new DataView(view.buffer, view.byteOffset, view.byteLength);
    if (!this.jsonDone && view.length >= 12) {
      if (dv.getUint32(0, true) !== GLB_MAGIC2) {
        this.jsonDone = true;
        this.json = null;
        return;
      }
      const len = dv.getUint32(12, true);
      const type = dv.getUint32(16, true);
      if (view.length >= 20 + len) {
        if (type === CHUNK_JSON) {
          const text = new TextDecoder("utf-8").decode(view.subarray(20, 20 + len));
          try {
            this.json = JSON.parse(text);
          } catch (err) {
            throw new ParseError(`GLB: битый JSON-чанк: ${err.message}`, 20, this.ctx.sourceUrl);
          }
        }
        this.jsonDone = true;
      }
    }
  }
  async finish() {
    if (this.finished)
      throw new ParseError("GLB: finish() уже вызван");
    this.finished = true;
    this.tryAdvance();
    const bytes = this.acc.take();
    if (!isGlbMagic(bytes)) {
      return parseGltfJsonBytes(bytes, this.ctx);
    }
    return parseGlb2(bytes, this.ctx);
  }
}

// packages/loaders/src/core/pipe.ts
function streamToAsyncIterable(stream) {
  return {
    [Symbol.asyncIterator]() {
      const reader = stream.getReader();
      return {
        async next() {
          const { done, value } = await reader.read();
          if (done)
            return { done: true, value: undefined };
          return { done: false, value };
        },
        async return() {
          await reader.cancel().catch(() => {});
          return { done: true, value: undefined };
        }
      };
    }
  };
}
async function readAllBytes(chunks, options = {}) {
  const acc = new GrowableBytes(options.initialCapacity ?? 1 << 16);
  for await (const chunk of chunks) {
    const received = acc.push(chunk);
    options.onChunk?.(received, chunk);
  }
  return acc.take();
}
function composeTransforms(...transforms) {
  const list = transforms.filter((t) => t !== null && t !== undefined);
  if (list.length === 0)
    return null;
  if (list.length === 1)
    return list[0];
  const composed = (chunks) => {
    let current = chunks;
    for (const t of list)
      current = t(current);
    return current;
  };
  Object.defineProperty(composed, "name", { value: `compose(${list.map((t) => t.name).join("|")})`, configurable: true });
  return composed;
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// packages/loaders/src/formats/obj.ts
class GrowableF32 {
  arr;
  len = 0;
  constructor(initial = 1024) {
    this.arr = new Float32Array(initial);
  }
  get length() {
    return this.len;
  }
  push(v) {
    this.ensure(1);
    this.arr[this.len++] = v;
  }
  push3(a, b, c) {
    this.ensure(3);
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
    this.arr[this.len++] = c;
  }
  push2(a, b) {
    this.ensure(2);
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
  }
  at(index) {
    return this.arr[index];
  }
  trimmed() {
    return this.arr.slice(0, this.len);
  }
  ensure(add) {
    if (this.len + add > this.arr.length) {
      let cap = this.arr.length;
      while (cap < this.len + add)
        cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.arr.subarray(0, this.len));
      this.arr = next;
    }
  }
}

class GrowableU32 {
  arr;
  len = 0;
  constructor(initial = 1024) {
    this.arr = new Uint32Array(initial);
  }
  get length() {
    return this.len;
  }
  push(v) {
    if (this.len >= this.arr.length) {
      let cap = this.arr.length;
      while (cap <= this.len)
        cap *= 2;
      const next = new Uint32Array(cap);
      next.set(this.arr);
      this.arr = next;
    }
    this.arr[this.len++] = v;
  }
  trimmed() {
    return this.arr.slice(0, this.len);
  }
}
var UV_SHIFT = 21;
function createState(ctx, totalBytes) {
  return {
    srcPositions: new GrowableF32(1 << 12),
    srcNormals: new GrowableF32(1 << 10),
    srcUvs: new GrowableF32(1 << 10),
    outPositions: new GrowableF32(1 << 12),
    outNormals: new GrowableF32(1 << 10),
    outUvs: new GrowableF32(1 << 10),
    indices: new GrowableU32(1 << 12),
    hasNormals: false,
    hasUvs: false,
    welded: false,
    fastCount: 0,
    weld: new Map,
    runs: [],
    currentMaterial: -1,
    currentGroup: null,
    runStart: 0,
    mtllibs: [],
    materialNames: new Map,
    warnings: [],
    totalBytes,
    ctx
  };
}
var isSpace = (c) => c === 32 || c === 9 || c === 13;
var isTokenEnd = (c) => c === -1 || c === 32 || c === 9 || c === 13;
function processLine(bytes, start, end, state) {
  let i = start;
  while (i < end && isSpace(bytes[i]))
    i++;
  if (i >= end)
    return;
  const c = bytes[i];
  if (c === 35)
    return;
  if (c === 118) {
    const second = i + 1 < end ? bytes[i + 1] : -1;
    if (second === 110) {
      state.hasNormals = true;
      pushNumbers(bytes, i + 2, end, state.srcNormals, 3);
    } else if (second === 116) {
      state.hasUvs = true;
      pushNumbers(bytes, i + 2, end, state.srcUvs, 2);
    } else if (isTokenEnd(second)) {
      pushNumbers(bytes, i + 1, end, state.srcPositions, 3);
    }
    return;
  }
  if (c === 102 && isTokenEnd(i + 1 < end ? bytes[i + 1] : -1)) {
    processFace(bytes, i + 1, end, state);
    return;
  }
  if (matchKeyword(bytes, i, end, "usemtl")) {
    const name = asciiFromBytes(bytes, i + 7, end).trim();
    setMaterial(state, name.length > 0 ? name : null);
    return;
  }
  if (matchKeyword(bytes, i, end, "mtllib")) {
    const rest = asciiFromBytes(bytes, i + 7, end).trim();
    if (rest.length > 0)
      state.mtllibs.push(...rest.split(/\s+/));
    return;
  }
  if ((c === 111 || c === 103) && isTokenEnd(i + 1 < end ? bytes[i + 1] : -1)) {
    const name = asciiFromBytes(bytes, i + 1, end).trim();
    if (name !== state.currentGroup)
      setGroup(state, name.length > 0 ? name : null);
    return;
  }
  if (c === 108 || c === 112) {
    if (state.warnings.length < 16) {
      state.warnings.push(`OBJ: ${c === 108 ? "l (lines)" : "p (points)"} не поддержаны — пропущено`);
    }
  }
}
function matchKeyword(bytes, i, end, keyword) {
  if (i + keyword.length > end)
    return false;
  for (let k = 0;k < keyword.length; k++) {
    if (bytes[i + k] !== keyword.charCodeAt(k))
      return false;
  }
  return isTokenEnd(i + keyword.length < end ? bytes[i + keyword.length] : -1);
}
function pushNumbers(bytes, start, end, out, expect) {
  let i = start;
  let count = 0;
  while (count < expect && i < end) {
    const r = parseFastFloat(bytes, i, end);
    if (Number.isNaN(r.value))
      break;
    out.push(r.value);
    i = r.next;
    count++;
  }
  while (count < expect) {
    out.push(0);
    count++;
  }
}
function processFace(bytes, start, end, state) {
  const posCount = state.srcPositions.length / 3;
  const uvCount = state.srcUvs.length / 2;
  const normCount = state.srcNormals.length / 3;
  let first = -1;
  let prev = -1;
  let cornerIndex = 0;
  let i = start;
  let sawSlash = false;
  for (;; ) {
    while (i < end && isSpace(bytes[i]))
      i++;
    if (i >= end)
      break;
    const r = parseFastInt(bytes, i, end);
    if (Number.isNaN(r.value))
      break;
    let p = r.value;
    i = r.next;
    let t = 0;
    let n = 0;
    let hasT = false;
    let hasN = false;
    if (i < end && bytes[i] === 47) {
      sawSlash = true;
      i++;
      if (i < end && bytes[i] !== 47) {
        const rt = parseFastInt(bytes, i, end);
        if (!Number.isNaN(rt.value)) {
          t = rt.value;
          i = rt.next;
          hasT = true;
        }
      }
      if (i < end && bytes[i] === 47) {
        i++;
        const rn = parseFastInt(bytes, i, end);
        if (!Number.isNaN(rn.value)) {
          n = rn.value;
          i = rn.next;
          hasN = true;
        }
      }
    }
    if (p < 0)
      p = posCount + p;
    else
      p -= 1;
    if (p < 0 || p >= posCount) {
      if (state.warnings.length < 16)
        state.warnings.push("OBJ: индекс позиции вне диапазона — угол пропущен");
      cornerIndex++;
      continue;
    }
    if (hasT) {
      t = t < 0 ? uvCount + t : t - 1;
      if (t < 0 || t >= uvCount) {
        t = 0;
        hasT = false;
      }
    }
    if (hasN) {
      n = n < 0 ? normCount + n : n - 1;
      if (n < 0 || n >= normCount) {
        n = 0;
        hasN = false;
      }
    }
    if (!state.welded && (sawSlash || state.hasNormals || state.hasUvs)) {
      upgradeToWeld(state, state.fastCount > 0);
    }
    const merged = state.welded ? weldCorner(state, p, hasT ? t : -1, hasN ? n : -1) : p;
    if (cornerIndex === 0) {
      first = merged;
    } else if (cornerIndex >= 2) {
      state.indices.push(first);
      state.indices.push(prev);
      state.indices.push(merged);
      if (!state.welded)
        state.fastCount += 3;
    }
    prev = merged;
    cornerIndex++;
    if ((cornerIndex & 8191) === 0)
      throwIfAborted2(state.ctx.signal, "obj parse");
  }
}
function upgradeToWeld(state, copyIdentity) {
  state.welded = true;
  if (!copyIdentity)
    return;
  const count = state.srcPositions.length / 3;
  for (let p = 0;p < count; p++) {
    state.outPositions.push3(state.srcPositions.at(p * 3), state.srcPositions.at(p * 3 + 1), state.srcPositions.at(p * 3 + 2));
    if (state.hasUvs)
      state.outUvs.push2(0, 0);
    if (state.hasNormals)
      state.outNormals.push3(0, 0, 0);
    let inner = state.weld.get(p);
    if (inner === undefined) {
      inner = new Map;
      state.weld.set(p, inner);
    }
    inner.set(0, p);
  }
}
function weldCorner(state, p, t, n) {
  let inner = state.weld.get(p);
  if (inner === undefined) {
    inner = new Map;
    state.weld.set(p, inner);
  }
  const key = t + 1 << UV_SHIFT | n + 1;
  const existing = inner.get(key);
  if (existing !== undefined)
    return existing;
  const mergedIndex = state.outPositions.length / 3;
  state.outPositions.push3(state.srcPositions.at(p * 3), state.srcPositions.at(p * 3 + 1), state.srcPositions.at(p * 3 + 2));
  if (state.hasUvs) {
    if (t >= 0)
      state.outUvs.push2(state.srcUvs.at(t * 2), state.srcUvs.at(t * 2 + 1));
    else
      state.outUvs.push2(0, 0);
  }
  if (state.hasNormals) {
    if (n >= 0) {
      state.outNormals.push3(state.srcNormals.at(n * 3), state.srcNormals.at(n * 3 + 1), state.srcNormals.at(n * 3 + 2));
    } else {
      state.outNormals.push3(0, 0, 0);
    }
  }
  inner.set(key, mergedIndex);
  return mergedIndex;
}
function setMaterial(state, name) {
  let index = -1;
  if (name !== null) {
    const existing = state.materialNames.get(name);
    if (existing !== undefined)
      index = existing;
    else {
      index = state.materialNames.size;
      state.materialNames.set(name, index);
    }
  }
  if (index !== state.currentMaterial) {
    closeRun(state);
    state.currentMaterial = index;
  }
}
function setGroup(state, name) {
  closeRun(state);
  state.currentGroup = name;
}
function closeRun(state) {
  const end = state.indices.length;
  if (end > state.runStart) {
    state.runs.push({
      material: state.currentMaterial,
      name: state.currentGroup,
      offset: state.runStart,
      count: end - state.runStart
    });
  }
  state.runStart = end;
}
function parseMtlBytes2(bytes) {
  const out = [];
  let current = null;
  const text = asciiFromBytes(bytes);
  const lines = text.split(`
`);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#"))
      continue;
    const spaceIdx = line.indexOf(" ");
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();
    switch (key) {
      case "newmtl":
        current = {
          name: rest,
          kd: [0.8, 0.8, 0.8],
          ks: [0, 0, 0],
          ke: [0, 0, 0],
          ns: 0,
          d: 1,
          tr: -1,
          illum: 1,
          mapKd: null,
          mapKs: null,
          mapKe: null,
          mapBump: null,
          mapD: null,
          norm: null
        };
        out.push(current);
        break;
      case "Kd":
        if (current !== null)
          current.kd = parseTriple(rest);
        break;
      case "Ks":
        if (current !== null)
          current.ks = parseTriple(rest);
        break;
      case "Ke":
        if (current !== null)
          current.ke = parseTriple(rest);
        break;
      case "Ns":
        if (current !== null)
          current.ns = Number.parseFloat(rest) || 0;
        break;
      case "d":
        if (current !== null)
          current.d = Number.parseFloat(rest) || 1;
        break;
      case "Tr":
        if (current !== null)
          current.tr = Number.parseFloat(rest) || 0;
        break;
      case "illum":
        if (current !== null)
          current.illum = Number.parseInt(rest, 10) || 1;
        break;
      case "map_Kd":
        if (current !== null)
          current.mapKd = firstToken(rest);
        break;
      case "map_Ks":
        if (current !== null)
          current.mapKs = firstToken(rest);
        break;
      case "map_Ke":
        if (current !== null)
          current.mapKe = firstToken(rest);
        break;
      case "map_d":
        if (current !== null)
          current.mapD = firstToken(rest);
        break;
      case "map_bump":
      case "bump":
        if (current !== null)
          current.mapBump = firstToken(rest);
        break;
      case "norm":
      case "normal_map":
        if (current !== null)
          current.norm = firstToken(rest);
        break;
      default:
        break;
    }
  }
  return out;
}
function firstToken(rest) {
  const t = rest.split(/\s+/)[0];
  return t !== undefined && t.length > 0 ? t : null;
}
function parseTriple(rest) {
  const parts = rest.split(/\s+/);
  return [
    Number.parseFloat(parts[0] ?? "") || 0,
    Number.parseFloat(parts[1] ?? "") || 0,
    Number.parseFloat(parts[2] ?? "") || 0
  ];
}
function mtlToMaterials(mtl, ctx, baseOffset, images) {
  const materials = [];
  const imageIndexCache = new Map;
  const tex = (path) => {
    if (path === null)
      return null;
    let idx = imageIndexCache.get(path);
    if (idx === undefined) {
      idx = images.length;
      imageIndexCache.set(path, idx);
      images.push({
        name: path,
        mimeType: null,
        bytes: null,
        uri: ctx.resolveUrl(ctx.sourceUrl, path)
      });
    }
    return { image: idx, texCoord: 0, sampler: null };
  };
  for (const m of mtl) {
    const alpha = m.tr >= 0 ? 1 - m.tr : m.d;
    const roughness = m.ns > 0 ? Math.max(0.05, Math.min(1, 1 - m.ns / 1000)) : 1;
    materials.push({
      name: m.name,
      baseColor: [m.kd[0], m.kd[1], m.kd[2], alpha],
      metallic: 0,
      roughness,
      emissive: [m.ke[0], m.ke[1], m.ke[2]],
      emissiveStrength: 1,
      normalScale: 1,
      occlusionStrength: 1,
      alphaMode: alpha < 1 ? "blend" : "opaque",
      alphaCutoff: 0.5,
      doubleSided: false,
      baseColorTexture: tex(m.mapKd),
      metallicRoughnessTexture: tex(m.mapKs),
      normalTexture: tex(m.mapBump ?? m.norm),
      emissiveTexture: tex(m.mapKe),
      occlusionTexture: null,
      source: "obj"
    });
  }
  return materials;
}
async function finalizeObj(state, opts) {
  closeRun(state);
  throwIfAborted2(state.ctx.signal, "obj finalize");
  const vertexCount = (state.welded ? state.outPositions.length : state.srcPositions.length) / 3;
  while (state.hasUvs && state.outUvs.length < vertexCount * 2)
    state.outUvs.push2(0, 0);
  while (state.hasNormals && state.outNormals.length < vertexCount * 3)
    state.outNormals.push3(0, 0, 0);
  const positions = state.welded ? state.outPositions.trimmed() : state.srcPositions.trimmed();
  const normals = state.hasNormals ? state.outNormals.trimmed() : null;
  const uvs = state.hasUvs ? state.outUvs.trimmed() : null;
  const indices = state.indices.trimmed();
  const materials = [];
  const images = [];
  const mtlLoaded = [];
  if ((opts.loadMtl ?? true) && state.mtllibs.length > 0) {
    const indexToName = new Map;
    for (const [name, idx] of state.materialNames)
      indexToName.set(idx, name);
    const nameToFinal = new Map;
    for (const lib of state.mtllibs) {
      try {
        const mtlBytes = await state.ctx.resolveExternal(lib);
        mtlLoaded.push(lib);
        const converted = mtlToMaterials(parseMtlBytes2(mtlBytes), state.ctx, materials.length, images);
        for (let i = 0;i < converted.length; i++) {
          const name = converted[i].name;
          if (name !== null)
            nameToFinal.set(name, materials.length + i);
        }
        materials.push(...converted);
      } catch (err) {
        if (state.warnings.length < 16) {
          state.warnings.push(`OBJ: mtllib "${lib}" не загрузился: ${String(err?.message ?? err)}`);
        }
      }
    }
    for (const run of state.runs) {
      if (run.material >= 0) {
        const name = indexToName.get(run.material);
        run.material = name !== undefined ? nameToFinal.get(name) ?? -1 : -1;
      }
    }
  }
  const primitive = {
    positions,
    normals,
    uvs,
    uvs2: null,
    tangents: null,
    colors: null,
    joints: null,
    weights: null,
    indices,
    mode: "triangles",
    submeshes: state.runs
  };
  const nodes = [
    {
      name: state.currentGroup ?? "obj",
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      matrix: null,
      primitives: [0],
      skin: -1,
      children: []
    }
  ];
  const doc = {
    source: "obj",
    meshNames: [state.currentGroup ?? "obj"],
    meshes: [primitive],
    materials,
    images,
    samplers: [],
    nodes,
    scenes: [[0]],
    skins: [],
    animations: [],
    stats: meshStatsOf([primitive], materials, images, nodes, []),
    mtllibs: mtlLoaded
  };
  return doc;
}

class ObjStreamSink {
  state;
  opts;
  pending = null;
  processedBytes = 0;
  finished = false;
  constructor(state, opts) {
    this.state = state;
    this.opts = opts;
  }
  push(chunk) {
    if (this.finished)
      return;
    const bytes = this.pending === null ? chunk : concatBytes(this.pending, chunk);
    this.pending = null;
    let lineStart = 0;
    for (let i = 0;i < bytes.length; i++) {
      if (bytes[i] === 10) {
        processLine(bytes, lineStart, i, this.state);
        lineStart = i + 1;
      }
    }
    if (lineStart < bytes.length) {
      this.pending = bytes.slice(lineStart);
    }
    this.processedBytes += bytes.length;
    if (this.state.totalBytes > 0) {
      this.state.ctx.reportProgress(Math.min(1, this.processedBytes / this.state.totalBytes));
    }
    throwIfAborted2(this.state.ctx.signal, "obj parse");
  }
  async finish() {
    if (this.finished)
      throw new Error("obj: finish() уже вызван");
    this.finished = true;
    if (this.pending !== null) {
      processLine(this.pending, 0, this.pending.length, this.state);
      this.pending = null;
    }
    return finalizeObj(this.state, this.opts);
  }
}
var objParser = {
  kind: "obj",
  extensions: [".obj"],
  parse(input, options = {}) {
    const state = createState(input.ctx, input.bytes.length);
    const bytes = input.bytes;
    let lineStart = 0;
    let lineCount = 0;
    for (let i = 0;i < bytes.length; i++) {
      if (bytes[i] === 10) {
        processLine(bytes, lineStart, i, state);
        lineStart = i + 1;
        if ((lineCount++ & 8191) === 0)
          throwIfAborted2(input.ctx.signal, "obj parse");
      }
    }
    if (lineStart < bytes.length)
      processLine(bytes, lineStart, bytes.length, state);
    return finalizeObj(state, options);
  },
  streaming(ctx, options = {}) {
    const state = createState(ctx, ctx.byteLength ?? 0);
    return new ObjStreamSink(state, options);
  }
};

// packages/loaders/src/formats/fbx.ts
var FBX_MAGIC = "Kaydara FBX Binary  \x00\x1A\x00";
var FBX_MIN_VERSION = 7000;
async function parseFbxTree(bytes, ctx) {
  const url = ctx.sourceUrl;
  if (bytes.length < 27)
    throw new ParseError("FBX: файл короче заголовка", 0, url);
  for (let i = 0;i < FBX_MAGIC.length; i++) {
    if (bytes[i] !== FBX_MAGIC.charCodeAt(i)) {
      const head = String.fromCharCode(...bytes.subarray(0, Math.min(64, bytes.length)));
      if (head.includes("FBXHeaderExtension") || head.startsWith(";")) {
        throw new UnsupportedError("FBX: ASCII-формат не поддерживается — конвертируйте в Binary (FBX SDK/Blender: «FBX binary»)", url);
      }
      throw new ParseError("FBX: неверная магика (не бинарный FBX)", 0, url);
    }
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(23, true);
  if (version < FBX_MIN_VERSION) {
    throw new UnsupportedError(`FBX: версия ${version} (6.x и старше) не поддерживается`, url);
  }
  const u64 = version >= 7500;
  const pos = 27;
  const children = [];
  let cursor = pos;
  while (cursor + (u64 ? 25 : 13) <= bytes.length) {
    const node = await parseNode(dv, cursor, bytes.length, u64, ctx, url);
    if (node === null)
      break;
    children.push(node.node);
    cursor = node.end;
  }
  return { version, root: { name: "__root__", props: [], children } };
}
async function parseNode(dv, start, fileEnd, u64, ctx, url) {
  if (start >= fileEnd)
    return null;
  const isNull = isZeroField(dv, start, u64) && isZeroField(dv, start + (u64 ? 8 : 4), u64) && isZeroField(dv, start + (u64 ? 16 : 8), u64);
  if (isNull) {
    return null;
  }
  const endOffset = u64 ? Number(dv.getBigUint64(start, true)) : dv.getUint32(start, true);
  const numProps = u64 ? Number(dv.getBigUint64(start + 8, true)) : dv.getUint32(start + 4, true);
  const nameLen = dv.getUint8(start + (u64 ? 24 : 12));
  const nameStart = start + (u64 ? 25 : 13);
  if (endOffset > fileEnd || endOffset <= nameStart) {
    throw new ParseError(`FBX: кривой endOffset у ноды на ${start}`, start, url);
  }
  const name = String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + nameStart, nameLen));
  let cursor = nameStart + nameLen;
  const props = [];
  for (let i = 0;i < numProps; i++) {
    const parsed = await parseProp(dv, cursor, u64, ctx, url);
    props.push(parsed.prop);
    cursor = parsed.end;
  }
  const children = [];
  while (cursor + (u64 ? 25 : 13) <= endOffset) {
    const child = await parseNode(dv, cursor, endOffset, u64, ctx, url);
    if (child === null) {
      break;
    }
    children.push(child.node);
    cursor = child.end;
  }
  return { node: { name, props, children }, end: endOffset };
}
function isZeroField(dv, at, u64) {
  if (u64)
    return dv.getBigUint64(at, true) === 0n;
  return dv.getUint32(at, true) === 0;
}
async function parseProp(dv, at, u64, ctx, url) {
  const t = String.fromCharCode(dv.getUint8(at));
  const p = at + 1;
  switch (t) {
    case "Y":
      return { prop: { type: t, value: dv.getInt16(p, true) }, end: p + 2 };
    case "C":
      return { prop: { type: t, value: dv.getUint8(p) !== 0 }, end: p + 1 };
    case "I":
      return { prop: { type: t, value: dv.getInt32(p, true) }, end: p + 4 };
    case "F":
      return { prop: { type: t, value: dv.getFloat32(p, true) }, end: p + 4 };
    case "D":
      return { prop: { type: t, value: dv.getFloat64(p, true) }, end: p + 8 };
    case "L":
      return { prop: { type: t, value: Number(dv.getBigInt64(p, true)) }, end: p + 8 };
    case "S":
    case "R": {
      const len = dv.getUint32(p, true);
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset + p + 4, len);
      const value = t === "S" ? fbxString(bytes) : bytes;
      return { prop: { type: t, value }, end: p + 4 + len };
    }
    case "f":
    case "d":
    case "l":
    case "i":
    case "b": {
      const arrayLen = dv.getUint32(p, true);
      const encoding = dv.getUint32(p + 4, true);
      const byteLen = dv.getUint32(p + 8, true);
      const dataStart = p + 12;
      let bytes = new Uint8Array(dv.buffer, dv.byteOffset + dataStart, byteLen);
      if (encoding === 1) {
        if (ctx.inflate === null) {
          throw new UnsupportedError("FBX: zlib-массивы требуют inflate (DecompressionStream) — недоступен", url);
        }
        bytes = await ctx.inflate(bytes);
      }
      const value = decodeFbxArray(t, bytes, arrayLen);
      return { prop: { type: t, value }, end: dataStart + byteLen };
    }
    default:
      throw new ParseError(`FBX: неизвестный тип свойства "${t}" на ${at}`, at, url);
  }
}
function fbxString(bytes) {
  let out = "";
  for (let i = 0;i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0 && i === bytes.length - 1)
      continue;
    out += c === 0 || c === 1 ? ":" : String.fromCharCode(c);
  }
  return out;
}
function decodeFbxArray(t, bytes, count) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (t) {
    case "d": {
      if (bytes.byteOffset % 8 === 0)
        return new Float64Array(bytes.buffer, bytes.byteOffset, count);
      const out = new Float64Array(count);
      for (let i = 0;i < count; i++)
        out[i] = dv.getFloat64(i * 8, true);
      return out;
    }
    case "f": {
      if (bytes.byteOffset % 4 === 0)
        return new Float32Array(bytes.buffer, bytes.byteOffset, count);
      const out = new Float32Array(count);
      for (let i = 0;i < count; i++)
        out[i] = dv.getFloat32(i * 4, true);
      return out;
    }
    case "i": {
      const out = new Int32Array(count);
      for (let i = 0;i < count; i++) {
        out[i] = dv.getUint8(i * 4) | dv.getUint8(i * 4 + 1) << 8 | dv.getUint8(i * 4 + 2) << 16 | dv.getUint8(i * 4 + 3) << 24;
      }
      return out;
    }
    case "l": {
      const out = new BigInt64Array(count);
      for (let i = 0;i < count; i++)
        out[i] = dv.getBigInt64(i * 8, true);
      return out;
    }
    case "b": {
      return bytes.subarray(0, count);
    }
    default:
      throw new ParseError(`FBX: массив типа ${t}?`);
  }
}
function fbxTreeToMeshDocument(doc, ctx) {
  const root = doc.root;
  const objects = new Map;
  const connections = [];
  for (const top of root.children) {
    if (top.name === "Objects") {
      for (const obj of top.children) {
        if (obj.props.length < 2)
          continue;
        const id = propNumber(obj.props[0]);
        const rawName = propString(obj.props[1]);
        objects.set(id, { id, name: stripFbxName(rawName), kind: obj.name, node: obj });
      }
    } else if (top.name === "Connections") {
      for (const c of top.children) {
        if (c.name !== "C" || c.props.length < 3)
          continue;
        const type = propString(c.props[0]);
        connections.push({
          type: type === "OP" ? "OP" : "OO",
          childId: propNumber(c.props[1]),
          parentId: propNumber(c.props[2]),
          propName: c.props.length >= 4 ? propString(c.props[3]) : null
        });
      }
    }
  }
  const matBuilders = [];
  const materialIndex = new Map;
  for (const obj of objects.values()) {
    if (obj.kind !== "Material")
      continue;
    const props70 = findChild(obj.node, "Properties70");
    const p = props70 !== null ? readP70(props70) : new Map;
    const diffuse = p.get("DiffuseColor") ?? [0.8, 0.8, 0.8];
    const emissive = p.get("EmissiveColor") ?? [0, 0, 0];
    const transparency = p.get("TransparencyFactor") ?? [0];
    const shininess = p.get("ShininessExponent") ?? p.get("Shininess") ?? [20];
    const alpha = 1 - clamp01(transparency[0] ?? 0);
    const roughness = shininess[0] > 0 ? clamp01(1 - Math.log10(shininess[0] + 1) / 3) : 1;
    materialIndex.set(obj.id, matBuilders.length);
    matBuilders.push({
      id: obj.id,
      baseTex: null,
      normalTex: null,
      data: {
        name: obj.name,
        baseColor: [diffuse[0], diffuse[1], diffuse[2], alpha],
        metallic: 0,
        roughness,
        emissive: [emissive[0], emissive[1], emissive[2]],
        emissiveStrength: 1,
        normalScale: 1,
        occlusionStrength: 1,
        alphaMode: alpha < 1 ? "blend" : "opaque",
        alphaCutoff: 0.5,
        doubleSided: false,
        metallicRoughnessTexture: null,
        emissiveTexture: null,
        occlusionTexture: null,
        source: "fbx"
      }
    });
  }
  const images = [];
  const imageIndexCache = new Map;
  for (const conn of connections) {
    if (conn.type !== "OP")
      continue;
    const matIdx = materialIndex.get(conn.parentId);
    if (matIdx === undefined)
      continue;
    const texObj = objects.get(conn.childId);
    if (texObj === undefined || texObj.kind !== "Texture")
      continue;
    const rel = findChild(texObj.node, "RelativeFilename") ?? findChild(texObj.node, "FileName");
    let file = null;
    if (rel !== null && rel.props.length > 0) {
      file = propString(rel.props[rel.props.length - 1]);
    }
    if (file === null || file.length === 0) {
      file = texObj.name;
    }
    if (file.length === 0)
      continue;
    let imageIdx = imageIndexCache.get(file);
    if (imageIdx === undefined) {
      imageIdx = images.length;
      imageIndexCache.set(file, imageIdx);
      images.push({ name: file, mimeType: null, bytes: null, uri: ctx.resolveUrl(ctx.sourceUrl, file) });
    }
    const tex = { image: imageIdx, texCoord: 0, sampler: null };
    const builder = matBuilders[matIdx];
    if (builder !== undefined) {
      if (conn.propName === "NormalMap" || conn.propName === "Bump")
        builder.normalTex = tex;
      else
        builder.baseTex = tex;
    }
  }
  const materials = matBuilders.map((b) => ({
    ...b.data,
    baseColorTexture: b.baseTex,
    normalTexture: b.normalTex
  }));
  const geometries = [];
  const geometryIndexById = new Map;
  for (const obj of objects.values()) {
    if (obj.kind !== "Geometry")
      continue;
    const index = geometries.length;
    geometryIndexById.set(obj.id, index);
    geometries.push({
      id: obj.id,
      name: obj.name,
      primitive: parseFbxGeometry(obj.node, ctx),
      materialIds: []
    });
  }
  for (const conn of connections) {
    if (conn.type !== "OO")
      continue;
    const gIdx = geometryIndexById.get(conn.parentId);
    const mIdx = materialIndex.get(conn.childId);
    if (gIdx !== undefined && mIdx !== undefined) {
      geometries[gIdx].materialIds.push(mIdx);
    }
  }
  const modelIds = [];
  const nodes = [];
  const nodeIndexByModel = new Map;
  for (const obj of objects.values()) {
    if (obj.kind !== "Model")
      continue;
    const index = nodes.length;
    nodeIndexByModel.set(obj.id, index);
    modelIds.push(obj.id);
    const p70 = findChild(obj.node, "Properties70");
    const p = p70 !== null ? readP70(p70) : new Map;
    const translation = p.get("Lcl Translation") ?? [0, 0, 0];
    const rotation = p.get("Lcl Rotation") ?? [0, 0, 0];
    const scale = p.get("Lcl Scaling") ?? [1, 1, 1];
    const rotationOrderNum = p.get("RotationOrder")?.[0] ?? 0;
    const quat = eulerDegToQuat(rotation[0], rotation[1], rotation[2], fbxEulerOrder(rotationOrderNum));
    nodes.push({
      name: obj.name,
      translation: [translation[0], translation[1], translation[2]],
      rotation: [quat[0], quat[1], quat[2], quat[3]],
      scale: [scale[0], scale[1], scale[2]],
      matrix: null,
      primitives: [],
      skin: -1,
      children: []
    });
  }
  const roots = [];
  for (const modelId of modelIds) {
    const nodeIdx = nodeIndexByModel.get(modelId);
    let hasParent = false;
    for (const conn of connections) {
      if (conn.type !== "OO" || conn.childId !== modelId)
        continue;
      if (conn.parentId === 0)
        continue;
      const parentIdx = nodeIndexByModel.get(conn.parentId);
      if (parentIdx !== undefined) {
        nodes[parentIdx].children.push(nodeIdx);
        hasParent = true;
        continue;
      }
      const gIdx = geometryIndexById.get(conn.childId);
      if (gIdx !== undefined && conn.parentId === modelId) {
        nodes[nodeIdx].primitives.push(gIdx);
        hasParent = true;
      }
    }
    for (const conn of connections) {
      if (conn.type !== "OO")
        continue;
      const gIdx = geometryIndexById.get(conn.childId);
      if (gIdx === undefined)
        continue;
      if (conn.parentId === modelId) {
        const already = nodes[nodeIdx].primitives.includes(gIdx);
        if (!already)
          nodes[nodeIdx].primitives.push(gIdx);
      }
    }
    if (!hasParent)
      roots.push(nodeIdx);
  }
  if (roots.length === 0 && nodes.length > 0) {
    for (let i = 0;i < nodes.length; i++)
      roots.push(i);
  }
  for (const geometry of geometries) {
    const prim = geometry.primitive;
    if (prim.submeshes.length === 0 && geometry.materialIds.length > 0) {
      const count = prim.indices !== null ? prim.indices.length : prim.positions.length / 3;
      const sub = {
        material: geometry.materialIds[0],
        name: geometry.name,
        offset: 0,
        count
      };
      prim.submeshes.push(sub);
    } else if (prim.submeshes.length > 1 && geometry.materialIds.length > 0) {
      for (const sub of prim.submeshes) {
        if (sub.material < 0)
          sub.material = geometry.materialIds[0];
      }
    }
  }
  return {
    source: "fbx",
    meshNames: geometries.map((g) => g.name),
    meshes: geometries.map((g) => g.primitive),
    materials,
    images,
    samplers: [],
    nodes,
    scenes: [roots],
    skins: [],
    animations: [],
    stats: meshStatsOf(geometries.map((g) => g.primitive), materials, images, nodes, [])
  };
}
function parseFbxGeometry(node, ctx) {
  const url = ctx.sourceUrl;
  const verticesNode = findChild(node, "Vertices");
  const pviNode = findChild(node, "PolygonVertexIndex");
  if (verticesNode === null || pviNode === null) {
    throw new ParseError(`FBX Geometry "${node.name}": нет Vertices/PolygonVertexIndex`, -1, url);
  }
  const controlPoints = propNumbers(verticesNode.props[0]);
  const polyIndex = propInts(pviNode.props[0]);
  const polygons = [];
  let polyStart = 0;
  for (let i = 0;i < polyIndex.length; i++) {
    if (polyIndex[i] < 0) {
      polygons.push([polyStart, i - polyStart + 1]);
      polyStart = i + 1;
    }
  }
  const layerNormal = findDescendant(node, "LayerElementNormal");
  const layerUv = findDescendant(node, "LayerElementUV");
  const layerMaterial = findDescendant(node, "LayerElementMaterial");
  const normalData = layerNormal !== null ? parseLayerElement(layerNormal, 3) : null;
  const uvData = layerUv !== null ? parseLayerElement(layerUv, 2) : null;
  const materialData = layerMaterial !== null ? parseLayerElement(layerMaterial, 1) : null;
  let polyMaterials = null;
  if (materialData !== null) {
    if ((materialData.mapping === "ByPolygon" || materialData.mapping === "ByPolygonVertex") && materialData.values instanceof Int32Array) {
      polyMaterials = materialData.values;
    } else if (materialData.mapping === "AllSame" && materialData.values.length > 0) {
      polyMaterials = new Int32Array(polygons.length).fill(materialData.values[0]);
    }
  }
  const normalsPerVertex = normalData !== null && (normalData.mapping === "ByVertice" || normalData.mapping === "ByVertex") && normalData.indexed === null;
  const uvPerVertex = uvData === null || (uvData.mapping === "ByVertice" || uvData.mapping === "ByVertex") && uvData.indexed === null;
  if (normalsPerVertex && uvPerVertex) {
    const triCount2 = polygons.reduce((acc, [, len]) => acc + Math.max(0, len - 2), 0);
    const indices = new Uint32Array(triCount2 * 3);
    let w = 0;
    for (const [start, len] of polygons) {
      for (let k = 1;k + 1 < len; k++) {
        indices[w++] = absIndex(polyIndex[start]);
        indices[w++] = absIndex(polyIndex[start + k]);
        indices[w++] = absIndex(polyIndex[start + k + 1]);
      }
    }
    const normals2 = normalData !== null ? toF32(normalData.values) : null;
    const uvs2 = uvData !== null ? toF32(uvData.values) : null;
    const submeshes2 = buildPolygonSubmeshes(polygons, polyMaterials, indices, null);
    return {
      positions: toF32(controlPoints),
      normals: normals2,
      uvs: uvs2,
      uvs2: null,
      tangents: null,
      colors: null,
      joints: null,
      weights: null,
      indices: indices.length > 0 ? indices : null,
      mode: "triangles",
      submeshes: submeshes2
    };
  }
  const triCount = polygons.reduce((acc, [, len]) => acc + Math.max(0, len - 2), 0);
  const positions = new Float32Array(triCount * 9);
  const normals = normalData !== null ? new Float32Array(triCount * 9) : null;
  const uvs = uvData !== null ? new Float32Array(triCount * 6) : null;
  const triMaterial = new Int32Array(triCount).fill(-1);
  let tri = 0;
  for (let pi = 0;pi < polygons.length; pi++) {
    const [start, len] = polygons[pi];
    const mat = polyMaterials !== null ? polyMaterials[pi] ?? -1 : -1;
    for (let k = 1;k + 1 < len; k++, tri++) {
      const corners = [start, start + k, start + k + 1];
      for (let ci = 0;ci < 3; ci++) {
        const corner = corners[ci];
        const cp = absIndex(polyIndex[corner]);
        positions.set(controlPoints.subarray(cp * 3, cp * 3 + 3), tri * 9 + ci * 3);
        if (normals !== null && normalData !== null) {
          const n = sampleLayer(normalData, corner, cp, pi);
          normals.set(n.subarray(0, 3), tri * 9 + ci * 3);
        }
        if (uvs !== null && uvData !== null) {
          const u = sampleLayer(uvData, corner, cp, pi);
          if (u.length >= 2) {
            uvs[tri * 6 + ci * 2] = u[0];
            uvs[tri * 6 + ci * 2 + 1] = u[1];
          }
        }
      }
      triMaterial[tri] = mat;
    }
    if ((pi & 2047) === 0 && pi > 0)
      throwIfAborted2(ctx.signal, "fbx parse");
  }
  const submeshes = [];
  let runStart = 0;
  let runMat = triMaterial.length > 0 ? triMaterial[0] : -1;
  for (let t = 1;t <= triMaterial.length; t++) {
    if (t === triMaterial.length || triMaterial[t] !== runMat) {
      submeshes.push({ material: runMat, name: null, offset: runStart * 3, count: (t - runStart) * 3 });
      runStart = t;
      runMat = t < triMaterial.length ? triMaterial[t] : -1;
    }
  }
  if (submeshes.length === 0 && triCount > 0) {
    submeshes.push({ material: -1, name: null, offset: 0, count: triCount * 3 });
  }
  return {
    positions,
    normals,
    uvs,
    uvs2: null,
    tangents: null,
    colors: null,
    joints: null,
    weights: null,
    indices: null,
    mode: "triangles",
    submeshes
  };
}
function buildPolygonSubmeshes(polygons, polyMaterials, indices, _cornerBase) {
  if (polyMaterials === null)
    return [];
  let triBase = 0;
  const ranges = [];
  for (let pi = 0;pi < polygons.length; pi++) {
    const [, len] = polygons[pi];
    const tris = Math.max(0, len - 2);
    const mat = polyMaterials[pi] ?? -1;
    const last = ranges.length - 1;
    if (last >= 0 && ranges[last].material === mat) {
      ranges[last].triEnd += tris;
    } else {
      ranges.push({ material: mat, triStart: triBase, triEnd: triBase + tris });
    }
    triBase += tris;
  }
  const out = [];
  for (const r of ranges) {
    if (r.triEnd <= r.triStart)
      continue;
    out.push({
      material: r.material,
      name: null,
      offset: r.triStart * 3,
      count: (r.triEnd - r.triStart) * 3
    });
  }
  return out;
}
function parseLayerElement(node, stride) {
  const mapping = findChildString(node, "MappingInformationType") ?? "ByPolygonVertex";
  let values = new Float64Array(0);
  let indexed = null;
  for (const child of node.children) {
    const arr = propArray2(child.props[0]);
    if (arr === null)
      continue;
    if (child.name === "Normals" || child.name === "UV" || child.name === "Materials") {
      values = arr;
    } else if (child.name === "NormalsIndex" || child.name === "UVIndex" || child.name === "MaterialsIndex" || child.name === "Index" || child.name === "Indexes") {
      indexed = arr instanceof Int32Array ? arr : Int32Array.from(arr);
    }
  }
  return { mapping, values, indexed, valueStride: stride };
}
function sampleLayer(layer, corner, cp, poly) {
  const stride = layer.valueStride;
  if (layer.mapping === "ByVertice" || layer.mapping === "ByVertex") {
    return subarraySafe(layer.values, cp * stride, stride);
  }
  if (layer.mapping === "ByPolygonVertex") {
    if (layer.indexed !== null) {
      const idx = layer.indexed[corner] ?? 0;
      return subarraySafe(layer.values, idx * stride, stride);
    }
    return subarraySafe(layer.values, corner * stride, stride);
  }
  if (layer.mapping === "ByPolygon") {
    if (layer.indexed !== null) {
      const idx = layer.indexed[poly] ?? 0;
      return subarraySafe(layer.values, idx * stride, stride);
    }
    return subarraySafe(layer.values, poly * stride, stride);
  }
  return subarraySafe(layer.values, 0, stride);
}
function subarraySafe(values, start, len) {
  if (start < 0 || start + len > values.length) {
    return values instanceof Float64Array ? new Float64Array(len) : new Int32Array(len);
  }
  return values.subarray(start, start + len);
}
function absIndex(v) {
  return v < 0 ? ~v : v;
}
function toF32(values) {
  const out = new Float32Array(values.length);
  for (let i = 0;i < values.length; i++)
    out[i] = values[i];
  return out;
}
function findChild(node, name) {
  for (const c of node.children)
    if (c.name === name)
      return c;
  return null;
}
function findDescendant(node, name) {
  const direct = findChild(node, name);
  if (direct !== null)
    return direct;
  for (const c of node.children) {
    const found = findDescendant(c, name);
    if (found !== null)
      return found;
  }
  return null;
}
function findChildString(node, name) {
  const child = findChild(node, name);
  if (child === null || child.props.length === 0)
    return null;
  const v = child.props[0].value;
  return typeof v === "string" ? v : null;
}
function propNumber(prop) {
  if (prop === undefined)
    return 0;
  const v = prop.value;
  if (typeof v === "number")
    return v;
  if (typeof v === "boolean")
    return v ? 1 : 0;
  return 0;
}
function propString(prop) {
  if (prop === undefined)
    return "";
  return typeof prop.value === "string" ? prop.value : "";
}
function propNumbers(prop) {
  if (prop === undefined)
    return new Float64Array(0);
  return prop.value instanceof Float64Array ? prop.value : new Float64Array(0);
}
function propInts(prop) {
  if (prop === undefined)
    return new Int32Array(0);
  return prop.value instanceof Int32Array ? prop.value : new Int32Array(0);
}
function propArray2(prop) {
  if (prop === undefined)
    return null;
  const v = prop.value;
  if (v instanceof Float64Array || v instanceof Int32Array)
    return v;
  if (v instanceof Float32Array)
    return Float64Array.from(v);
  return null;
}
function stripFbxName(raw) {
  const sep = raw.indexOf("::");
  return sep >= 0 ? raw.slice(sep + 2) : raw;
}
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
function readP70(props70) {
  const out = new Map;
  for (const p of props70.children) {
    if (p.name !== "P" || p.props.length < 4)
      continue;
    const name = propString(p.props[0]);
    const values = [];
    for (let i = 4;i < p.props.length; i++) {
      const v = p.props[i].value;
      if (typeof v === "number")
        values.push(v);
    }
    out.set(name, values);
  }
  return out;
}
function fbxEulerOrder(order) {
  switch (order) {
    case 1:
      return "YZX";
    case 2:
      return "XZY";
    case 3:
      return "ZXY";
    case 4:
      return "YXZ";
    case 5:
      return "ZYX";
    default:
      return "ZYX";
  }
}
function eulerDegToQuat(degX, degY, degZ, order) {
  const x = degX * Math.PI / 180;
  const y = degY * Math.PI / 180;
  const z = degZ * Math.PI / 180;
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2), sz = Math.sin(z / 2);
  const qx = [sx, 0, 0, cx];
  const qy = [0, sy, 0, cy];
  const qz = [0, 0, sz, cz];
  const mul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ];
  const parts = order.split("");
  const byAxis = { X: qx, Y: qy, Z: qz };
  let q = byAxis[parts[0]];
  q = mul(q, byAxis[parts[1]]);
  q = mul(q, byAxis[parts[2]]);
  return q;
}
var fbxParser = {
  kind: "fbx",
  extensions: [".fbx"],
  async parse(input) {
    const tree = await parseFbxTree(input.bytes, input.ctx);
    return fbxTreeToMeshDocument(tree, input.ctx);
  }
};

// packages/loaders/src/formats/image.ts
function createImageParser(options) {
  return {
    kind: "image",
    extensions: [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"],
    async parse(input, decodeOptions = {}) {
      if (options.decodeImage === null) {
        throw new UnsupportedError("image: платформенный декодер недоступен (нет createImageBitmap) — передайте decodeImage в менеджер", input.ctx.sourceUrl);
      }
      const mime = sniffKind(input.bytes, input.ctx.sourceUrl).mimeType;
      return options.decodeImage(input.bytes, mime, decodeOptions);
    }
  };
}
function parseHdrBytes(bytes, ctx) {
  const url = ctx.sourceUrl;
  let pos = 0;
  const readLine = () => {
    const start = pos;
    while (pos < bytes.length && bytes[pos] !== 10)
      pos++;
    const s = String.fromCharCode(...bytes.subarray(start, pos));
    pos++;
    return s;
  };
  const magic = readLine();
  if (!magic.startsWith("#?RADIANCE") && !magic.startsWith("#?RGBE")) {
    throw new ParseError("HDR: не Radiance-файл", 0, url);
  }
  let format = "";
  for (;; ) {
    if (pos >= bytes.length)
      throw new ParseError("HDR: внезапный конец заголовка", pos, url);
    const line = readLine();
    if (line === "")
      break;
    if (line.startsWith("FORMAT="))
      format = line.slice(7).trim();
  }
  if (!format.includes("32-bit_rle_rgbe")) {
    throw new ParseError(`HDR: формат ${format} не поддерживается (нужен 32-bit_rle_rgbe)`, pos, url);
  }
  const resLine = readLine();
  const resParts = resLine.trim().split(/\s+/);
  let width = 0;
  let height = 0;
  if (resParts.length >= 4 && resParts[0] === "-Y" && resParts[2] === "+X") {
    height = parseInt(resParts[1], 10);
    width = parseInt(resParts[3], 10);
  }
  if (!width || !height)
    throw new ParseError(`HDR: битая строка разрешения "${resLine}"`, pos, url);
  const out = new Float32Array(width * height * 3);
  for (let y = 0;y < height; y++) {
    throwIfAborted2(ctx.signal, "hdr parse");
    const isNewStyle = pos + 4 <= bytes.length && bytes[pos] === 2 && bytes[pos + 1] === 2 && bytes[pos + 2] * 256 + bytes[pos + 3] === width;
    if (!isNewStyle) {
      for (let x = 0;x < width; x++) {
        if (pos + 4 > bytes.length)
          throw new ParseError("HDR: обрезанный flat-сканлайн", pos, url);
        const r = bytes[pos], g = bytes[pos + 1], b = bytes[pos + 2], e = bytes[pos + 3];
        pos += 4;
        const scale = e !== 0 ? Math.pow(2, e - 136) : 0;
        const o = (y * width + x) * 3;
        out[o] = r * scale;
        out[o + 1] = g * scale;
        out[o + 2] = b * scale;
      }
      continue;
    }
    pos += 4;
    const ch = [
      new Uint8Array(width),
      new Uint8Array(width),
      new Uint8Array(width),
      new Uint8Array(width)
    ];
    let ok = true;
    for (let c = 0;c < 4 && ok; c++) {
      let xi = 0;
      while (xi < width) {
        if (pos >= bytes.length) {
          ok = false;
          break;
        }
        const count = bytes[pos++];
        if (count > 128) {
          const repeat = count - 128;
          if (pos >= bytes.length) {
            ok = false;
            break;
          }
          const value = bytes[pos++];
          ch[c].fill(value, xi, xi + repeat);
          xi += repeat;
        } else {
          const end = Math.min(xi + count, width);
          for (;xi < end; xi++) {
            if (pos >= bytes.length) {
              ok = false;
              break;
            }
            ch[c][xi] = bytes[pos++];
          }
        }
      }
    }
    if (!ok)
      throw new ParseError("HDR: обрезанные RLE-данные", pos, url);
    for (let x = 0;x < width; x++) {
      const e = ch[3][x];
      const scale = e !== 0 ? Math.pow(2, e - 136) : 0;
      const o = (y * width + x) * 3;
      out[o] = ch[0][x] * scale;
      out[o + 1] = ch[1][x] * scale;
      out[o + 2] = ch[2][x] * scale;
    }
  }
  const flipped = new Float32Array(out.length);
  for (let y = 0;y < height; y++) {
    const src = y * width * 3;
    const dst = (height - 1 - y) * width * 3;
    flipped.set(out.subarray(src, src + width * 3), dst);
  }
  return { width, height, rgb: flipped };
}
var hdrParser = {
  kind: "hdr",
  extensions: [".hdr", ".pic"],
  parse(input) {
    return parseHdrBytes(input.bytes, input.ctx);
  }
};

// packages/loaders/src/formats/config.ts
var bytesParser = {
  kind: "bytes",
  extensions: [".bin"],
  parse(input) {
    return input.bytes;
  }
};
var SHARED_DECODER = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;
function decodeUtf82(bytes) {
  if (SHARED_DECODER === null) {
    let out = "";
    for (let i = 0;i < bytes.length; i += 4096) {
      out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 4096, bytes.length)));
    }
    return out;
  }
  return SHARED_DECODER.decode(bytes);
}
var textParser = {
  kind: "text",
  extensions: [".txt"],
  parse(input) {
    return decodeUtf82(skipBom(input.bytes));
  }
};
function skipBom(bytes) {
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    return bytes.subarray(3);
  }
  return bytes;
}
var jsonParser = {
  kind: "json",
  extensions: [".json"],
  parse(input) {
    const text = decodeUtf82(skipBom(input.bytes));
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new ParseError(`невалидный JSON: ${err.message}`, 0, input.ctx.sourceUrl ?? undefined);
    }
  }
};
var WS = new Uint8Array(256).map((_, i) => i === 32 || i === 9 || i === 10 || i === 13 ? 1 : 0);
function isWs(c) {
  return c < 256 && WS[c] === 1;
}
function isNameStart(c) {
  return c >= 97 && c <= 122 || c >= 65 && c <= 90 || c === 95 || c === 58 || c > 127;
}
function isNameChar(c) {
  return isNameStart(c) || c >= 48 && c <= 57 || c === 45 || c === 46;
}
function parseZmlBytes(bytes, ctx) {
  const b = skipBom(bytes);
  const decoder = new ZmlScanner(b);
  return decoder.parseDocument(ctx?.sourceUrl ?? null);
}
var zmlParser = {
  kind: "zml",
  extensions: [".zml", ".xml"],
  parse(input) {
    return parseZmlBytes(input.bytes, input.ctx);
  }
};

class ZmlScanner {
  bytes;
  pos = 0;
  constructor(bytes) {
    this.bytes = bytes;
  }
  parseDocument(url) {
    this.skipProlog();
    const root = this.parseElement(url);
    this.skipMisc();
    if (this.pos < this.bytes.length) {
      throw new ParseError("ZML: мусор после корневого элемента", this.pos, url);
    }
    return root;
  }
  skipProlog() {
    for (;; ) {
      this.skipWs();
      if (this.match("<?")) {
        this.skipUntil("?>", "ZML: незакрытый <? ... ?>");
        continue;
      }
      if (this.match("<!--")) {
        this.skipUntil("-->", "ZML: незакрытый комментарий");
        continue;
      }
      if (this.match("<!DOCTYPE")) {
        this.skipUntil(">", "ZML: незакрытый DOCTYPE");
        continue;
      }
      return;
    }
  }
  skipMisc() {
    for (;; ) {
      this.skipWs();
      if (this.match("<!--")) {
        this.skipUntil("-->", "ZML: незакрытый комментарий");
        continue;
      }
      return;
    }
  }
  parseElement(url) {
    if (this.peek() !== 60) {
      throw new ParseError("ZML: ожидался <", this.pos, url);
    }
    this.pos++;
    const name = this.parseName(url);
    const attrs = this.parseAttrs(url);
    if (this.match("/>")) {
      return { name, attrs, children: [], text: null };
    }
    if (this.peek() !== 62) {
      throw new ParseError(`ZML: ожидался > после <${name}`, this.pos, url);
    }
    this.pos++;
    let text = null;
    const children = [];
    let textStart = -1;
    let textEnd = -1;
    for (;; ) {
      const next = this.indexOfByteFrom(60);
      if (next === -1) {
        throw new ParseError(`ZML: нет закрывающего </${name}>`, this.pos, url);
      }
      if (textStart === -1 && next > this.pos) {
        textStart = this.pos;
        textEnd = next;
      } else if (textStart !== -1 && next > this.pos) {
        textEnd = next;
      }
      this.pos = next;
      if (this.match(`</${name}`)) {
        this.skipWs();
        if (this.peek() !== 62) {
          throw new ParseError(`ZML: кривой закрывающий тег </${name}`, this.pos, url);
        }
        this.pos++;
        const raw = textStart === -1 ? null : this.bytes.subarray(textStart, textEnd);
        if (raw !== null) {
          const decoded = decodeEntities(decodeUtf82(raw), this.pos, url);
          const trimmed = decoded.trim();
          if (trimmed.length > 0)
            text = (text ?? "") + trimmed;
        }
        return { name, attrs, children, text };
      }
      if (this.match("<!--")) {
        this.skipUntil("-->", "ZML: незакрытый комментарий");
        continue;
      }
      if (this.match("<![CDATA[")) {
        const end = this.indexOfAscii("]]>");
        if (end === -1)
          throw new ParseError("ZML: незакрытый CDATA", this.pos, url);
        const cdata = decodeUtf82(this.bytes.subarray(this.pos, end));
        text = (text ?? "") + cdata;
        this.pos = end + 3;
        textStart = -1;
        continue;
      }
      const child = this.parseElement(url);
      children.push(child);
      textStart = -1;
    }
  }
  parseName(url) {
    const start = this.pos;
    if (this.pos >= this.bytes.length || !isNameStart(this.bytes[this.pos])) {
      throw new ParseError("ZML: кривое имя тега", this.pos, url);
    }
    this.pos++;
    while (this.pos < this.bytes.length && isNameChar(this.bytes[this.pos]))
      this.pos++;
    return String.fromCharCode(...this.bytes.subarray(start, this.pos));
  }
  parseAttrs(url) {
    const attrs = {};
    for (;; ) {
      this.skipWs();
      const c = this.peek();
      if (c === 62 || c === 47)
        return attrs;
      if (c === -1)
        throw new ParseError("ZML: внезапный конец в атрибутах", this.pos, url);
      const name = this.parseName(url);
      this.skipWs();
      if (this.peek() !== 61) {
        throw new ParseError(`ZML: у атрибута ${name} нет =`, this.pos, url);
      }
      this.pos++;
      this.skipWs();
      const quote = this.peek();
      if (quote !== 39 && quote !== 34) {
        throw new ParseError(`ZML: значение ${name} без кавычек`, this.pos, url);
      }
      this.pos++;
      const end = this.indexOfByteFrom(quote);
      if (end === -1)
        throw new ParseError(`ZML: значение ${name} не закрыто`, this.pos, url);
      const value = decodeEntities(decodeUtf82(this.bytes.subarray(this.pos, end)), this.pos, url);
      this.pos = end + 1;
      attrs[name] = value;
    }
  }
  skipWs() {
    while (this.pos < this.bytes.length && isWs(this.bytes[this.pos]))
      this.pos++;
  }
  peek() {
    return this.pos < this.bytes.length ? this.bytes[this.pos] : -1;
  }
  match(ascii) {
    if (this.pos + ascii.length > this.bytes.length)
      return false;
    for (let i = 0;i < ascii.length; i++) {
      if (this.bytes[this.pos + i] !== ascii.charCodeAt(i))
        return false;
    }
    this.pos += ascii.length;
    return true;
  }
  skipUntil(marker, err) {
    const at = this.indexOfAscii(marker);
    if (at === -1)
      throw new ParseError(err, this.pos);
    this.pos = at + marker.length;
  }
  indexOfAscii(needle) {
    const first = needle.charCodeAt(0);
    for (let i = this.pos;i <= this.bytes.length - needle.length; i++) {
      if (this.bytes[i] !== first)
        continue;
      let ok = true;
      for (let j = 1;j < needle.length; j++) {
        if (this.bytes[i + j] !== needle.charCodeAt(j)) {
          ok = false;
          break;
        }
      }
      if (ok)
        return i;
    }
    return -1;
  }
  indexOfByteFrom(c) {
    for (let i = this.pos;i < this.bytes.length; i++) {
      if (this.bytes[i] === c)
        return i;
    }
    return -1;
  }
}
var ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'"
};
function decodeEntities(text, offset, url) {
  if (!text.includes("&"))
    return text;
  let out = "";
  let i = 0;
  for (;; ) {
    const next = text.indexOf("&", i);
    if (next === -1)
      break;
    out += text.slice(i, next);
    const semi = text.indexOf(";", next + 1);
    if (semi === -1 || semi - next > 12) {
      out += "&";
      i = next + 1;
      continue;
    }
    const entity = text.slice(next + 1, semi);
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = parseInt(entity.slice(2), 16);
      out += Number.isFinite(code) ? String.fromCodePoint(code) : "";
    } else if (entity.startsWith("#")) {
      const code = parseInt(entity.slice(1), 10);
      out += Number.isFinite(code) ? String.fromCodePoint(code) : "";
    } else {
      const mapped = ENTITIES[entity];
      if (mapped !== undefined)
        out += mapped;
      else
        throw new ParseError(`ZML: неизвестная entity &${entity};`, offset + next, url);
    }
    i = semi + 1;
  }
  out += text.slice(i);
  return out;
}

// packages/loaders/src/registry.ts
var PHASE_WEIGHTS = { fetch: 0.7, parse: 0.2, transform: 0.1 };

class LoadHandle {
  url;
  key;
  promise;
  snapshot;
  settled = false;
  cancelImpl;
  priorityImpl;
  constructor(url, key, promise, snapshot, cancelImpl, priorityImpl) {
    this.url = url;
    this.key = key;
    this.promise = promise;
    this.snapshot = snapshot;
    this.cancelImpl = cancelImpl;
    this.priorityImpl = priorityImpl;
  }
  get progress() {
    return this.snapshot;
  }
  get state() {
    return this.snapshot.phase;
  }
  get isSettled() {
    return this.settled;
  }
  markSettled() {
    this.settled = true;
  }
  update(snapshot) {
    this.snapshot = snapshot;
  }
  cancel(reason) {
    return this.cancelImpl(reason);
  }
  setPriority(priority) {
    return this.priorityImpl(priority);
  }
  then(onFulfilled, onRejected) {
    return this.promise.then(onFulfilled, onRejected);
  }
  catch(onRejected) {
    return this.promise.then(undefined, onRejected);
  }
}
function isBinaryFbx(bytes) {
  return bytes.length >= 23 && asciiDecode(bytes, 0, 20) === "Kaydara FBX Binary  ";
}
function defaultFormats() {
  return [
    {
      id: "glb",
      extensions: ["glb"],
      parse: (ctx) => parseGlb(ctx.assembler, gltfOptionsFrom(ctx))
    },
    {
      id: "gltf",
      extensions: ["gltf"],
      parse: async (ctx) => {
        await ctx.assembler.completion;
        const text = new TextDecoder("utf-8").decode(ctx.assembler.fullView());
        return parseGltfJson(text, { loadExternal: ctx.loadExternal }, gltfOptionsFrom(ctx));
      }
    },
    { id: "obj", extensions: ["obj"], parse: (ctx) => parseObj(ctx.assembler, { onPhase: ctx.onPhase }) },
    {
      id: "mtl",
      extensions: ["mtl"],
      parse: async (ctx) => {
        await ctx.assembler.completion;
        return parseMtl(ctx.assembler.fullView());
      }
    },
    {
      id: "fbx",
      extensions: ["fbx"],
      parse: async (ctx) => {
        await ctx.assembler.completion;
        const bytes = ctx.assembler.fullView();
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return parseFBX(buffer);
      }
    },
    {
      id: "image",
      extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "ico"],
      parse: (ctx) => parseImage(ctx.assembler, {
        signal: ctx.signal,
        onPhase: ctx.onPhase,
        createBitmap: ctx.createBitmap
      })
    },
    {
      id: "config",
      extensions: ["json", "zml", "ini", "txt", "yaml", "yml", "toml"],
      parse: (ctx) => parseConfig(ctx.assembler, extensionOf2(ctx.url), { onPhase: ctx.onPhase })
    },
    {
      id: "bytes",
      extensions: ["bin", "ktx2"],
      parse: async (ctx) => {
        await ctx.assembler.completion;
        return ctx.assembler.fullView();
      }
    }
  ];
}
function gltfOptionsFrom(ctx) {
  return {
    signal: ctx.signal,
    onPhase: ctx.onPhase,
    createBitmap: ctx.createBitmap,
    dracoDecoder: ctx.dracoDecoder
  };
}

class AssetLoader {
  scheduler;
  fetchImpl;
  cacheBytesLimit;
  createBitmap;
  dracoDecoder;
  defaults;
  formats = defaultFormats();
  jobs = new Map;
  cache = new Map;
  listeners = new Map;
  downloads = 0;
  downloadBytes = 0;
  cacheHits = 0;
  constructor(options = {}) {
    this.scheduler = options.scheduler ?? new FetchScheduler;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheBytesLimit = options.cacheBytesLimit ?? 268435456;
    this.createBitmap = options.createBitmap;
    this.dracoDecoder = options.dracoDecoder;
    this.defaults = options.defaults ?? {};
  }
  load(url, options = {}) {
    const opts = { ...this.defaults, ...options };
    const key = url;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      cached.lastAccess = nowMs();
      this.cacheHits++;
      const handle2 = new LoadHandle(url, key, Promise.resolve(cached.asset), {
        phase: "done",
        loaded: cached.bytes,
        total: cached.bytes,
        phaseRatio: 1,
        ratio: 1,
        url,
        cached: true,
        detail: "из кэша"
      }, () => false, () => false);
      handle2.markSettled();
      opts.onProgress?.(handle2.progress);
      this.emit({ type: "done", handle: handle2 });
      return handle2;
    }
    const active = this.jobs.get(key);
    if (active !== undefined)
      return active.handle;
    let weight = opts.weightBytes ?? 8388608;
    let phase = "queued";
    let loaded = 0;
    let total = 0;
    let phaseRatio = 0;
    let detail = "в очереди";
    let resolveAsset;
    let rejectAsset;
    const assetPromise = new Promise((resolve, reject) => {
      resolveAsset = resolve;
      rejectAsset = reject;
    });
    const snapshot = () => ({
      phase,
      loaded,
      total,
      phaseRatio,
      ratio: overallRatio(phase, phaseRatio, loaded, total),
      url,
      cached: false,
      detail
    });
    const forgetJob = () => {
      this.jobs.delete(key);
    };
    const job = {
      id: allocJobId(),
      priority: opts.priority ?? 5,
      seq: allocJobId(),
      weight: () => weight,
      onCancelledBeforeStart: (reason) => {
        phase = "cancelled";
        const snap = snapshot();
        handle.update(snap);
        opts.onProgress?.(snap);
        forgetJob();
        handle.markSettled();
        rejectAsset(toAbortError(reason));
        this.emit({ type: "cancelled", handle });
      },
      start: async (schedulerSignal) => {
        const startedAt = nowMs();
        phase = "fetching";
        reportProgress("соединение");
        const controller = new AbortController;
        const external = opts.signal;
        if (external?.aborted)
          throw toAbortError(external.reason);
        external?.addEventListener("abort", () => controller.abort(toAbortError(external.reason)), {
          once: true
        });
        schedulerSignal.addEventListener("abort", () => controller.abort(toAbortError(schedulerSignal.reason)), {
          once: true
        });
        const fetchOptions = {
          signal: controller.signal,
          connectTimeoutMs: opts.connectTimeoutMs,
          retries: opts.retries,
          fetchImpl: this.fetchImpl,
          onBytes: (received, declared) => {
            loaded = received;
            if (declared > 0 && received <= declared && declared !== total) {
              total = declared;
              weight = declared;
              this.scheduler.updateWeight(job);
            } else if (total > 0 && received > total) {
              total = 0;
            }
            phaseRatio = total > 0 ? loaded / total : unknownTotalRatio(loaded);
            reportProgress(`${formatBytes(loaded)}${total > 0 ? ` / ${formatBytes(total)}` : ""}`);
          }
        };
        try {
          const response = await fetchStreaming(url, fetchOptions);
          if (response.contentLength !== undefined && response.contentLength > 0) {
            total = response.contentLength;
            weight = response.contentLength;
            this.scheduler.updateWeight(job);
          }
          this.downloads++;
          const parse = await this.resolveParser(url, opts, response.assembler);
          phase = "parsing";
          phaseRatio = 0;
          reportProgress("парсинг");
          const parseStartedAt = nowMs();
          const asset = await parse({
            url,
            assembler: response.assembler,
            signal: controller.signal,
            onPhase: (event) => {
              phaseRatio = event.ratio;
              reportProgress(`${event.stage}: ${event.detail}`);
            },
            loadExternal: async (uri) => {
              const resolved = resolveUrl(url, uri);
              const externalResponse = await fetchStreaming(resolved, fetchOptions);
              await externalResponse.done;
              return externalResponse.assembler.fullView();
            },
            createBitmap: this.createBitmap,
            dracoDecoder: this.dracoDecoder
          });
          const parsedMs = nowMs() - parseStartedAt;
          const transforms = opts.transform ?? [];
          let result = asset;
          if (transforms.length > 0) {
            phase = "transforming";
            for (let i = 0;i < transforms.length; i++) {
              phaseRatio = i / transforms.length;
              reportProgress(`transform ${i + 1}/${transforms.length}`);
              const meta = { url, bytes: loaded, fetchedMs: parseStartedAt - startedAt, parsedMs };
              result = await transforms[i](result, meta);
            }
          }
          if (!opts.noCache) {
            this.cache.set(key, { asset: result, bytes: Math.max(loaded, total, 1), lastAccess: nowMs() });
            this.evictIfNeeded();
          }
          this.downloadBytes += loaded;
          phase = "done";
          phaseRatio = 1;
          reportProgress(`готово за ${formatDuration(nowMs() - startedAt)}`);
          forgetJob();
          resolveAsset(result);
          handle.markSettled();
          this.emit({ type: "done", handle });
        } catch (error) {
          const cancelled = isAbortError(error);
          phase = cancelled ? "cancelled" : "error";
          const snap = snapshot();
          handle.update(snap);
          opts.onProgress?.(snap);
          forgetJob();
          handle.markSettled();
          rejectAsset(error);
          if (cancelled)
            this.emit({ type: "cancelled", handle });
          else
            this.emit({ type: "error", handle, error });
        }
      }
    };
    const handle = new LoadHandle(url, key, assetPromise, {
      phase: "queued",
      loaded: 0,
      total: 0,
      phaseRatio: 0,
      ratio: 0,
      url,
      cached: false,
      detail: "в очереди"
    }, (reason) => {
      if (handle.isSettled)
        return false;
      return this.scheduler.cancel(job, reason);
    }, (priority) => {
      if (handle.isSettled)
        return false;
      return this.scheduler.setPriority(job, priority);
    });
    const reportProgress = (text) => {
      if (text !== undefined)
        detail = text;
      const snap = snapshot();
      handle.update(snap);
      opts.onProgress?.(snap);
      this.emit({ type: "progress", handle });
    };
    this.jobs.set(key, { handle, schedulerJob: job });
    this.scheduler.submit(job);
    return handle;
  }
  async preload(urls, options = {}) {
    const ok = [];
    const failed = [];
    await Promise.all(urls.map(async (url) => {
      try {
        await this.load(url, options);
        ok.push(url);
      } catch (error) {
        failed.push({ url, error });
      }
    }));
    return { ok, failed };
  }
  loadGroup(entries) {
    const handles = entries.map((entry) => this.load(entry.url, entry.options ?? {}));
    const promise = Promise.all(handles.map((handle) => handle.then((asset) => asset)));
    return {
      urls: entries.map((entry) => entry.url),
      promise,
      get progress() {
        let weightSum = 0;
        let ratioWeighted = 0;
        let loadedSum = 0;
        let totalSum = 0;
        let doneCount = 0;
        let worstPhase = "queued";
        let worstRank = 0;
        const ranks = {
          queued: 1,
          fetching: 2,
          parsing: 3,
          transforming: 4,
          done: 5,
          error: 5,
          cancelled: 5
        };
        for (const handle of handles) {
          const progress = handle.progress;
          const weight = Math.max(progress.total, progress.loaded, 1);
          weightSum += weight;
          ratioWeighted += weight * progress.ratio;
          loadedSum += progress.loaded;
          totalSum += progress.total;
          if (progress.phase === "done")
            doneCount++;
          if (ranks[progress.phase] > worstRank) {
            worstRank = ranks[progress.phase];
            worstPhase = progress.phase;
          }
        }
        const groupRatio = weightSum > 0 ? ratioWeighted / weightSum : 0;
        const text = `${doneCount}/${handles.length} готово · ` + (worstPhase === "fetching" ? `${formatBytes(loadedSum)}${totalSum > 0 ? ` / ${formatBytes(totalSum)}` : ""}` : worstPhase);
        return {
          phase: worstPhase,
          loaded: loadedSum,
          total: totalSum,
          phaseRatio: groupRatio,
          ratio: groupRatio,
          url: entries.length === 1 ? entries[0].url : `${handles.length} ассетов`,
          cached: false,
          detail: text
        };
      },
      cancel: (reason) => {
        for (const handle of handles)
          handle.cancel(reason);
      }
    };
  }
  get(url) {
    return this.cache.get(url)?.asset;
  }
  getHandle(url) {
    return this.jobs.get(url)?.handle;
  }
  stats() {
    let cacheBytes = 0;
    for (const entry of this.cache.values())
      cacheBytes += entry.bytes;
    const schedulerStats = this.scheduler.stats();
    return {
      cached: this.cache.size,
      cacheBytes,
      running: schedulerStats.running,
      queued: schedulerStats.queued,
      bytesInFlight: schedulerStats.bytesInFlight,
      downloads: this.downloads,
      downloadBytes: this.downloadBytes,
      cacheHits: this.cacheHits
    };
  }
  dispose(url) {
    return this.cache.delete(url);
  }
  clear() {
    this.cache.clear();
  }
  on(type, listener) {
    let list = this.listeners.get(type);
    if (list === undefined) {
      list = [];
      this.listeners.set(type, list);
    }
    list.push(listener);
    return () => {
      const current = this.listeners.get(type);
      if (current === undefined)
        return;
      const index = current.indexOf(listener);
      if (index >= 0)
        current.splice(index, 1);
    };
  }
  registerFormat(id, extensions, parse) {
    this.formats.unshift({ id, extensions, parse });
  }
  get configParsers() {
    return {
      register: registerConfigParser,
      of: configParserOf
    };
  }
  async resolveParser(url, options, assembler) {
    if (options.parser !== undefined) {
      const format = this.formats.find((f) => f.id === options.parser);
      if (format !== undefined)
        return format.parse;
      throw new Error(`парсер «${options.parser}» не зарегистрирован`);
    }
    const extension = extensionOf2(url);
    if (extension !== "") {
      const format = this.formats.find((f) => f.extensions.includes(extension));
      if (format !== undefined)
        return format.parse;
    }
    await assembler.waitFor(24);
    const prefix = assembler.slice(0, Math.min(24, assembler.watermark));
    if (isGltfJson(prefix))
      return this.formats.find((f) => f.id === "glb").parse;
    if (isBinaryFbx(prefix))
      return this.formats.find((f) => f.id === "fbx").parse;
    return this.formats.find((f) => f.id === "bytes").parse;
  }
  emit(event) {
    const list = this.listeners.get(event.type);
    if (list === undefined)
      return;
    for (const listener of [...list])
      try {
        listener(event);
      } catch {}
  }
  evictIfNeeded() {
    if (this.cacheBytesLimit <= 0)
      return;
    let bytes = 0;
    for (const entry of this.cache.values())
      bytes += entry.bytes;
    while (bytes > this.cacheBytesLimit) {
      let victim;
      for (const [key, entry] of this.cache) {
        if (this.jobs.has(key))
          continue;
        if (victim === undefined || entry.lastAccess < victim.entry.lastAccess)
          victim = { key, entry };
      }
      if (victim === undefined)
        break;
      this.cache.delete(victim.key);
      bytes -= victim.entry.bytes;
      this.emit({ type: "evicted", url: victim.key, bytes: victim.entry.bytes });
    }
  }
}
function extensionOf2(url) {
  const path = url.split("?")[0]?.split("#")[0] ?? "";
  const lastSlash = path.lastIndexOf("/");
  const lastDot = path.lastIndexOf(".");
  if (lastDot <= lastSlash)
    return "";
  return path.slice(lastDot + 1).toLowerCase();
}
function overallRatio(phase, phaseRatio, loaded, total) {
  switch (phase) {
    case "queued":
      return 0;
    case "fetching":
      return PHASE_WEIGHTS.fetch * (total > 0 ? Math.min(1, loaded / total) : unknownTotalRatio(loaded));
    case "parsing":
      return PHASE_WEIGHTS.fetch + PHASE_WEIGHTS.parse * phaseRatio;
    case "transforming":
      return PHASE_WEIGHTS.fetch + PHASE_WEIGHTS.parse + PHASE_WEIGHTS.transform * phaseRatio;
    case "done":
      return 1;
    case "error":
    case "cancelled":
      return 0;
  }
}
function unknownTotalRatio(bytes) {
  return Math.min(0.95, 1 - Math.exp(-bytes / 8388608));
}
function resolveUrl(baseUrl, uri) {
  if (/^https?:\/\//i.test(uri) || uri.startsWith("data:"))
    return uri;
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    const lastSlash = baseUrl.lastIndexOf("/");
    return lastSlash >= 0 ? `${baseUrl.slice(0, lastSlash + 1)}${uri}` : uri;
  }
}
function formatBytes(bytes) {
  if (bytes >= 1048576)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024)
    return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} с` : `${Math.round(ms)} мс`;
}
var mtlParserAdapter = {
  kind: "mtl",
  extensions: [".mtl"],
  parse(input) {
    return parseMtl(input.bytes);
  }
};
function createParserRegistry(options = {}) {
  const decodeImage = options.decodeImage !== undefined ? options.decodeImage : typeof createImageBitmap === "function" ? createImageBitmap : null;
  const map = new Map;
  map.set("gltf", gltfParser);
  map.set("obj", objParser);
  map.set("fbx", fbxParser);
  map.set("mtl", mtlParserAdapter);
  map.set("image", createImageParser({ decodeImage }));
  map.set("hdr", hdrParser);
  map.set("json", jsonParser);
  map.set("zml", zmlParser);
  map.set("text", textParser);
  map.set("bytes", bytesParser);
  return map;
}
// packages/loaders/src/scheduler.ts
var nextJobId2 = 1;

class LoadScheduler {
  maxConcurrent;
  maxBytesInFlight;
  queue = [];
  running = new Map;
  weights = new Map;
  bytesInFlight = 0;
  paused = false;
  started = 0;
  finished = 0;
  drainListeners = new Set;
  constructor(options = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.maxBytesInFlight = Math.max(1, options.maxBytesInFlight ?? 64 * 1024 * 1024);
  }
  submit(job) {
    this.queue.push(job);
    this.sortQueue();
    this.pump();
  }
  setPriority(job, priority) {
    if (job.priority === priority)
      return false;
    job.priority = priority;
    const inQueue = this.queue.includes(job);
    if (inQueue)
      this.sortQueue();
    this.pump();
    return inQueue;
  }
  cancel(job, reason) {
    const qi = this.queue.indexOf(job);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      job.onCancelledBeforeStart?.(reason);
      this.notifyDrain();
      return true;
    }
    const run = this.running.get(job.id);
    if (run !== undefined) {
      run.controller.abort(new DOMException(reason ?? "загрузка отменена", "AbortError"));
      return true;
    }
    return false;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.pump();
  }
  get isPaused() {
    return this.paused;
  }
  setBytesQuota(bytes) {
    this.maxBytesInFlight = Math.max(1, bytes);
    this.pump();
  }
  updateWeight(job) {
    if (!this.running.has(job.id))
      return;
    const old = this.weights.get(job.id);
    const fresh = Math.max(1, job.weight());
    if (old === fresh)
      return;
    this.weights.set(job.id, fresh);
    this.bytesInFlight += fresh - (old ?? fresh);
    if (this.bytesInFlight < 0)
      this.bytesInFlight = 0;
    this.pump();
  }
  setConcurrency(n) {
    this.maxConcurrent = Math.max(1, n);
    this.pump();
  }
  stats() {
    return {
      running: this.running.size,
      queued: this.queue.length,
      bytesInFlight: this.bytesInFlight,
      maxConcurrent: this.maxConcurrent,
      maxBytesInFlight: this.maxBytesInFlight,
      started: this.started,
      finished: this.finished
    };
  }
  onDrain(listener) {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }
  notifyDrain() {
    if (this.queue.length === 0 && this.running.size === 0) {
      for (const l of [...this.drainListeners])
        l();
    }
  }
  sortQueue() {
    this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  }
  pump() {
    if (this.paused)
      return;
    while (this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue[0];
      if (job === undefined)
        break;
      const weight = Math.max(1, job.weight());
      if (this.running.size > 0 && this.bytesInFlight + weight > this.maxBytesInFlight) {
        break;
      }
      this.queue.shift();
      const controller = new AbortController;
      this.running.set(job.id, { job, controller });
      this.weights.set(job.id, weight);
      this.bytesInFlight += weight;
      this.started++;
      job.start(controller.signal).then(() => this.finish(job.id, undefined), (error) => this.finish(job.id, error));
    }
  }
  finish(jobId, _error) {
    const run = this.running.get(jobId);
    if (run === undefined)
      return;
    this.running.delete(jobId);
    const weight = this.weights.get(jobId) ?? Math.max(1, run.job.weight());
    this.weights.delete(jobId);
    this.bytesInFlight -= weight;
    if (this.bytesInFlight < 0)
      this.bytesInFlight = 0;
    this.finished++;
    this.pump();
    this.notifyDrain();
  }
}
function nextSchedulerJobId() {
  return nextJobId2++;
}

// packages/loaders/src/source.ts
async function openByteSource(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = Math.max(0, options.retries ?? 1);
  const connectTimeoutMs = options.connectTimeoutMs ?? 30000;
  let lastError = null;
  for (let attempt = 0;attempt <= retries; attempt++) {
    if (options.signal?.aborted)
      throw abortError2(options.signal);
    const controller = new AbortController;
    const stopTimeout = connectTimeout(controller, connectTimeoutMs, options.signal);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      stopTimeout();
      followAbort(options.signal, controller);
      if (!response.ok || response.body === null) {
        const retryable = response.status >= 500 || response.status === 429;
        lastError = new TypeError(`HTTP ${response.status} ${response.statusText} — ${url}`);
        if (retryable && attempt < retries) {
          await backoff(attempt, options.signal);
          continue;
        }
        throw lastError;
      }
      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = contentLengthHeader !== null ? Number(contentLengthHeader) : undefined;
      const assembler = new Assembler(response.body, {
        total: Number.isFinite(contentLength) ? contentLength : undefined,
        signal: options.signal,
        onBytes: options.onBytes
      });
      return {
        url,
        contentLength: assembler.total,
        assembler,
        done: assembler.completion
      };
    } catch (error) {
      stopTimeout();
      if (isAbort(error))
        throw error;
      lastError = error;
      if (attempt < retries) {
        await backoff(attempt, options.signal);
        continue;
      }
      throw error;
    }
  }
  throw lastError ?? new Error(`источник недоступен: ${url}`);
}
function connectTimeout(controller, ms, _external) {
  const timer = setTimeout(() => {
    controller.abort(new DOMException("таймаут соединения", "TimeoutError"));
  }, ms);
  return () => clearTimeout(timer);
}
function followAbort(external, controller) {
  if (external === undefined)
    return;
  if (external.aborted) {
    controller.abort(abortError2(external));
    return;
  }
  external.addEventListener("abort", () => {
    controller.abort(abortError2(external));
  }, { once: true });
}
async function backoff(attempt, signal) {
  const delay = Math.min(4000, 250 * 2 ** attempt);
  await sleepAbortable2(delay, signal);
}
function sleepAbortable2(ms, signal) {
  if (signal?.aborted)
    return Promise.reject(abortError2(signal));
  return new Promise((resolve, reject) => {
    const external = signal;
    const timer = setTimeout(() => {
      external?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError2(external));
    };
    external?.addEventListener("abort", onAbort, { once: true });
  });
}
function abortError2(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("загрузка отменена", "AbortError");
}
function isAbort(error) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}

// packages/loaders/src/types.ts
var PHASE_WEIGHTS2 = {
  fetch: 0.7,
  parse: 0.2,
  transform: 0.1
};

// packages/loaders/src/library.ts
function defaultFormats2() {
  return [
    { id: "glb", extensions: ["glb"], parse: async (ctx) => parseGlb(ctx.assembler, gltfOptions(ctx)) },
    {
      id: "gltf",
      extensions: ["gltf"],
      parse: async (ctx) => {
        await ctx.assembler.completion;
        const jsonText = parseTextBytes(ctx.assembler.fullView());
        return parseGltfJson(jsonText, { loadExternal: ctx.loadExternal }, gltfOptions(ctx));
      }
    },
    { id: "obj", extensions: ["obj"], parse: async (ctx) => parseObjStream(ctx.assembler, { onPhase: ctx.onPhase }) },
    {
      id: "mtl",
      extensions: ["mtl"],
      parse: async (ctx) => {
        await ctx.assembler.completion;
        return parseMtlBytes(ctx.assembler.fullView());
      }
    },
    {
      id: "fbx",
      extensions: ["fbx"],
      parse: async (ctx) => {
        await ctx.assembler.completion;
        return parseFbx(ctx.assembler.fullView(), { signal: ctx.signal, onPhase: ctx.onPhase });
      }
    },
    {
      id: "image",
      extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "ico"],
      parse: async (ctx) => parseImage(ctx.assembler, { signal: ctx.signal, onPhase: ctx.onPhase, createBitmap: ctx.createBitmap })
    },
    {
      id: "config",
      extensions: ["json", "zml", "ini", "txt", "yaml", "yml", "toml"],
      parse: async (ctx) => parseConfig(ctx.assembler, extensionOf3(ctx.url), { onPhase: ctx.onPhase })
    },
    {
      id: "bytes",
      extensions: ["bin", "ktx2"],
      parse: async (ctx) => {
        await ctx.assembler.completion;
        return ctx.assembler.fullView();
      }
    }
  ];
}
function gltfOptions(ctx) {
  return { signal: ctx.signal, onPhase: ctx.onPhase, createBitmap: ctx.createBitmap, dracoDecoder: ctx.dracoDecoder };
}
function extensionOf3(url) {
  const clean = url.split("?")[0]?.split("#")[0] ?? "";
  const slash = clean.lastIndexOf("/");
  const dot = clean.lastIndexOf(".");
  if (dot <= slash)
    return "";
  return clean.slice(dot + 1).toLowerCase();
}

class AssetHandleImpl {
  url;
  key;
  promise;
  cancelImpl;
  priorityImpl;
  snapshot;
  settled = false;
  constructor(url, key, promise, initial, cancelImpl, priorityImpl) {
    this.url = url;
    this.key = key;
    this.promise = promise;
    this.cancelImpl = cancelImpl;
    this.priorityImpl = priorityImpl;
    this.snapshot = initial;
  }
  get progress() {
    return this.snapshot;
  }
  get state() {
    return this.snapshot.phase;
  }
  get isSettled() {
    return this.settled;
  }
  markSettled() {
    this.settled = true;
  }
  update(next) {
    this.snapshot = next;
  }
  cancel(reason) {
    return this.cancelImpl(reason);
  }
  setPriority(priority) {
    return this.priorityImpl(priority);
  }
  then(onfulfilled, onrejected) {
    return this.promise.then(onfulfilled, onrejected);
  }
  catch(onrejected) {
    return this.promise.then(undefined, onrejected);
  }
}

class AssetLibrary {
  scheduler;
  fetchImpl;
  cacheBytesLimit;
  createBitmap;
  dracoDecoder;
  defaults;
  formats = defaultFormats2();
  jobs = new Map;
  cache = new Map;
  listeners = new Map;
  downloads = 0;
  downloadBytes = 0;
  cacheHits = 0;
  constructor(options = {}) {
    this.scheduler = options.scheduler ?? new LoadScheduler;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.cacheBytesLimit = options.cacheBytesLimit ?? 256 * 1024 * 1024;
    this.createBitmap = options.createBitmap;
    this.dracoDecoder = options.dracoDecoder;
    this.defaults = options.defaults ?? {};
  }
  load(url, options = {}) {
    const merged = { ...this.defaults, ...options };
    const key = url;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      cached.lastAccess = now();
      this.cacheHits++;
      const handle2 = new AssetHandleImpl(url, key, Promise.resolve(cached.asset), { phase: "done", loaded: cached.bytes, total: cached.bytes, phaseRatio: 1, ratio: 1, url, cached: true, detail: "из кэша" }, () => false, () => false);
      handle2.markSettled();
      options.onProgress?.(handle2.progress);
      this.emit({ type: "done", handle: handle2 });
      return handle2;
    }
    const existing = this.jobs.get(key);
    if (existing !== undefined) {
      return existing.handle;
    }
    let currentWeight = merged.weightBytes ?? 8 * 1024 * 1024;
    let phase = "queued";
    let loaded = 0;
    let total = 0;
    let phaseRatio = 0;
    let detail = "в очереди";
    let resolveAsset;
    let rejectAsset;
    const promise = new Promise((resolve, reject) => {
      resolveAsset = resolve;
      rejectAsset = reject;
    });
    const snapshot = () => ({
      phase,
      loaded,
      total,
      phaseRatio,
      ratio: aggregateRatio(phase, phaseRatio, loaded, total),
      url,
      cached: false,
      detail
    });
    const finishJob = () => {
      this.jobs.delete(key);
    };
    const schedulerJob = {
      id: nextSchedulerJobId(),
      priority: merged.priority ?? 5,
      seq: nextSchedulerJobId(),
      weight: () => currentWeight,
      onCancelledBeforeStart: (reason) => {
        phase = "cancelled";
        const snap = snapshot();
        handle.update(snap);
        merged.onProgress?.(snap);
        finishJob();
        handle.markSettled();
        rejectAsset(cancelError(reason));
        this.emit({ type: "cancelled", handle });
      },
      start: async (signal) => {
        const startedAt = now();
        phase = "fetching";
        pushProgress("соединение");
        const controller = new AbortController;
        const external = merged.signal;
        if (external?.aborted)
          throw cancelError(external.reason);
        external?.addEventListener("abort", () => controller.abort(cancelError(external.reason)), { once: true });
        signal.addEventListener("abort", () => controller.abort(cancelError(signal.reason)), { once: true });
        try {
          const sourceOptions = {
            signal: controller.signal,
            connectTimeoutMs: merged.connectTimeoutMs,
            retries: merged.retries,
            fetchImpl: this.fetchImpl,
            onBytes: (received, contentTotal) => {
              loaded = received;
              if (contentTotal > 0 && received <= contentTotal && contentTotal !== total) {
                total = contentTotal;
                currentWeight = contentTotal;
                this.scheduler.updateWeight(schedulerJob);
              } else if (total > 0 && received > total) {
                total = 0;
              }
              phaseRatio = total > 0 ? received / total : asymptotic(received);
              pushProgress(`${fmtBytes(received)}${total > 0 ? ` / ${fmtBytes(total)}` : ""}`);
            }
          };
          const source = await openByteSource(url, sourceOptions);
          if (source.contentLength !== undefined && source.contentLength > 0) {
            total = source.contentLength;
            currentWeight = source.contentLength;
            this.scheduler.updateWeight(schedulerJob);
          }
          this.downloads++;
          const parser = await this.resolveParser(url, merged, source.assembler);
          phase = "parsing";
          phaseRatio = 0;
          pushProgress("парсинг");
          const parseStartedAt = now();
          const asset = await parser({
            url,
            assembler: source.assembler,
            signal: controller.signal,
            onPhase: (info) => {
              phaseRatio = info.ratio;
              pushProgress(`${info.stage}: ${info.detail}`);
            },
            loadExternal: async (uri) => {
              const absolute = resolveUrl2(url, uri);
              const sub = await openByteSource(absolute, sourceOptions);
              await sub.done;
              return sub.assembler.fullView();
            },
            createBitmap: this.createBitmap,
            dracoDecoder: this.dracoDecoder
          });
          const parseMs = now() - parseStartedAt;
          const transforms = merged.transform ?? [];
          let value = asset;
          if (transforms.length > 0) {
            phase = "transforming";
            for (let i = 0;i < transforms.length; i++) {
              phaseRatio = i / transforms.length;
              pushProgress(`transform ${i + 1}/${transforms.length}`);
              const meta = { url, bytes: loaded, fetchedMs: parseStartedAt - startedAt, parsedMs: parseMs };
              value = await transforms[i](value, meta);
            }
          }
          if (!merged.noCache) {
            this.cache.set(key, { asset: value, bytes: Math.max(loaded, total, 1), lastAccess: now() });
            this.evictIfNeeded();
          }
          this.downloadBytes += loaded;
          phase = "done";
          phaseRatio = 1;
          pushProgress(`готово за ${fmtMs(now() - startedAt)}`);
          finishJob();
          resolveAsset(value);
          handle.markSettled();
          this.emit({ type: "done", handle });
        } catch (error) {
          const aborted = isAbortError3(error);
          phase = aborted ? "cancelled" : "error";
          const snap = snapshot();
          handle.update(snap);
          merged.onProgress?.(snap);
          finishJob();
          handle.markSettled();
          rejectAsset(error);
          if (aborted)
            this.emit({ type: "cancelled", handle });
          else
            this.emit({ type: "error", handle, error });
        }
      }
    };
    const handle = new AssetHandleImpl(url, key, promise, { phase: "queued", loaded: 0, total: 0, phaseRatio: 0, ratio: 0, url, cached: false, detail: "в очереди" }, (reason) => {
      if (handle.isSettled)
        return false;
      const job = this.jobs.get(key);
      if (job !== undefined)
        job.cancelled = true;
      return this.scheduler.cancel(schedulerJob, reason);
    }, (priority) => {
      if (handle.isSettled)
        return false;
      return this.scheduler.setPriority(schedulerJob, priority);
    });
    function pushProgress(nextDetail) {
      if (nextDetail !== undefined)
        detail = nextDetail;
      const snap = snapshot();
      handle.update(snap);
      merged.onProgress?.(snap);
      emitProgress(snap);
    }
    const emitProgress = (snap) => {
      this.emit({ type: "progress", handle });
    };
    this.jobs.set(key, { handle, schedulerJob, cancelled: false });
    this.scheduler.submit(schedulerJob);
    return handle;
  }
  async preload(urls, options = {}) {
    const ok = [];
    const failed = [];
    await Promise.all(urls.map(async (url) => {
      try {
        await this.load(url, options);
        ok.push(url);
      } catch (error) {
        failed.push({ url, error });
      }
    }));
    return { ok, failed };
  }
  loadGroup(entries) {
    const handles = entries.map((entry) => this.load(entry.url, entry.options ?? {}));
    let cancelled = false;
    const promise = Promise.all(handles.map((handle) => handle.then((value) => value)));
    const group = {
      urls: entries.map((entry) => entry.url),
      promise,
      get progress() {
        let weightSum = 0;
        let weighted = 0;
        let loaded = 0;
        let total = 0;
        let doneCount = 0;
        let label = "queued";
        const rank = {
          queued: 1,
          fetching: 2,
          parsing: 3,
          transforming: 4,
          done: 5,
          error: 5,
          cancelled: 5
        };
        let worstRank = 0;
        for (const handle of handles) {
          const p = handle.progress;
          const weight = Math.max(p.total, p.loaded, 1);
          weightSum += weight;
          weighted += weight * p.ratio;
          loaded += p.loaded;
          total += p.total;
          if (p.phase === "done")
            doneCount++;
          if (rank[p.phase] > worstRank) {
            worstRank = rank[p.phase];
            label = p.phase;
          }
        }
        const ratio = weightSum > 0 ? weighted / weightSum : 0;
        const detail = `${doneCount}/${handles.length} готово · ` + (label === "fetching" ? `${fmtBytes(loaded)}${total > 0 ? ` / ${fmtBytes(total)}` : ""}` : label);
        return {
          phase: label,
          loaded,
          total,
          phaseRatio: ratio,
          ratio,
          url: entries.length === 1 ? entries[0].url : `${handles.length} ассетов`,
          cached: false,
          detail
        };
      },
      cancel: (reason) => {
        cancelled = true;
        for (const handle of handles)
          handle.cancel(reason);
      }
    };
    return group;
  }
  get(url) {
    return this.cache.get(url)?.asset;
  }
  getHandle(url) {
    return this.jobs.get(url)?.handle;
  }
  stats() {
    let cacheBytes = 0;
    for (const entry of this.cache.values())
      cacheBytes += entry.bytes;
    const s = this.scheduler.stats();
    return {
      cached: this.cache.size,
      cacheBytes,
      running: s.running,
      queued: s.queued,
      bytesInFlight: s.bytesInFlight,
      downloads: this.downloads,
      downloadBytes: this.downloadBytes,
      cacheHits: this.cacheHits
    };
  }
  dispose(url) {
    return this.cache.delete(url);
  }
  clear() {
    this.cache.clear();
  }
  on(type, listener) {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set;
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }
  registerFormat(id, extensions, parse) {
    this.formats.unshift({ id, extensions, parse });
  }
  get configParsers() {
    return { register: registerConfigParser, of: (ext) => configParserOf(ext) };
  }
  async resolveParser(url, options, assembler) {
    if (options.parser !== undefined) {
      const byId = this.formats.find((format) => format.id === options.parser);
      if (byId !== undefined)
        return byId.parse;
      throw new Error(`парсер «${options.parser}» не зарегистрирован`);
    }
    const extension = extensionOf3(url);
    if (extension !== "") {
      const byExtension = this.formats.find((format) => format.extensions.includes(extension));
      if (byExtension !== undefined)
        return byExtension.parse;
    }
    await assembler.waitFor(24);
    const head = assembler.slice(0, Math.min(24, assembler.watermark));
    if (looksLikeGlb(head))
      return this.formats.find((f) => f.id === "glb").parse;
    if (looksLikeFbxBinary(head))
      return this.formats.find((f) => f.id === "fbx").parse;
    return this.formats.find((f) => f.id === "bytes").parse;
  }
  emit(event) {
    const set = this.listeners.get(event.type);
    if (set === undefined)
      return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {}
    }
  }
  evictIfNeeded() {
    if (this.cacheBytesLimit <= 0)
      return;
    let total = 0;
    for (const entry of this.cache.values())
      total += entry.bytes;
    while (total > this.cacheBytesLimit) {
      let victim;
      for (const [key, entry] of this.cache) {
        if (this.jobs.has(key))
          continue;
        if (victim === undefined || entry.lastAccess < victim.entry.lastAccess)
          victim = { key, entry };
      }
      if (victim === undefined)
        break;
      this.cache.delete(victim.key);
      total -= victim.entry.bytes;
      this.emit({ type: "evicted", url: victim.key, bytes: victim.entry.bytes });
    }
  }
}
function resolveUrl2(baseUrl, uri) {
  if (/^https?:\/\//i.test(uri) || uri.startsWith("data:"))
    return uri;
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    const slash = baseUrl.lastIndexOf("/");
    return slash >= 0 ? `${baseUrl.slice(0, slash + 1)}${uri}` : uri;
  }
}
function aggregateRatio(phase, phaseRatio, loaded, total) {
  switch (phase) {
    case "queued":
      return 0;
    case "fetching":
      return PHASE_WEIGHTS2.fetch * (total > 0 ? Math.min(1, loaded / total) : asymptotic(loaded));
    case "parsing":
      return PHASE_WEIGHTS2.fetch + PHASE_WEIGHTS2.parse * phaseRatio;
    case "transforming":
      return PHASE_WEIGHTS2.fetch + PHASE_WEIGHTS2.parse + PHASE_WEIGHTS2.transform * phaseRatio;
    case "done":
      return 1;
    case "error":
    case "cancelled":
      return 0;
  }
}
function asymptotic(loaded) {
  return Math.min(0.95, 1 - Math.exp(-loaded / (8 * 1024 * 1024)));
}
function cancelError(reason) {
  if (reason instanceof Error)
    return reason;
  const message = typeof reason === "string" ? reason : "загрузка отменена";
  return new DOMException(message, "AbortError");
}
function isAbortError3(error) {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError");
}
function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
function fmtBytes(n) {
  if (n >= 1024 * 1024)
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024)
    return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
function fmtMs(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)} с` : `${Math.round(n)} мс`;
}
// packages/loaders/src/core/types.ts
var Priority = {
  critical: 1000,
  high: 100,
  normal: 50,
  low: 20,
  prefetch: 0
};

// packages/loaders/src/core/source.ts
function normalizeSource(source) {
  if (typeof source === "string") {
    if (source.length === 0)
      throw new LoadError("source", "пустой URL");
    return { url: source, totalBytes: null, fetchUrl: source, fetchRequest: null };
  }
  if (source instanceof URL) {
    return { url: source.href, totalBytes: null, fetchUrl: source.href, fetchRequest: null };
  }
  if (source instanceof Request) {
    return { url: source.url, totalBytes: null, fetchUrl: null, fetchRequest: source };
  }
  if (source instanceof Response) {
    const url = source.url || null;
    const total = responseTotalBytes(source);
    if (source.body === null) {
      return { url, stream: emptyIterable(), totalBytes: total, fetchUrl: null, fetchRequest: null };
    }
    return { url, stream: streamToAsyncIterable(source.body), totalBytes: total, fetchUrl: null, fetchRequest: null };
  }
  if (source instanceof ArrayBuffer) {
    return { url: null, bytes: new Uint8Array(source), totalBytes: source.byteLength, fetchUrl: null, fetchRequest: null };
  }
  if (source instanceof Uint8Array) {
    return { url: null, bytes: source, totalBytes: source.byteLength, fetchUrl: null, fetchRequest: null };
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const url = source instanceof File ? source.name : null;
    const stream = streamToAsyncIterable(source.stream());
    return { url, stream, totalBytes: source.size, fetchUrl: null, fetchRequest: null };
  }
  if (typeof ReadableStream !== "undefined" && source instanceof ReadableStream) {
    return { url: null, stream: streamToAsyncIterable(source), totalBytes: null, fetchUrl: null, fetchRequest: null };
  }
  if (typeof source[Symbol.asyncIterator] === "function") {
    return { url: null, stream: source, totalBytes: null, fetchUrl: null, fetchRequest: null };
  }
  throw new LoadError("source", `normalizeSource: неизвестный тип источника ${Object.prototype.toString.call(source)}`);
}
function emptyIterable() {
  async function* gen() {}
  return gen();
}
function responseTotalBytes(response) {
  const header = response.headers?.get("content-length");
  if (header === null || header === undefined)
    return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// packages/loaders/src/core/manager.ts
var PROGRESS_EMIT_INTERVAL_MS = 50;
var DEFAULT_RESERVE_BYTES = 2 * 1024 * 1024;
var MIN_CONCURRENCY = 1;
function createLoadManager(options = {}) {
  const caps = resolvePlatformCaps({
    fetchImpl: options.fetchImpl,
    resolveUrl: options.resolveUrl,
    inflate: options.inflate,
    decodeImage: options.decodeImage
  });
  const now2 = options.now ?? (() => Date.now());
  let concurrency = Math.max(MIN_CONCURRENCY, options.concurrency ?? 6);
  const maxInflightBytes = options.maxInflightBytes ?? Number.POSITIVE_INFINITY;
  const agingPerSecond = options.agingPerSecond ?? 0.1;
  const parsers = new Map(options.parsers ?? createParserRegistry({
    fetchImpl: caps.fetchImpl,
    resolveUrl: caps.resolveUrl,
    inflate: caps.inflate,
    decodeImage: caps.decodeImage
  }));
  if (!parsers.has("bytes"))
    parsers.set("bytes", bytesParser);
  const tasks = new Map;
  const heap = [];
  const groups = new Set;
  let activeCount = 0;
  let inflightBytes = 0;
  let nextId = 1;
  let nextSeq = 1;
  let bytesReceivedTotal = 0;
  let disposed = false;
  const drainWaiters = new Set;
  function effPriority(task) {
    const ageSec = (now2() - task.enqueuedAt) / 1000;
    return task.priority + agingPerSecond * Math.max(0, ageSec);
  }
  function heapCompare(a, b) {
    const d = effPriority(b) - effPriority(a);
    return d !== 0 ? d : a.seq - b.seq;
  }
  function heapPush(task) {
    heap.push(task);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = i - 1 >> 1;
      if (heapCompare(heap[parent], heap[i]) <= 0)
        break;
      swap(heap, parent, i);
      i = parent;
    }
  }
  function heapPop() {
    if (heap.length === 0)
      return;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;; ) {
        const l = i * 2 + 1;
        const r = l + 1;
        let best = i;
        if (l < heap.length && heapCompare(heap[l], heap[best]) < 0)
          best = l;
        if (r < heap.length && heapCompare(heap[r], heap[best]) < 0)
          best = r;
        if (best === i)
          break;
        swap(heap, best, i);
        i = best;
      }
    }
    return top;
  }
  function rebuildHeap() {
    const items = heap.slice();
    heap.length = 0;
    for (const t of items)
      heapPush(t);
  }
  function swap(arr, a, b) {
    const tmp = arr[a];
    arr[a] = arr[b];
    arr[b] = tmp;
  }
  function reserveFor(task) {
    if (task.reservedBytes === 0) {
      task.reservedBytes = task.totalBytes ?? task.expectedBytes ?? DEFAULT_RESERVE_BYTES;
      inflightBytes += task.reservedBytes;
    }
  }
  function releaseSlot(task) {
    if (task.reservedBytes > 0) {
      inflightBytes -= task.reservedBytes;
      task.reservedBytes = 0;
    }
    task.holdsSlot = false;
  }
  function updateReservation(task, knownTotal) {
    if (knownTotal > task.reservedBytes) {
      inflightBytes += knownTotal - task.reservedBytes;
      task.reservedBytes = knownTotal;
    }
  }
  function pump() {
    if (disposed)
      return;
    const deferred = [];
    while (activeCount < concurrency && heap.length > 0) {
      const task = heapPop();
      if (task === undefined)
        break;
      if (task.state !== "queued")
        continue;
      const needsNetwork = task.source.bytes === undefined;
      if (needsNetwork) {
        const est = task.reservedBytes > 0 ? task.reservedBytes : task.totalBytes ?? task.expectedBytes ?? DEFAULT_RESERVE_BYTES;
        if (inflightBytes + est > maxInflightBytes) {
          deferred.push(task);
          continue;
        }
        reserveFor(task);
      }
      startTask(task);
    }
    for (const t of deferred)
      heapPush(t);
    checkDrain();
  }
  function enqueue(task) {
    task.enqueuedAt = now2();
    heapPush(task);
    pump();
  }
  function startTask(task) {
    task.active = true;
    activeCount++;
    runTask(task).finally(() => {
      task.active = false;
      activeCount--;
      releaseSlot(task);
      pump();
    });
  }
  async function runTask(task) {
    try {
      let outcome;
      if (task.source.bytes !== undefined) {
        outcome = task.source.bytes;
      } else {
        outcome = await fetchPhase(task);
      }
      if (task.controller.signal.aborted)
        throw abortError("cancelled");
      if ("streamed" in outcome)
        return;
      const value = await parsePhase(task, outcome);
      finishTask(task, value, undefined);
    } catch (err) {
      finishTask(task, undefined, err);
    }
  }
  function finishTask(task, value, error) {
    if (task.state === "done" || task.state === "cancelled" || task.state === "failed")
      return;
    if (error !== undefined) {
      const isAbort2 = isAbortError2(error);
      task.state = isAbort2 ? "cancelled" : "failed";
      emitProgress(task, true);
      task.settledError = error;
      notifyGroup(task);
      task.rejectRaw(error);
      return;
    }
    task.state = "done";
    task.fraction = 1;
    emitProgress(task, true);
    task.settledValue = value;
    notifyGroup(task);
    task.resolveRaw(value);
  }
  function notifyGroup(task) {
    if (task.group === null)
      return;
    for (const notify of task.group.enoughNotifiers)
      notify();
  }
  async function fetchPhase(task) {
    if (task.source.stream !== undefined) {
      setPhase(task, task.transforms.length > 0 ? "transforming" : "fetching");
      return await consumeStream(task, task.source.stream);
    }
    for (;; ) {
      task.timedOut = false;
      task.controller = freshController(task.externalSignal);
      const timeoutId = task.timeoutMs !== undefined && task.timeoutMs > 0 ? setTimeout(() => {
        task.timedOut = true;
        task.controller.abort(abortError(`fetch timeout ${task.timeoutMs}ms`));
      }, task.timeoutMs) : null;
      try {
        setPhase(task, task.transforms.length > 0 ? "transforming" : "fetching");
        const input = task.source.fetchRequest ?? task.source.fetchUrl;
        const response = await caps.fetchImpl(input, { signal: task.controller.signal });
        if (!response.ok) {
          if (isRetryableStatus(response.status) && canRetry(task)) {
            await delayRetry(task);
            continue;
          }
          throw new LoadError("http", `HTTP ${response.status} ${response.statusText}`, {
            status: response.status,
            url: task.url
          });
        }
        const knownTotal = responseTotalBytes(response) ?? task.expectedBytes;
        if (knownTotal !== null && knownTotal !== task.totalBytes) {
          task.totalBytes = knownTotal;
          updateReservation(task, knownTotal);
          emitProgress(task, true);
        }
        const chunks = response.body !== null ? streamToAsyncIterable(response.body) : emptyChunks();
        return await consumeStream(task, chunks);
      } catch (err) {
        const aborted = isAbortError2(err);
        if (aborted) {
          if (task.timedOut) {
            if (canRetry(task)) {
              await delayRetry(task);
              continue;
            }
            throw new LoadError("timeout", `fetch timeout после ${task.timeoutMs}мс`, {
              url: task.url
            });
          }
          throw err;
        }
        if (canRetry(task) && isRetryableError(err)) {
          await delayRetry(task);
          continue;
        }
        throw err instanceof LoadError ? err : new LoadError("network", String(err?.message ?? err), {
          cause: err,
          url: task.url
        });
      } finally {
        if (timeoutId !== null)
          clearTimeout(timeoutId);
      }
    }
  }
  async function consumeStream(task, chunks) {
    const sinkFactory = task.parser.streaming;
    if (sinkFactory === undefined) {
      const bytes = await readAllBytes(chunks, {
        onChunk: (received) => onChunkReceived(task, received - task.receivedBytes, received)
      });
      releaseSlot(task);
      return bytes;
    }
    let stream = chunks;
    const transform = composeTransforms(...task.transforms);
    if (transform !== null)
      stream = transform(stream);
    const sink = sinkFactory(makeContext(task), task.parserOptions);
    for await (const chunk of stream) {
      onChunkReceived(task, chunk.byteLength, undefined);
      const pushResult = sink.push(chunk);
      if (pushResult !== undefined)
        await pushResult;
      if (task.controller.signal.aborted)
        throw abortError("cancelled");
    }
    releaseSlot(task);
    if (task.controller.signal.aborted)
      throw abortError("cancelled");
    const result = await sink.finish();
    if (task.controller.signal.aborted)
      throw abortError("cancelled");
    finishTask(task, result, undefined);
    return { streamed: true };
  }
  function canRetry(task) {
    return task.attempt < task.retries;
  }
  async function delayRetry(task) {
    task.attempt++;
    const delay = typeof task.retryDelayMs === "function" ? task.retryDelayMs(task.attempt) : task.retryDelayMs;
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (task.controller.signal.aborted)
        throw abortError("cancelled");
    }
  }
  function onChunkReceived(task, deltaBytes, absolute) {
    task.receivedBytes = absolute ?? task.receivedBytes + deltaBytes;
    bytesReceivedTotal += deltaBytes;
    if (task.totalBytes !== null && (task.state === "fetching" || task.state === "transforming")) {
      task.fraction = Math.min(1, task.receivedBytes / task.totalBytes);
    }
    emitProgress(task);
  }
  async function parsePhase(task, bytes) {
    setPhase(task, "parsing");
    const result = task.parser.parse({ bytes, ctx: makeContext(task) }, task.parserOptions);
    const value = result instanceof Promise ? await result : result;
    if (task.controller.signal.aborted)
      throw abortError("cancelled");
    return value;
  }
  function setPhase(task, phase) {
    if (task.state === phase)
      return;
    task.state = phase;
    if (phase === "fetching" || phase === "transforming") {
      task.holdsSlot = true;
      reserveFor(task);
    }
    emitProgress(task, true);
  }
  function freshController(externalSignal) {
    const controller = new AbortController;
    if (externalSignal !== null) {
      if (externalSignal.aborted)
        controller.abort(externalSignal.reason);
      else
        externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), {
          once: true
        });
    }
    return controller;
  }
  function emitProgress(task, force = false) {
    if (task.onProgress === undefined)
      return;
    if (!force && task.state === task.lastEmitPhase) {
      if (now2() - task.lastEmitAt < PROGRESS_EMIT_INTERVAL_MS)
        return;
    }
    task.lastEmitAt = now2();
    task.lastEmitPhase = task.state;
    task.onProgress(progressOf(task));
  }
  function progressOf(task) {
    return {
      phase: task.state,
      receivedBytes: task.receivedBytes,
      totalBytes: task.totalBytes,
      fraction: task.state === "done" ? 1 : task.fraction
    };
  }
  function makeContext(task) {
    return {
      sourceUrl: task.url ?? task.source.url,
      byteLength: task.totalBytes ?? task.source.totalBytes ?? task.source.bytes?.byteLength ?? null,
      signal: task.controller.signal,
      reportProgress(fraction) {
        const f = Math.max(0, Math.min(1, fraction));
        if (task.state === "parsing")
          task.fraction = f;
        else if (task.fraction === null)
          task.fraction = f;
        emitProgress(task);
      },
      resolveExternal(url) {
        const abs = caps.resolveUrl(task.url ?? task.source.url, url);
        const child = createTask({
          source: normalizeSource(abs),
          parser: bytesParser,
          parserOptions: undefined,
          priority: Math.max(0, task.priority - 1),
          externalSignal: task.controller.signal,
          onProgress: undefined,
          transforms: [],
          retries: 0,
          retryDelayMs: 0,
          timeoutMs: options.defaultTimeoutMs,
          expectedBytes: null,
          group: null
        });
        enqueue(child);
        return child.promise;
      },
      resolveUrl: caps.resolveUrl,
      inflate: caps.inflate,
      taskId: task.id
    };
  }
  function createTask(args) {
    const id = nextId++;
    let resolveRaw;
    let rejectRaw;
    const promise = new Promise((res, rej) => {
      resolveRaw = res;
      rejectRaw = rej;
    });
    promise.catch(() => {});
    const task = {
      id,
      seq: nextSeq++,
      group: args.group,
      state: "queued",
      priority: args.priority,
      source: args.source,
      parser: args.parser,
      parserOptions: args.parserOptions,
      transforms: args.transforms,
      onProgress: args.onProgress,
      retries: args.retries,
      retryDelayMs: args.retryDelayMs,
      timeoutMs: args.timeoutMs,
      expectedBytes: args.expectedBytes,
      controller: freshController(args.externalSignal),
      externalSignal: args.externalSignal,
      receivedBytes: 0,
      totalBytes: args.source.totalBytes ?? args.expectedBytes,
      fraction: null,
      promise,
      resolveRaw,
      rejectRaw,
      settledValue: undefined,
      settledError: undefined,
      enqueuedAt: now2(),
      attempt: 0,
      active: false,
      holdsSlot: false,
      reservedBytes: 0,
      timedOut: false,
      url: args.source.url,
      lastEmitAt: 0,
      lastEmitPhase: "queued"
    };
    tasks.set(id, task);
    const external = args.externalSignal;
    if (external !== null) {
      if (external.aborted)
        cancelTask(task, describeAbortReason(external));
      else
        external.addEventListener("abort", () => {
          if (!task.active)
            cancelTask(task, describeAbortReason(external));
          else
            task.controller.abort(describeAbortReason(external));
        }, { once: true });
    }
    return task;
  }
  function describeAbortReason(signal) {
    const reason = signal.reason;
    return typeof reason === "string" ? reason : "aborted";
  }
  function cancelTask(task, reason) {
    if (task.state === "done" || task.state === "cancelled" || task.state === "failed")
      return;
    const err = abortError(reason);
    task.controller.abort(err);
    finishTask(task, undefined, err);
    pump();
  }
  function pickParser(normalized, opts) {
    if (opts?.parser !== undefined)
      return opts.parser;
    if (opts?.kind !== undefined) {
      const p = parsers.get(opts.kind);
      if (p === undefined)
        throw new LoadError("source", `нет парсера для kind="${opts.kind}"`);
      return p;
    }
    const url = normalized.url ?? normalized.fetchUrl;
    if (normalized.bytes !== undefined || url !== null) {
      const sniffed = sniffKind(normalized.bytes ?? new Uint8Array(0), url).kind;
      if (sniffed !== null) {
        const p = parsers.get(sniffed === "glb" ? "gltf" : sniffed);
        if (p !== undefined)
          return p;
      }
    }
    throw new LoadError("source", "не удалось выбрать парсер: укажите kind или parser");
  }
  function createTaskFromOptions(source, opts, group) {
    let normalized;
    let parser;
    try {
      normalized = normalizeSource(source);
      parser = pickParser(normalized, opts);
    } catch (err) {
      normalized = { url: null, totalBytes: 0, fetchUrl: null, fetchRequest: null, bytes: new Uint8Array(0) };
      parser = makeFailingParser(err);
    }
    const task = createTask({
      source: normalized,
      parser,
      parserOptions: opts?.parserOptions,
      priority: opts?.priority ?? Priority.normal,
      externalSignal: opts?.signal ?? null,
      onProgress: opts?.onProgress,
      transforms: opts?.transforms ?? [],
      retries: opts?.retries ?? options.defaultRetries ?? 0,
      retryDelayMs: opts?.retryDelayMs ?? 0,
      timeoutMs: opts?.timeoutMs ?? options.defaultTimeoutMs,
      expectedBytes: opts?.expectedBytes ?? null,
      group
    });
    if (group !== null)
      group.tasks.push(task);
    return task;
  }
  function makeFailingParser(err) {
    return {
      kind: "__error__",
      parse() {
        throw err;
      }
    };
  }
  function checkDrain() {
    if (drainWaiters.size === 0)
      return;
    if (countStates().queued > 0 || activeCount > 0)
      return;
    const waiters = [...drainWaiters];
    drainWaiters.clear();
    for (const w of waiters)
      w();
  }
  function countStates() {
    let queued = 0, active = 0, done = 0, failed = 0, cancelled = 0;
    for (const t of tasks.values()) {
      switch (t.state) {
        case "queued":
          queued++;
          break;
        case "fetching":
        case "transforming":
        case "parsing":
          active++;
          break;
        case "done":
          done++;
          break;
        case "failed":
          failed++;
          break;
        case "cancelled":
          cancelled++;
          break;
      }
    }
    return { queued, active, done, failed, cancelled };
  }
  function makeGroup(name, defaultPriority) {
    const impl = {
      name,
      tasks: [],
      defaultPriority,
      enoughNotifiers: new Set,
      enoughDemoted: false
    };
    groups.add(impl);
    function groupProgress() {
      let done = 0, failed = 0, cancelled = 0, active = 0, queued = 0;
      let receivedBytes = 0;
      let totalBytes = 0;
      let weightSum = 0;
      let valueSum = 0;
      for (const t of impl.tasks) {
        switch (t.state) {
          case "done":
            done++;
            break;
          case "failed":
            failed++;
            break;
          case "cancelled":
            cancelled++;
            break;
          case "fetching":
          case "transforming":
          case "parsing":
            active++;
            break;
          case "queued":
            queued++;
            break;
        }
        receivedBytes += t.receivedBytes;
        if (t.totalBytes === null)
          totalBytes = null;
        else if (totalBytes !== null)
          totalBytes += t.totalBytes;
        const w = t.totalBytes ?? t.receivedBytes ?? 1;
        weightSum += w;
        valueSum += (t.state === "done" ? 1 : t.fraction ?? 0) * w;
      }
      return {
        total: impl.tasks.length,
        done,
        failed,
        cancelled,
        active,
        queued,
        receivedBytes,
        totalBytes,
        fraction: weightSum > 0 ? valueSum / weightSum : 0
      };
    }
    return {
      name,
      add(source, opts) {
        const priority = opts?.priority ?? impl.defaultPriority;
        const task = createTaskFromOptions(source, { ...opts, priority }, impl);
        enqueue(task);
        return makeHandle(task);
      },
      enough(count, enoughOpts) {
        const demoteTo = enoughOpts?.demoteRemainingTo === null ? null : enoughOpts?.demoteRemainingTo ?? Priority.prefetch;
        return new Promise((resolve, reject) => {
          const notify = () => {
            const doneTasks = impl.tasks.filter((t) => t.state === "done");
            if (doneTasks.length >= count) {
              impl.enoughNotifiers.delete(notify);
              if (demoteTo !== null && !impl.enoughDemoted) {
                impl.enoughDemoted = true;
                for (const t of impl.tasks) {
                  if (t.state === "queued" && t.priority > demoteTo)
                    t.priority = demoteTo;
                }
                rebuildHeap();
              }
              resolve(doneTasks.slice(0, count).map((t) => t.settledValue));
              return;
            }
            const settled = impl.tasks.filter((t) => t.state === "done" || t.state === "failed" || t.state === "cancelled");
            if (settled.length === impl.tasks.length) {
              impl.enoughNotifiers.delete(notify);
              reject(new AggregateError(impl.tasks.filter((t) => t.state !== "done").map((t) => t.settledError), `enough(${count}): кворум недостижим (готово ${doneTasks.length} из ${impl.tasks.length})`));
            }
          };
          impl.enoughNotifiers.add(notify);
          notify();
        });
      },
      async waitAll() {
        const values = [];
        const errors = [];
        await Promise.all(impl.tasks.map(async (t) => {
          try {
            values.push(await t.promise);
          } catch (err) {
            errors.push(err);
          }
        }));
        if (errors.length > 0) {
          throw new AggregateError(errors, `group "${name}": упало ${errors.length} из ${impl.tasks.length}`);
        }
        return values;
      },
      async settleAll() {
        return Promise.all(impl.tasks.map(async (t) => {
          try {
            return { value: await t.promise };
          } catch (err) {
            return { error: err, cancelled: isAbortError2(err) };
          }
        }));
      },
      cancelAll() {
        for (const t of impl.tasks)
          cancelTask(t, `group "${name}" cancelled`);
      },
      setPriority(priority) {
        for (const t of impl.tasks) {
          if (t.state === "queued")
            t.priority = priority;
        }
        rebuildHeap();
      },
      get progress() {
        return groupProgress();
      },
      get handles() {
        return impl.tasks.map((t) => makeHandle(t));
      }
    };
  }
  function makeHandle(task) {
    return {
      id: task.id,
      get url() {
        return task.url;
      },
      get state() {
        return task.state;
      },
      get progress() {
        return progressOf(task);
      },
      get ready() {
        return task.promise;
      },
      cancel(reason) {
        cancelTask(task, reason);
      }
    };
  }
  const manager = {
    load(source, opts) {
      if (disposed)
        throw new LoadError("source", "manager disposed");
      const task = createTaskFromOptions(source, opts, null);
      enqueue(task);
      return makeHandle(task);
    },
    loadBytes(url, opts) {
      return manager.load(url, { ...opts, kind: "bytes" });
    },
    group(name, opts) {
      return makeGroup(name ?? `group-${groups.size + 1}`, opts?.defaultPriority ?? Priority.normal);
    },
    registerParser(kind, parser) {
      parsers.set(kind, parser);
    },
    setConcurrency(n) {
      concurrency = Math.max(MIN_CONCURRENCY, Math.floor(n));
      pump();
    },
    drain() {
      if (countStates().queued === 0 && activeCount === 0)
        return Promise.resolve();
      return new Promise((resolve) => {
        drainWaiters.add(resolve);
        checkDrain();
      });
    },
    stats() {
      const c = countStates();
      return {
        ...c,
        inflightBytes,
        bytesReceived: bytesReceivedTotal,
        tasks: tasks.size
      };
    },
    pruneTerminal() {
      for (const [id, t] of tasks) {
        if (t.state === "done" || t.state === "failed" || t.state === "cancelled") {
          tasks.delete(id);
        }
      }
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      for (const t of tasks.values()) {
        if (t.state !== "done" && t.state !== "failed" && t.state !== "cancelled") {
          cancelTask(t, "manager disposed");
        }
      }
      tasks.clear();
      heap.length = 0;
      groups.clear();
      checkDrain();
    },
    get disposed() {
      return disposed;
    }
  };
  return manager;
}
function isRetryableStatus(status) {
  return status >= 500 || status === 429;
}
function isRetryableError(err) {
  if (err instanceof TypeError)
    return true;
  if (err instanceof LoadError)
    return err.code === "network";
  return false;
}
function emptyChunks() {
  async function* gen() {}
  return gen();
}

// packages/loaders/src/index.ts
async function loadImage(url, options = {}) {
  const blob = await fetchBlob(url, { timeoutMs: options.timeoutMs, signal: options.signal });
  return createImageBitmap(blob, options.imageBitmapOptions ?? {});
}
async function loadJSON(url, options = {}) {
  const blob = await fetchBlob(url, options);
  const text = await blob.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SyntaxError(`loadJSON: ${url} — невалидный JSON: ${err.message}`, { cause: err });
  }
}
async function loadArrayBuffer(url, options = {}) {
  const blob = await fetchBlob(url, options);
  return blob.arrayBuffer();
}
async function fetchBlob(url, options) {
  const controller = new AbortController;
  const externalAbort = options.signal?.addEventListener("abort", () => controller.abort()) ?? (() => {});
  const timeoutId = options.timeoutMs !== undefined ? setTimeout(() => controller.abort(new DOMException("loadImage timeout", "TimeoutError")), options.timeoutMs) : null;
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new TypeError(`loadBlob: ${url} — HTTP ${response.status} ${response.statusText}`);
    }
    return await response.blob();
  } finally {
    if (timeoutId !== null)
      clearTimeout(timeoutId);
    if (typeof externalAbort === "function")
      externalAbort();
  }
}
export {
  toAbortError,
  throwIfAborted2 as throwIfAborted,
  sniffKind,
  sniffImageMime,
  signalAbortError,
  resolveUrl,
  registerConfigParser,
  quatFromEulerXYZ,
  parseZml,
  parseObj,
  parseMtlText,
  parseMtl,
  parseIni,
  parseImage,
  parseGltfJson,
  parseGlb,
  parseFBX,
  parseDecimal,
  parseConfig,
  nowMs,
  loadJSON,
  loadImage,
  loadArrayBuffer,
  isWhitespace,
  isGltfJson,
  isBinaryFbx,
  isAbortError,
  invert4,
  inflateDeflate,
  fetchStreaming,
  extensionOf2 as extensionOf,
  defaultFormats,
  defaultCreateBitmap,
  createParserRegistry,
  createLoadManager,
  configParserOf,
  clamp,
  asciiDecode,
  allocJobId,
  align4,
  abortError,
  UnsupportedError,
  ParseError,
  PHASE_WEIGHTS,
  LoadScheduler,
  LoadHandle,
  LoadError,
  FetchScheduler,
  CHAR,
  AssetLoader,
  AssetLibrary,
  Assembler
};
