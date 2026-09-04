var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// packages/core/src/signal/tracking.ts
function pushCollector(sink) {
  collectors.push(sink);
}
function popCollector() {
  collectors.pop();
}
function reportRead(cell) {
  const top = collectors[collectors.length - 1];
  if (top !== undefined)
    top.push(cell);
}
var collectors;
var init_tracking = __esm(() => {
  collectors = [];
});

// packages/core/src/signal/batch.ts
function batch(run) {
  enterBatch();
  try {
    return run();
  } finally {
    exitBatch();
  }
}
function enterBatch() {
  depth++;
}
function exitBatch() {
  depth--;
  if (depth === 0) {
    depth++;
    try {
      flushPending();
    } finally {
      depth--;
    }
  }
}
function flushPending() {
  while (pending.length > 0) {
    const jobs = pending;
    pending = [];
    for (const job of jobs)
      job();
  }
}
function schedule(job) {
  if (depth === 0)
    job();
  else
    pending.push(job);
}
var depth = 0, pending;
var init_batch = __esm(() => {
  pending = [];
});

// packages/core/src/signal/signal.ts
function signal(initial, _options = {}) {
  let current = initial;
  let version = 0;
  const subscribers = new Set;
  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }
  const cell = {
    get value() {
      reportRead(cell);
      return current;
    },
    set value(next) {
      if (next === current)
        return;
      current = next;
      version++;
      if (subscribers.size === 0)
        return;
      const snapshot = current;
      schedule(() => {
        for (const fn of [...subscribers])
          fn(snapshot);
      });
    },
    peek: () => current,
    subscribe,
    get version() {
      return version;
    }
  };
  return cell;
}
var init_signal = __esm(() => {
  init_tracking();
  init_batch();
});

// packages/core/src/signal/derive.ts
function derive(compute) {
  let deps = [];
  let depVersions = [];
  let cached = collect();
  snapshotVersions();
  let revision = 0;
  const subscribers = new Set;
  let unsubscribes = [];
  const onDepChange = () => {
    if (subscribers.size > 0)
      revalidate();
  };
  function collect() {
    deps = [];
    pushCollector(deps);
    const next = compute();
    popCollector();
    return next;
  }
  function snapshotVersions() {
    depVersions = [];
    for (const dep of deps)
      depVersions.push(dep.version);
  }
  function dirty() {
    for (let at = 0;at < deps.length; at++) {
      if (deps[at].version !== depVersions[at])
        return true;
    }
    return false;
  }
  let boundDeps = [];
  function rebind() {
    if (deps.length === boundDeps.length) {
      let same = true;
      for (let at = 0;at < deps.length; at++) {
        if (deps[at] !== boundDeps[at]) {
          same = false;
          break;
        }
      }
      if (same)
        return;
    }
    for (const unsubscribe of unsubscribes)
      unsubscribe();
    unsubscribes = deps.map((dep) => dep.subscribe(onDepChange));
    boundDeps = deps.slice();
  }
  function revalidate() {
    if (!dirty())
      return false;
    const previous = cached;
    cached = collect();
    snapshotVersions();
    revision++;
    rebind();
    if (cached !== previous && subscribers.size > 0) {
      for (const fn of [...subscribers])
        fn(cached);
    }
    return true;
  }
  const derived = {
    get value() {
      revalidate();
      reportRead(derived);
      return cached;
    },
    peek: () => {
      revalidate();
      return cached;
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    get version() {
      revalidate();
      return revision;
    }
  };
  rebind();
  return derived;
}
var init_derive = __esm(() => {
  init_tracking();
});

// packages/core/src/signal/shared.ts
function detachAll(subscriptions) {
  for (const unsubscribe of subscriptions)
    unsubscribe();
  subscriptions.length = 0;
}

// packages/core/src/signal/effect.ts
function effect(run) {
  const cell = new EffectCell(run);
  return () => cell.dispose();
}

class EffectCell {
  run;
  subscriptions = [];
  boundDeps = [];
  disposed = false;
  rerunQueued = false;
  onDepChange = () => {
    this.queueRerun();
  };
  constructor(run) {
    this.run = run;
    this.rerun();
  }
  dispose() {
    this.disposed = true;
    detachAll(this.subscriptions);
    this.subscriptions = [];
    this.boundDeps = [];
  }
  rerun() {
    if (this.disposed)
      return;
    const collected = [];
    this.trackRun(collected);
    this.rebind(collected);
  }
  trackRun(collected) {
    pushCollector(collected);
    try {
      this.run();
    } finally {
      popCollector();
    }
  }
  rebind(next) {
    if (next.length === this.boundDeps.length) {
      let same = true;
      for (let at = 0;at < next.length; at++) {
        if (next[at] !== this.boundDeps[at]) {
          same = false;
          break;
        }
      }
      if (same)
        return;
    }
    detachAll(this.subscriptions);
    this.subscriptions = next.map((dep) => dep.subscribe(this.onDepChange));
    this.boundDeps = next;
  }
  queueRerun() {
    if (this.rerunQueued || this.disposed)
      return;
    this.rerunQueued = true;
    schedule(() => {
      this.rerunQueued = false;
      this.rerun();
    });
  }
}
var init_effect = __esm(() => {
  init_tracking();
  init_batch();
});

// packages/core/src/epoch/epoch.ts
function createEpoch() {
  let index = 0;
  let nesting = 0;
  return {
    get index() {
      return index;
    },
    frame(body) {
      if (nesting === 0)
        index++;
      nesting++;
      try {
        return batch(body);
      } finally {
        nesting--;
      }
    }
  };
}
var init_epoch = __esm(() => {
  init_batch();
});

// packages/core/src/pool/transientPool.ts
function createTransientPool(depth2 = 2) {
  const bins = new Map;
  let created = 0;
  let bytes = 0;
  let frames = 0;
  function beginFrame() {
    frames++;
  }
  function alloc(tag, length) {
    const bin = binFor(`${tag}:${length}`);
    reclaim(bin);
    const buf = bin.free.pop() ?? create(tag, length);
    bin.leased.push({ buf, frame: frames });
    return buf;
  }
  function binFor(key) {
    const found = bins.get(key);
    if (found !== undefined)
      return found;
    const fresh = { free: [], leased: [] };
    bins.set(key, fresh);
    return fresh;
  }
  function reclaim(bin) {
    while (bin.leased.length > 0 && frames - bin.leased[0].frame >= depth2) {
      bin.free.push(bin.leased.shift().buf);
    }
  }
  function create(tag, length) {
    created++;
    bytes += length * BYTES[tag];
    return MAKE[tag](length);
  }
  function stats() {
    let pooled = 0;
    let leased = 0;
    for (const bin of bins.values()) {
      pooled += bin.free.length;
      leased += bin.leased.length;
    }
    return { created, pooled, leased, bytes, frames };
  }
  return {
    beginFrame,
    f32: (length) => alloc("f32", length),
    f64: (length) => alloc("f64", length),
    i32: (length) => alloc("i32", length),
    u32: (length) => alloc("u32", length),
    u8: (length) => alloc("u8", length),
    stats
  };
}
var BYTES, MAKE;
var init_transientPool = __esm(() => {
  BYTES = { f32: 4, f64: 8, i32: 4, u32: 4, u8: 1 };
  MAKE = {
    f32: (length) => new Float32Array(length),
    f64: (length) => new Float64Array(length),
    i32: (length) => new Int32Array(length),
    u32: (length) => new Uint32Array(length),
    u8: (length) => new Uint8Array(length)
  };
});

// packages/core/src/tape/opcodes.ts
var OpCode;
var init_opcodes = __esm(() => {
  OpCode = {
    BeginPass: 1,
    Draw: 2,
    EndPass: 3,
    BindTarget: 4
  };
});

// packages/core/src/tape/writer.ts
function createTapeWriter(initialOps) {
  let capacity = Math.max(16, initialOps);
  let op = new Int32Array(capacity);
  let a = new Int32Array(capacity);
  let b = new Int32Array(capacity);
  let c = new Int32Array(capacity);
  let d = new Int32Array(capacity);
  let count = 0;
  function reset() {
    count = 0;
  }
  function emit(code, pa, pb, pc, pd) {
    if (count === capacity)
      grow();
    op[count] = code;
    a[count] = pa;
    b[count] = pb;
    c[count] = pc;
    d[count] = pd;
    count++;
  }
  function emitPacked(rows, packed) {
    if (packed === 0)
      return;
    while (count + packed > capacity)
      grow();
    const base = count;
    for (let at = 0;at < packed; at++)
      op[base + at] = rows[at * 5];
    for (let at = 0;at < packed; at++)
      a[base + at] = rows[at * 5 + 1];
    for (let at = 0;at < packed; at++)
      b[base + at] = rows[at * 5 + 2];
    for (let at = 0;at < packed; at++)
      c[base + at] = rows[at * 5 + 3];
    for (let at = 0;at < packed; at++)
      d[base + at] = rows[at * 5 + 4];
    count = base + packed;
  }
  function grow() {
    capacity *= 2;
    op = growColumn(op);
    a = growColumn(a);
    b = growColumn(b);
    c = growColumn(c);
    d = growColumn(d);
  }
  function growColumn(column) {
    const next = new Int32Array(capacity);
    next.set(column);
    return next;
  }
  return {
    reset,
    emit,
    emitPacked,
    get count() {
      return count;
    },
    get columns() {
      return { op, a, b, c, d };
    }
  };
}

// packages/core/src/tape/layout.ts
function writerView(writer) {
  const columns = writer.columns;
  return {
    count: writer.count,
    op: columns.op,
    a: columns.a,
    b: columns.b,
    c: columns.c,
    d: columns.d
  };
}

// packages/core/src/tape/serialize.ts
function serializeTape(writer) {
  const count = writer.count;
  const columns = writer.columns;
  const buffer = new ArrayBuffer((1 + count * 5) * 4);
  const words = new Int32Array(buffer);
  words[0] = count;
  words.set(columns.op.subarray(0, count), 1);
  words.set(columns.a.subarray(0, count), 1 + count);
  words.set(columns.b.subarray(0, count), 1 + count * 2);
  words.set(columns.c.subarray(0, count), 1 + count * 3);
  words.set(columns.d.subarray(0, count), 1 + count * 4);
  return buffer;
}
function parseTape(buffer) {
  if (buffer.byteLength < 4 || buffer.byteLength % 4 !== 0) {
    throw new Error("rune: parseTape — corrupted tape buffer");
  }
  const words = new Int32Array(buffer);
  const count = words[0];
  if (count < 0 || (1 + count * 5) * 4 > buffer.byteLength) {
    throw new Error(`rune: parseTape — count ${count} is inconsistent with the buffer size`);
  }
  return {
    count,
    opCount: count,
    op: words.subarray(1, 1 + count),
    a: words.subarray(1 + count, 1 + count * 2),
    b: words.subarray(1 + count * 2, 1 + count * 3),
    c: words.subarray(1 + count * 3, 1 + count * 4),
    d: words.subarray(1 + count * 4, 1 + count * 5)
  };
}

// packages/core/src/tape/segments.ts
function createSegmentStore(capacity) {
  const segments = new Map;
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let epoch = 0;
  function fetch(commandId) {
    const found = segments.get(commandId);
    if (found === undefined) {
      misses++;
      return;
    }
    hits++;
    found.touchedAt = ++epoch;
    return found;
  }
  function store(commandId, rows, count) {
    segments.delete(commandId);
    segments.set(commandId, { rows, count, writtenAt: ++epoch, touchedAt: epoch });
    evict();
  }
  function invalidate(commandId) {
    segments.delete(commandId);
  }
  function evict() {
    if (capacity < 1)
      return;
    while (segments.size > capacity) {
      let victimId;
      let victimEpoch = Infinity;
      for (const [id, segment] of segments) {
        if (segment.touchedAt < victimEpoch) {
          victimEpoch = segment.touchedAt;
          victimId = id;
        }
      }
      if (victimId === undefined)
        break;
      segments.delete(victimId);
      evictions++;
    }
  }
  return {
    fetch,
    store,
    invalidate,
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    get evictions() {
      return evictions;
    }
  };
}

// packages/core/src/live/liveCommand.ts
function createLiveCommand(segments, record, deps = []) {
  const id = nextLiveId++;
  const versions = deps.map(() => -1);
  const scratch = createTapeWriter(64);
  let frameStride = 1;
  let framePhase = 0;
  let frameCounter = 0;
  let active = true;
  let dirty = true;
  function every(n) {
    if (n < 1)
      throw new Error("rune: every(n) requires n >= 1");
    frameStride = n;
    framePhase = frameCounter % n;
    return command;
  }
  function tickFrame() {
    frameCounter++;
    active = frameCounter % frameStride === framePhase;
    pollDeps();
  }
  function pollDeps() {
    for (let at = 0;at < deps.length; at++) {
      const version = deps[at].version;
      if (version !== versions[at]) {
        versions[at] = version;
        dirty = true;
      }
    }
  }
  function emit(writer, force = false) {
    if (!active)
      return false;
    const cached = segments.fetch(id);
    if (!force && !dirty && cached !== undefined) {
      replay(writer, cached.rows, cached.count);
      return true;
    }
    scratch.reset();
    record(scratch);
    const count = scratch.count;
    const columns = scratch.columns;
    const rows = packRows(columns, count);
    segments.store(id, rows, count);
    replay(writer, rows, count);
    dirty = false;
    return true;
  }
  function invalidate() {
    dirty = true;
    segments.invalidate(id);
  }
  const command = {
    id,
    every,
    tickFrame,
    get active() {
      return active;
    },
    get dirty() {
      return dirty;
    },
    emit,
    invalidate
  };
  return command;
}
function replay(writer, rows, count) {
  writer.emitPacked(rows, count);
}
function packRows(columns, count) {
  const rows = new Int32Array(count * 5);
  for (let at = 0;at < count; at++) {
    const base = at * 5;
    rows[base] = columns.op[at];
    rows[base + 1] = columns.a[at];
    rows[base + 2] = columns.b[at];
    rows[base + 3] = columns.c[at];
    rows[base + 4] = columns.d[at];
  }
  return rows;
}
var nextLiveId = 1;
var init_liveCommand = () => {};

// packages/core/src/live/frameBuilder.ts
function buildFrame(lives, writer) {
  for (const live of lives) {
    live.tickFrame();
    live.emit(writer);
  }
}
function buildFrameReRecording(lives, writer) {
  for (const live of lives) {
    live.emit(writer, true);
  }
}

// packages/core/src/uniforms/arena.ts
function createUniformArena(floats = 1 << 16) {
  const buffer = new Float32Array(floats);
  const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const slots = [];
  const bases = [];
  let cursor = 0;
  let lastHit = 0;
  function alloc(sizeOrType) {
    if (typeof sizeOrType === "string") {
      const byteSize = TYPE_BYTES[sizeOrType];
      if (byteSize === undefined)
        throw new Error(`rune: unknown uniform type "${sizeOrType}"`);
      return allocBytes(byteSize);
    }
    return allocFloats(sizeOrType);
  }
  function allocFloats(size) {
    if (cursor + size > floats)
      throw new Error(`rune: uniform arena overflowed (${floats} float)`);
    const slot = { base: cursor, size, dirty: true };
    cursor += size;
    bases.push(slot.base);
    slots.push(slot);
    return slot;
  }
  function allocBytes(byteSize) {
    const size = byteSize / 4;
    if (cursor + size > floats)
      throw new Error(`rune: uniform arena overflowed (${floats} float)`);
    const slot = { base: cursor, size, dirty: true };
    cursor += size;
    bases.push(slot.base);
    slots.push(slot);
    return { offset: slot.base * 4, size: byteSize };
  }
  function write(slot, values) {
    let changed = false;
    if (typeof values === "number") {
      if (Math.fround(values) !== buffer[slot.base]) {
        buffer[slot.base] = values;
        changed = true;
      }
    } else {
      for (let at = 0;at < slot.size; at++) {
        const next = values[at] ?? 0;
        if (Math.fround(next) !== buffer[slot.base + at]) {
          buffer[slot.base + at] = next;
          changed = true;
        }
      }
    }
    if (changed)
      slot.dirty = true;
    return changed;
  }
  function slotAt(floatIndex) {
    const hit = slots[lastHit];
    if (hit !== undefined && floatIndex >= hit.base && floatIndex < hit.base + hit.size)
      return hit;
    if (bases.length === 0)
      return null;
    let low = 0;
    let high = bases.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = low + high >>> 1;
      if (bases[mid] <= floatIndex) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found === -1)
      return null;
    const owner = slots[found];
    if (floatIndex >= owner.base + owner.size)
      return null;
    lastHit = found;
    return owner;
  }
  function byteOffsetOf(slot) {
    return typeof slot === "number" ? slot : slot.offset;
  }
  function writeFloat(slot, value) {
    const offset = byteOffsetOf(slot);
    if (offset % 4 !== 0 || offset < 0 || offset >= buffer.byteLength) {
      throw new Error(`rune: writeFloat — invalid offset ${offset}`);
    }
    const floatIndex = offset >> 2;
    if (Math.fround(value) !== buffer[floatIndex]) {
      buffer[floatIndex] = value;
      const owner = slotAt(floatIndex);
      if (owner !== null)
        owner.dirty = true;
    }
  }
  function readFloat(slot, index = 0) {
    const offset = byteOffsetOf(slot);
    return buffer[(offset >> 2) + index];
  }
  function floatIndexOf(slot) {
    return "base" in slot ? slot.base : slot.offset >> 2;
  }
  function writeVec4(slot, x, y, z, w) {
    const base = floatIndexOf(slot);
    let changed = false;
    if (Math.fround(x) !== buffer[base]) {
      buffer[base] = x;
      changed = true;
    }
    if (Math.fround(y) !== buffer[base + 1]) {
      buffer[base + 1] = y;
      changed = true;
    }
    if (Math.fround(z) !== buffer[base + 2]) {
      buffer[base + 2] = z;
      changed = true;
    }
    if (Math.fround(w) !== buffer[base + 3]) {
      buffer[base + 3] = w;
      changed = true;
    }
    if (changed) {
      const owner = slotAt(base);
      if (owner !== null)
        owner.dirty = true;
    }
  }
  function isDirty(slot) {
    const owner = slotAt(floatIndexOf(slot));
    return owner !== null && owner.dirty;
  }
  function dirtySlots() {
    return slots.filter((slot) => slot.dirty);
  }
  const dirtyRangesOut = [];
  function dirtyRanges() {
    let write2 = 0;
    for (let at = 0;at < slots.length; at++) {
      const slot = slots[at];
      if (!slot.dirty)
        continue;
      const from = slot.base * 4;
      const to = (slot.base + slot.size) * 4;
      const last = write2 > 0 ? dirtyRangesOut[write2 - 1] : undefined;
      if (last !== undefined && from <= last.to) {
        if (to > last.to)
          last.to = to;
      } else {
        if (write2 < dirtyRangesOut.length) {
          const reuse = dirtyRangesOut[write2];
          reuse.from = from;
          reuse.to = to;
        } else {
          dirtyRangesOut.push({ from, to });
        }
        write2++;
      }
    }
    dirtyRangesOut.length = write2;
    return dirtyRangesOut;
  }
  function importBytes(from, source) {
    if (source.byteLength === 0)
      return;
    if (from < 0 || from + source.byteLength > buffer.byteLength) {
      throw new Error("rune: importBytes goes out of the arena bounds");
    }
    bytes.set(source, from);
    const fromFloat = from >> 2;
    const toFloat = from + source.byteLength + 3 >> 2;
    let low = 0;
    let high = slots.length;
    while (low < high) {
      const mid = low + high >>> 1;
      if (bases[mid] + slots[mid].size > fromFloat)
        high = mid;
      else
        low = mid + 1;
    }
    for (let at = low;at < slots.length; at++) {
      const slot = slots[at];
      if (slot.base >= toFloat)
        break;
      slot.dirty = true;
    }
  }
  function clearDirty() {
    for (const slot of slots)
      slot.dirty = false;
  }
  function used() {
    return cursor;
  }
  return {
    buffer,
    get bytes() {
      return bytes;
    },
    alloc,
    write,
    writeFloat,
    readFloat,
    writeVec4,
    isDirty,
    dirtySlots,
    dirtyRanges,
    importBytes,
    clearDirty,
    used,
    get usedBytes() {
      return cursor * 4;
    }
  };
}
var TYPE_BYTES;
var init_arena = __esm(() => {
  TYPE_BYTES = {
    float: 4,
    int: 4,
    uint: 4,
    bool: 4,
    vec2: 8,
    vec3: 12,
    vec4: 16,
    ivec2: 8,
    ivec3: 12,
    ivec4: 16,
    uvec2: 8,
    uvec3: 12,
    uvec4: 16,
    bvec2: 8,
    bvec3: 12,
    bvec4: 16,
    mat2: 16,
    mat3: 48,
    mat4: 64
  };
});

// packages/core/src/uniforms/uniformSet.ts
function createUniformSet(name, schema, options = {}) {
  const offsets = {};
  let attached = false;
  let linked = {};
  const cache = {};
  options.frequency;
  function attach(alloc) {
    if (attached)
      return;
    attached = true;
    for (const [field, type] of Object.entries(schema)) {
      offsets[field] = alloc(type).offset;
    }
  }
  function write(writeFloat) {
    for (const [field] of Object.entries(schema)) {
      const offset = offsets[field];
      if (offset === undefined)
        continue;
      const signal2 = linked[field];
      const value = signal2 !== undefined ? signal2.peek() : cache[field];
      if (value === undefined)
        continue;
      writeField(offset, value, writeFloat);
    }
  }
  function link(values) {
    linked = { ...linked, ...values };
  }
  return {
    name,
    attach,
    write,
    link,
    offsets
  };
}
function writeField(offset, value, writeFloat) {
  if (typeof value === "number") {
    writeFloat(offset, value);
    return;
  }
  const array = value;
  for (let i = 0;i < array.length; i++)
    writeFloat(offset + i * 4, array[i]);
}

// packages/core/src/uniforms/frequencyArena.ts
function createFrequencyArena(frameBytes = 4096, drawBytes = 1 << 16) {
  const frame = createUniformArena(frameBytes);
  const draw = createUniformArena(drawBytes);
  return {
    frame,
    draw,
    alloc(type, frequency) {
      return frequency === "frame" ? frame.alloc(type) : draw.alloc(type);
    },
    frameRanges: () => frame.dirtyRanges(),
    drawRanges: () => draw.dirtyRanges(),
    clearDirty: () => {
      frame.clearDirty();
      draw.clearDirty();
    }
  };
}
var init_frequencyArena = __esm(() => {
  init_arena();
});

// packages/core/src/streaming/uploadScheduler.ts
function createUploadScheduler(options = {}) {
  const min = options.minBytes ?? 64 * 1024;
  const max = options.maxBytes ?? 16 * 1024 * 1024;
  const maxBurst = options.maxBurstBytes ?? 4 * 1024 * 1024;
  let window2 = Math.min(max, Math.max(min, options.initialBytes ?? 2 * 1024 * 1024));
  const heap = [];
  function burst(bytes) {
    window2 = Math.min(max, Math.max(window2, Math.min(bytes, maxBurst)));
  }
  function push(job) {
    heap.push(job);
    siftUp(heap.length - 1);
  }
  function drain() {
    let budget = window2;
    let executed = 0;
    let closingJob = false;
    while (heap.length > 0) {
      const job = heap[0];
      if (job.bytes <= budget) {
        pop();
        job.run();
        budget -= job.bytes;
        executed++;
      } else {
        pop();
        job.run();
        executed++;
        closingJob = true;
        break;
      }
    }
    adaptWindow(executed, closingJob);
  }
  function adaptWindow(executed, closingJob) {
    if (closingJob || executed > 0 && heap.length === 0) {
      window2 = Math.min(max, window2 + Math.max(1, Math.floor(window2 / 8)));
    } else if (executed === 0 && heap.length === 0) {
      window2 = Math.max(min, Math.floor(window2 * 7 / 8));
    }
  }
  function pop() {
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      siftDown(0);
    }
  }
  function siftUp(at) {
    while (at > 0) {
      const parent = at - 1 >> 1;
      if (heap[parent].priority >= heap[at].priority)
        break;
      swap(parent, at);
      at = parent;
    }
  }
  function siftDown(at) {
    for (;; ) {
      const left = at * 2 + 1;
      const right = left + 1;
      let best = at;
      if (left < heap.length && heap[left].priority > heap[best].priority)
        best = left;
      if (right < heap.length && heap[right].priority > heap[best].priority)
        best = right;
      if (best === at)
        return;
      swap(best, at);
      at = best;
    }
  }
  function swap(a, b) {
    const tmp = heap[a];
    heap[a] = heap[b];
    heap[b] = tmp;
  }
  return {
    push,
    burst,
    drain,
    get pending() {
      return heap.length;
    },
    get window() {
      return window2;
    }
  };
}

// packages/core/src/streaming/chunker.ts
function chunkRect(width, height, tileH) {
  if (tileH < 1)
    throw new Error("rune: chunkRect requires tileH >= 1");
  const tiles = [];
  for (let y = 0;y < height; y += tileH) {
    const rows = Math.min(tileH, height - y);
    tiles.push({ x: 0, y, width, height: rows });
  }
  return tiles;
}
function countTiles(width, height, tileH) {
  if (tileH < 1)
    throw new Error("rune: countTiles requires tileH >= 1");
  if (height <= 0)
    return 0;
  return Math.ceil(height / tileH);
}
function tileForBudget(width, budgetBytes) {
  const rowBytes = width * 4;
  if (rowBytes <= 0)
    return 1;
  return Math.max(1, Math.min(256, Math.floor(budgetBytes / rowBytes)));
}
function tileBytes(tile, source, sourceWidth) {
  if (tile.width === sourceWidth) {
    return source.subarray(tile.y * sourceWidth * 4, (tile.y + tile.height) * sourceWidth * 4);
  }
  const out = new Uint8Array(tile.width * tile.height * 4);
  for (let row = 0;row < tile.height; row++) {
    const from = ((tile.y + row) * sourceWidth + tile.x) * 4;
    out.set(source.subarray(from, from + tile.width * 4), row * tile.width * 4);
  }
  return out;
}

// packages/core/src/streaming/textureUpload.ts
function previewWidth(width, budget) {
  const scale = Math.min(1, Math.sqrt(budget / (width * width * 4)));
  const scaled = Math.max(64, Math.floor(width * scale / 64) * 64);
  return Math.min(width, scaled);
}
function downsample(source, w, h, pw, ph) {
  const out = new Uint8Array(pw * ph * 4);
  for (let y = 0;y < ph; y++) {
    const sy = (y + 0.5) * h / ph - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0;x < pw; x++) {
      const sx = (x + 0.5) * w / pw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const fx = sx - x0;
      const at = (y * pw + x) * 4;
      for (let ch = 0;ch < 4; ch++) {
        const p00 = source[(y0 * w + x0) * 4 + ch];
        const p10 = source[(y0 * w + x1) * 4 + ch];
        const p01 = source[(y1 * w + x0) * 4 + ch];
        const p11 = source[(y1 * w + x1) * 4 + ch];
        out[at + ch] = bilinear(p00, p10, p01, p11, fx, fy);
      }
    }
  }
  return out;
}
function bilinear(p00, p10, p01, p11, fx, fy) {
  const top = p00 + (p10 - p00) * fx;
  const bottom = p01 + (p11 - p01) * fx;
  return Math.round(top + (bottom - top) * fy);
}
function streamTexture(scheduler, source, width, height, upload, options = {}) {
  const priority = options.priority ?? 1;
  const previewBudget = options.previewBudget ?? 64 * 1024;
  let cancelled = false;
  let tilesDone = 0;
  const tiles = chunkRect(width, height, tileForBudget(width, previewBudget));
  scheduler.burst(source.length);
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  function maybeFinish() {
    if (tilesDone >= tiles.length)
      resolveDone();
  }
  const pw = previewWidth(width, previewBudget);
  const ph = Math.max(1, Math.round(height * pw / width));
  const preview = downsample(source, width, height, pw, ph);
  scheduler.push({
    bytes: preview.length,
    priority: priority + 1,
    run: () => {
      if (cancelled)
        return;
      upload({ x: 0, y: 0, width: pw, height: ph }, preview);
    }
  });
  for (const tile of tiles) {
    const bytes = tileBytes(tile, source, width);
    scheduler.push({
      bytes: bytes.length,
      priority,
      run: () => {
        if (cancelled)
          return;
        upload(tile, bytes);
        tilesDone++;
        options.onProgress?.(tilesDone / tiles.length);
        maybeFinish();
      }
    });
  }
  return {
    get progress() {
      return tiles.length === 0 ? 1 : tilesDone / tiles.length;
    },
    cancel() {
      cancelled = true;
      resolveDone();
    },
    done
  };
}
var init_textureUpload = () => {};

// packages/core/src/transport/layoutGuard.ts
function createLayoutGuard() {
  const recent = [];
  function classify(width, height) {
    const key = `${Math.round(width)}x${Math.round(height)}`;
    if (recent.length > 0 && recent[recent.length - 1] === key) {
      return { verdict: "ignore", cssWidth: width, cssHeight: height };
    }
    recent.push(key);
    if (recent.length > HISTORY)
      recent.shift();
    if (oscillates()) {
      return { verdict: "runaway", cssWidth: width, cssHeight: height };
    }
    return { verdict: "apply", cssWidth: width, cssHeight: height };
  }
  function oscillates() {
    if (recent.length < 4)
      return false;
    const last4 = recent.slice(-4);
    return last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1];
  }
  return { classify };
}
var HISTORY = 6;

// packages/core/src/transport/seqlock.ts
function atomicsView(data) {
  let view = atomicsViews.get(data);
  if (view === undefined) {
    if (data.byteOffset % 4 !== 0 || data.byteLength % 4 !== 0) {
      throw new Error("rune: seqlock requires 4-byte buffer alignment");
    }
    view = new Int32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
    atomicsViews.set(data, view);
  }
  return view;
}
function versionIndex(versionAt) {
  if ((versionAt & 3) !== 0)
    throw new Error("rune: seqlock version must lie on a 4-byte boundary");
  return versionAt >> 2;
}
function readSeqlock(data, versionAt, valueAt) {
  const i32 = atomicsView(data);
  const at = versionIndex(versionAt);
  for (let attempt = 0;attempt < MAX_READ_ATTEMPTS; attempt++) {
    const before = Atomics.load(i32, at);
    if ((before & 1) === 0) {
      const value = data.getFloat64(valueAt, true);
      const after = Atomics.load(i32, at);
      if (before === after)
        return { version: before, value };
    }
  }
  throw new Error("rune: seqlock did not close within the attempt limit — the writer holds the slot (livelock)");
}
function readSeqlockValue(data, versionAt, valueAt) {
  const i32 = atomicsView(data);
  const at = versionIndex(versionAt);
  for (let attempt = 0;attempt < MAX_READ_ATTEMPTS; attempt++) {
    const before = Atomics.load(i32, at);
    if ((before & 1) === 0) {
      const value = data.getFloat64(valueAt, true);
      const after = Atomics.load(i32, at);
      if (before === after)
        return value;
    }
  }
  throw new Error("rune: seqlock did not close within the attempt limit — the writer holds the slot (livelock)");
}
function writeSeqlock(data, versionAt, valueAt, value) {
  const i32 = atomicsView(data);
  const at = versionIndex(versionAt);
  const version = Atomics.load(i32, at);
  Atomics.store(i32, at, version + 1);
  data.setFloat64(valueAt, value, true);
  Atomics.store(i32, at, version + 2);
}
function seqlockVersion(data, versionAt) {
  return Atomics.load(atomicsView(data), versionIndex(versionAt));
}
var MAX_READ_ATTEMPTS, atomicsViews;
var init_seqlock = __esm(() => {
  MAX_READ_ATTEMPTS = 1 << 16;
  atomicsViews = new WeakMap;
});

// packages/core/src/transport/sharedRegistry.ts
function nameHash(name) {
  let hash = 2166136261;
  for (let i = 0;i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function schemaHash(names) {
  return nameHash(names.join("\x00"));
}
function createSharedRegistry(names) {
  const view = new DataView(new SharedArrayBuffer(headerBytes() + names.length * SLOT_BYTES));
  putHeader(view, names);
  putSlots(view, names);
  const slots = indexSlots(view, names);
  return {
    buffer: view.buffer,
    bind: (signal2, name) => bindSignal(view, slots, signal2, name),
    write: (name, value) => writeSlot(view, slots, name, value)
  };
}
function writeSlot(view, slots, name, value) {
  const offset = requireSlot(slots, name);
  writeSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET, value);
}
function attachSharedRegistry(buffer, names) {
  const view = new DataView(buffer);
  checkSchema(view, names);
  const slots = indexSlots(view, names);
  const watchers = new Map;
  const plan = [];
  const seen = [];
  for (const name of names) {
    const offset = requireSlot(slots, name);
    const versionAt = offset + VERSION_OFFSET;
    plan.push({ offset, versionAt });
    seen.push(seqlockVersion(view, versionAt));
  }
  return {
    transport: "sab",
    signal: (name) => mirrorSignal(view, slots, watchers, name),
    sampleAll: () => {
      let changed = 0;
      for (let at = 0;at < plan.length; at++) {
        const slot = plan[at];
        const version = seqlockVersion(view, slot.versionAt);
        if (version === seen[at])
          continue;
        seen[at] = version;
        changed++;
        fireWatchers(view, slot.offset, watchers.get(slot.offset));
      }
      return changed;
    }
  };
}
function headerBytes() {
  return HEADER_BYTES;
}
function putHeader(view, names) {
  view.setUint32(0, SHARED_MAGIC, true);
  view.setUint32(4, schemaHash(names), true);
  view.setUint32(8, names.length, true);
}
function checkSchema(view, names) {
  if (view.getUint32(0, true) !== SHARED_MAGIC)
    throw new Error("rune: corrupted signal registry");
  if (view.getUint32(4, true) !== schemaHash(names)) {
    throw new Error("rune: shared signal schema version mismatch — update both worlds");
  }
}
function putSlots(view, names) {
  names.forEach((name, i) => {
    view.setUint32(HEADER_BYTES + i * SLOT_BYTES, nameHash(name), true);
  });
}
function indexSlots(view, names) {
  const slots = new Map;
  const count = view.getUint32(8, true);
  for (let i = 0;i < count; i++) {
    slots.set(view.getUint32(HEADER_BYTES + i * SLOT_BYTES, true), HEADER_BYTES + i * SLOT_BYTES);
  }
  for (const name of names) {
    if (!slots.has(nameHash(name)))
      throw new Error(`rune: signal "${name}" is not registered`);
  }
  return slots;
}
function bindSignal(view, slots, signal2, name) {
  const offset = requireSlot(slots, name);
  writeSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET, signal2.peek());
  return signal2.subscribe((value) => writeSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET, value));
}
function mirrorSignal(view, slots, watchers, name) {
  const offset = requireSlot(slots, name);
  const listeners = [];
  watchers.set(offset, listeners);
  return {
    peek: () => readSeqlockValue(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET),
    subscribe: (subscriber) => subscribeListener(listeners, subscriber),
    get value() {
      return readSeqlockValue(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET);
    },
    get version() {
      return seqlockVersion(view, offset + VERSION_OFFSET);
    }
  };
}
function subscribeListener(listeners, subscriber) {
  listeners.push(subscriber);
  return () => removeListener(listeners, subscriber);
}
function removeListener(listeners, subscriber) {
  const at = listeners.indexOf(subscriber);
  if (at >= 0)
    listeners.splice(at, 1);
}
function requireSlot(slots, name) {
  const offset = slots.get(nameHash(name));
  if (offset === undefined)
    throw new Error(`rune: signal "${name}" is not registered`);
  return offset;
}
function fireWatchers(view, offset, listeners) {
  if (listeners === undefined || listeners.length === 0)
    return;
  const { value } = readSeqlock(view, offset + VERSION_OFFSET, offset + VALUE_OFFSET);
  for (const subscriber of [...listeners])
    subscriber(value);
}
var VERSION_OFFSET = 4, VALUE_OFFSET = 8, SLOT_BYTES = 16, SHARED_MAGIC = 1381322323, HEADER_BYTES = 32;
var init_sharedRegistry = __esm(() => {
  init_seqlock();
});

// packages/core/src/feed/feed.ts
function feedStride(layout) {
  let stride = 0;
  for (const format of Object.values(layout)) {
    stride += formatBytes(format);
  }
  return stride;
}
function formatBytes(format) {
  if (format === "float32x2")
    return 8;
  if (format === "float32x3")
    return 12;
  if (format === "float32x4")
    return 16;
  return 4;
}
function feedFieldSize(format) {
  if (format === "float32x2")
    return 2;
  if (format === "float32x3")
    return 3;
  if (format === "float32x4")
    return 4;
  return 1;
}
function createFeed(options) {
  const stride = feedStride(options.layout);
  const backing = options.backing ?? "sab";
  const buffer = backing === "sab" ? new SharedArrayBuffer(HEADER_BYTES2 + options.capacity * stride) : new ArrayBuffer(HEADER_BYTES2 + options.capacity * stride);
  return makeFeed(buffer, options.layout, options.capacity, options.policy ?? "drop-oldest");
}
function attachFeed(buffer, layout, capacity) {
  return makeFeed(buffer, layout, capacity, "drop-oldest");
}
function makeFeed(buffer, layout, capacity, policy) {
  const stride = feedStride(layout);
  const u32 = new Uint32Array(buffer);
  const f32 = new Float32Array(buffer, HEADER_BYTES2);
  const u8 = new Uint8Array(buffer, HEADER_BYTES2);
  const offsets = fieldOffsets(layout);
  u32[0] = 0;
  u32[1] = 0;
  u32[2] = 0;
  let wFrom = 0;
  const writer = {
    setFloat: (name, index, value) => {
      const offset = requireOffset(offsets, name);
      f32[(wFrom + index) * stride + offset >> 2] = value;
    },
    setVec2: (name, index, x, y) => {
      const offset = requireOffset(offsets, name);
      const at = (wFrom + index) * stride + offset >> 2;
      f32[at] = x;
      f32[at + 1] = y;
    },
    setVec3: (name, index, x, y, z) => {
      const offset = requireOffset(offsets, name);
      const at = (wFrom + index) * stride + offset >> 2;
      f32[at] = x;
      f32[at + 1] = y;
      f32[at + 2] = z;
    },
    setVec4: (name, index, x, y, z, w) => {
      const offset = requireOffset(offsets, name);
      const at = (wFrom + index) * stride + offset >> 2;
      f32[at] = x;
      f32[at + 1] = y;
      f32[at + 2] = z;
      f32[at + 3] = w;
    },
    setVec4Bytes: (name, index, r, g, b, a) => {
      const offset = requireOffset(offsets, name);
      const at = (wFrom + index) * stride + offset;
      u8[at] = r;
      u8[at + 1] = g;
      u8[at + 2] = b;
      u8[at + 3] = a;
    }
  };
  return {
    buffer,
    capacity,
    stride,
    view: (from, count) => {
      wFrom = from;
      return writer;
    },
    push: (count) => {
      wFrom = reserve(u32, capacity, count, policy);
      return writer;
    },
    publish: () => publishCount(u32),
    publishedCount: () => Atomics.load(u32, 1)
  };
}
function reserve(u32, capacity, count, _policy) {
  const from = Atomics.load(u32, 0);
  if (from + count > capacity) {
    Atomics.add(u32, 2, count);
    return capacity;
  }
  Atomics.add(u32, 0, count);
  return from;
}
function publishCount(u32) {
  Atomics.store(u32, 1, Atomics.load(u32, 0));
}
function fieldOffsets(layout) {
  const offsets = new Map;
  let offset = 0;
  for (const [name, format] of Object.entries(layout)) {
    offsets.set(name, offset);
    offset += formatBytes(format);
  }
  return offsets;
}
function requireOffset(offsets, name) {
  const offset = offsets.get(name);
  if (offset === undefined)
    throw new Error(`rune: feed field "${name}" is not declared`);
  return offset;
}
var HEADER_BYTES2 = 64;

// packages/core/src/transport/transport.ts
function detectTransport(probe) {
  const hasSab = probe?.sharedArrayBuffer ?? typeof SharedArrayBuffer !== "undefined";
  if (!hasSab)
    return "msg";
  const hasWaitAsync = probe?.waitAsync ?? (typeof Atomics !== "undefined" && typeof Atomics.waitAsync === "function");
  return hasWaitAsync ? "sab+async" : "sab";
}
function hasSharedArrayBuffer() {
  return typeof SharedArrayBuffer !== "undefined";
}
function createTransport(options) {
  const mode = options?.mode ?? "memory";
  const names = options?.names ?? [];
  if (mode === "memory") {
    const cells = new Map;
    for (const name of names)
      cells.set(name, signal(0));
    const host2 = memoryHost(names, cells);
    const client2 = signalClient("memory", cells);
    return { mode, host: host2, client: client2 };
  }
  if (mode === "msg") {
    const state = createMsgState(names);
    const host2 = msgHost(state);
    const client2 = msgClient(state);
    return { mode, host: host2, client: client2 };
  }
  const registry = createSharedRegistry(names);
  const feedMeta = new Map;
  const sabFeeds = new Map;
  let nextFeedId = 1;
  const host = {
    mode,
    share: (source, name) => registry.bind(source, name),
    write: (name, value) => registry.write(name, value),
    createFeed: (feedOptions) => {
      const feed = createFeed({ ...feedOptions, backing: "sab" });
      const id = nextFeedId;
      nextFeedId++;
      sabFeeds.set(id, feed);
      feedMeta.set(id, { id, layout: feedOptions.layout, capacity: feedOptions.capacity, buffer: feed.buffer });
      return feed;
    },
    flush: () => null,
    reclaim: () => {},
    describe: () => ({
      mode,
      names,
      signals: registry.buffer,
      feeds: [...feedMeta.values()]
    })
  };
  const client = sabClient(mode, names, registry.buffer, feedMeta);
  return { mode, host, client };
}
function createTransportHost(options) {
  const names = options.names ?? [];
  if (options.mode === "memory") {
    const cells = new Map;
    for (const name of names)
      cells.set(name, signal(0));
    return memoryHost(names, cells);
  }
  if (options.mode === "msg")
    return msgHost(createMsgState(names));
  const registry = createSharedRegistry(names);
  const feedMeta = new Map;
  let nextFeedId = 1;
  return {
    mode: options.mode,
    share: (source, name) => registry.bind(source, name),
    write: (name, value) => registry.write(name, value),
    createFeed: (feedOptions) => {
      const feed = createFeed({ ...feedOptions, backing: "sab" });
      const id = nextFeedId;
      nextFeedId++;
      feedMeta.set(id, { id, layout: feedOptions.layout, capacity: feedOptions.capacity, buffer: feed.buffer });
      return feed;
    },
    flush: () => null,
    reclaim: () => {},
    describe: () => ({ mode: options.mode, names, signals: registry.buffer, feeds: [...feedMeta.values()] })
  };
}
function attachTransport(descriptor) {
  if (descriptor.mode === "msg")
    return msgClient(createMsgState(descriptor.names, descriptor.feeds));
  if (descriptor.mode === "memory") {
    const cells = new Map;
    for (const name of descriptor.names)
      cells.set(name, signal(0));
    return signalClient("memory", cells);
  }
  const meta = new Map;
  for (const feed of descriptor.feeds ?? [])
    meta.set(feed.id, feed);
  return sabClient(descriptor.mode, descriptor.names, descriptor.signals, meta);
}
function memoryHost(names, cells) {
  const feeds = new Map;
  let nextFeedId = 1;
  return {
    mode: "memory",
    share: (source, name) => {
      const cell = requireCell(cells, name);
      cell.value = source.peek();
      return source.subscribe((value) => {
        cell.value = value;
      });
    },
    write: (name, value) => {
      requireCell(cells, name).value = value;
    },
    createFeed: (feedOptions) => {
      const feed = createFeed({ ...feedOptions, backing: "local" });
      feeds.set(nextFeedId, feed);
      nextFeedId++;
      return feed;
    },
    flush: () => null,
    reclaim: () => {},
    describe: () => ({ mode: "memory", names, feeds: [] })
  };
}
function sabClient(mode, names, signals, feedMeta) {
  const mirror = attachSharedRegistry(signals, names);
  const views = new Map;
  for (const meta of feedMeta.values()) {
    if (meta.buffer !== undefined)
      views.set(meta.id, sabFeedView(meta.id, meta.buffer, meta.layout, meta.capacity));
  }
  return {
    mode,
    shared: (name) => mirror.signal(name),
    sampleAll: () => mirror.sampleAll(),
    apply: () => {},
    takeRecycled: () => [],
    feed: (id) => views.get(id) ?? sabViewFromMeta(feedMeta, id, views),
    attachFeed: (id, layout, capacity) => {
      const known = views.get(id);
      if (known !== undefined)
        return known;
      const meta = feedMeta.get(id);
      if (meta === undefined || meta.buffer === undefined) {
        throw new Error(`rune: SAB feed ${id} is not described in the descriptor — pass buffer`);
      }
      const view = sabFeedView(id, meta.buffer, layout, capacity);
      views.set(id, view);
      return view;
    },
    waitForChange: (name, timeoutMs) => waitSlotChange(mirror, signals, names, name, timeoutMs)
  };
}
function sabViewFromMeta(feedMeta, id, views) {
  const meta = feedMeta.get(id);
  if (meta === undefined || meta.buffer === undefined)
    return null;
  const view = sabFeedView(id, meta.buffer, meta.layout, meta.capacity);
  views.set(id, view);
  return view;
}
function sabFeedView(feedId, buffer, layout, capacity) {
  const stride = feedStride(layout);
  const bytes = new Float32Array(buffer, 64, capacity * stride / 4);
  const u32 = new Uint32Array(buffer);
  return {
    feedId,
    stride,
    capacity,
    layout,
    count: () => Atomics.load(u32, 1),
    bytes: () => bytes,
    recycle: () => {}
  };
}
async function waitSlotChange(mirror, sab, names, name, timeoutMs = 1000) {
  if (typeof Atomics === "undefined" || typeof Atomics.waitAsync !== "function") {
    return false;
  }
  requireName(names, name);
  const probe = mirror.signal(name);
  const before = probe.version;
  const i32 = new Int32Array(sab);
  const index = versionWordIndex(names, name);
  const expected = i32[index];
  const res = Atomics.waitAsync(i32, index, expected, timeoutMs);
  if (res.async)
    await res.value;
  return probe.version !== before;
}
function versionWordIndex(names, name) {
  const at = names.indexOf(name);
  if (at < 0)
    throw new Error(`rune: signal "${name}" is not registered`);
  return 32 + at * 16 + 4 >> 2;
}
function createMsgState(names, feedMetas) {
  const slots = new Map;
  for (const name of names)
    slots.set(name, { value: 0, hash: nameHash(name), dirty: false });
  const state = { names, slots, feeds: new Map, mirrors: new Map, recycled: [], nextFeedId: 1 };
  for (const meta of feedMetas ?? []) {
    state.mirrors.set(meta.id, {
      mirror: new Float32Array(meta.capacity * feedStride(meta.layout) / 4),
      stride: feedStride(meta.layout),
      capacity: meta.capacity,
      layout: meta.layout,
      count: 0,
      pending: []
    });
  }
  return state;
}
function msgHost(state) {
  return {
    mode: "msg",
    share: (source, name) => {
      const slot = requireMsgSlot(state, name);
      slot.value = source.peek();
      slot.dirty = true;
      return source.subscribe((value) => {
        slot.value = value;
        slot.dirty = true;
      });
    },
    write: (name, value) => {
      const slot = requireMsgSlot(state, name);
      slot.value = value;
      slot.dirty = true;
    },
    createFeed: (feedOptions) => msgFeedFacade(state, feedOptions),
    flush: () => flushMsg(state),
    reclaim: (chunk) => {
      state.recycled.push(chunk);
    },
    describe: () => ({
      mode: "msg",
      names: state.names,
      feeds: [...state.feeds.entries()].map(([id, core]) => ({ id, layout: core.layout, capacity: core.capacity }))
    })
  };
}
function msgClient(state) {
  const cells = new Map;
  const versions = new Map;
  const hashIndex = new Map;
  for (const name of state.names) {
    const cell = signal(0);
    cells.set(name, cell);
    versions.set(name, 0);
    const hash = nameHash(name);
    const bucket = hashIndex.get(hash);
    if (bucket === undefined)
      hashIndex.set(hash, [cell]);
    else
      bucket.push(cell);
  }
  const views = new Map;
  for (const [id, entry] of state.mirrors)
    views.set(id, mirrorFeedView(state, id, entry));
  return {
    mode: "msg",
    shared: (name) => {
      const cell = cells.get(name);
      if (cell === undefined)
        throw new Error(`rune: signal "${name}" is not registered`);
      return cell;
    },
    sampleAll: () => {
      let changed = 0;
      for (const [name, cell] of cells) {
        const seen = versions.get(name);
        if (cell.version === seen)
          continue;
        versions.set(name, cell.version);
        changed++;
      }
      return changed;
    },
    apply: (message) => {
      if (message?.kind !== "rune.transport.frame")
        return;
      for (const [hash, value] of message.deltas) {
        const targets = hashIndex.get(hash);
        if (targets === undefined)
          continue;
        for (const cell of targets)
          cell.value = value;
      }
      for (const chunk of message.chunks) {
        const entry = state.mirrors.get(chunk.feedId);
        if (entry === undefined)
          continue;
        applyChunkBytes(entry, chunk);
        entry.count = Math.max(entry.count, chunk.from + chunk.count);
        entry.pending.push(chunk);
      }
    },
    feed: (id) => views.get(id) ?? mirrorFromCore(state, id, views),
    takeRecycled: () => {
      const out = [...state.recycled];
      state.recycled.length = 0;
      return out;
    },
    attachFeed: (id, layout, capacity) => {
      const known = views.get(id);
      if (known !== undefined)
        return known;
      const stride = feedStride(layout);
      const entry = {
        mirror: new Float32Array(capacity * stride / 4),
        stride,
        capacity,
        layout,
        count: 0,
        pending: []
      };
      state.mirrors.set(id, entry);
      const view = mirrorFeedView(state, id, entry);
      views.set(id, view);
      return view;
    },
    waitForChange: () => Promise.resolve(false)
  };
}
function mirrorFromCore(state, id, views) {
  const core = state.feeds.get(id);
  if (core === undefined)
    return null;
  const entry = {
    mirror: new Float32Array(core.capacity * core.stride / 4),
    stride: core.stride,
    capacity: core.capacity,
    layout: core.layout,
    count: 0,
    pending: []
  };
  state.mirrors.set(id, entry);
  const view = mirrorFeedView(state, id, entry);
  views.set(id, view);
  return view;
}
function flushMsg(state) {
  for (const chunk of state.recycled) {
    const core = state.feeds.get(chunk.feedId);
    core?.pool.push(chunk.bytes);
  }
  state.recycled.length = 0;
  const deltas = [];
  for (const slot of state.slots.values()) {
    if (!slot.dirty)
      continue;
    deltas.push([slot.hash, slot.value]);
    slot.dirty = false;
  }
  const chunks = [];
  for (const [id, core] of state.feeds) {
    if (core.written === 0)
      continue;
    chunks.push({ feedId: id, from: core.base, count: core.written, bytes: core.current });
    core.current = core.pool.pop() ?? new ArrayBuffer(core.capacity * core.stride);
    core.f32 = new Float32Array(core.current);
    core.u8 = new Uint8Array(core.current);
    core.base += core.written;
    core.shipped += core.written;
    core.written = 0;
  }
  if (deltas.length === 0 && chunks.length === 0)
    return null;
  return { kind: "rune.transport.frame", deltas, chunks };
}
function msgFeedFacade(state, feedOptions, forcedId) {
  const id = forcedId ?? state.nextFeedId;
  if (forcedId === undefined)
    state.nextFeedId++;
  else
    state.nextFeedId = Math.max(state.nextFeedId, forcedId + 1);
  const stride = feedStride(feedOptions.layout);
  const current = new ArrayBuffer(feedOptions.capacity * stride);
  const core = {
    layout: feedOptions.layout,
    capacity: feedOptions.capacity,
    stride,
    pool: [],
    current,
    f32: new Float32Array(current),
    u8: new Uint8Array(current),
    written: 0,
    base: 0,
    shipped: 0,
    published: 0
  };
  state.feeds.set(id, core);
  let wFrom = 0;
  const writer = {
    setFloat: (name, index, value) => {
      const c = core;
      const at = msgFieldAt(c, name, wFrom + index);
      c.f32[at >> 2] = value;
    },
    setVec2: (name, index, x, y) => {
      const c = core;
      const at = msgFieldAt(c, name, wFrom + index);
      const f = at >> 2;
      c.f32[f] = x;
      c.f32[f + 1] = y;
    },
    setVec3: (name, index, x, y, z) => {
      const c = core;
      const at = msgFieldAt(c, name, wFrom + index);
      const f = at >> 2;
      c.f32[f] = x;
      c.f32[f + 1] = y;
      c.f32[f + 2] = z;
    },
    setVec4: (name, index, x, y, z, w) => {
      const c = core;
      const at = msgFieldAt(c, name, wFrom + index);
      const f = at >> 2;
      c.f32[f] = x;
      c.f32[f + 1] = y;
      c.f32[f + 2] = z;
      c.f32[f + 3] = w;
    },
    setVec4Bytes: (name, index, r, g, b, a) => {
      const c = core;
      const at = msgFieldAt(c, name, wFrom + index);
      c.u8[at] = r;
      c.u8[at + 1] = g;
      c.u8[at + 2] = b;
      c.u8[at + 3] = a;
    }
  };
  return {
    get buffer() {
      return core.current;
    },
    get capacity() {
      return core.capacity;
    },
    get stride() {
      return stride;
    },
    view: (from, count) => {
      const local = from - core.base;
      if (local < 0 || from + count > core.base + core.capacity) {
        throw new Error(`rune: T3 feed is append-only — view(${from},${count}) is outside the window [${core.base}, ${core.base + core.capacity})`);
      }
      if (local + count > core.written)
        core.written = local + count;
      wFrom = from;
      return writer;
    },
    push: (count) => {
      const from = core.base + core.written;
      if (core.base + core.written + count > core.capacity) {
        wFrom = from;
        return writer;
      }
      core.written += count;
      wFrom = from;
      return writer;
    },
    publish: () => {
      core.published = core.base + core.written;
    },
    publishedCount: () => core.published
  };
}
function msgFieldAt(c, name, logicalIndex) {
  const fieldAt = byteOffsets(c.layout).get(name);
  if (fieldAt === undefined)
    throw new Error(`rune: feed field "${name}" is not declared`);
  const local = logicalIndex - c.base;
  if (local < 0 || local >= c.capacity) {
    throw new Error(`rune: T3 feed is append-only — index ${logicalIndex} is outside the window [${c.base}, ${c.base + c.capacity})`);
  }
  return local * c.stride + fieldAt;
}
function applyChunkBytes(entry, chunk) {
  const src = new Float32Array(chunk.bytes);
  const strideF = entry.stride / 4;
  const dstAt = chunk.from * strideF;
  const fitF = Math.min(chunk.count * strideF, src.length, Math.max(0, entry.mirror.length - dstAt));
  if (fitF > 0)
    entry.mirror.set(src.subarray(0, fitF), dstAt);
}
function byteOffsets(layout) {
  const cached = byteOffsetCache.get(layout);
  if (cached !== undefined)
    return cached;
  const offsets = new Map;
  let offset = 0;
  for (const [name, format] of Object.entries(layout)) {
    offsets.set(name, offset);
    offset += format === "float32x2" ? 8 : format === "float32x3" ? 12 : format === "float32x4" ? 16 : 4;
  }
  byteOffsetCache.set(layout, offsets);
  return offsets;
}
function mirrorFeedView(state, feedId, entry) {
  return {
    feedId,
    stride: entry.stride,
    capacity: entry.capacity,
    layout: entry.layout,
    count: () => entry.count,
    bytes: () => entry.mirror,
    recycle: () => {
      for (const chunk of entry.pending)
        state.recycled.push(chunk);
      entry.pending.length = 0;
    }
  };
}
function createMsgFeedWriter(feedId, options) {
  const state = createMsgState([]);
  const facade = msgFeedFacade(state, options, feedId);
  return {
    feed: facade,
    ship: () => {
      const message = flushMsg(state);
      return message === null ? [] : [...message.chunks];
    },
    reclaim: (chunks) => {
      for (const chunk of chunks)
        state.recycled.push(chunk);
    }
  };
}
function createMsgFeedReader(feedId, options) {
  const stride = feedStride(options.layout);
  const mirror = new Float32Array(options.capacity * stride / 4);
  const entry = { mirror, stride, capacity: options.capacity, count: 0, pending: [] };
  const state = { names: [], slots: new Map, feeds: new Map, mirrors: new Map([[feedId, entry]]), recycled: [], nextFeedId: feedId + 1 };
  const view = mirrorFeedView(state, feedId, entry);
  return {
    view,
    apply: (chunks) => {
      for (const chunk of chunks) {
        if (chunk.feedId !== feedId)
          continue;
        applyChunkBytes(entry, chunk);
        entry.count = Math.min(Math.max(entry.count, chunk.from + chunk.count), options.capacity);
        entry.pending.push(chunk);
      }
    },
    takeRecycled: () => {
      const out = [...state.recycled];
      state.recycled.length = 0;
      return out;
    }
  };
}
function signalClient(mode, cells) {
  return {
    mode,
    shared: (name) => {
      const cell = cells.get(name);
      if (cell === undefined)
        throw new Error(`rune: signal "${name}" is not registered`);
      return cell;
    },
    sampleAll: () => 0,
    apply: () => {},
    takeRecycled: () => [],
    feed: () => null,
    attachFeed: () => {
      throw new Error("rune: T0 feeds are not registered by the transport — the channel is shared");
    },
    waitForChange: () => Promise.resolve(false)
  };
}
function requireCell(cells, name) {
  const cell = cells.get(name);
  if (cell === undefined)
    throw new Error(`rune: signal "${name}" is not registered`);
  return cell;
}
function requireName(names, name) {
  if (!names.includes(name))
    throw new Error(`rune: signal "${name}" is not registered`);
}
function requireMsgSlot(state, name) {
  const slot = state.slots.get(name);
  if (slot === undefined)
    throw new Error(`rune: signal "${name}" is not registered`);
  return slot;
}
var byteOffsetCache;
var init_transport = __esm(() => {
  init_signal();
  init_sharedRegistry();
  byteOffsetCache = new WeakMap;
});

// packages/core/src/streaming/uploadQueue.ts
function createUploadQueue() {
  const heap = [];
  return {
    get size() {
      return heap.length;
    },
    push: (job) => {
      heap.push(job);
      siftUp(heap, heap.length - 1);
    },
    pop: () => {
      if (heap.length === 0)
        return null;
      swap(heap, 0, heap.length - 1);
      const top = heap.pop();
      if (heap.length > 0)
        siftDown(heap, 0);
      return top;
    },
    clear: () => {
      heap.length = 0;
    }
  };
}
function less(a, b) {
  return a.priority < b.priority;
}
function swap(heap, i, j) {
  const tmp = heap[i];
  heap[i] = heap[j];
  heap[j] = tmp;
}
function siftUp(heap, at) {
  while (at > 0) {
    const parent = at - 1 >> 1;
    if (!less(heap[at], heap[parent]))
      return;
    swap(heap, at, parent);
    at = parent;
  }
}
function siftDown(heap, at) {
  for (;; ) {
    const left = at * 2 + 1;
    const right = left + 1;
    let smallest = at;
    if (left < heap.length && less(heap[left], heap[smallest]))
      smallest = left;
    if (right < heap.length && less(heap[right], heap[smallest]))
      smallest = right;
    if (smallest === at)
      return;
    swap(heap, at, smallest);
    at = smallest;
  }
}

// packages/core/src/uniforms/layout.ts
function isUniformType(text) {
  return text in TABLE;
}
var IVEC2, IVEC3, IVEC4, TABLE;
var init_layout = __esm(() => {
  IVEC2 = { align: 8, size: 8, kind: "i32" };
  IVEC3 = { align: 16, size: 12, kind: "i32" };
  IVEC4 = { align: 16, size: 16, kind: "i32" };
  TABLE = {
    float: { align: 4, size: 4, kind: "f32" },
    int: { align: 4, size: 4, kind: "i32" },
    uint: { align: 4, size: 4, kind: "i32" },
    bool: { align: 4, size: 4, kind: "i32" },
    vec2: { align: 8, size: 8, kind: "f32" },
    vec3: { align: 16, size: 12, kind: "f32" },
    vec4: { align: 16, size: 16, kind: "f32" },
    ivec2: IVEC2,
    ivec3: IVEC3,
    ivec4: IVEC4,
    uvec2: IVEC2,
    uvec3: IVEC3,
    uvec4: IVEC4,
    bvec2: IVEC2,
    bvec3: IVEC3,
    bvec4: IVEC4,
    mat2: { align: 16, size: 32, kind: "f32" },
    mat3: { align: 16, size: 48, kind: "f32" },
    mat4: { align: 16, size: 64, kind: "f32" },
    sampler2D: { align: 4, size: 4, kind: "i32" },
    samplerCube: { align: 4, size: 4, kind: "i32" },
    sampler2DArray: { align: 4, size: 4, kind: "i32" }
  };
});

// packages/core/src/shader/glslReflect.ts
function reflectGlsl(vertexSource, fragmentSource) {
  const key = `${vertexSource}\x00${fragmentSource}`;
  const cached = reflectionCache.get(key);
  if (cached !== undefined)
    return cached;
  const reflection = parseGlsl(vertexSource, fragmentSource);
  remember(key, reflection);
  return reflection;
}
function remember(key, reflection) {
  if (reflectionCache.size >= CACHE_LIMIT)
    return;
  reflectionCache.set(key, reflection);
}
function parseGlsl(vertexSource, fragmentSource) {
  const uniforms = new Map;
  collectUniforms(vertexSource, uniforms);
  collectUniforms(fragmentSource, uniforms);
  const attributes = collectAttributes(vertexSource);
  return { uniforms: [...uniforms.values()], attributes };
}
function collectUniforms(source, into) {
  const lines = stripComments(source).split(`
`);
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (isInterfaceBlock(line)) {
      i = skipBlock(lines, i);
      continue;
    }
    const found = matchUniform(line);
    if (found !== null && !into.has(found.name))
      into.set(found.name, found);
  }
}
function collectAttributes(source) {
  const found = [];
  for (const line of stripComments(source).split(`
`)) {
    const attribute = matchAttribute(line);
    if (attribute !== null)
      found.push(attribute);
  }
  return found;
}
function isInterfaceBlock(line) {
  return /^\s*uniform\s+\w+\s*\{/.test(line);
}
function skipBlock(lines, start) {
  let i = start;
  while (i < lines.length && !/\}\s*(\w+\s*)?;/.test(lines[i]))
    i++;
  return i;
}
function matchUniform(line) {
  const match = /^\s*uniform\s+(\w+)\s+(\w+)(?:\s*\[\s*(\d+)\s*\])?\s*;/.exec(line);
  if (match === null)
    return null;
  const type = match[1];
  if (!isUniformType(type))
    return null;
  return { name: match[2], type, arrayLength: match[3] !== undefined ? Number(match[3]) : 1 };
}
function matchAttribute(line) {
  const match = /^\s*(?:layout\(\s*location\s*=\s*(\d+)\s*\)\s*)?in\s+(\w+)\s+(\w+)\s*;/.exec(line);
  if (match === null)
    return null;
  return { name: match[3], location: match[1] !== undefined ? Number(match[1]) : -1 };
}
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
var reflectionCache, CACHE_LIMIT = 512;
var init_glslReflect = __esm(() => {
  init_layout();
  reflectionCache = new Map;
});

// packages/core/src/shader/wgslReflect.ts
function reflectWgsl(source) {
  const cached = reflectionCache2.get(source);
  if (cached !== undefined)
    return cached;
  const reflection = parseWgsl(source);
  if (reflectionCache2.size < CACHE_LIMIT2)
    reflectionCache2.set(source, reflection);
  return reflection;
}
function parseWgsl(source) {
  const cleaned = stripComments2(source);
  const structs = collectStructs(cleaned);
  const vars = collectVars(cleaned);
  return {
    uniforms: expandUniformVars(vars, structs),
    textures: collectTextures(vars),
    attributes: collectAttributes2(cleaned),
    entries: collectEntries(cleaned)
  };
}
function stripComments2(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}
function collectStructs(source) {
  const structs = new Map;
  for (const match of source.matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    structs.set(match[1], parseStructFields(match[2]));
  }
  return structs;
}
function parseStructFields(body) {
  const fields = [];
  for (const raw of body.split(",")) {
    const field = matchField(raw.trim());
    if (field !== null)
      fields.push(field);
  }
  return fields;
}
function matchField(text) {
  const match = /^(\w+)\s*:\s*([\w<>]+)$/.exec(text);
  if (match === null)
    return null;
  const type = wgslTypeToAbi(match[2]);
  if (type === null)
    return null;
  return { name: match[1], type };
}
function wgslTypeToAbi(wgslType) {
  const mapped = WGSL_TYPE_MAP[wgslType];
  return mapped ?? null;
}
function collectVars(source) {
  const vars = [];
  const pattern = /@group\((\d+)\)\s*@binding\((\d+)\)\s*var(?:<(\w+)>)?\s+(\w+)\s*:\s*([\w<>]+)/g;
  for (const match of source.matchAll(pattern)) {
    vars.push({
      group: Number(match[1]),
      binding: Number(match[2]),
      isUniform: match[3] === "uniform",
      name: match[4],
      type: match[5]
    });
  }
  return vars;
}
function expandUniformVars(vars, structs) {
  const uniforms = [];
  for (const binding of vars) {
    if (!binding.isUniform)
      continue;
    const fields = structs.get(binding.type);
    if (fields === undefined)
      continue;
    pushStructFields(uniforms, fields, binding);
  }
  return uniforms;
}
function pushStructFields(out, fields, binding) {
  for (const field of fields) {
    out.push({ name: field.name, type: field.type, group: binding.group, binding: binding.binding });
  }
}
function collectTextures(vars) {
  const textures = [];
  for (const binding of vars) {
    if (binding.isUniform)
      continue;
    const type = wgslTypeToAbi(binding.type);
    if (type === null || !isTextureType(type))
      continue;
    textures.push({ name: binding.name, type, group: binding.group, binding: binding.binding });
  }
  return textures;
}
function isTextureType(type) {
  return type === "sampler2D" || type === "samplerCube" || type === "sampler2DArray";
}
function collectAttributes2(source) {
  const attributes = [];
  const vertexFn = matchVertexFn(source);
  if (vertexFn === null)
    return attributes;
  for (const param of splitParams(vertexFn)) {
    const attribute = matchLocationParam(param);
    if (attribute !== null)
      attributes.push(attribute);
  }
  return attributes;
}
function matchVertexFn(source) {
  const match = /@vertex\s+fn\s+\w+\s*\(([\s\S]*?)\)\s*(?:->|\{)/.exec(source);
  return match === null ? null : match[1];
}
function splitParams(params) {
  return params.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}
function matchLocationParam(param) {
  const match = /^@location\((\d+)\)\s+(\w+)\s*:/.exec(param);
  if (match === null)
    return null;
  return { name: match[2], location: Number(match[1]) };
}
function collectEntries(source) {
  return {
    vertex: matchEntry(source, "vertex"),
    fragment: matchEntry(source, "fragment"),
    compute: matchEntry(source, "compute")
  };
}
function matchEntry(source, stage) {
  const match = new RegExp(`@${stage}[\\s\\S]{0,80}?fn\\s+(\\w+)`).exec(source);
  return match === null ? null : match[1];
}
var reflectionCache2, CACHE_LIMIT2 = 512, WGSL_TYPE_MAP;
var init_wgslReflect = __esm(() => {
  reflectionCache2 = new Map;
  WGSL_TYPE_MAP = {
    f32: "float",
    i32: "int",
    u32: "uint",
    bool: "bool",
    "vec2<f32>": "vec2",
    "vec3<f32>": "vec3",
    "vec4<f32>": "vec4",
    "vec2<i32>": "ivec2",
    "vec3<i32>": "ivec3",
    "vec4<i32>": "ivec4",
    "vec2<u32>": "uvec2",
    "vec3<u32>": "uvec3",
    "vec4<u32>": "uvec4",
    "vec2<bool>": "bvec2",
    "vec3<bool>": "bvec3",
    "vec4<bool>": "bvec4",
    "mat2x2<f32>": "mat2",
    "mat3x3<f32>": "mat3",
    "mat4x4<f32>": "mat4",
    "texture_2d<f32>": "sampler2D",
    "texture_cube<f32>": "samplerCube",
    "texture_2d_array<f32>": "sampler2DArray",
    texture_depth_2d: "sampler2D",
    texture_external: "sampler2D"
  };
});

// packages/core/src/journal/journal.ts
function createJournal() {
  const ops = [];
  return {
    record(op) {
      ops.push(op.kind === "createBuffer" && !(op.data instanceof Float32Array) ? { ...op, data: toFloat32Array(op.data) } : op);
    },
    replay(apply) {
      for (const op of ops)
        apply(op);
    },
    entries() {
      return ops.slice();
    },
    compact() {
      const destroyedTextures = new Set;
      const destroyedPrograms = new Set;
      const destroyedBuffers = new Set;
      const destroyedTargets = new Set;
      const destroyedTextureViews = new Set;
      const lastTexLifecycle = new Map;
      const lastTexCreateIdx = new Map;
      for (let i = 0;i < ops.length; i++) {
        const op = ops[i];
        if (op.kind === "createTexture") {
          lastTexLifecycle.set(op.id, "create");
          lastTexCreateIdx.set(op.id, i);
        } else if (op.kind === "destroyTexture") {
          lastTexLifecycle.set(op.id, "destroy");
        }
      }
      const runningState = new Map;
      const aliveAt = new Map;
      for (let i = 0;i < ops.length; i++) {
        const op = ops[i];
        if (op.kind === "texImage2DFromSource" || op.kind === "createTextureView" || op.kind === "createTarget") {
          aliveAt.set(i, runningState.get(op.textureId) === "create");
        } else if (op.kind === "createTexture") {
          runningState.set(op.id, "create");
        } else if (op.kind === "destroyTexture") {
          runningState.set(op.id, "destroy");
        }
      }
      const texAliveAt = (i, textureId) => lastTexLifecycle.get(textureId) === "create" && (lastTexCreateIdx.get(textureId) ?? -1) < i && aliveAt.get(i) === true;
      for (const op of ops) {
        if (op.kind === "destroyTexture")
          destroyedTextures.add(op.id);
        else if (op.kind === "destroyProgram")
          destroyedPrograms.add(op.id);
        else if (op.kind === "destroyBuffer")
          destroyedBuffers.add(op.id);
        else if (op.kind === "destroyTarget")
          destroyedTargets.add(op.id);
        else if (op.kind === "destroyTextureView")
          destroyedTextureViews.add(op.id);
      }
      const keep = [];
      const seenDestroy = {
        tex: new Set,
        prog: new Set,
        buf: new Set,
        tgt: new Set,
        view: new Set
      };
      const prunedViewIds = new Set;
      const prunedTargetIds = new Set;
      for (let i = 0;i < ops.length; i++) {
        const op = ops[i];
        switch (op.kind) {
          case "createTexture":
            if (destroyedTextures.has(op.id) && !seenDestroy.tex.has(op.id)) {
              seenDestroy.tex.add(op.id);
            } else {
              keep.push(op);
            }
            break;
          case "destroyTexture":
            if (seenDestroy.tex.has(op.id))
              continue;
            keep.push(op);
            break;
          case "createProgram":
            if (destroyedPrograms.has(op.id) && !seenDestroy.prog.has(op.id)) {
              seenDestroy.prog.add(op.id);
            } else {
              keep.push(op);
            }
            break;
          case "destroyProgram":
            if (seenDestroy.prog.has(op.id))
              continue;
            keep.push(op);
            break;
          case "createBuffer":
            if (destroyedBuffers.has(op.id) && !seenDestroy.buf.has(op.id)) {
              seenDestroy.buf.add(op.id);
            } else {
              keep.push(op);
            }
            break;
          case "destroyBuffer":
            if (seenDestroy.buf.has(op.id))
              continue;
            keep.push(op);
            break;
          case "createTarget":
            if (!texAliveAt(i, op.textureId)) {
              prunedTargetIds.add(op.id);
              continue;
            }
            if (destroyedTargets.has(op.id) && !seenDestroy.tgt.has(op.id)) {
              seenDestroy.tgt.add(op.id);
            } else {
              keep.push(op);
            }
            break;
          case "destroyTarget":
            if (prunedTargetIds.has(op.id))
              continue;
            if (seenDestroy.tgt.has(op.id))
              continue;
            keep.push(op);
            break;
          case "createTextureView":
            if (!texAliveAt(i, op.textureId)) {
              prunedViewIds.add(op.id);
              continue;
            }
            if (destroyedTextureViews.has(op.id) && !seenDestroy.view.has(op.id)) {
              seenDestroy.view.add(op.id);
            } else {
              keep.push(op);
            }
            break;
          case "destroyTextureView":
            if (prunedViewIds.has(op.id))
              continue;
            if (seenDestroy.view.has(op.id))
              continue;
            keep.push(op);
            break;
          case "texImage2DFromSource":
            if (!texAliveAt(i, op.textureId))
              continue;
            keep.push(op);
            break;
          default:
            keep.push(op);
        }
      }
      ops.length = 0;
      ops.push(...keep);
    },
    snapshot() {
      const copy = ops.map(cloneOp);
      return { ops: copy };
    },
    evict(predicate) {
      for (let i = ops.length - 1;i >= 0; i--) {
        if (predicate(ops[i]))
          ops.splice(i, 1);
      }
    },
    reset() {
      ops.length = 0;
    },
    get size() {
      return ops.length;
    }
  };
}
function cloneOp(op) {
  if (op.kind === "createBuffer") {
    return { ...op, data: toFloat32Array(op.data).slice() };
  }
  return op;
}
function toFloat32Array(data) {
  if (data instanceof Float32Array)
    return data;
  if (Array.isArray(data))
    return new Float32Array(data);
  if (typeof data === "object" && data !== null) {
    const values = Object.values(data);
    return new Float32Array(values.filter((v) => typeof v === "number"));
  }
  return new Float32Array(0);
}

// packages/core/src/formats.ts
function unorm(channels, bytesPerChannel, srgb = false) {
  return {
    texelBytes: channels * bytesPerChannel,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: channels * bytesPerChannel,
    srgb,
    kind: "color",
    numeric: "unorm",
    channels,
    sampleType: "float",
    family: "uncompressed"
  };
}
function snorm(channels, bytesPerChannel) {
  return {
    texelBytes: channels * bytesPerChannel,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: channels * bytesPerChannel,
    srgb: false,
    kind: "color",
    numeric: "snorm",
    channels,
    sampleType: "float",
    family: "uncompressed"
  };
}
function intFormat(channels, bytesPerChannel, signed) {
  return {
    texelBytes: channels * bytesPerChannel,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: channels * bytesPerChannel,
    srgb: false,
    kind: "color",
    numeric: signed ? "sint" : "uint",
    channels,
    sampleType: signed ? "sint" : "uint",
    family: "uncompressed"
  };
}
function floatFormat(channels, bytesPerChannel) {
  return {
    texelBytes: channels * bytesPerChannel,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: channels * bytesPerChannel,
    srgb: false,
    kind: "color",
    numeric: "float",
    channels,
    sampleType: "float",
    family: "uncompressed"
  };
}
function packed(numeric, channels, texelBytes, sampleType = "float") {
  return {
    texelBytes,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: texelBytes,
    srgb: false,
    kind: "color",
    numeric,
    channels,
    sampleType,
    family: "uncompressed"
  };
}
function compressed(family, blockWidth, blockHeight, blockBytes, srgb, channels, numeric = "unorm") {
  return {
    texelBytes: 0,
    blockWidth,
    blockHeight,
    blockBytes,
    srgb,
    kind: "color",
    numeric,
    channels,
    sampleType: "float",
    family
  };
}
function depthFormat(kind, texelBytes) {
  return {
    texelBytes,
    blockWidth: 1,
    blockHeight: 1,
    blockBytes: texelBytes,
    srgb: false,
    kind,
    numeric: "float",
    channels: 0,
    sampleType: "depth",
    family: "uncompressed"
  };
}
function textureFormatInfo(format) {
  if (format === "canvas")
    return TEXTURE_FORMATS.rgba8unorm;
  return TEXTURE_FORMATS[format];
}
function normalizeTextureFormat(name) {
  const legacy = LEGACY_ALIASES[name];
  if (legacy !== undefined)
    return legacy;
  if (name === "canvas")
    return "canvas";
  if (Object.prototype.hasOwnProperty.call(TEXTURE_FORMATS, name))
    return name;
  return;
}
var LEGACY_ALIASES, TEXTURE_FORMATS, TEXTURE_FORMAT_IDS;
var init_formats = __esm(() => {
  LEGACY_ALIASES = {
    rgba8: "rgba8unorm",
    rgba16f: "rgba16float",
    rgba32f: "rgba32float"
  };
  TEXTURE_FORMATS = {
    r8unorm: unorm(1, 1),
    r8snorm: snorm(1, 1),
    r8uint: intFormat(1, 1, false),
    r8sint: intFormat(1, 1, true),
    rg8unorm: unorm(2, 1),
    rg8snorm: snorm(2, 1),
    rg8uint: intFormat(2, 1, false),
    rg8sint: intFormat(2, 1, true),
    rgba8unorm: unorm(4, 1),
    "rgba8unorm-srgb": unorm(4, 1, true),
    rgba8snorm: snorm(4, 1),
    rgba8uint: intFormat(4, 1, false),
    rgba8sint: intFormat(4, 1, true),
    bgra8unorm: unorm(4, 1),
    "bgra8unorm-srgb": unorm(4, 1, true),
    rgb8unorm: unorm(3, 1),
    "rgb8unorm-srgb": unorm(3, 1, true),
    rgb8snorm: snorm(3, 1),
    rgb8uint: intFormat(3, 1, false),
    rgb8sint: intFormat(3, 1, true),
    rgb565: packed("unorm", 3, 2),
    rgba4: packed("unorm", 4, 2),
    rgb5a1: packed("unorm", 4, 2),
    r16uint: intFormat(1, 2, false),
    r16sint: intFormat(1, 2, true),
    r16float: floatFormat(1, 2),
    rg16uint: intFormat(2, 2, false),
    rg16sint: intFormat(2, 2, true),
    rg16float: floatFormat(2, 2),
    rgba16uint: intFormat(4, 2, false),
    rgba16sint: intFormat(4, 2, true),
    rgba16float: floatFormat(4, 2),
    rgb16uint: intFormat(3, 2, false),
    rgb16sint: intFormat(3, 2, true),
    rgb16float: floatFormat(3, 2),
    r16unorm: unorm(1, 2),
    r16snorm: snorm(1, 2),
    rg16unorm: unorm(2, 2),
    rg16snorm: snorm(2, 2),
    rgba16unorm: unorm(4, 2),
    rgba16snorm: snorm(4, 2),
    r32uint: intFormat(1, 4, false),
    r32sint: intFormat(1, 4, true),
    r32float: floatFormat(1, 4),
    rg32uint: intFormat(2, 4, false),
    rg32sint: intFormat(2, 4, true),
    rg32float: floatFormat(2, 4),
    rgba32uint: intFormat(4, 4, false),
    rgba32sint: intFormat(4, 4, true),
    rgba32float: floatFormat(4, 4),
    rgb32uint: intFormat(3, 4, false),
    rgb32sint: intFormat(3, 4, true),
    rgb32float: floatFormat(3, 4),
    rgb10a2uint: packed("uint", 4, 4, "uint"),
    rgb10a2unorm: packed("unorm", 4, 4),
    rg11b10ufloat: packed("float", 3, 4),
    rgb9e5ufloat: packed("float", 3, 4),
    stencil8: { texelBytes: 1, blockWidth: 1, blockHeight: 1, blockBytes: 1, srgb: false, kind: "stencil", numeric: "uint", channels: 0, sampleType: "uint", family: "uncompressed" },
    depth16unorm: depthFormat("depth", 2),
    depth24plus: depthFormat("depth", 4),
    "depth24plus-stencil8": depthFormat("depth-stencil", 4),
    depth32float: depthFormat("depth", 4),
    "depth32float-stencil8": depthFormat("depth-stencil", 4),
    "bc1-rgba-unorm": compressed("bc1", 4, 4, 8, false, 4),
    "bc1-rgba-unorm-srgb": compressed("bc1", 4, 4, 8, true, 4),
    "bc2-rgba-unorm": compressed("bc2", 4, 4, 16, false, 4),
    "bc2-rgba-unorm-srgb": compressed("bc2", 4, 4, 16, true, 4),
    "bc3-rgba-unorm": compressed("bc3", 4, 4, 16, false, 4),
    "bc3-rgba-unorm-srgb": compressed("bc3", 4, 4, 16, true, 4),
    "bc4-r-unorm": compressed("bc4", 4, 4, 8, false, 1),
    "bc4-r-snorm": compressed("bc4", 4, 4, 8, false, 1, "snorm"),
    "bc5-rg-unorm": compressed("bc5", 4, 4, 16, false, 2),
    "bc5-rg-snorm": compressed("bc5", 4, 4, 16, false, 2, "snorm"),
    "bc6h-rgb-ufloat": compressed("bc6h", 4, 4, 16, false, 3, "ufloat"),
    "bc6h-rgb-float": compressed("bc6h", 4, 4, 16, false, 3, "float"),
    "bc7-rgba-unorm": compressed("bc7", 4, 4, 16, false, 4),
    "bc7-rgba-unorm-srgb": compressed("bc7", 4, 4, 16, true, 4),
    "etc2-rgb8unorm": compressed("etc2", 4, 4, 8, false, 3),
    "etc2-rgb8unorm-srgb": compressed("etc2", 4, 4, 8, true, 3),
    "etc2-rgb8a1unorm": compressed("etc2", 4, 4, 8, false, 4),
    "etc2-rgb8a1unorm-srgb": compressed("etc2", 4, 4, 8, true, 4),
    "etc2-rgba8unorm": compressed("etc2", 4, 4, 16, false, 4),
    "etc2-rgba8unorm-srgb": compressed("etc2", 4, 4, 16, true, 4),
    "eac-r11unorm": compressed("eac", 4, 4, 8, false, 1),
    "eac-r11snorm": compressed("eac", 4, 4, 8, false, 1, "snorm"),
    "eac-rg11unorm": compressed("eac", 4, 4, 16, false, 2),
    "eac-rg11snorm": compressed("eac", 4, 4, 16, false, 2, "snorm"),
    "astc-4x4-unorm": compressed("astc", 4, 4, 16, false, 4),
    "astc-4x4-unorm-srgb": compressed("astc", 4, 4, 16, true, 4),
    "astc-5x4-unorm": compressed("astc", 5, 4, 16, false, 4),
    "astc-5x4-unorm-srgb": compressed("astc", 5, 4, 16, true, 4),
    "astc-5x5-unorm": compressed("astc", 5, 5, 16, false, 4),
    "astc-5x5-unorm-srgb": compressed("astc", 5, 5, 16, true, 4),
    "astc-6x5-unorm": compressed("astc", 6, 5, 16, false, 4),
    "astc-6x5-unorm-srgb": compressed("astc", 6, 5, 16, true, 4),
    "astc-6x6-unorm": compressed("astc", 6, 6, 16, false, 4),
    "astc-6x6-unorm-srgb": compressed("astc", 6, 6, 16, true, 4),
    "astc-8x5-unorm": compressed("astc", 8, 5, 16, false, 4),
    "astc-8x5-unorm-srgb": compressed("astc", 8, 5, 16, true, 4),
    "astc-8x6-unorm": compressed("astc", 8, 6, 16, false, 4),
    "astc-8x6-unorm-srgb": compressed("astc", 8, 6, 16, true, 4),
    "astc-8x8-unorm": compressed("astc", 8, 8, 16, false, 4),
    "astc-8x8-unorm-srgb": compressed("astc", 8, 8, 16, true, 4),
    "astc-10x5-unorm": compressed("astc", 10, 5, 16, false, 4),
    "astc-10x5-unorm-srgb": compressed("astc", 10, 5, 16, true, 4),
    "astc-10x6-unorm": compressed("astc", 10, 6, 16, false, 4),
    "astc-10x6-unorm-srgb": compressed("astc", 10, 6, 16, true, 4),
    "astc-10x8-unorm": compressed("astc", 10, 8, 16, false, 4),
    "astc-10x8-unorm-srgb": compressed("astc", 10, 8, 16, true, 4),
    "astc-10x10-unorm": compressed("astc", 10, 10, 16, false, 4),
    "astc-10x10-unorm-srgb": compressed("astc", 10, 10, 16, true, 4),
    "astc-12x10-unorm": compressed("astc", 12, 10, 16, false, 4),
    "astc-12x10-unorm-srgb": compressed("astc", 12, 10, 16, true, 4),
    "astc-12x12-unorm": compressed("astc", 12, 12, 16, false, 4),
    "astc-12x12-unorm-srgb": compressed("astc", 12, 12, 16, true, 4)
  };
  TEXTURE_FORMAT_IDS = Object.keys(TEXTURE_FORMATS);
});

// packages/core/src/journal/resourceJournal.ts
function textureFormatBytesPerPixel(format) {
  if (format === undefined)
    return 4;
  const info = TEXTURE_FORMATS[format];
  if (info === undefined)
    return 4;
  if (info.blockWidth > 1 || info.blockHeight > 1) {
    return info.blockBytes / (info.blockWidth * info.blockHeight);
  }
  return info.texelBytes;
}
function selectResidentOps(ops, keep) {
  const lastTexLifecycle = new Map;
  const lastViewLifecycle = new Map;
  const lastTargetLifecycle = new Map;
  const viewParent = new Map;
  const targetParent = new Map;
  const lastTexCreateIdx = new Map;
  const lastViewCreateIdx = new Map;
  const lastTargetCreateIdx = new Map;
  for (let i = 0;i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "texture.create") {
      lastTexLifecycle.set(op.id, "create");
      lastTexCreateIdx.set(op.id, i);
    } else if (op.kind === "texture.destroy")
      lastTexLifecycle.set(op.id, "destroy");
    else if (op.kind === "view.create") {
      lastViewLifecycle.set(op.id, "create");
      lastViewCreateIdx.set(op.id, i);
      viewParent.set(op.id, op.textureId);
    } else if (op.kind === "view.destroy")
      lastViewLifecycle.set(op.id, "destroy");
    else if (op.kind === "target.create") {
      lastTargetLifecycle.set(op.id, "create");
      lastTargetCreateIdx.set(op.id, i);
      targetParent.set(op.id, op.textureId);
    } else if (op.kind === "target.destroy")
      lastTargetLifecycle.set(op.id, "destroy");
  }
  const texKeep = new Set(keep.textureIds ?? []);
  const viewKeep = new Set(keep.viewIds ?? []);
  const targetKeep = new Set(keep.targetIds ?? []);
  for (const viewId of viewKeep) {
    const parent = viewParent.get(viewId);
    if (parent !== undefined)
      texKeep.add(parent);
  }
  for (const targetId of targetKeep) {
    const parent = targetParent.get(targetId);
    if (parent !== undefined)
      texKeep.add(parent);
  }
  const texNeedsContent = new Set(keep.textureIds ?? []);
  for (const viewId of viewKeep) {
    const parent = viewParent.get(viewId);
    if (parent !== undefined)
      texNeedsContent.add(parent);
  }
  const selected = [];
  for (let i = 0;i < ops.length; i++) {
    const op = ops[i];
    switch (op.kind) {
      case "texture.create": {
        if (texKeep.has(op.id) && lastTexCreateIdx.get(op.id) === i)
          selected.push(op);
        break;
      }
      case "texture.destroy": {
        break;
      }
      case "texture.write":
      case "texture.update":
      case "texture.writeMip": {
        if (texKeep.has(op.id) && texNeedsContent.has(op.id) && lastTexLifecycle.get(op.id) === "create" && (lastTexCreateIdx.get(op.id) ?? -1) < i) {
          selected.push(op);
        }
        break;
      }
      case "view.create": {
        if (viewKeep.has(op.id) && lastViewCreateIdx.get(op.id) === i)
          selected.push(op);
        break;
      }
      case "target.create": {
        if (targetKeep.has(op.id) && lastTargetCreateIdx.get(op.id) === i)
          selected.push(op);
        break;
      }
      default:
        break;
    }
  }
  const deferredTextures = [];
  for (const [id, lifecycle] of lastTexLifecycle) {
    if (lifecycle === "create" && !texKeep.has(id))
      deferredTextures.push(id);
  }
  const deferredViews = [];
  for (const [id, lifecycle] of lastViewLifecycle) {
    if (lifecycle === "create" && !viewKeep.has(id))
      deferredViews.push(id);
  }
  const deferredTargets = [];
  for (const [id, lifecycle] of lastTargetLifecycle) {
    if (lifecycle === "create" && !targetKeep.has(id))
      deferredTargets.push(id);
  }
  return { ops: selected, deferredTextures, deferredViews, deferredTargets };
}
function sourceIsDead(source) {
  if (source === null || source === undefined)
    return true;
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    return source.width === 0 || source.height === 0;
  }
  return false;
}
function createResourceJournal() {
  const ops = [];
  const sources = new Map;
  let nextRef = 1;
  function storeSource(source, kind, width, height) {
    const ref = nextRef++;
    sources.set(ref, source);
    return { ref, kind, width, height };
  }
  function pruneSources() {
    const used = new Set;
    for (const op of ops) {
      if (op.kind === "texture.write" || op.kind === "texture.update" || op.kind === "texture.writeMip") {
        used.add(op.content.ref);
      }
    }
    let pruned = 0;
    for (const ref of [...sources.keys()]) {
      if (!used.has(ref)) {
        sources.delete(ref);
        pruned++;
      }
    }
    return pruned;
  }
  return {
    record(op) {
      ops.push(op);
    },
    replay(apply) {
      for (const op of ops)
        apply(op);
    },
    entries() {
      return ops.slice();
    },
    compact() {
      const lastTexLifecycle = new Map;
      const lastTexCreateIdx = new Map;
      for (let i = 0;i < ops.length; i++) {
        const op = ops[i];
        if (op.kind === "texture.create") {
          lastTexLifecycle.set(op.id, "create");
          lastTexCreateIdx.set(op.id, i);
        } else if (op.kind === "texture.destroy") {
          lastTexLifecycle.set(op.id, "destroy");
        }
      }
      const running = new Map;
      const aliveAt = new Map;
      const opTextureId = (op) => op.kind === "texture.write" || op.kind === "texture.update" || op.kind === "texture.writeMip" ? op.id : op.kind === "view.create" || op.kind === "target.create" ? op.textureId : null;
      for (let i = 0;i < ops.length; i++) {
        const op = ops[i];
        const dep = opTextureId(op);
        if (dep !== null) {
          aliveAt.set(i, running.get(dep) === "create");
        } else if (op.kind === "texture.create") {
          running.set(op.id, "create");
        } else if (op.kind === "texture.destroy") {
          running.set(op.id, "destroy");
        }
      }
      const texAliveAt = (i, textureId) => lastTexLifecycle.get(textureId) === "create" && (lastTexCreateIdx.get(textureId) ?? -1) < i && aliveAt.get(i) === true;
      const seenTexDestroy = new Set;
      const seenViewDestroy = new Set;
      const seenTargetDestroy = new Set;
      for (const op of ops) {
        if (op.kind === "texture.destroy")
          seenTexDestroy.add(op.id);
        else if (op.kind === "view.destroy")
          seenViewDestroy.add(op.id);
        else if (op.kind === "target.destroy")
          seenTargetDestroy.add(op.id);
      }
      const prunedViews = new Set;
      const prunedTargets = new Set;
      const keep = [];
      const pairedTexCreateDropped = new Set;
      const pairedViewCreateDropped = new Set;
      const pairedTargetCreateDropped = new Set;
      for (let i = 0;i < ops.length; i++) {
        const op = ops[i];
        switch (op.kind) {
          case "texture.create":
            if (seenTexDestroy.has(op.id) && !pairedTexCreateDropped.has(op.id)) {
              pairedTexCreateDropped.add(op.id);
            } else {
              keep.push(op);
            }
            break;
          case "texture.destroy":
            if (pairedTexCreateDropped.has(op.id))
              continue;
            keep.push(op);
            break;
          case "view.create":
            if (seenViewDestroy.has(op.id) && !pairedViewCreateDropped.has(op.id)) {
              pairedViewCreateDropped.add(op.id);
              continue;
            }
            if (!texAliveAt(i, op.textureId)) {
              prunedViews.add(op.id);
              continue;
            }
            keep.push(op);
            break;
          case "view.destroy":
            if (pairedViewCreateDropped.has(op.id))
              continue;
            if (prunedViews.has(op.id))
              continue;
            keep.push(op);
            break;
          case "target.create":
            if (seenTargetDestroy.has(op.id) && !pairedTargetCreateDropped.has(op.id)) {
              pairedTargetCreateDropped.add(op.id);
              continue;
            }
            if (!texAliveAt(i, op.textureId)) {
              prunedTargets.add(op.id);
              continue;
            }
            keep.push(op);
            break;
          case "target.destroy":
            if (pairedTargetCreateDropped.has(op.id))
              continue;
            if (prunedTargets.has(op.id))
              continue;
            keep.push(op);
            break;
          case "texture.write":
          case "texture.update":
          case "texture.writeMip":
            if (!texAliveAt(i, op.id))
              continue;
            keep.push(op);
            break;
          default:
            keep.push(op);
        }
      }
      ops.length = 0;
      ops.push(...keep);
      const contentKeep = [];
      const absorbed = new Set;
      for (let i = 0;i < ops.length; i++) {
        const op = ops[i];
        if (op.kind === "texture.write") {
          for (let j = 0;j < contentKeep.length; j++) {
            const prev = contentKeep[j];
            if (prev.id === op.id && (prev.kind === "texture.write" || prev.kind === "texture.update")) {
              absorbed.add(j);
            }
          }
          contentKeep.push(op);
        } else if (op.kind === "texture.update") {
          for (let j = 0;j < contentKeep.length; j++) {
            const prev = contentKeep[j];
            if (prev.id === op.id && prev.kind === "texture.update" && prev.x === op.x && prev.y === op.y && prev.w === op.w && prev.h === op.h) {
              absorbed.add(j);
            }
          }
          contentKeep.push(op);
        } else if (op.kind === "texture.writeMip") {
          for (let j = 0;j < contentKeep.length; j++) {
            const prev = contentKeep[j];
            if (prev.id === op.id && prev.kind === "texture.writeMip" && prev.level === op.level) {
              absorbed.add(j);
            }
          }
          contentKeep.push(op);
        } else {
          contentKeep.push(op);
        }
      }
      const coalesced = contentKeep.filter((_, j) => !absorbed.has(j));
      ops.length = 0;
      ops.push(...coalesced);
      pruneSources();
    },
    snapshot() {
      const manifest = [];
      for (const [ref, source] of sources) {
        const meta = opContentByRef(ops, ref);
        manifest.push({ ref, kind: meta.kind, width: meta.width, height: meta.height });
      }
      return { ops: ops.map(cloneResOp), content: manifest };
    },
    evict(predicate) {
      for (let i = ops.length - 1;i >= 0; i--) {
        if (predicate(ops[i]))
          ops.splice(i, 1);
      }
    },
    reset() {
      ops.length = 0;
    },
    get size() {
      return ops.length;
    },
    storeSource,
    getSource(ref) {
      return sources.get(ref) ?? null;
    },
    attachSource(ref, source) {
      sources.set(ref, source);
    },
    isSourceAlive(ref) {
      return !sourceIsDead(sources.get(ref) ?? null);
    },
    maxTextureId() {
      let max = 0;
      for (const op of ops)
        if (op.kind === "texture.create" && op.id > max)
          max = op.id;
      return max;
    },
    maxViewId() {
      let max = 1e6 - 1;
      for (const op of ops)
        if (op.kind === "view.create" && op.id > max)
          max = op.id;
      return max;
    },
    maxTargetId() {
      let max = 0;
      for (const op of ops)
        if (op.kind === "target.create" && op.id > max)
          max = op.id;
      return max;
    }
  };
}
function opContentByRef(ops, ref) {
  for (const op of ops) {
    if (op.kind === "texture.write" || op.kind === "texture.update" || op.kind === "texture.writeMip") {
      if (op.content.ref === ref)
        return { ref, kind: op.content.kind, width: op.content.width, height: op.content.height };
    }
  }
  return { ref, kind: "unknown", width: 0, height: 0 };
}
function cloneResOp(op) {
  if (op.kind === "texture.write" || op.kind === "texture.update" || op.kind === "texture.writeMip") {
    return { ...op, content: { ...op.content } };
  }
  return op;
}
var init_resourceJournal = __esm(() => {
  init_formats();
});

// packages/core/src/journal/lossPolicy.ts
function decideRecovery(event, history = []) {
  const recent = [...history, event].filter((e) => event.at - e.at <= LOSS_STORM_WINDOW_MS);
  if (recent.length >= LOSS_STORM_MAX) {
    return {
      recover: false,
      strategy: "abort",
      kind: "loss-storm",
      message: `Loss storm: ${recent.length} losses within ${LOSS_STORM_WINDOW_MS / 1000} s — ` + `the system has degraded (driver/GPU/memory). Recovery would mask the problem and loop forever. ` + `We stop rendering; restart the page or free up memory.`
    };
  }
  switch (event.kind) {
    case "out-of-memory":
      return {
        recover: true,
        strategy: "soft",
        kind: event.kind,
        message: "The context was lost due to a GPU memory shortage (out-of-memory). " + "A full replay would repeat the same allocations — instead we do a SOFT RESET: " + "restoring only the scene working set, the remaining resources " + "stay in the journal and will return to GPU memory lazily on demand " + "(ensureResident). If memory is not enough even for the scene — reduce the size of " + "textures/atlas pages, the number of render targets, or the canvas resolution."
      };
    case "shader-compile":
      return {
        recover: false,
        strategy: "abort",
        kind: event.kind,
        message: "The context was killed, apparently by compiling an ultra-heavy shader " + "(driver watchdog / overflow). Lazy recovery will not help: " + "the very first draw will recompile the same shader — the loss will repeat. " + "Simplify the shader (fewer instructions/loops/samples) and restart."
      };
    case "context-lost":
      return {
        recover: true,
        strategy: "full",
        kind: event.kind,
        message: "The WebGL2 context was lost (an ordinary loss). Recovering: a replay of the journal " + "of primary resources will restore textures/targets/views and their content."
      };
    case "device-destroyed":
      return {
        recover: true,
        strategy: "full",
        kind: event.kind,
        message: "The GPU device was destroyed (expected on backend switch/dispose). " + "Recovering by replaying the journal on the new device."
      };
    case "device-unknown":
      return {
        recover: true,
        strategy: "full",
        kind: event.kind,
        message: "The GPU device was lost for an unknown reason (driver/OS/reset). " + "We try to recover by replaying the journal; if it repeats, the storm budget will fire."
      };
    case "loss-storm":
      return {
        recover: false,
        strategy: "abort",
        kind: event.kind,
        message: "Device loss storm. Recovery cancelled."
      };
    default:
      return {
        recover: true,
        strategy: "full",
        kind: "unknown",
        message: "Device loss of an unknown type. We try to recover by replaying the journal."
      };
  }
}
function createLossBudget(windowMs = LOSS_STORM_WINDOW_MS, maxLosses = LOSS_STORM_MAX) {
  const events = [];
  return {
    note(event) {
      events.push(event);
      while (events.length > 0 && event.at - events[0].at > windowMs)
        events.shift();
    },
    storm() {
      return events.length >= maxLosses;
    },
    events() {
      return events.slice();
    },
    reset() {
      events.length = 0;
    }
  };
}
function classifyGpuError(error) {
  if (typeof GPUOutOfMemoryError !== "undefined" && error instanceof GPUOutOfMemoryError)
    return "out-of-memory";
  return "unknown";
}
function classifyDeviceLost(reason) {
  if (reason === "destroyed")
    return "device-destroyed";
  return "device-unknown";
}
var LOSS_STORM_WINDOW_MS = 1e4, LOSS_STORM_MAX = 3;

// packages/core/src/journal/residency.ts
function bytesPerPixel(format) {
  return textureFormatBytesPerPixel(format);
}
function estimateTextureBytes(width, height, mipLevels = 1, format) {
  const base = width * height * bytesPerPixel(format);
  if (mipLevels <= 1)
    return base;
  const levels = Math.min(mipLevels, 1 + Math.floor(Math.log2(Math.max(width, height))));
  const sum = base * (1 - Math.pow(4, -levels)) / 0.75;
  return Math.ceil(sum);
}
function selectLRUEvictions(entries, budgetBytes, pinned) {
  const pin = pinned ?? new Set;
  const unpinned = entries.filter((e) => !pin.has(e.id));
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (totalBytes <= budgetBytes) {
    return { evictIds: [], freedBytes: 0, residentBytes: totalBytes };
  }
  const byLru = [...unpinned].sort((a, b) => a.lastUse - b.lastUse || a.id - b.id);
  const evictIds = [];
  let freed = 0;
  for (const e of byLru) {
    if (totalBytes - freed <= budgetBytes)
      break;
    evictIds.push(e.id);
    freed += e.bytes;
  }
  return { evictIds, freedBytes: freed, residentBytes: totalBytes - freed };
}
var init_residency = __esm(() => {
  init_resourceJournal();
});

// packages/core/src/caps.ts
function createCaps(query, statsProvider = null) {
  const snapshot = query;
  let statsRef = statsProvider;
  function formatKey(f, axis) {
    return `${f}|${axis}`;
  }
  return {
    has(f) {
      return snapshot.features.has(f);
    },
    format(f, axis) {
      return snapshot.formatMatrix.get(formatKey(f, axis)) ?? "none";
    },
    path(name) {
      return snapshot.paths.get(name) ?? "unknown";
    },
    ext(name) {
      return snapshot.extensions.get(name) ?? null;
    },
    stats() {
      if (!statsRef)
        return ZERO_STATS;
      return statsRef();
    },
    limit(name) {
      const v = snapshot.limits[name];
      return v === undefined ? null : v;
    },
    get backend() {
      return snapshot.backend;
    },
    invalidate() {
      statsRef = null;
    }
  };
}
function createStatsCollector(now = () => performance.now()) {
  let frameStart = 0;
  let cpuMs = 0;
  let drawCalls = 0;
  let memoryEstimate = 0;
  let frameCount = 0;
  let gpuTimer = null;
  let gpuMs = null;
  return {
    beginFrame() {
      frameStart = now();
      drawCalls = 0;
      cpuMs = 0;
      frameCount++;
      if (gpuTimer !== null) {
        const prev = gpuTimer.result();
        gpuMs = prev;
        gpuTimer.begin();
      }
    },
    endFrame() {
      cpuMs = now() - frameStart;
      if (gpuTimer !== null) {
        gpuTimer.end();
      }
    },
    addDrawCall() {
      drawCalls++;
    },
    addMemory(bytes) {
      memoryEstimate += bytes;
    },
    subMemory(bytes) {
      memoryEstimate = Math.max(0, memoryEstimate - bytes);
    },
    snapshot() {
      return {
        cpuMs,
        gpuMs: gpuTimer === null ? null : gpuMs,
        memoryEstimate,
        drawCalls,
        frameCount,
        hitRate: 1
      };
    },
    resetForFrame() {
      drawCalls = 0;
    },
    setGpuTimer(timer) {
      gpuTimer = timer;
      gpuMs = timer === null ? null : gpuMs;
    }
  };
}
var ZERO_STATS;
var init_caps = __esm(() => {
  ZERO_STATS = {
    cpuMs: 0,
    gpuMs: null,
    memoryEstimate: 0,
    drawCalls: 0,
    frameCount: 0,
    hitRate: 1
  };
});

// packages/core/src/gpgpu.ts
function createGpuScratch(floats) {
  if (!Number.isInteger(floats) || floats <= 0) {
    throw new Error(`rune/core: createGpuScratch — floats must be a positive integer (got ${floats})`);
  }
  const bytes = new ArrayBuffer(floats * 4);
  return { bytes, f32: new Float32Array(bytes), u32: new Uint32Array(bytes) };
}
function createResourceSet() {
  const disposers = [];
  let disposed = false;
  return {
    add(disposer) {
      if (!disposed)
        disposers.push(disposer);
    },
    dispose() {
      if (disposed)
        return;
      disposed = true;
      for (let i = disposers.length - 1;i >= 0; i--)
        disposers[i]();
      disposers.length = 0;
    }
  };
}
function createSsboTier(backend) {
  const resources = createResourceSet();
  return {
    kind: "ssbo",
    backend,
    createBuffer(byteLength, usage) {
      const id = backend.createExternalBuffer(byteLength, usage);
      resources.add(() => backend.deleteExternalBuffer(id));
      return id;
    },
    writeBuffer(bufferId, data, byteOffset, byteLength) {
      backend.writeExternalBuffer(bufferId, data, byteOffset, byteLength);
    },
    createKernel(wgsl, uniformBytes, bufferIds) {
      const id = backend.createCompute(wgsl, uniformBytes, bufferIds);
      resources.add(() => backend.deleteCompute(id));
      return id;
    },
    runKernel(computeId, entry, uniformData, workgroups) {
      backend.runCompute(computeId, entry, uniformData, workgroups);
    },
    scratch: createGpuScratch,
    dispose() {
      resources.dispose();
    }
  };
}
function createTfTier(backend) {
  const resources = createResourceSet();
  return {
    kind: "transform-feedback",
    backend,
    createBuffer(init) {
      const id = backend.createBuffer(init);
      resources.add(() => backend.deleteBuffer(id));
      return id;
    },
    updateBuffer(bufferId, data, byteOffset) {
      backend.updateBuffer(bufferId, data, byteOffset);
    },
    createTexture(width, height, options) {
      const id = backend.createTexture(width, height, options);
      resources.add(() => backend.deleteTexture(id));
      return id;
    },
    texSubImage2D(textureId, x, y, width, height, bytes) {
      backend.texSubImage2D(textureId, x, y, width, height, bytes);
    },
    texSubImage2DBuffer(textureId, x, y, width, height, bufferId, byteOffset) {
      backend.texSubImage2DBuffer(textureId, x, y, width, height, bufferId, byteOffset);
    },
    createPass(desc) {
      const id = backend.createTransformPass(desc);
      resources.add(() => backend.deleteTransformPass(id));
      return id;
    },
    runPass(passId, vertexCount, bindings) {
      backend.runTransformPass(passId, vertexCount, bindings);
    },
    scratch: createGpuScratch,
    dispose() {
      resources.dispose();
    }
  };
}
function createGpgpu(backend) {
  if (typeof backend.createCompute === "function") {
    return createSsboTier(backend);
  }
  if (typeof backend.createTransformPass === "function") {
    return createTfTier(backend);
  }
  throw new Error("rune/core: createGpgpu needs a WebGPU compute facade (createCompute) or a WebGL2 transform-feedback facade (createTransformPass)");
}
var GPU_BUFFER_USAGE;
var init_gpgpu = __esm(() => {
  GPU_BUFFER_USAGE = {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256
  };
});

// packages/core/src/noise.ts
function buildPerm() {
  const p = new Uint8Array(256);
  for (let i = 0;i < 256; i++)
    p[i] = i;
  let state = 2654435769;
  for (let i = 255;i > 0; i--) {
    state = Math.imul(state ^ state >>> 15, 2246822507) | 0;
    state = Math.imul(state ^ state >>> 13, 3266489909) | 0;
    const j = (state >>> 24) % (i + 1);
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const wrapped = new Uint8Array(512);
  for (let i = 0;i < 512; i++)
    wrapped[i] = p[i & 255];
  return wrapped;
}
function simplex3(x, y, z) {
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
  const t = (i + j + k) * G3;
  const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0) {
      i1 = 1;
      j1 = 0;
      k1 = 0;
      i2 = 1;
      j2 = 1;
      k2 = 0;
    } else if (x0 >= z0) {
      i1 = 1;
      j1 = 0;
      k1 = 0;
      i2 = 1;
      j2 = 0;
      k2 = 1;
    } else {
      i1 = 0;
      j1 = 0;
      k1 = 1;
      i2 = 1;
      j2 = 0;
      k2 = 1;
    }
  } else {
    if (y0 < z0) {
      i1 = 0;
      j1 = 0;
      k1 = 1;
      i2 = 0;
      j2 = 1;
      k2 = 1;
    } else if (x0 < z0) {
      i1 = 0;
      j1 = 1;
      k1 = 0;
      i2 = 0;
      j2 = 1;
      k2 = 1;
    } else {
      i1 = 0;
      j1 = 1;
      k1 = 0;
      i2 = 1;
      j2 = 1;
      k2 = 0;
    }
  }
  const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
  const ii = i & 255, jj = j & 255, kk = k & 255;
  let n = 0;
  let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0) {
    const g = PERM[ii + PERM[jj + PERM[kk]]] % 12 * 3;
    t0 *= t0;
    n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
  }
  let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0) {
    const g = PERM[ii + i1 + PERM[jj + j1 + PERM[kk + k1]]] % 12 * 3;
    t1 *= t1;
    n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
  }
  let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0) {
    const g = PERM[ii + i2 + PERM[jj + j2 + PERM[kk + k2]]] % 12 * 3;
    t2 *= t2;
    n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
  }
  let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0) {
    const g = PERM[ii + 1 + PERM[jj + 1 + PERM[kk + 1]]] % 12 * 3;
    t3 *= t3;
    n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
  }
  return 32 * n;
}
var F3, G3, PERM, GRAD3;
var init_noise = __esm(() => {
  F3 = 1 / 3;
  G3 = 1 / 6;
  PERM = buildPerm();
  GRAD3 = new Int8Array([
    1,
    1,
    0,
    -1,
    1,
    0,
    1,
    -1,
    0,
    -1,
    -1,
    0,
    1,
    0,
    1,
    -1,
    0,
    1,
    1,
    0,
    -1,
    -1,
    0,
    -1,
    0,
    1,
    1,
    0,
    -1,
    1,
    0,
    1,
    -1,
    0,
    -1,
    -1
  ]);
});

// packages/core/src/random.ts
function hash01(seed, index, salt) {
  let h = Math.imul(seed | 0, 374761393) + Math.imul(index | 0, 668265263) + Math.imul(salt | 0, 2246822519) | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// packages/core/src/index.ts
var exports_src = {};
__export(exports_src, {
  writerView: () => writerView,
  toFloat32Array: () => toFloat32Array,
  tileForBudget: () => tileForBudget,
  tileBytes: () => tileBytes,
  textureFormatInfo: () => textureFormatInfo,
  textureFormatBytesPerPixel: () => textureFormatBytesPerPixel,
  streamTexture: () => streamTexture,
  simplex3: () => simplex3,
  signal: () => signal,
  serializeTape: () => serializeTape,
  selectResidentOps: () => selectResidentOps,
  selectLRUEvictions: () => selectLRUEvictions,
  schemaHash: () => schemaHash,
  schedule: () => schedule,
  reflectWgsl: () => reflectWgsl,
  reflectGlsl: () => reflectGlsl,
  parseTape: () => parseTape,
  normalizeTextureFormat: () => normalizeTextureFormat,
  nameHash: () => nameHash,
  hash01: () => hash01,
  hasSharedArrayBuffer: () => hasSharedArrayBuffer,
  feedStride: () => feedStride,
  feedFieldSize: () => feedFieldSize,
  estimateTextureBytes: () => estimateTextureBytes,
  effect: () => effect,
  detectTransport: () => detectTransport,
  derive: () => derive,
  decideRecovery: () => decideRecovery,
  createUploadScheduler: () => createUploadScheduler,
  createUploadQueue: () => createUploadQueue,
  createUniformSet: () => createUniformSet,
  createUniformArena: () => createUniformArena,
  createTransportHost: () => createTransportHost,
  createTransport: () => createTransport,
  createTransientPool: () => createTransientPool,
  createTfTier: () => createTfTier,
  createTapeWriter: () => createTapeWriter,
  createStatsCollector: () => createStatsCollector,
  createSsboTier: () => createSsboTier,
  createSharedRegistry: () => createSharedRegistry,
  createSegmentStore: () => createSegmentStore,
  createResourceJournal: () => createResourceJournal,
  createMsgFeedWriter: () => createMsgFeedWriter,
  createMsgFeedReader: () => createMsgFeedReader,
  createLossBudget: () => createLossBudget,
  createLiveCommand: () => createLiveCommand,
  createLayoutGuard: () => createLayoutGuard,
  createJournal: () => createJournal,
  createGpuScratch: () => createGpuScratch,
  createGpgpu: () => createGpgpu,
  createFrequencyArena: () => createFrequencyArena,
  createFeed: () => createFeed,
  createEpoch: () => createEpoch,
  createCaps: () => createCaps,
  countTiles: () => countTiles,
  classifyGpuError: () => classifyGpuError,
  classifyDeviceLost: () => classifyDeviceLost,
  chunkRect: () => chunkRect,
  buildFrameReRecording: () => buildFrameReRecording,
  buildFrame: () => buildFrame,
  batch: () => batch,
  attachTransport: () => attachTransport,
  attachSharedRegistry: () => attachSharedRegistry,
  attachFeed: () => attachFeed,
  TEXTURE_FORMATS: () => TEXTURE_FORMATS,
  SHARED_MAGIC: () => SHARED_MAGIC,
  PERM: () => PERM,
  OpCode: () => OpCode,
  LOSS_STORM_WINDOW_MS: () => LOSS_STORM_WINDOW_MS,
  LOSS_STORM_MAX: () => LOSS_STORM_MAX,
  GRAD3: () => GRAD3,
  GPU_BUFFER_USAGE: () => GPU_BUFFER_USAGE
});
var init_src = __esm(() => {
  init_signal();
  init_derive();
  init_batch();
  init_effect();
  init_epoch();
  init_transientPool();
  init_opcodes();
  init_liveCommand();
  init_arena();
  init_frequencyArena();
  init_textureUpload();
  init_sharedRegistry();
  init_transport();
  init_glslReflect();
  init_wgslReflect();
  init_resourceJournal();
  init_residency();
  init_caps();
  init_formats();
  init_gpgpu();
  init_noise();
});

// packages/gl/src/autoBackend.ts
function shaderCoverage(spec) {
  const glsl = spec.shader.glsl;
  const wgsl = spec.shader.wgsl;
  return {
    id: spec.id,
    hasGlsl: !!glsl && !!glsl.vertex && !!glsl.fragment,
    hasWgsl: !!wgsl
  };
}
function coversBackend(backend, coverage) {
  if (backend === "webgpu")
    return coverage.every((c) => c.hasWgsl);
  return coverage.every((c) => c.hasGlsl);
}
function missingSpecs(backend, coverage) {
  const field = backend === "webgpu" ? "hasWgsl" : "hasGlsl";
  const want = backend === "webgpu" ? "WGSL" : "GLSL";
  return coverage.filter((c) => !c[field]).map((c) => `"${c.id ?? "<no id>"}" (no ${want})`);
}
function resolveBackend(input) {
  const order = input.order ?? ["webgpu", "webgl2"];
  const specs = input.specs ?? [];
  const coverage = specs.map(shaderCoverage);
  const hardware = input.hardware;
  const invalid = coverage.filter((c) => !c.hasGlsl && !c.hasWgsl);
  if (invalid.length > 0) {
    const names = invalid.map((c) => `"${c.id ?? "<no id>"}"`).join(", ");
    return decision(null, order, coverage, hardware, {
      webgpu: { available: hardware.webgpu, covers: false, rejected: `invalid spec: ${names}` },
      webgl2: { available: hardware.webgl2, covers: false, rejected: `invalid spec: ${names}` }
    }, `Invalid spec (neither GLSL nor WGSL): ${names}. Add at least one shader variant.`);
  }
  const verdicts = {
    webgpu: verdictFor("webgpu", hardware.webgpu, coversBackend("webgpu", coverage), coverage),
    webgl2: verdictFor("webgl2", hardware.webgl2, coversBackend("webgl2", coverage), coverage)
  };
  const candidates = order.filter((b) => verdicts[b].available && verdicts[b].covers);
  const chosen = candidates.length > 0 ? candidates[0] : null;
  return decision(chosen, order, coverage, hardware, verdicts, messageFor(chosen, order, verdicts, coverage));
}
function verdictFor(backend, available, covers, coverage) {
  if (!available && !covers) {
    return { available: false, covers, rejected: `no adapter and coverage failed: ${missingSpecs(backend, coverage).join(", ")}` };
  }
  if (!available) {
    return { available: false, covers, rejected: "no adapter" };
  }
  if (!covers) {
    return { available, covers: false, rejected: `spec has no variant for ${backend === "webgpu" ? "WGSL" : "GLSL"}: ${missingSpecs(backend, coverage).join(", ")}` };
  }
  return { available: true, covers: true };
}
function decision(chosen, order, coverage, hardware, verdicts, message) {
  return { chosen, message, verdicts, coverage, order };
}
function label(b) {
  return b === "webgpu" ? "WebGPU" : "WebGL2";
}
function messageFor(chosen, order, verdicts, coverage) {
  if (order.length === 1) {
    const only = order[0];
    if (chosen === null) {
      const v = verdicts[only];
      if (!v.available) {
        return `Forced ${label(only)} unavailable: ${v.rejected}. Soften order=${JSON.stringify(["webgpu", "webgl2"])} to allow fallback.`;
      }
      return `Forced ${label(only)} does not cover the specs: ${v.rejected}. Add ${only === "webgpu" ? "WGSL" : "GLSL"} to the specs.`;
    }
    return `Forced choice (order=${JSON.stringify(order)})`;
  }
  if (chosen !== null) {
    const forcedBy = coverage.filter((c) => chosen === "webgpu" ? !c.hasGlsl : !c.hasWgsl);
    if (forcedBy.length > 0) {
      const names = forcedBy.map((c) => `"${c.id ?? "<no id>"}"`).join(", ");
      const other = order.filter((b) => b !== chosen)[0];
      const otherRejected = verdicts[other]?.rejected ?? "none";
      const missingVariant = chosen === "webgpu" ? "GLSL" : "WGSL";
      return `Chosen ${label(chosen)} — available; specs without ${missingVariant}: ${names} — fallback candidate ${label(other)} rejected (${otherRejected})`;
    }
    return `Chosen ${label(chosen)} — available and covers all specs`;
  }
  const rejections = order.map((b) => `${label(b)}: ${verdicts[b].rejected ?? "unknown"}`).join("; ");
  return `Conflict — no backend from order=${JSON.stringify(order)} passed. Verdicts: ${rejections}`;
}

// packages/gl/src/webgl2Renderer.ts
init_src();
init_src();

// packages/webgl2/src/glslReflect.ts
var SIZE = {
  mat4: 16,
  vec4: 4,
  vec3: 3,
  vec2: 2,
  float: 1,
  int: 1,
  sampler2D: 1
};
function reflectGlsl2(vertex, fragment) {
  return {
    uniforms: [...scanUniforms(vertex), ...scanUniforms(fragment)],
    attributes: [...scanAttributes(vertex)].sort(byLocation),
    samplers: [...scanUniforms(vertex), ...scanUniforms(fragment)].filter((u) => u.type === "sampler2D").map((u) => u.name)
  };
}
function scanUniforms(source) {
  const found = [];
  const re = /uniform\s+(mat4|vec4|vec3|vec2|float|int|sampler2D)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;
  for (const match of source.matchAll(re)) {
    const type = match[1];
    const count = match[3] !== undefined ? Number(match[3]) : 1;
    found.push({ name: match[2], type, size: SIZE[type] * count });
  }
  return found;
}
function scanAttributes(source) {
  const found = [];
  const re = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*in\s+(vec4|vec3|vec2|float)\s+(\w+)\s*;/g;
  for (const match of source.matchAll(re)) {
    found.push({ name: match[3], location: Number(match[1]), size: vecSize(match[2]) });
  }
  return found;
}
function vecSize(type) {
  if (type === "vec4")
    return 4;
  if (type === "vec3")
    return 3;
  if (type === "vec2")
    return 2;
  return 1;
}
function byLocation(a, b) {
  return a.location - b.location;
}
// packages/webgl2/src/command.ts
init_src();
function createCompileContext(arena, mode = "codegen") {
  return { arena, commands: [], mode, programs: new Map };
}
function compileDrawSpec(spec, ctx) {
  const reflection = reflectCached(spec, ctx);
  const fields = reflection.uniforms.filter((u) => u.type !== "sampler2D").map(toField);
  const samplers = bindSamplers(reflection, spec);
  const state = readState(spec);
  const attributes = reflection.attributes.map((attr) => ({
    location: attr.location,
    size: spec.attributes?.[attr.name]?.size ?? attr.size,
    data: spec.attributes?.[attr.name]?.data ?? empty(attr.size),
    stride: spec.attributes?.[attr.name]?.stride,
    offset: spec.attributes?.[attr.name]?.offset,
    bufferId: spec.attributes?.[attr.name]?.bufferId,
    instance: spec.attributes?.[attr.name]?.instance ?? spec.attributes?.[attr.name]?.step === "instance"
  }));
  const id = ctx.commands.length;
  const bindings = fields.map((field) => ({
    name: field.name,
    type: field.type,
    slot: { offset: field.slot.base * 4, size: field.slot.size * 4 }
  }));
  function toField(info) {
    return { name: info.name, type: info.type, slot: ctx.arena.alloc(info.size) };
  }
  function record(props, frameCtx, writer) {
    command.lastProps = props;
    for (const field of fields) {
      const value = resolve(spec.uniforms?.[field.name], props, frameCtx);
      if (value !== undefined)
        ctx.arena.write(field.slot, value);
    }
    const count = resolveNumber(spec.count, props, frameCtx);
    const instances = spec.instances === undefined ? 1 : resolveNumber(spec.instances, props, frameCtx);
    writer.emit(OpCode.Draw, id, 0, count, instances);
  }
  const command = {
    id,
    record,
    lastProps: undefined,
    bindings
  };
  const rich = command;
  rich.state = state;
  rich.fields = fields;
  rich.samplers = samplers;
  rich.attributes = attributes;
  rich.glsl = spec.shader.glsl;
  ctx.commands.push(command);
  return command;
}
function bindSamplers(reflection, spec) {
  const bound = [];
  let unit = 0;
  for (const name of reflection.samplers) {
    const handle = spec.textures?.[name];
    if (handle === undefined)
      continue;
    bound.push({ name, unit: unit++, textureId: handle.textureId });
  }
  return bound;
}
function readState(spec) {
  const depth2 = spec.pipeline?.depth;
  const raster = spec.pipeline?.raster;
  const blend = spec.pipeline?.blend;
  const depthOff = depth2 === false;
  return {
    depthTest: depthOff ? "always" : depth2?.test ?? "less",
    depthWrite: depthOff ? false : depth2?.write ?? true,
    cull: raster?.cull ?? "back",
    blend: blend === undefined || blend === false ? null : { src: blend.src, dst: blend.dst, equation: blend.equation ?? "add" }
  };
}
function resolve(declared, props, frameCtx) {
  if (declared === undefined)
    return;
  if (typeof declared === "function")
    return declared(props, frameCtx);
  if (typeof declared === "object" && declared !== null && "peek" in declared) {
    return declared.peek();
  }
  return declared;
}
function resolveNumber(declared, props, frameCtx) {
  const value = resolve(declared, props, frameCtx);
  return typeof value === "number" ? value : 0;
}
function reflectCached(spec, ctx) {
  const key = `${spec.shader.glsl.vertex}\x00${spec.shader.glsl.fragment}`;
  const known = ctx.programs.get(key);
  if (known !== undefined)
    return known;
  const reflection = reflectGlsl2(spec.shader.glsl.vertex, spec.shader.glsl.fragment);
  ctx.programs.set(key, reflection);
  return reflection;
}
function empty(size) {
  return new Float32Array(size);
}
// packages/webgl2/src/executor.ts
var DEFAULT_CLEAR = { color: [0.07, 0.08, 0.11, 1], depth: 1 };
function createExecutor(options) {
  const gl = options.gl;
  const arena = options.arena;
  const commands = options.commands;
  const clears = options.clears;
  let lastProgram = -1;
  let lastDepthTest = "";
  let lastCull = "";
  let lastBlend = "";
  function run(view) {
    for (let at = 0;at < view.count; at++) {
      const op = view.op[at];
      if (op === 1)
        beginPass();
      else if (op === 2)
        drawCommand(commands[view.a[at]], view.c[at], view.d[at]);
      else if (op === 4)
        gl.bindTarget(view.a[at], view.b[at] === 1);
    }
  }
  function beginPass() {
    gl.bindTarget(0, false);
    const clear = clears[0] ?? DEFAULT_CLEAR;
    gl.clear(clear.color, clear.depth);
    lastProgram = -1;
    lastDepthTest = "";
    lastCull = "";
    lastBlend = "";
  }
  function drawCommand(command, count, instances) {
    if (command === undefined)
      return;
    const rich = command;
    ensureProgram(rich);
    if (rich.programId !== lastProgram) {
      gl.useProgram(rich.programId);
      lastProgram = rich.programId;
    }
    applyState(rich);
    uploadUniforms(rich);
    for (const sampler of rich.samplers) {
      gl.bindTexture(sampler.textureId, sampler.unit);
      gl.setUniform1i(rich.programId, sampler.name, sampler.unit);
    }
    for (const attribute of rich.attributes) {
      const divisor = attribute.instance === true ? 1 : 0;
      if (attribute.bufferId !== undefined) {
        gl.bindVertexBuffer(attribute.bufferId, attribute.location, attribute.size, attribute.stride, attribute.offset, divisor);
      } else {
        gl.bindVertexBuffer(rich.bufferIds[attribute.location], attribute.location, attribute.size, undefined, undefined, divisor);
      }
    }
    gl.drawArrays("triangles", 0, count, instances);
  }
  function ensureProgram(command) {
    const rich = command;
    if (rich.programId === undefined) {
      rich.programId = gl.createProgram(rich.glsl.vertex, rich.glsl.fragment);
      rich.bufferIds = rich.attributes.map((attribute) => attribute.bufferId !== undefined ? -1 : gl.createBuffer(attribute.data));
    }
  }
  function applyState(command) {
    const state = command.state;
    const depthKey = `${state.depthTest}/${state.depthWrite}`;
    if (depthKey !== lastDepthTest) {
      gl.setDepthMode(state.depthTest, state.depthWrite);
      lastDepthTest = depthKey;
    }
    if (state.cull !== lastCull) {
      gl.setCull(state.cull);
      lastCull = state.cull;
    }
    const blendKey = state.blend === null ? "off" : `${state.blend.src}/${state.blend.dst}/${state.blend.equation}`;
    if (blendKey !== lastBlend) {
      gl.setBlend(state.blend === null ? null : state.blend.src, state.blend === null ? null : state.blend.dst, state.blend === null ? undefined : state.blend.equation);
      lastBlend = blendKey;
    }
  }
  function uploadUniforms(command) {
    const rich = command;
    for (const field of rich.fields) {
      if (!field.slot.dirty)
        continue;
      const view16 = arena.buffer.subarray(field.slot.base, field.slot.base + field.slot.size);
      setByType(rich.programId, field.name, field.type, view16);
      field.slot.dirty = false;
    }
  }
  function setByType(programId, name, type, values) {
    if (type === "mat4")
      gl.setUniformMatrix4(programId, name, values);
    else if (type === "vec4")
      gl.setUniform4fv(programId, name, values);
    else if (type === "vec3")
      gl.setUniform3fv(programId, name, values);
    else if (type === "vec2")
      gl.setUniform2fv(programId, name, values);
    else
      gl.setUniform1f(programId, name, values[0]);
  }
  return { run };
}
// packages/webgl2/src/realGL.ts
var ENUM = {
  RGBA8: 32856,
  RGBA16F: 34842,
  RGBA32F: 34836,
  RGBA: 6408,
  UNSIGNED_BYTE: 5121,
  HALF_FLOAT: 5131,
  FLOAT: 5126,
  NEAREST: 9728,
  LINEAR: 9729,
  NEAREST_MIPMAP_NEAREST: 9984,
  LINEAR_MIPMAP_LINEAR: 9987
};
function formatInfo(format) {
  switch (format) {
    case "rgba16f":
      return { internalFormat: ENUM.RGBA16F, uploadFormat: ENUM.RGBA, uploadType: ENUM.HALF_FLOAT };
    case "rgba32f":
      return { internalFormat: ENUM.RGBA32F, uploadFormat: ENUM.RGBA, uploadType: ENUM.FLOAT };
    default:
      return { internalFormat: ENUM.RGBA8, uploadFormat: ENUM.RGBA, uploadType: ENUM.UNSIGNED_BYTE };
  }
}
function createRealGL(gl, onViewportHeal) {
  const programs = new Map;
  const buffers = new Map;
  const textures = new Map;
  const targets = new Map;
  const textureMeta = new Map;
  const textureViews = new Map;
  let nextTextureViewId = 1e6;
  let anisoExt = null;
  try {
    anisoExt = gl.getExtension?.("EXT_texture_filter_anisotropic") ?? null;
  } catch {
    anisoExt = null;
  }
  let anisoMax = 1;
  if (anisoExt !== null) {
    try {
      anisoMax = gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
    } catch {
      anisoMax = 1;
    }
  }
  let nextProgram = 1;
  let nextBuffer = 1;
  let nextTexture = 1;
  let nextTarget = 1;
  let currentProgram = null;
  let currentProgramId = -1;
  let currentTarget = 0;
  let canvasWidth = 1;
  let canvasHeight = 1;
  const unitTextures = new Map;
  let floatLinearExt = false;
  try {
    floatLinearExt = gl.getExtension?.("OES_texture_float_linear") != null;
  } catch {
    floatLinearExt = false;
  }
  function magFilter(format) {
    return format === "rgba32f" && !floatLinearExt ? ENUM.NEAREST : ENUM.LINEAR;
  }
  function minFilter(format, mipLevels) {
    const linear = !(format === "rgba32f" && !floatLinearExt);
    if (mipLevels > 1)
      return linear ? ENUM.LINEAR_MIPMAP_LINEAR : ENUM.NEAREST_MIPMAP_NEAREST;
    return linear ? ENUM.LINEAR : ENUM.NEAREST;
  }
  function uploadPair(textureId, explicit) {
    const meta = textureMeta.get(textureId);
    const fi = meta !== undefined ? formatInfo(meta.format) : formatInfo("rgba8");
    return {
      format: explicit?.format ?? fi.uploadFormat,
      type: explicit?.type ?? fi.uploadType
    };
  }
  function createProgram(vertex, fragment) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`rune: program linking: ${gl.getProgramInfoLog(program)}`);
    }
    const id = nextProgram++;
    programs.set(id, { program, uniforms: new Map });
    return id;
  }
  function compile(type, source) {
    const shader = gl.createShader(type);
    if (shader === null)
      throw new Error("rune: createShader returned null");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`rune: shader compilation: ${log}`);
    }
    return shader;
  }
  function useProgram(programId) {
    if (programId === currentProgramId)
      return;
    const record = programs.get(programId);
    if (record === undefined || record.program === currentProgram)
      return;
    currentProgram = record.program;
    currentProgramId = programId;
    gl.useProgram(record.program);
  }
  function location(programId, name) {
    const record = programs.get(programId);
    if (record === undefined)
      return null;
    const cached = record.uniforms.get(name);
    if (cached !== undefined)
      return cached;
    let loc = gl.getUniformLocation(record.program, name);
    if (loc === null && !name.includes("[")) {
      loc = gl.getUniformLocation(record.program, `${name}[0]`);
    }
    record.uniforms.set(name, loc);
    return loc;
  }
  function createBuffer(data) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const id = nextBuffer++;
    buffers.set(id, buffer);
    return id;
  }
  function bindVertexBuffer(bufferId, location2, size, stride, byteOffset, divisor) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.get(bufferId) ?? null);
    gl.enableVertexAttribArray(location2);
    gl.vertexAttribPointer(location2, size, gl.FLOAT, false, stride ?? 0, byteOffset ?? 0);
    gl.vertexAttribDivisor(location2, divisor ?? 0);
  }
  function updateBuffer(bufferId, data, byteOffset = 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.get(bufferId) ?? null);
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, data);
  }
  function setUniformMatrix4(programId, name, values) {
    useProgram(programId);
    const loc = location(programId, name);
    if (loc !== null)
      gl.uniformMatrix4fv(loc, false, values);
  }
  function setUniform4fv(programId, name, values) {
    useProgram(programId);
    const loc = location(programId, name);
    if (loc !== null)
      gl.uniform4fv(loc, values);
  }
  function setUniform3fv(programId, name, values) {
    useProgram(programId);
    const loc = location(programId, name);
    if (loc !== null)
      gl.uniform3fv(loc, values);
  }
  function setUniform2fv(programId, name, values) {
    useProgram(programId);
    const loc = location(programId, name);
    if (loc !== null)
      gl.uniform2fv(loc, values);
  }
  function setUniform1f(programId, name, value) {
    useProgram(programId);
    const loc = location(programId, name);
    if (loc !== null)
      gl.uniform1f(loc, value);
  }
  function setUniform1i(programId, name, value) {
    useProgram(programId);
    const loc = location(programId, name);
    if (loc !== null)
      gl.uniform1i(loc, value);
  }
  function createTexture(width, height, options) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const mipLevels = options?.mipLevels ?? 1;
    const format = options?.format ?? "rgba8";
    const fi = formatInfo(format);
    if (mipLevels > 1) {
      gl.texStorage2D(gl.TEXTURE_2D, mipLevels, fi.internalFormat, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter(format, mipLevels));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter(format));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, fi.internalFormat, width, height, 0, fi.uploadFormat, fi.uploadType, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter(format, mipLevels));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, magFilter(format));
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let appliedAniso = 1;
    if (mipLevels > 1 && anisoExt !== null) {
      const requested = options?.maxAnisotropy ?? anisoMax;
      const clamped = Math.max(1, Math.min(requested, anisoMax));
      gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, clamped);
      appliedAniso = clamped;
    }
    const id = nextTexture++;
    textures.set(id, texture);
    textureMeta.set(id, { mipLevels, maxLoadedLevel: 0, maxAnisotropy: appliedAniso, format });
    return id;
  }
  function texSubImage2D(textureId, x, y, width, height, bytes) {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const pair = uploadPair(textureId);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, pair.format, pair.type, bytes);
  }
  function texImage2DFromSource(textureId, source, options) {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null);
    const flipY = options?.flipY ?? false;
    if (flipY)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const meta = textureMeta.get(textureId);
    const pair = uploadPair(textureId);
    if (meta !== undefined && meta.mipLevels > 1) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pair.format, pair.type, source);
    } else {
      const internalFormat = meta !== undefined ? formatInfo(meta.format).internalFormat : ENUM.RGBA8;
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, pair.format, pair.type, source);
    }
    if (flipY)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  function texSubImage2DFromSource(textureId, x, y, source, options) {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null);
    const flipY = options?.flipY ?? false;
    if (flipY)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    const pair = uploadPair(textureId);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, pair.format, pair.type, source);
    if (flipY)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }
  function texImage2DLevel(textureId, level, source, options) {
    gl.bindTexture(gl.TEXTURE_2D, textures.get(textureId) ?? null);
    const flipY = options?.flipY ?? false;
    const meta = textureMeta.get(textureId);
    const fi = meta !== undefined ? formatInfo(meta.format) : formatInfo("rgba8");
    const internalFormat = options?.internalFormat ?? fi.internalFormat;
    const pair = uploadPair(textureId, options);
    const format = pair.format;
    const type = pair.type;
    if (flipY)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (meta !== undefined && meta.mipLevels > 1) {
      gl.texSubImage2D(gl.TEXTURE_2D, level, 0, 0, format, type, source);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, format, type, source);
    }
    if (flipY)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (meta !== undefined && meta.mipLevels > 1 && level > meta.maxLoadedLevel) {
      meta.maxLoadedLevel = level;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level);
    }
  }
  function bindTexture(textureOrViewId, unit) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    const subView = textureViews.get(textureOrViewId);
    let underlyingTextureId;
    let baseLevel;
    let maxLevel;
    if (subView !== undefined) {
      underlyingTextureId = subView.textureId;
      baseLevel = subView.baseMipLevel;
      maxLevel = subView.maxMipLevel;
    } else {
      underlyingTextureId = textureOrViewId;
      const meta = textureMeta.get(underlyingTextureId);
      baseLevel = 0;
      maxLevel = meta !== undefined ? meta.maxLoadedLevel : 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, textures.get(underlyingTextureId) ?? null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, baseLevel);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, maxLevel);
    unitTextures.set(unit, underlyingTextureId);
  }
  function createTextureView(textureId, options) {
    const meta = textureMeta.get(textureId);
    if (meta === undefined) {
      throw new Error(`rune: createTextureView — texture ${textureId} not found`);
    }
    const mipLevels = meta.mipLevels;
    if (mipLevels < 2) {
      throw new Error(`rune: createTextureView — texture ${textureId} has mipLevels=${mipLevels} ` + "(no mip-chain). A sub-mip view only makes sense with mipLevels ≥ 2.");
    }
    const baseMipLevel = options?.baseMipLevel ?? 0;
    if (baseMipLevel < 0 || baseMipLevel >= mipLevels) {
      throw new Error(`rune: createTextureView — baseMipLevel=${baseMipLevel} out of range [0, ${mipLevels - 1}] ` + `(textureId=${textureId}, mipLevels=${mipLevels})`);
    }
    const mipLevelCount = options?.mipLevelCount ?? mipLevels - baseMipLevel;
    if (mipLevelCount < 1 || baseMipLevel + mipLevelCount > mipLevels) {
      throw new Error(`rune: createTextureView — baseMipLevel=${baseMipLevel} + mipLevelCount=${mipLevelCount} ` + `exceeds mipLevels=${mipLevels} (textureId=${textureId})`);
    }
    const viewId = nextTextureViewId++;
    textureViews.set(viewId, {
      textureId,
      baseMipLevel,
      maxMipLevel: baseMipLevel + mipLevelCount - 1
    });
    return viewId;
  }
  function deleteTextureView(viewId) {
    textureViews.delete(viewId);
  }
  function setViewport(width, height) {
    canvasWidth = width;
    canvasHeight = height;
    gl.viewport(0, 0, width, height);
  }
  function createTarget(textureId, width, height, depth2, color) {
    const fbo = gl.createFramebuffer();
    if (fbo === null)
      throw new Error("rune: createFramebuffer returned null");
    let depthRenderbuffer = null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textures.get(textureId) ?? null, 0);
    if (depth2) {
      depthRenderbuffer = gl.createRenderbuffer();
      if (depthRenderbuffer === null)
        throw new Error("rune: createRenderbuffer returned null");
      gl.bindRenderbuffer(gl.RENDERBUFFER, depthRenderbuffer);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRenderbuffer);
    }
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, currentTarget === 0 ? null : targets.get(currentTarget)?.fbo ?? null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      if (depthRenderbuffer !== null)
        gl.deleteRenderbuffer(depthRenderbuffer);
      gl.deleteFramebuffer(fbo);
      throw new Error(`rune: surface FBO incomplete (status ${status}) — size ${width}x${height}`);
    }
    const id = nextTarget++;
    targets.set(id, {
      fbo,
      textureId,
      width,
      height,
      depth: depth2,
      depthRenderbuffer,
      color
    });
    return id;
  }
  function bindTarget(targetId, clear2) {
    if (targetId === 0) {
      currentTarget = 0;
      const bufferW = gl.drawingBufferWidth;
      const bufferH = gl.drawingBufferHeight;
      if (bufferW > 0 && bufferH > 0 && (bufferW !== canvasWidth || bufferH !== canvasHeight)) {
        onViewportHeal?.(`viewport heal: the drawing buffer is ${bufferW}x${bufferH} but the renderer tracked ${canvasWidth}x${canvasHeight} — adopted the real size (an external canvas resize?)`);
        canvasWidth = bufferW;
        canvasHeight = bufferH;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvasWidth, canvasHeight);
      return;
    }
    if (targetId === currentTarget && !clear2)
      return;
    currentTarget = targetId;
    const target = targets.get(targetId);
    if (target === undefined)
      return;
    for (const [unit, boundId] of unitTextures) {
      if (boundId === target.textureId) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, null);
        unitTextures.delete(unit);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    if (clear2) {
      gl.clearColor(target.color[0], target.color[1], target.color[2], target.color[3]);
      if (target.depth) {
        gl.depthMask(true);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      } else {
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
  }
  function setDepthMode(test, write) {
    if (test === "always")
      gl.disable(gl.DEPTH_TEST);
    else {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(test === "lequal" ? gl.LEQUAL : gl.LESS);
    }
    gl.depthMask(write);
  }
  function readTargetPixels(targetId) {
    if (targetId === 0) {
      throw new Error("rune: readTargetPixels(0) — the canvas cannot be read (parity with WebGPU: the presented texture lives for one frame). Read the SURFACE instead: renderer.surface(...) → capture/passes → surface.read()");
    }
    const target = targets.get(targetId);
    if (target === undefined) {
      throw new Error(`rune: readTargetPixels — target ${targetId} not found (deleted or never created)`);
    }
    const w = target.width;
    const h = target.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const rowBytes = w * 4;
    const bottomUp = new Uint8Array(rowBytes * h);
    try {
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, currentTarget === 0 ? null : targets.get(currentTarget)?.fbo ?? null);
    }
    const out = new Uint8Array(rowBytes * h);
    for (let y = 0;y < h; y++) {
      out.set(bottomUp.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes);
    }
    return out;
  }
  function setCull(mode) {
    if (mode === "none")
      gl.disable(gl.CULL_FACE);
    else {
      gl.enable(gl.CULL_FACE);
      gl.cullFace(mode === "front" ? gl.FRONT : gl.BACK);
    }
  }
  const BLEND_FACTORS = {
    zero: 0,
    one: 1,
    "src-color": 768,
    "one-minus-src-color": 769,
    "src-alpha": 770,
    "one-minus-src-alpha": 771,
    "dst-alpha": 772,
    "one-minus-dst-alpha": 773,
    "dst-color": 774,
    "one-minus-dst-color": 775,
    "src-alpha-saturated": 776
  };
  const BLEND_EQUATIONS = {
    add: 32774,
    subtract: 32778,
    "reverse-subtract": 32779,
    min: 32775,
    max: 32776
  };
  function setBlend(src, dst, equation) {
    if (src === null || dst === null) {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(BLEND_EQUATIONS[equation ?? "add"] ?? gl.FUNC_ADD);
    gl.blendFunc(BLEND_FACTORS[src] ?? gl.ONE, BLEND_FACTORS[dst] ?? gl.ZERO);
  }
  function clear(color, depth2) {
    gl.clearColor(color[0], color[1], color[2], color[3]);
    if (depth2 !== null) {
      gl.depthMask(true);
      gl.clearDepth(depth2);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }
  function drawArrays(mode, first, count, instances) {
    if (instances > 1)
      gl.drawArraysInstanced(mode === "triangles" ? gl.TRIANGLES : gl.TRIANGLES, first, count, instances);
    else
      gl.drawArrays(gl.TRIANGLES, first, count);
  }
  function deleteTexture(textureId) {
    const texture = textures.get(textureId);
    if (texture === undefined)
      return;
    for (const [unit, boundId] of unitTextures) {
      if (boundId === textureId) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, null);
        unitTextures.delete(unit);
      }
    }
    gl.deleteTexture(texture);
    textures.delete(textureId);
    textureMeta.delete(textureId);
    for (const [viewId, sv] of textureViews) {
      if (sv.textureId === textureId) {
        textureViews.delete(viewId);
      }
    }
  }
  function deleteTarget(targetId) {
    const target = targets.get(targetId);
    if (target === undefined)
      return;
    if (currentTarget === targetId) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      currentTarget = 0;
    }
    if (target.depthRenderbuffer !== null)
      gl.deleteRenderbuffer(target.depthRenderbuffer);
    gl.deleteFramebuffer(target.fbo);
    targets.delete(targetId);
  }
  function deleteProgram(programId) {
    const record = programs.get(programId);
    if (record === undefined)
      return;
    if (currentProgram === record.program) {
      gl.useProgram(null);
      currentProgram = null;
      currentProgramId = -1;
    }
    gl.deleteProgram(record.program);
    programs.delete(programId);
  }
  function deleteBuffer(bufferId) {
    const buffer = buffers.get(bufferId);
    if (buffer === undefined)
      return;
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.deleteBuffer(buffer);
    buffers.delete(bufferId);
  }
  const transformPasses = new Map;
  let nextTransformPass = 1;
  const transformProgramIds = new Set;
  function createTransformPass(desc) {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, desc.vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
precision lowp float;
void main() {}
`));
    gl.transformFeedbackVaryings(program, desc.outputs, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`rune: transform pass linking: ${gl.getProgramInfoLog(program)}`);
    }
    const tf = gl.createTransformFeedback();
    const vao = gl.createVertexArray();
    const attribDecl = desc.attributes ?? [];
    const attribLocations = attribDecl.map((a) => gl.getAttribLocation(program, a.name));
    const id = nextTransformPass++;
    transformPasses.set(id, {
      program,
      tf,
      vao,
      uniforms: new Map,
      attribLocations,
      attribDecl,
      uniformDecl: desc.uniforms ?? [],
      textureDecl: desc.textures ?? []
    });
    const programId = nextProgram++;
    programs.set(programId, { program, uniforms: transformPasses.get(id).uniforms });
    transformProgramIds.add(programId);
    transformPassIds.set(id, programId);
    return id;
  }
  const transformPassIds = new Map;
  function tfLocation(record, name) {
    const cached = record.uniforms.get(name);
    if (cached !== undefined)
      return cached;
    const loc = gl.getUniformLocation(record.program, name);
    record.uniforms.set(name, loc);
    return loc;
  }
  function runTransformPass(passId, vertexCount, output) {
    const record = transformPasses.get(passId);
    if (record === undefined) {
      throw new Error(`rune: runTransformPass(${passId}) — no such transform pass`);
    }
    if (vertexCount <= 0)
      return;
    const outBuffer = buffers.get(output.bufferId);
    if (outBuffer === undefined) {
      throw new Error(`rune: runTransformPass(${passId}, out ${output.bufferId}) — no such output buffer`);
    }
    const programId = transformPassIds.get(passId);
    if (programId !== undefined)
      useProgram(programId);
    else
      gl.useProgram(record.program);
    gl.bindVertexArray(record.vao);
    const ab = output.attribBuffers;
    if (ab !== undefined) {
      for (let i = 0;i < record.attribLocations.length && i < ab.length; i++) {
        const bufferId = ab[i];
        if (bufferId === undefined)
          continue;
        const a = record.attribDecl[i];
        bindVertexBuffer(bufferId, record.attribLocations[i], a.size, a.stride, a.offset, a.divisor);
      }
    }
    const tex = output.textures;
    if (tex !== undefined) {
      for (let i = 0;i < record.textureDecl.length && i < tex.length; i++) {
        const textureId = tex[i];
        if (textureId === undefined)
          continue;
        bindTexture(textureId, i);
      }
    }
    const data = output.uniformData;
    if (data !== undefined) {
      let at = 0;
      for (const u of record.uniformDecl) {
        const loc = tfLocation(record, u.name);
        if (loc === null)
          continue;
        if (u.size === 1)
          gl.uniform1f(loc, data[at] ?? 0);
        else if (u.size === 2)
          gl.uniform2f(loc, data[at] ?? 0, data[at + 1] ?? 0);
        else if (u.size === 3)
          gl.uniform3f(loc, data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0);
        else
          gl.uniform4f(loc, data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0);
        at += u.size;
      }
    }
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, record.tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, outBuffer);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, vertexCount);
    gl.endTransformFeedback();
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindVertexArray(null);
  }
  function deleteTransformPass(passId) {
    const record = transformPasses.get(passId);
    if (record === undefined)
      return;
    const programId = transformPassIds.get(passId);
    if (programId !== undefined) {
      if (currentProgramId === programId) {
        gl.useProgram(null);
        currentProgram = null;
        currentProgramId = -1;
      }
      programs.delete(programId);
      transformProgramIds.delete(programId);
    }
    gl.deleteTransformFeedback(record.tf);
    gl.deleteVertexArray(record.vao);
    gl.deleteProgram(record.program);
    transformPassIds.delete(passId);
    transformPasses.delete(passId);
  }
  function texSubImage2DBuffer(textureId, x, y, width, height, bufferId, byteOffset = 0) {
    const texture = textures.get(textureId);
    if (texture === undefined) {
      throw new Error(`rune: texSubImage2DBuffer — no such texture ${textureId}`);
    }
    const buffer = buffers.get(bufferId);
    if (buffer === undefined) {
      throw new Error(`rune: texSubImage2DBuffer — no such buffer ${bufferId}`);
    }
    const pair = uploadPair(textureId);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, pair.format, pair.type, byteOffset);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  }
  return {
    createProgram,
    useProgram,
    createBuffer,
    bindVertexBuffer,
    updateBuffer,
    setUniformMatrix4,
    setUniform4fv,
    setUniform3fv,
    setUniform2fv,
    setUniform1f,
    setUniform1i,
    createTexture,
    texSubImage2D,
    texImage2DFromSource,
    texSubImage2DFromSource,
    texImage2DLevel,
    bindTexture,
    createTextureView,
    deleteTextureView,
    setViewport,
    setDepthMode,
    setCull,
    setBlend,
    clear,
    drawArrays,
    createTarget,
    bindTarget,
    readTargetPixels,
    deleteTexture,
    deleteTarget,
    deleteProgram,
    deleteBuffer,
    createTransformPass,
    runTransformPass,
    deleteTransformPass,
    texSubImage2DBuffer
  };
}
// packages/webgl2/src/capsProbe.ts
function probeGLCaps(probe) {
  const features = new Set;
  const formatMatrix = new Map;
  const paths = new Map;
  const extensions = new Map;
  const limits = {};
  const extList = [
    ["astc", "WEBGL_compressed_texture_astc"],
    ["etc2", "WEBGL_compressed_texture_etc"],
    ["bc1", "WEBGL_compressed_texture_s3tc"],
    ["bc3", "WEBGL_compressed_texture_s3tc"],
    ["bc4", "EXT_texture_compression_rgtc"],
    ["bc5", "EXT_texture_compression_rgtc"],
    ["pvrtc", "WEBGL_compressed_texture_pvrtc"],
    ["anisotropic", "EXT_texture_filter_anisotropic"],
    ["float32-texture", "OES_texture_float"],
    ["float16-texture", "OES_texture_half_float"],
    ["float32-filterable", "OES_texture_float_linear"],
    ["linear-filter-float", "OES_texture_float_linear"],
    ["float16-filterable", "OES_texture_half_float_linear"],
    ["linear-filter-half-float", "OES_texture_half_float_linear"],
    ["float32-render", "EXT_color_buffer_float"],
    ["float16-render", "EXT_color_buffer_half_float"],
    ["timestamp-query", "EXT_disjoint_timer_query_webgl2"]
  ];
  for (const [feature, extName] of extList) {
    const ext = probe.getExtension(extName);
    if (ext) {
      features.add(feature);
      extensions.set(extName, ext);
    }
  }
  const colorBufferFloat = probe.getExtension("EXT_color_buffer_float");
  const floatBlend = probe.getExtension("EXT_float_blend");
  if (floatBlend && colorBufferFloat) {
    features.add("float32-blend");
    features.add("float16-blend");
    extensions.set("EXT_float_blend", floatBlend);
  }
  let float32StorageOk = true;
  if (probe.supportsFloat32Storage !== undefined && !probe.supportsFloat32Storage()) {
    float32StorageOk = false;
    features.delete("float32-texture");
    features.delete("float32-filterable");
    features.delete("linear-filter-float");
  }
  features.add("instancing");
  if (typeof OffscreenCanvas !== "undefined")
    features.add("offscreen-canvas");
  if (typeof VideoFrame !== "undefined")
    features.add("video-frame");
  const num = (pname, name) => {
    const v = probe.getParameter(pname);
    if (typeof v === "number" && Number.isFinite(v))
      limits[name] = v;
  };
  num(probe.MAX_TEXTURE_SIZE, "maxTextureSize2D");
  num(probe.MAX_3D_TEXTURE_SIZE, "maxTextureSize3D");
  num(probe.MAX_ARRAY_TEXTURE_LAYERS, "maxTextureArrayLayers");
  num(probe.MAX_CUBE_MAP_TEXTURE_SIZE, "maxCubeMapSize");
  num(probe.MAX_RENDERBUFFER_SIZE, "maxRenderbufferSize");
  num(probe.MAX_VERTEX_TEXTURE_IMAGE_UNITS, "maxVertexTextureUnits");
  num(probe.MAX_TEXTURE_IMAGE_UNITS, "maxFragmentTextureUnits");
  num(probe.MAX_COMBINED_TEXTURE_IMAGE_UNITS, "maxCombinedTextureUnits");
  num(probe.MAX_VERTEX_ATTRIBS, "maxVertexAttributes");
  num(probe.MAX_VERTEX_UNIFORM_VECTORS, "maxVertexUniformVectors");
  num(probe.MAX_FRAGMENT_UNIFORM_VECTORS, "maxFragmentUniformVectors");
  num(probe.MAX_VARYING_VECTORS, "maxVaryingVectors");
  num(probe.MAX_DRAW_BUFFERS, "maxDrawBuffers");
  num(probe.MAX_ELEMENTS_VERTICES, "maxElementsVertices");
  num(probe.MAX_ELEMENTS_INDICES, "maxElementsIndices");
  const vp = probe.getParameter(probe.MAX_VIEWPORT_DIMS);
  if (vp && typeof vp === "object" && "length" in vp && vp.length >= 2) {
    const arr = vp;
    limits["maxViewportWidth"] = arr[0];
    limits["maxViewportHeight"] = arr[1];
  }
  const hasFloat16Render = features.has("float16-render");
  const hasFloat32Render = features.has("float32-render");
  const hasFloat16Blend = features.has("float16-blend");
  const hasFloat32Blend = features.has("float32-blend");
  const hasFloat16Filter = features.has("float16-filterable");
  const hasFloat32Filter = features.has("float32-filterable");
  const setFmt = (format, axis, support) => {
    formatMatrix.set(`${format}|${axis}`, support);
  };
  for (const axis of ["sampled", "render", "blend", "filter", "msaa"]) {
    setFmt("rgba8unorm", axis, "native");
  }
  setFmt("rgba8unorm", "storage", "none");
  for (const axis of ["sampled", "render", "blend", "filter", "msaa"]) {
    setFmt("rgba8unorm-srgb", axis, "native");
  }
  setFmt("rgba8unorm-srgb", "storage", "none");
  for (const axis of ["sampled", "filter", "render", "msaa"]) {
    setFmt("r8unorm", axis, "native");
    setFmt("rg8unorm", axis, "native");
  }
  setFmt("r8unorm", "blend", "none");
  setFmt("r8unorm", "storage", "none");
  setFmt("rg8unorm", "blend", "none");
  setFmt("rg8unorm", "storage", "none");
  setFmt("rgba16float", "sampled", "native");
  setFmt("rgba16float", "filter", hasFloat16Filter ? "native" : "none");
  setFmt("rgba16float", "render", hasFloat16Render ? "native" : "none");
  setFmt("rgba16float", "blend", hasFloat16Blend ? "native" : "none");
  setFmt("rgba16float", "msaa", hasFloat16Render ? "native" : "none");
  setFmt("rgba16float", "storage", "none");
  setFmt("rgba32float", "sampled", float32StorageOk ? "native" : "none");
  setFmt("rgba32float", "filter", float32StorageOk && hasFloat32Filter ? "native" : "none");
  setFmt("rgba32float", "render", float32StorageOk && hasFloat32Render ? "native" : "none");
  setFmt("rgba32float", "blend", float32StorageOk && hasFloat32Blend ? "native" : "none");
  setFmt("rgba32float", "msaa", float32StorageOk && hasFloat32Render ? "native" : "none");
  setFmt("rgba32float", "storage", "none");
  setFmt("r16float", "sampled", "native");
  setFmt("r16float", "filter", hasFloat16Filter ? "native" : "none");
  setFmt("r16float", "render", hasFloat16Render ? "native" : "none");
  setFmt("r16float", "blend", "none");
  setFmt("r16float", "msaa", "none");
  setFmt("r16float", "storage", "none");
  setFmt("r32float", "sampled", "native");
  setFmt("r32float", "filter", hasFloat32Filter ? "native" : "none");
  setFmt("r32float", "render", hasFloat32Render ? "native" : "none");
  setFmt("r32float", "blend", "none");
  setFmt("r32float", "msaa", "none");
  setFmt("r32float", "storage", "none");
  setFmt("depth24plus", "sampled", "native");
  setFmt("depth24plus", "render", "native");
  setFmt("depth24plus", "filter", "none");
  setFmt("depth24plus", "blend", "none");
  setFmt("depth24plus", "msaa", "native");
  setFmt("depth24plus", "storage", "none");
  setFmt("depth24plus-stencil8", "sampled", "native");
  setFmt("depth24plus-stencil8", "render", "native");
  setFmt("depth24plus-stencil8", "filter", "none");
  setFmt("depth24plus-stencil8", "blend", "none");
  setFmt("depth24plus-stencil8", "msaa", "native");
  setFmt("depth24plus-stencil8", "storage", "none");
  const bgra = probe.getExtension("EXT_texture_format_BGRA8888");
  if (bgra) {
    for (const axis of ["sampled", "render", "blend", "filter", "msaa"]) {
      setFmt("bgra8unorm", axis, "native");
    }
  } else {
    for (const axis of ["sampled", "render", "blend", "filter", "msaa"]) {
      setFmt("bgra8unorm", axis, "none");
    }
  }
  setFmt("bgra8unorm", "storage", "none");
  paths.set("canvas-direct", "supported");
  paths.set("preserve", "supported");
  paths.set("blit", "supported");
  paths.set("asyncbmp", features.has("offscreen-canvas") ? "supported" : "unsupported");
  return {
    features,
    formatMatrix,
    paths,
    extensions,
    limits,
    backend: "webgl2"
  };
}
function makeGLProbe(gl) {
  const MAX_TEXTURE_SIZE = gl.MAX_TEXTURE_SIZE;
  const MAX_3D_TEXTURE_SIZE = gl.MAX_3D_TEXTURE_SIZE;
  const MAX_ARRAY_TEXTURE_LAYERS = gl.MAX_ARRAY_TEXTURE_LAYERS;
  const MAX_CUBE_MAP_TEXTURE_SIZE = gl.MAX_CUBE_MAP_TEXTURE_SIZE;
  const MAX_RENDERBUFFER_SIZE = gl.MAX_RENDERBUFFER_SIZE;
  const MAX_VERTEX_TEXTURE_IMAGE_UNITS = gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS;
  const MAX_TEXTURE_IMAGE_UNITS = gl.MAX_TEXTURE_IMAGE_UNITS;
  const MAX_COMBINED_TEXTURE_IMAGE_UNITS = gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS;
  const MAX_VERTEX_ATTRIBS = gl.MAX_VERTEX_ATTRIBS;
  const MAX_VERTEX_UNIFORM_VECTORS = gl.MAX_VERTEX_UNIFORM_VECTORS;
  const MAX_FRAGMENT_UNIFORM_VECTORS = gl.MAX_FRAGMENT_UNIFORM_VECTORS;
  const MAX_VARYING_VECTORS = gl.MAX_VARYING_VECTORS;
  const MAX_DRAW_BUFFERS = gl.MAX_DRAW_BUFFERS;
  const MAX_VIEWPORT_DIMS = gl.MAX_VIEWPORT_DIMS;
  const MAX_ELEMENTS_VERTICES = gl.MAX_ELEMENTS_VERTICES;
  const MAX_ELEMENTS_INDICES = gl.MAX_ELEMENTS_INDICES;
  return {
    getExtension: (name) => {
      try {
        return gl.getExtension(name);
      } catch {
        return null;
      }
    },
    getParameter: (pname) => {
      try {
        return gl.getParameter(pname);
      } catch {
        return 0;
      }
    },
    getString: (pname) => {
      try {
        return gl.getParameter(pname);
      } catch {
        return "";
      }
    },
    hasTimerQuery: () => gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null,
    hasFloatLinear: () => gl.getExtension("OES_texture_float_linear") !== null,
    supportsFloat32Storage: () => {
      try {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 4, 4);
        let ok = true;
        for (;; ) {
          const err = gl.getError();
          if (err === gl.NO_ERROR)
            break;
          ok = false;
        }
        gl.deleteTexture(tex);
        gl.getError();
        return ok;
      } catch {
        return false;
      }
    },
    MAX_TEXTURE_SIZE,
    MAX_3D_TEXTURE_SIZE,
    MAX_ARRAY_TEXTURE_LAYERS,
    MAX_CUBE_MAP_TEXTURE_SIZE,
    MAX_RENDERBUFFER_SIZE,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS,
    MAX_TEXTURE_IMAGE_UNITS,
    MAX_COMBINED_TEXTURE_IMAGE_UNITS,
    MAX_VERTEX_ATTRIBS,
    MAX_VERTEX_UNIFORM_VECTORS,
    MAX_FRAGMENT_UNIFORM_VECTORS,
    MAX_VARYING_VECTORS,
    MAX_DRAW_BUFFERS,
    MAX_VIEWPORT_DIMS,
    MAX_ELEMENTS_VERTICES,
    MAX_ELEMENTS_INDICES
  };
}
// packages/webgl2/src/gpuTimer.ts
function createGLGpuTimer(gl) {
  const extOrNull = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  if (extOrNull === null)
    return null;
  const ext = extOrNull;
  let active = null;
  let pending2 = null;
  let lastResult = null;
  let alive = true;
  function safeBegin() {
    if (!alive)
      return;
    try {
      if (active !== null) {
        return;
      }
      active = ext.createQueryEXT();
      if (active === null) {
        alive = false;
        return;
      }
      ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, active);
    } catch {
      alive = false;
    }
  }
  function safeEnd() {
    if (!alive)
      return;
    try {
      if (active === null)
        return;
      ext.endQueryEXT(ext.TIME_ELAPSED_EXT);
      if (pending2 !== null) {
        ext.deleteQueryEXT(pending2);
      }
      pending2 = active;
      active = null;
    } catch {
      alive = false;
    }
  }
  function safeResult() {
    if (!alive || pending2 === null)
      return lastResult;
    try {
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      if (disjoint !== 0) {
        ext.deleteQueryEXT(pending2);
        pending2 = null;
        lastResult = null;
        return null;
      }
      const available = ext.getQueryObjectEXT(pending2, ext.QUERY_RESULT_AVAILABLE_EXT);
      if (!available) {
        return lastResult;
      }
      const ns = ext.getQueryObjectEXT(pending2, ext.QUERY_RESULT_EXT);
      lastResult = typeof ns === "number" && Number.isFinite(ns) ? ns / 1e6 : null;
      return lastResult;
    } catch {
      alive = false;
      return null;
    }
  }
  return {
    begin: safeBegin,
    end: safeEnd,
    result: safeResult
  };
}
// packages/prims/src/cube.ts
var FACES = [
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] }
];
var CORNER_POS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1]
];
var CORNER_UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1]
];
function cube(half) {
  const positions = new Float32Array(FACES.length * 6 * 3);
  const normals = new Float32Array(FACES.length * 6 * 3);
  const uvs = new Float32Array(FACES.length * 6 * 2);
  let at = 0;
  for (const face of FACES) {
    at = emitFace(face, half, positions, normals, uvs, at);
  }
  return { positions, normals, uvs, vertexCount: FACES.length * 6 };
}
function box(params = {}) {
  const width = params.width ?? 1;
  const height = params.height ?? 1;
  const depth2 = params.depth ?? 1;
  const ws = Math.max(1, Math.floor(params.widthSegments ?? 1));
  const hs = Math.max(1, Math.floor(params.heightSegments ?? 1));
  const ds = Math.max(1, Math.floor(params.depthSegments ?? 1));
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth2 / 2;
  const halfOf = (axis) => {
    const [ax, ay] = axis;
    if (ax !== 0)
      return hx;
    if (ay !== 0)
      return hy;
    return hz;
  };
  const faceSegs = [
    [ws, hs],
    [ws, hs],
    [ds, hs],
    [ds, hs],
    [ws, ds],
    [ws, ds]
  ];
  const cells = faceSegs.reduce((sum, [su, sv]) => sum + su * sv, 0);
  const vertexCount = cells * 6;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  let at = 0;
  for (let f = 0;f < FACES.length; f++) {
    const face = FACES[f];
    const [su, sv] = faceSegs[f];
    const hu = halfOf(face.u);
    const hv = halfOf(face.v);
    const hn = halfOf(face.n);
    for (let j = 0;j < sv; j++) {
      for (let i = 0;i < su; i++) {
        const corners = [
          [-1 + 2 * i / su, -1 + 2 * j / sv, i / su, j / sv],
          [-1 + 2 * (i + 1) / su, -1 + 2 * j / sv, (i + 1) / su, j / sv],
          [-1 + 2 * (i + 1) / su, -1 + 2 * (j + 1) / sv, (i + 1) / su, (j + 1) / sv],
          [-1 + 2 * i / su, -1 + 2 * (j + 1) / sv, i / su, (j + 1) / sv]
        ];
        const order = [0, 1, 2, 0, 2, 3];
        for (const c of order) {
          const [cp, cq, u, v] = corners[c];
          positions[at * 3] = face.n[0] * hn + face.u[0] * hu * cp + face.v[0] * hv * cq;
          positions[at * 3 + 1] = face.n[1] * hn + face.u[1] * hu * cp + face.v[1] * hv * cq;
          positions[at * 3 + 2] = face.n[2] * hn + face.u[2] * hu * cp + face.v[2] * hv * cq;
          normals[at * 3] = face.n[0];
          normals[at * 3 + 1] = face.n[1];
          normals[at * 3 + 2] = face.n[2];
          uvs[at * 2] = u;
          uvs[at * 2 + 1] = v;
          at++;
        }
      }
    }
  }
  return { positions, normals, uvs, vertexCount };
}
function emitFace(face, half, positions, normals, uvs, at) {
  const corners = CORNER_POS.map(([cp, cq]) => [
    (face.n[0] + face.u[0] * cp + face.v[0] * cq) * half,
    (face.n[1] + face.u[1] * cp + face.v[1] * cq) * half,
    (face.n[2] + face.u[2] * cp + face.v[2] * cq) * half
  ]);
  const order = [0, 1, 2, 0, 2, 3];
  for (const corner of order) {
    const [x, y, z] = corners[corner];
    positions[at * 3] = x;
    positions[at * 3 + 1] = y;
    positions[at * 3 + 2] = z;
    normals[at * 3] = face.n[0];
    normals[at * 3 + 1] = face.n[1];
    normals[at * 3 + 2] = face.n[2];
    const [u, v] = CORNER_UV[corner];
    uvs[at * 2] = u;
    uvs[at * 2 + 1] = v;
    at++;
  }
  return at;
}
// packages/prims/src/quad.ts
var CORNERS = [
  [-1, -1, 0, 1],
  [1, -1, 1, 1],
  [1, 1, 1, 0],
  [-1, 1, 0, 0]
];
var ORDER = [0, 1, 2, 0, 2, 3];
function quad() {
  const positions = new Float32Array(ORDER.length * 2);
  const uvs = new Float32Array(ORDER.length * 2);
  let at = 0;
  for (const corner of ORDER) {
    const [x, y, u, v] = CORNERS[corner];
    positions[at * 2] = x;
    positions[at * 2 + 1] = y;
    uvs[at * 2] = u;
    uvs[at * 2 + 1] = v;
    at++;
  }
  return { positions, uvs, vertexCount: ORDER.length };
}
// packages/prims/src/sphere.ts
function sphere(params = {}) {
  const radius = params.radius ?? 1;
  const radial = Math.max(3, Math.floor(params.widthSegments ?? 48));
  const bands = Math.max(2, Math.floor(params.heightSegments ?? 32));
  const quads = (bands - 1) * radial;
  const positions = new Float32Array(quads * 6 * 3);
  const normals = new Float32Array(quads * 6 * 3);
  const uvs = new Float32Array(quads * 6 * 2);
  let v = 0;
  const emit = (phi, theta, u, vv) => {
    const sinPhi = Math.sin(phi);
    const nx = sinPhi * Math.sin(theta);
    const ny = Math.cos(phi);
    const nz = sinPhi * Math.cos(theta);
    positions[v * 3] = nx * radius;
    positions[v * 3 + 1] = ny * radius;
    positions[v * 3 + 2] = nz * radius;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = ny;
    normals[v * 3 + 2] = nz;
    uvs[v * 2] = u;
    uvs[v * 2 + 1] = vv;
    v++;
  };
  for (let j = 0;j < bands; j++) {
    const phi0 = j / bands * Math.PI;
    const phi1 = (j + 1) / bands * Math.PI;
    const northPole = j === 0;
    const southPole = j === bands - 1;
    for (let i = 0;i < radial; i++) {
      const t0 = i / radial * Math.PI * 2;
      const t1 = (i + 1) / radial * Math.PI * 2;
      const u0 = i / radial;
      const u1 = (i + 1) / radial;
      if (!southPole) {
        emit(phi1, t0, u0, (j + 1) / bands);
        emit(phi1, t1, u1, (j + 1) / bands);
        emit(phi0, t1, u1, j / bands);
      }
      if (!northPole) {
        emit(phi1, t0, u0, (j + 1) / bands);
        emit(phi0, t1, u1, j / bands);
        emit(phi0, t0, u0, j / bands);
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v };
}
// packages/prims/src/plane.ts
function plane(params = {}) {
  const width = params.width ?? 1;
  const height = params.height ?? 1;
  const cellsX = Math.max(1, Math.floor(params.widthSegments ?? 1));
  const cellsZ = Math.max(1, Math.floor(params.heightSegments ?? 1));
  const halfW = width / 2;
  const halfH = height / 2;
  const stepX = width / cellsX;
  const stepZ = height / cellsZ;
  const quads = cellsX * cellsZ;
  const positions = new Float32Array(quads * 6 * 3);
  const normals = new Float32Array(quads * 6 * 3);
  const uvs = new Float32Array(quads * 6 * 2);
  let v = 0;
  const emit = (i, j) => {
    positions[v * 3] = -halfW + i * stepX;
    positions[v * 3 + 1] = 0;
    positions[v * 3 + 2] = -halfH + j * stepZ;
    normals[v * 3] = 0;
    normals[v * 3 + 1] = 1;
    normals[v * 3 + 2] = 0;
    uvs[v * 2] = i / cellsX;
    uvs[v * 2 + 1] = j / cellsZ;
    v++;
  };
  for (let j = 0;j < cellsZ; j++) {
    for (let i = 0;i < cellsX; i++) {
      emit(i, j);
      emit(i, j + 1);
      emit(i + 1, j + 1);
      emit(i, j);
      emit(i + 1, j + 1);
      emit(i + 1, j);
    }
  }
  return { positions, normals, uvs, vertexCount: v };
}
// packages/prims/src/cylinder.ts
function cylinder(params = {}) {
  const rTop = params.radiusTop ?? 1;
  const rBottom = params.radiusBottom ?? 1;
  const height = params.height ?? 2;
  const radial = Math.max(3, Math.floor(params.radialSegments ?? 48));
  const hSegs = Math.max(1, Math.floor(params.heightSegments ?? 1));
  const caps = params.openEnded !== true;
  const apex = rTop <= 0.000000001;
  const bottomApex = rBottom <= 0.000000001;
  const sideTris = apex && bottomApex ? 0 : radial * (2 * hSegs - (apex ? 1 : 0) - (bottomApex ? 1 : 0));
  const capTris = (caps && !apex ? radial : 0) + (caps && !bottomApex ? radial : 0);
  const vertexCount = (sideTris + capTris) * 3;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  let v = 0;
  const dr = (rBottom - rTop) / height;
  const slopeLen = Math.hypot(1, dr);
  const nySide = dr / slopeLen;
  const nrSide = 1 / slopeLen;
  const emit = (x, y, z, nx, nyy, nz, u, vv) => {
    positions[v * 3] = x;
    positions[v * 3 + 1] = y;
    positions[v * 3 + 2] = z;
    normals[v * 3] = nx;
    normals[v * 3 + 1] = nyy;
    normals[v * 3 + 2] = nz;
    uvs[v * 2] = u;
    uvs[v * 2 + 1] = vv;
    v++;
  };
  for (let j = 0;j < hSegs; j++) {
    const v0 = j / hSegs;
    const v1 = (j + 1) / hSegs;
    const y0 = -height / 2 + v0 * height;
    const y1 = -height / 2 + v1 * height;
    const r0 = rBottom + (rTop - rBottom) * v0;
    const r1 = rBottom + (rTop - rBottom) * v1;
    for (let i = 0;i < radial; i++) {
      const a0 = i / radial * Math.PI * 2;
      const a1 = (i + 1) / radial * Math.PI * 2;
      const u0 = i / radial;
      const u1 = (i + 1) / radial;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      if (r0 > 0.000000001) {
        emit(r0 * c0, y0, r0 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v0);
        emit(r1 * c1, y1, r1 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v1);
        emit(r0 * c1, y0, r0 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v0);
      }
      if (r1 > 0.000000001) {
        emit(r0 * c0, y0, r0 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v0);
        emit(r1 * c0, y1, r1 * s0, c0 * nrSide, nySide, s0 * nrSide, u0, v1);
        emit(r1 * c1, y1, r1 * s1, c1 * nrSide, nySide, s1 * nrSide, u1, v1);
      }
    }
  }
  if (caps) {
    const yTop = height / 2;
    const yBot = -height / 2;
    if (!apex) {
      for (let i = 0;i < radial; i++) {
        const a0 = i / radial * Math.PI * 2;
        const a1 = (i + 1) / radial * Math.PI * 2;
        emit(0, yTop, 0, 0, 1, 0, 0.5, 0.5);
        emit(rTop * Math.cos(a1), yTop, rTop * Math.sin(a1), 0, 1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1));
        emit(rTop * Math.cos(a0), yTop, rTop * Math.sin(a0), 0, 1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0));
      }
    }
    if (!bottomApex) {
      for (let i = 0;i < radial; i++) {
        const a0 = i / radial * Math.PI * 2;
        const a1 = (i + 1) / radial * Math.PI * 2;
        emit(0, yBot, 0, 0, -1, 0, 0.5, 0.5);
        emit(rBottom * Math.cos(a0), yBot, rBottom * Math.sin(a0), 0, -1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0));
        emit(rBottom * Math.cos(a1), yBot, rBottom * Math.sin(a1), 0, -1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1));
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v };
}
function cone(params = {}) {
  return cylinder({
    radiusTop: 0,
    radiusBottom: params.radius ?? 1,
    height: params.height ?? 2,
    radialSegments: params.radialSegments ?? 48,
    heightSegments: params.heightSegments ?? 1,
    openEnded: params.openEnded ?? false
  });
}
// packages/prims/src/capsule.ts
function capsule(params = {}) {
  const radius = params.radius ?? 0.6;
  const length = params.height ?? 1.2;
  const rr = Math.max(3, Math.floor(params.radialSegments ?? 32));
  const halfRings = Math.max(2, Math.floor(params.capSegments ?? 10));
  const half = length / 2;
  const ringCount = halfRings * 2 + 1;
  const triCount = 2 * rr * (ringCount - 2);
  const positions = new Float32Array(triCount * 3 * 3);
  const normals = new Float32Array(triCount * 3 * 3);
  const uvs = new Float32Array(triCount * 3 * 2);
  let v = 0;
  const ring = (k) => {
    const phi = k / (ringCount - 1) * Math.PI;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const cy = cosPhi > 0 ? half : -half;
    return { sinPhi, cosPhi, y: cy + cosPhi * radius };
  };
  for (let k = 0;k < ringCount - 1; k++) {
    const a = ring(k);
    const b = ring(k + 1);
    const northPole = k === 0;
    const southPole = k === ringCount - 2;
    for (let i = 0;i < rr; i++) {
      const th0 = i / rr * Math.PI * 2;
      const th1 = (i + 1) / rr * Math.PI * 2;
      const u0 = i / rr;
      const u1 = (i + 1) / rr;
      const v0 = k / (ringCount - 1);
      const v1 = (k + 1) / (ringCount - 1);
      const c0 = Math.cos(th0), s0 = Math.sin(th0);
      const c1 = Math.cos(th1), s1 = Math.sin(th1);
      const ra = a.sinPhi * radius;
      const rb = b.sinPhi * radius;
      const emit = (px, py, pz, nx, ny, nz, u, vv) => {
        positions[v * 3] = px;
        positions[v * 3 + 1] = py;
        positions[v * 3 + 2] = pz;
        normals[v * 3] = nx;
        normals[v * 3 + 1] = ny;
        normals[v * 3 + 2] = nz;
        uvs[v * 2] = u;
        uvs[v * 2 + 1] = vv;
        v++;
      };
      if (!northPole) {
        emit(ra * c0, a.y, ra * s0, c0 * a.sinPhi, a.cosPhi, s0 * a.sinPhi, u0, v0);
        emit(ra * c1, a.y, ra * s1, c1 * a.sinPhi, a.cosPhi, s1 * a.sinPhi, u1, v0);
        emit(rb * c1, b.y, rb * s1, c1 * b.sinPhi, b.cosPhi, s1 * b.sinPhi, u1, v1);
      }
      if (!southPole) {
        emit(ra * c0, a.y, ra * s0, c0 * a.sinPhi, a.cosPhi, s0 * a.sinPhi, u0, v0);
        emit(rb * c1, b.y, rb * s1, c1 * b.sinPhi, b.cosPhi, s1 * b.sinPhi, u1, v1);
        emit(rb * c0, b.y, rb * s0, c0 * b.sinPhi, b.cosPhi, s0 * b.sinPhi, u0, v1);
      }
    }
  }
  return { positions, normals, uvs, vertexCount: v };
}
// packages/prims/src/torus.ts
function torus(params = {}) {
  const majorRadius = params.radius ?? 1;
  const tubeRadius = params.tube ?? 0.35;
  const tub = Math.max(3, Math.floor(params.tubularSegments ?? 64));
  const rad = Math.max(3, Math.floor(params.radialSegments ?? 24));
  const positions = new Float32Array(tub * rad * 6 * 3);
  const normals = new Float32Array(tub * rad * 6 * 3);
  const uvs = new Float32Array(tub * rad * 6 * 2);
  let v = 0;
  const emit = (theta, phi, u, vv) => {
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    positions[v * 3] = Math.cos(theta) * (majorRadius + tubeRadius * cosPhi);
    positions[v * 3 + 1] = tubeRadius * sinPhi;
    positions[v * 3 + 2] = Math.sin(theta) * (majorRadius + tubeRadius * cosPhi);
    normals[v * 3] = Math.cos(theta) * cosPhi;
    normals[v * 3 + 1] = sinPhi;
    normals[v * 3 + 2] = Math.sin(theta) * cosPhi;
    uvs[v * 2] = u;
    uvs[v * 2 + 1] = vv;
    v++;
  };
  for (let i = 0;i < tub; i++) {
    const t0 = i / tub * Math.PI * 2;
    const t1 = (i + 1) / tub * Math.PI * 2;
    for (let j = 0;j < rad; j++) {
      const p0 = j / rad * Math.PI * 2;
      const p1 = (j + 1) / rad * Math.PI * 2;
      const u0 = i / tub;
      const u1 = (i + 1) / tub;
      const w0 = j / rad;
      const w1 = (j + 1) / rad;
      emit(t0, p0, u0, w0);
      emit(t0, p1, u0, w1);
      emit(t1, p1, u1, w1);
      emit(t0, p0, u0, w0);
      emit(t1, p1, u1, w1);
      emit(t1, p0, u1, w0);
    }
  }
  return { positions, normals, uvs, vertexCount: v };
}
function knotPoint(p, q, t, scale) {
  const r = 2 + Math.cos(q * t);
  return [Math.cos(p * t) * r * scale, Math.sin(q * t) * scale, Math.sin(p * t) * r * scale];
}
function torusKnot(params = {}) {
  const p = params.p ?? 2;
  const q = params.q ?? 3;
  const tubeRadius = params.tube ?? 0.3;
  const seg = Math.max(8, Math.floor(params.tubularSegments ?? 220));
  const rad = Math.max(3, Math.floor(params.radialSegments ?? 14));
  const scale = params.scale ?? 0.45;
  const positions = [];
  const normals = [];
  const uvs = [];
  let prevNormal = null;
  const frames = [];
  for (let i = 0;i < seg; i++) {
    const t = i / seg * Math.PI * 2;
    const tNext = (i + 1) / seg * Math.PI * 2;
    const a = knotPoint(p, q, t, scale);
    const b = knotPoint(p, q, tNext, scale);
    const tangent = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const tl = Math.hypot(tangent[0], tangent[1], tangent[2]) || 1;
    tangent[0] /= tl;
    tangent[1] /= tl;
    tangent[2] /= tl;
    let normal;
    if (prevNormal === null) {
      const up = Math.abs(tangent[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      const d = up[1] * tangent[2] - up[2] * tangent[1];
      const e = up[2] * tangent[0] - up[0] * tangent[2];
      const f = up[0] * tangent[1] - up[1] * tangent[0];
      const nl = Math.hypot(d, e, f) || 1;
      normal = [d / nl, e / nl, f / nl];
    } else {
      const dot = prevNormal[0] * tangent[0] + prevNormal[1] * tangent[1] + prevNormal[2] * tangent[2];
      const nx = prevNormal[0] - dot * tangent[0];
      const ny = prevNormal[1] - dot * tangent[1];
      const nz = prevNormal[2] - dot * tangent[2];
      const nl = Math.hypot(nx, ny, nz) || 1;
      normal = [nx / nl, ny / nl, nz / nl];
    }
    prevNormal = normal;
    const binormal = [
      tangent[1] * normal[2] - tangent[2] * normal[1],
      tangent[2] * normal[0] - tangent[0] * normal[2],
      tangent[0] * normal[1] - tangent[1] * normal[0]
    ];
    frames.push({ tangent, normal, binormal });
  }
  const emit = (cx, cy, cz, nx, ny, nz, u, vv) => {
    positions.push(cx, cy, cz);
    normals.push(nx, ny, nz);
    uvs.push(u, vv);
  };
  for (let i = 0;i < seg; i++) {
    const f0 = frames[i];
    const f1 = frames[(i + 1) % seg];
    const c0 = knotPoint(p, q, i / seg * Math.PI * 2, scale);
    const c1 = knotPoint(p, q, (i + 1) / seg * Math.PI * 2, scale);
    for (let j = 0;j < rad; j++) {
      const a0 = j / rad * Math.PI * 2;
      const a1 = (j + 1) / rad * Math.PI * 2;
      const u0 = i / seg;
      const u1 = (i + 1) / seg;
      const w0 = j / rad;
      const w1 = (j + 1) / rad;
      const ring0 = (f, ang, c) => ({
        pos: [
          c[0] + (f.normal[0] * Math.cos(ang) + f.binormal[0] * Math.sin(ang)) * tubeRadius,
          c[1] + (f.normal[1] * Math.cos(ang) + f.binormal[1] * Math.sin(ang)) * tubeRadius,
          c[2] + (f.normal[2] * Math.cos(ang) + f.binormal[2] * Math.sin(ang)) * tubeRadius
        ],
        n: [
          f.normal[0] * Math.cos(ang) + f.binormal[0] * Math.sin(ang),
          f.normal[1] * Math.cos(ang) + f.binormal[1] * Math.sin(ang),
          f.normal[2] * Math.cos(ang) + f.binormal[2] * Math.sin(ang)
        ]
      });
      const v00 = ring0(f0, a0, c0);
      const v01 = ring0(f0, a1, c0);
      const v11 = ring0(f1, a1, c1);
      const v10 = ring0(f1, a0, c1);
      emit(v00.pos[0], v00.pos[1], v00.pos[2], v00.n[0], v00.n[1], v00.n[2], u0, w0);
      emit(v01.pos[0], v01.pos[1], v01.pos[2], v01.n[0], v01.n[1], v01.n[2], u0, w1);
      emit(v11.pos[0], v11.pos[1], v11.pos[2], v11.n[0], v11.n[1], v11.n[2], u1, w1);
      emit(v00.pos[0], v00.pos[1], v00.pos[2], v00.n[0], v00.n[1], v00.n[2], u0, w0);
      emit(v11.pos[0], v11.pos[1], v11.pos[2], v11.n[0], v11.n[1], v11.n[2], u1, w1);
      emit(v10.pos[0], v10.pos[1], v10.pos[2], v10.n[0], v10.n[1], v10.n[2], u1, w0);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3
  };
}
// packages/prims/src/platonic.ts
function planarCornerUv(fan) {
  const a = fan[0];
  const b1 = fan[1];
  const c1 = fan[2];
  const ux = b1[0] - a[0], uy = b1[1] - a[1], uz = b1[2] - a[2];
  const wx = c1[0] - a[0], wy = c1[1] - a[1], wz = c1[2] - a[2];
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  const upX = Math.abs(ny) < 0.9 ? 0 : 1;
  const upY = Math.abs(ny) < 0.9 ? 1 : 0;
  let tx = upY * nz;
  let ty = -upX * nz;
  let tz = upX * ny - upY * nx;
  const tLen = Math.hypot(tx, ty, tz) || 1;
  tx /= tLen;
  ty /= tLen;
  tz /= tLen;
  const bx = ny * tz - nz * ty;
  const by = nz * tx - nx * tz;
  const bz = nx * ty - ny * tx;
  const us = [];
  const vs = [];
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of fan) {
    const du = p[0] * tx + p[1] * ty + p[2] * tz;
    const dv = p[0] * bx + p[1] * by + p[2] * bz;
    us.push(du);
    vs.push(dv);
    if (du < uMin)
      uMin = du;
    if (du > uMax)
      uMax = du;
    if (dv < vMin)
      vMin = dv;
    if (dv > vMax)
      vMax = dv;
  }
  const uSpan = Math.max(uMax - uMin, 0.000000001);
  const vSpan = Math.max(vMax - vMin, 0.000000001);
  return fan.map((_, k) => [(us[k] - uMin) / uSpan, (vs[k] - vMin) / vSpan]);
}
function subdivide(a, b, c, d, radius, project) {
  const onSphere = (p) => {
    if (!project)
      return p;
    const len = Math.hypot(p[0], p[1], p[2]);
    if (len < 0.000000000001)
      return p;
    return [p[0] / len * radius, p[1] / len * radius, p[2] / len * radius];
  };
  const out = [];
  const n = d + 1;
  const point = (i, j) => onSphere([
    a[0] + (b[0] - a[0]) * (i / n) + (c[0] - a[0]) * (j / n),
    a[1] + (b[1] - a[1]) * (i / n) + (c[1] - a[1]) * (j / n),
    a[2] + (b[2] - a[2]) * (i / n) + (c[2] - a[2]) * (j / n)
  ]);
  const bary = (i, j) => [i / n, j / n];
  for (let j = 0;j < n; j++) {
    for (let i = 0;i < n - j; i++) {
      const p00 = point(i, j);
      const p10 = point(i + 1, j);
      const p01 = point(i, j + 1);
      out.push({
        tri: [p00, p10, p01],
        w: [bary(i, j), bary(i + 1, j), bary(i, j + 1)]
      });
      if (i + 1 + j + 1 <= n) {
        const p11 = point(i + 1, j + 1);
        out.push({
          tri: [p10, p11, p01],
          w: [bary(i + 1, j), bary(i + 1, j + 1), bary(i, j + 1)]
        });
      }
    }
  }
  return out;
}
function flatFan(fan, radius, detail) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const cornerUv = planarCornerUv(fan);
  const d = Math.max(0, Math.floor(detail));
  const project = d > 0;
  for (let i = 1;i < fan.length - 1; i++) {
    const a = fan[0];
    const b = fan[i];
    const c = fan[i + 1];
    const ua = cornerUv[0];
    const ub = cornerUv[i];
    const uc = cornerUv[i + 1];
    for (const { tri, w } of subdivide(a, b, c, d, radius, project)) {
      const [pa, pb, pc] = tri;
      const ex = pb[0] - pa[0], ey = pb[1] - pa[1], ez = pb[2] - pa[2];
      const fx = pc[0] - pa[0], fy = pc[1] - pa[1], fz = pc[2] - pa[2];
      let nx = ey * fz - ez * fy;
      let ny = ez * fx - ex * fz;
      let nz = ex * fy - ey * fx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0.000000000001) {
        nx /= len;
        ny /= len;
        nz /= len;
      }
      const uvOf = (k) => [
        ua[0] + (ub[0] - ua[0]) * w[k][0] + (uc[0] - ua[0]) * w[k][1],
        ua[1] + (ub[1] - ua[1]) * w[k][0] + (uc[1] - ua[1]) * w[k][1]
      ];
      const corners = tri;
      for (let k = 0;k < 3; k++) {
        const p = corners[k];
        positions.push(p[0], p[1], p[2]);
        normals.push(nx, ny, nz);
        const [u, vv] = uvOf(k);
        uvs.push(u, vv);
      }
    }
  }
  return { positions, normals, uvs };
}
function pack(parts) {
  const positions = [];
  const normals = [];
  const uvs = [];
  for (const part of parts) {
    positions.push(...part.positions);
    normals.push(...part.normals);
    uvs.push(...part.uvs);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3
  };
}
function polyhedron(faces, params) {
  const radius = params.radius ?? 1;
  const detail = params.detail ?? 0;
  return pack(faces.map((f) => flatFan(f, radius, detail)));
}
var TETRA = [
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1]
];
var TETRA_FACES = [
  [TETRA[0], TETRA[1], TETRA[2]],
  [TETRA[0], TETRA[3], TETRA[1]],
  [TETRA[0], TETRA[2], TETRA[3]],
  [TETRA[1], TETRA[3], TETRA[2]]
];
function tetrahedron(params = {}) {
  const radius = params.radius ?? 1;
  const s = radius / Math.sqrt(3);
  return polyhedron(TETRA_FACES.map((f) => f.map((v) => [v[0] * s, v[1] * s, v[2] * s])), { ...params, radius });
}
var OCTA_FACES = (() => {
  const v = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1]
  ];
  return [
    [v[0], v[2], v[4]],
    [v[2], v[1], v[4]],
    [v[1], v[3], v[4]],
    [v[3], v[0], v[4]],
    [v[2], v[0], v[5]],
    [v[1], v[2], v[5]],
    [v[3], v[1], v[5]],
    [v[0], v[3], v[5]]
  ];
})();
function octahedron(params = {}) {
  const radius = params.radius ?? 1;
  return polyhedron(OCTA_FACES.map((f) => f.map((v) => [v[0] * radius, v[1] * radius, v[2] * radius])), params);
}
var ICO_FACES = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1]
  ];
  const v = raw.map((p) => {
    const len = Math.hypot(p[0], p[1], p[2]);
    return [p[0] / len, p[1] / len, p[2] / len];
  });
  return [
    [v[0], v[11], v[5]],
    [v[0], v[5], v[1]],
    [v[0], v[1], v[7]],
    [v[0], v[7], v[10]],
    [v[0], v[10], v[11]],
    [v[1], v[5], v[9]],
    [v[5], v[11], v[4]],
    [v[11], v[10], v[2]],
    [v[10], v[7], v[6]],
    [v[7], v[1], v[8]],
    [v[3], v[9], v[4]],
    [v[3], v[4], v[2]],
    [v[3], v[2], v[6]],
    [v[3], v[6], v[8]],
    [v[3], v[8], v[9]],
    [v[4], v[9], v[5]],
    [v[2], v[4], v[11]],
    [v[6], v[2], v[10]],
    [v[8], v[6], v[7]],
    [v[9], v[8], v[1]]
  ];
})();
function icosahedron(params = {}) {
  const radius = params.radius ?? 1;
  return polyhedron(ICO_FACES.map((f) => f.map((v) => [v[0] * radius, v[1] * radius, v[2] * radius])), { ...params, radius });
}
function dodecahedron(params = {}) {
  const radius = params.radius ?? 1;
  const vertices = [];
  const seen = new Set;
  for (const face of ICO_FACES) {
    for (const v of face) {
      const key = v.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        vertices.push(v);
      }
    }
  }
  const dv = ICO_FACES.map((f) => {
    const c = [
      (f[0][0] + f[1][0] + f[2][0]) / 3,
      (f[0][1] + f[1][1] + f[2][1]) / 3,
      (f[0][2] + f[1][2] + f[2][2]) / 3
    ];
    const len = Math.hypot(c[0], c[1], c[2]) || 1;
    return [c[0] / len, c[1] / len, c[2] / len];
  });
  const dFaces = [];
  for (const c of vertices) {
    const ring = [];
    for (let f = 0;f < ICO_FACES.length; f++) {
      if (ICO_FACES[f].includes(c))
        ring.push(dv[f]);
    }
    if (ring.length !== 5) {
      throw new Error(`rune: prims — duality broken: an icosahedron vertex has ${ring.length} adjacent faces (expected 5)`);
    }
    const up = Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = [
      up[1] * c[2] - up[2] * c[1],
      up[2] * c[0] - up[0] * c[2],
      up[0] * c[1] - up[1] * c[0]
    ];
    const uLen = Math.hypot(u[0], u[1], u[2]) || 1;
    const un = [u[0] / uLen, u[1] / uLen, u[2] / uLen];
    const w = [
      c[1] * un[2] - c[2] * un[1],
      c[2] * un[0] - c[0] * un[2],
      c[0] * un[1] - c[1] * un[0]
    ];
    const angleOf = (p) => {
      const du = p[0] * un[0] + p[1] * un[1] + p[2] * un[2];
      const dw = p[0] * w[0] + p[1] * w[1] + p[2] * w[2];
      return Math.atan2(dw, du);
    };
    ring.sort((a, b) => angleOf(a) - angleOf(b));
    dFaces.push(ring);
  }
  return polyhedron(dFaces.map((f) => f.map((v) => [v[0] * radius, v[1] * radius, v[2] * radius])), params);
}
// packages/prims/src/disk.ts
function disk(params = {}) {
  const radius = params.radius ?? 1;
  const seg = Math.max(3, Math.floor(params.segments ?? 48));
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let i = 0;i < seg; i++) {
    const a0 = i / seg * Math.PI * 2;
    const a1 = (i + 1) / seg * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const tri = [
      [0, 0, 0.5, 0.5, 0],
      [c1 * radius, s1 * radius, 0.5 + 0.5 * c1, 0.5 + 0.5 * s1, 0],
      [c0 * radius, s0 * radius, 0.5 + 0.5 * c0, 0.5 + 0.5 * s0, 0]
    ];
    for (const [x, z, u, v] of tri) {
      positions.push(x, 0, z);
      normals.push(0, 1, 0);
      uvs.push(u, v);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3
  };
}
function ring(params = {}) {
  const innerRadius = params.innerRadius ?? 0.5;
  const outerRadius = params.outerRadius ?? 1;
  const seg = Math.max(3, Math.floor(params.segments ?? 48));
  const positions = [];
  const normals = [];
  const uvs = [];
  for (let i = 0;i < seg; i++) {
    const a0 = i / seg * Math.PI * 2;
    const a1 = (i + 1) / seg * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const quad2 = [
      [c0 * innerRadius, s0 * innerRadius, i / seg, 0],
      [c1 * innerRadius, s1 * innerRadius, (i + 1) / seg, 0],
      [c1 * outerRadius, s1 * outerRadius, (i + 1) / seg, 1],
      [c0 * outerRadius, s0 * outerRadius, i / seg, 1]
    ];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const [x, z, u, v] = quad2[k];
      positions.push(x, 0, z);
      normals.push(0, 1, 0);
      uvs.push(u, v);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    vertexCount: positions.length / 3
  };
}
// packages/prims/src/noise.ts
function hash2i(x, y, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 2147483647;
  h = h ^ h >>> 13 | 0;
  h = Math.imul(h, 1274126177);
  h = (h ^ h >>> 16) >>> 0;
  return h / 4294967296;
}
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function valueNoise2D(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = fade(x - xi);
  const ty = fade(y - yi);
  const v00 = hash2i(xi, yi, seed);
  const v10 = hash2i(xi + 1, yi, seed);
  const v01 = hash2i(xi, yi + 1, seed);
  const v11 = hash2i(xi + 1, yi + 1, seed);
  const a = v00 + (v10 - v00) * tx;
  const b = v01 + (v11 - v01) * tx;
  return a + (b - a) * ty;
}
function fbm2D(x, y, seed, octaves = 5, lacunarity = 2, gain = 0.5) {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0;o < octaves; o++) {
    sum += valueNoise2D(fx, fy, seed + o * 101) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}
function ridged2D(x, y, seed, octaves = 5, ridgePower = 1.3) {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let o = 0;o < octaves; o++) {
    const n = 1 - Math.abs(2 * valueNoise2D(fx, fy, seed + o * 131) - 1);
    sum += Math.pow(n, ridgePower) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

// packages/prims/src/terrain.ts
function terrain(size, segments, height, options = {}) {
  const amp = options.amplitude ?? 1;
  const cells = Math.max(1, Math.floor(segments));
  const vertsPerSide = cells + 1;
  const n = vertsPerSide * vertsPerSide;
  const half = size / 2;
  const step = size / cells;
  const heights = new Float32Array(n);
  for (let j = 0;j < vertsPerSide; j++) {
    for (let i = 0;i < vertsPerSide; i++) {
      const nx = i / cells * 2 - 1;
      const nz = j / cells * 2 - 1;
      heights[j * vertsPerSide + i] = height(nx, nz) * amp;
    }
  }
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let k = 0;k < n; k++) {
    const h = heights[k];
    if (h < hMin)
      hMin = h;
    if (h > hMax)
      hMax = h;
  }
  const hSpan = Math.max(hMax - hMin, 0.000001);
  const at = (i, j) => heights[Math.min(Math.max(j, 0), cells) * vertsPerSide + Math.min(Math.max(i, 0), cells)];
  const normalAt = (i, j, out, o) => {
    const dhdx = i === 0 ? (at(1, j) - at(0, j)) / step : i === cells ? (at(cells, j) - at(cells - 1, j)) / step : (at(i + 1, j) - at(i - 1, j)) / (2 * step);
    const dhdz = j === 0 ? (at(i, 1) - at(i, 0)) / step : j === cells ? (at(i, cells) - at(i, cells - 1)) / step : (at(i, j + 1) - at(i, j - 1)) / (2 * step);
    const nx = -dhdx;
    const ny = 1;
    const nz = -dhdz;
    const len = Math.hypot(nx, ny, nz);
    out[o] = nx / len;
    out[o + 1] = ny / len;
    out[o + 2] = nz / len;
  };
  const quads = cells * cells;
  const positions = new Float32Array(quads * 6 * 3);
  const normals = new Float32Array(quads * 6 * 3);
  const uvs = new Float32Array(quads * 6 * 2);
  let v = 0;
  const emit = (i, j) => {
    const x = -half + i * step;
    const z = -half + j * step;
    const h = at(i, j);
    positions[v * 3] = x;
    positions[v * 3 + 1] = h;
    positions[v * 3 + 2] = z;
    normalAt(i, j, normals, v * 3);
    uvs[v * 2] = i / cells;
    uvs[v * 2 + 1] = (h - hMin) / hSpan;
    v++;
  };
  for (let j = 0;j < cells; j++) {
    for (let i = 0;i < cells; i++) {
      emit(i, j);
      emit(i, j + 1);
      emit(i + 1, j + 1);
      emit(i, j);
      emit(i + 1, j + 1);
      emit(i + 1, j);
    }
  }
  return { positions, normals, uvs, vertexCount: v };
}
function heightHills(seed = 7) {
  return (x, z) => fbm2D(x * 3, z * 3, seed, 5) - 0.5;
}
function heightRidged(seed = 11) {
  return (x, z) => {
    const r = ridged2D(x * 2.2, z * 2.2, seed, 6, 1.4);
    return (r - 0.45) * 1.6;
  };
}
function heightIsland(seed = 3) {
  return (x, z) => {
    const d = Math.hypot(x, z);
    const falloff = 1 - Math.min(1, Math.pow(d, 2.2));
    const hills = fbm2D(x * 2.5, z * 2.5, seed, 5);
    return (hills * 1.2 - 0.25) * falloff - (1 - falloff) * 0.15;
  };
}
function heightDunes(seed = 5) {
  return (x, z) => {
    const warp = fbm2D(x * 2, z * 2, seed, 3) * 0.8;
    const ridge = Math.abs(Math.sin((x * 4 + warp * 2.5 + z * 0.6) * Math.PI));
    const soft = fbm2D(x * 5, z * 5, seed + 91, 2) * 0.25;
    return ridge * 0.9 + soft - 0.45;
  };
}
function heightCanyon(seed = 9) {
  return (x, z) => {
    const base = fbm2D(x * 2, z * 2, seed, 4);
    const steps = 6;
    const q = Math.floor(base * steps) / steps;
    const cliff = base - q;
    const terrace = q + Math.pow(cliff * steps, 4) / steps;
    return (terrace - 0.45) * 1.3;
  };
}
function heightVolcano(seed = 13) {
  return (x, z) => {
    const d = Math.hypot(x, z);
    const rim = 0.55;
    const rough = fbm2D(x * 4, z * 4, seed, 4) * 0.18;
    let profile;
    if (d >= rim) {
      profile = Math.max(0, 1 - (d - rim) / (1 - rim));
    } else {
      profile = 1 - Math.pow(1 - d / rim, 1.6) * 0.8;
    }
    return profile * 0.9 + rough - 0.12;
  };
}
var terrainPresets = {
  hills: { label: "Hills", height: heightHills, amplitude: 1, note: "fBm value noise: soft mounds, 5 octaves" },
  ridged: { label: "Ridges", height: heightRidged, amplitude: 1, note: "ridged multifractal: sharp ridges 1−|2n−1|" },
  island: { label: "Island", height: heightIsland, amplitude: 1.4, note: "hills × radial falloff: beach → mountains" },
  dunes: { label: "Dunes", height: heightDunes, amplitude: 0.8, note: "anisotropic |sin| ridges warped by noise" },
  canyon: { label: "Canyon", height: heightCanyon, amplitude: 1.2, note: "fBm step terraces: table plateaus" },
  volcano: { label: "Volcano", height: heightVolcano, amplitude: 1.5, note: "a cone with a crater + a noisy rim" }
};

// packages/prims/src/adaptive.ts
function tileResolution(dist, p) {
  const { maxSegments, minSegments, lodBias, tileSize } = p;
  const rel = Math.max(dist, 0.000001) / (lodBias * tileSize);
  const level = Math.max(0, Math.ceil(Math.log2(rel)));
  const res = Math.max(minSegments, maxSegments >> level);
  return Math.min(res, maxSegments);
}
function createAdaptiveTerrain(params) {
  const amplitude = params.amplitude ?? 1;
  const tileSize = Math.max(0.5, params.tileSize ?? 4);
  const radius = Math.max(tileSize, params.radius ?? 24);
  const maxSegments = clampPow2(params.maxSegments ?? 32);
  const minSegments = clampPow2(Math.min(params.minSegments ?? 4, maxSegments));
  const skirtDepth = params.skirtDepth ?? 0.4;
  const lodBias = params.lodBias ?? 2.6;
  const heightFn = params.heightFn;
  const hNorm = (h) => {
    const t = (h / amplitude + 1) / 2;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  };
  let geometry;
  let rebuilds = 1;
  let tiles = 0;
  let lastMs = 0;
  let lastX = 0;
  let lastZ = 0;
  let levelCounts = [];
  geometry = build(0, 0);
  tiles = countTiles2();
  function clampPow2(v) {
    const n = Math.max(2, Math.floor(v));
    let pow = 2;
    while (pow < n)
      pow *= 2;
    return pow;
  }
  function tilesFor(camX, camZ) {
    const span = Math.ceil(radius / tileSize);
    const cx = Math.round(camX / tileSize);
    const cz = Math.round(camZ / tileSize);
    const result = [];
    for (let iz = cz - span;iz <= cz + span; iz++) {
      for (let ix = cx - span;ix <= cx + span; ix++) {
        const centerX = (ix + 0.5) * tileSize;
        const centerZ = (iz + 0.5) * tileSize;
        const dist = Math.hypot(centerX - camX, centerZ - camZ);
        if (dist > radius)
          continue;
        result.push({ ix, iz, res: tileResolution(dist, { maxSegments, minSegments, lodBias, tileSize }) });
      }
    }
    return result;
  }
  function countTiles2(camX = 0, camZ = 0) {
    return tilesFor(camX, camZ).length;
  }
  function build(camX, camZ) {
    const t0 = performance.now();
    const tileList = tilesFor(camX, camZ);
    let quadCount = 0;
    for (const tile of tileList) {
      quadCount += tile.res * tile.res + (skirtDepth > 0 ? 4 * tile.res : 0);
    }
    const positions = new Float32Array(quadCount * 6 * 3);
    const normals = new Float32Array(quadCount * 6 * 3);
    const uvs = new Float32Array(quadCount * 6 * 2);
    const cursor = { v: 0 };
    levelCounts = [];
    const maxLevel = Math.max(1, Math.log2(maxSegments / minSegments));
    for (const tile of tileList) {
      const level = Math.round(Math.log2(maxSegments / tile.res));
      while (levelCounts.length <= level)
        levelCounts.push(0);
      levelCounts[level] = (levelCounts[level] ?? 0) + 1;
      emitTile(tile, positions, normals, uvs, cursor, level / maxLevel);
    }
    lastMs = performance.now() - t0;
    tiles = tileList.length;
    lastX = camX;
    lastZ = camZ;
    return { positions, normals, uvs, vertexCount: cursor.v };
  }
  function emitTile(tile, positions, normals, uvs, cursor, lodNorm) {
    const res = tile.res;
    const step = tileSize / res;
    const x0 = tile.ix * tileSize;
    const z0 = tile.iz * tileSize;
    const dim = res + 3;
    const heights = new Float32Array(dim * dim);
    for (let j = 0;j < dim; j++) {
      const wz = z0 + (j - 1) * step;
      for (let i = 0;i < dim; i++) {
        const wx = x0 + (i - 1) * step;
        heights[j * dim + i] = heightFn(wx, wz) * amplitude;
      }
    }
    const at = (i, j) => heights[(j + 1) * dim + (i + 1)];
    const emit = (i, j, yOverride, nOverride) => {
      const v = cursor.v;
      const h = yOverride ?? at(i, j);
      positions[v * 3] = x0 + i * step;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = z0 + j * step;
      if (nOverride !== undefined) {
        normals[v * 3] = nOverride[0];
        normals[v * 3 + 1] = nOverride[1];
        normals[v * 3 + 2] = nOverride[2];
      } else {
        const dhdx = (at(i + 1, j) - at(i - 1, j)) / (2 * step);
        const dhdz = (at(i, j + 1) - at(i, j - 1)) / (2 * step);
        let nx = -dhdx;
        const ny = 1;
        let nz = -dhdz;
        const len = Math.hypot(nx, ny, nz);
        nx /= len;
        nz /= len;
        normals[v * 3] = nx;
        normals[v * 3 + 1] = ny / len;
        normals[v * 3 + 2] = nz;
      }
      uvs[v * 2] = lodNorm;
      uvs[v * 2 + 1] = hNorm(h);
      cursor.v = v + 1;
    };
    for (let j = 0;j < res; j++) {
      for (let i = 0;i < res; i++) {
        emit(i, j);
        emit(i, j + 1);
        emit(i + 1, j + 1);
        emit(i, j);
        emit(i + 1, j + 1);
        emit(i + 1, j);
      }
    }
    if (skirtDepth <= 0)
      return;
    const drop = skirtDepth * amplitude;
    const down = (i, j, n) => {
      emit(i, j, at(i, j) - drop, n);
    };
    const skirt = (count, edgeA, edgeB, reverse) => {
      for (let k = 0;k < count; k++) {
        const k0 = reverse ? k + 1 : k;
        const k1 = reverse ? k : k + 1;
        edgeA(k0);
        edgeA(k1);
        edgeB(k1);
        edgeA(k0);
        edgeB(k1);
        edgeB(k0);
      }
    };
    skirt(res, (k) => emit(0, k), (k) => down(0, k, [-1, 0, 0]), true);
    skirt(res, (k) => emit(res, k), (k) => down(res, k, [1, 0, 0]), false);
    skirt(res, (k) => emit(k, 0), (k) => down(k, 0, [0, 0, -1]), false);
    skirt(res, (k) => emit(k, res), (k) => down(k, res, [0, 0, 1]), true);
  }
  return {
    get geometry() {
      return geometry;
    },
    update(camX, camZ) {
      if (Math.hypot(camX - lastX, camZ - lastZ) < tileSize / 2)
        return false;
      geometry = build(camX, camZ);
      rebuilds++;
      return true;
    },
    get rebuilds() {
      return rebuilds;
    },
    get tiles() {
      return tiles;
    },
    get lastMs() {
      return lastMs;
    },
    get center() {
      return { x: lastX, z: lastZ };
    },
    get levelCounts() {
      return levelCounts;
    }
  };
}
function worldHills(seed = 7) {
  return (x, z) => fbm2D(x * 0.3, z * 0.3, seed, 5) - 0.5;
}
function worldRidged(seed = 11) {
  return (x, z) => (ridged2D(x * 0.22, z * 0.22, seed, 6, 1.4) - 0.45) * 1.2;
}
function worldDunes(seed = 5) {
  return (x, z) => {
    const warp = fbm2D(x * 0.2, z * 0.2, seed, 3) * 0.8;
    const ridge = Math.abs(Math.sin((x * 0.55 + warp * 1.8 + z * 0.18) * Math.PI));
    const soft = fbm2D(x * 0.6, z * 0.6, seed + 91, 2) * 0.25;
    return ridge * 0.7 + soft - 0.35;
  };
}
function worldCanyon(seed = 9) {
  return (x, z) => {
    const base = fbm2D(x * 0.18, z * 0.18, seed, 4);
    const steps = 6;
    const q = Math.floor(base * steps) / steps;
    const cliff = base - q;
    const terrace = q + Math.pow(cliff * steps, 4) / steps;
    return (terrace - 0.45) * 1.1;
  };
}
function worldIsland(seed = 3) {
  return (x, z) => {
    const d = Math.hypot(x, z);
    const falloff = 1 - Math.min(1, Math.pow(d / 10, 2.2));
    const hills = fbm2D(x * 0.3, z * 0.3, seed, 5);
    return (hills * 1.2 - 0.25) * falloff - (1 - falloff) * 0.35;
  };
}
var adaptivePresets = {
  hills: { label: "Hills", height: worldHills, amplitude: 1, note: "fBm over the world: LOD rings around the camera, skirts at seams" },
  ridged: { label: "Ridges", height: worldRidged, amplitude: 1.1, note: "ridged ridges: sharp peaks fade into coarse far rings" },
  island: { label: "Island", height: worldIsland, amplitude: 1.3, note: "radial falloff: an ocean up to the fog — you can see LOD muting the distance" },
  dunes: { label: "Dunes", height: worldDunes, amplitude: 0.6, note: "anisotropic ridges: skirts hold the seams under displace" },
  canyon: { label: "Canyon", height: worldCanyon, amplitude: 1, note: "step terraces: flat plateaus read at any LOD" }
};

// packages/prims/src/registry.ts
function segmentValue(base, k, min, max) {
  return Math.max(min, Math.min(max, Math.round(base * k)));
}
var TERRAIN_SIZE = 2.4;
function terrainEntry(id, presetKey, note) {
  const preset = terrainPresets[presetKey];
  return {
    id,
    label: preset.label,
    group: "Terrains",
    note,
    offsetY: -0.25,
    dist: 3.4,
    params: [
      { key: "seed", label: "Relief seed", min: 1, max: 999, step: 1, def: 7, integer: true },
      { key: "amp", label: "Amplitude", min: 0.4, max: 2.5, step: 0.1, def: preset.amplitude },
      { key: "segs", label: "Segments", min: 16, max: 256, step: 8, def: 96, segment: true }
    ],
    make: (v, _k) => terrain(TERRAIN_SIZE, v.segs ?? 96, preset.height(v.seed ?? 7), { amplitude: v.amp ?? preset.amplitude })
  };
}
function adaptiveEntry(id, presetKey, note) {
  const preset = adaptivePresets[presetKey];
  return {
    id,
    label: preset.label,
    group: "Adaptive relief",
    note,
    offsetY: -0.2,
    dist: 7.5,
    params: [
      { key: "seed", label: "Relief seed", min: 1, max: 999, step: 1, def: 7, integer: true },
      { key: "amp", label: "Amplitude", min: 0.3, max: 2.5, step: 0.1, def: preset.amplitude },
      { key: "radius", label: "Build radius", min: 8, max: 48, step: 4, def: 20, integer: true },
      { key: "tile", label: "Tile size", min: 2, max: 8, step: 1, def: 4, integer: true },
      { key: "maxSeg", label: "Max segments", min: 8, max: 64, step: 8, def: 24, segment: true },
      { key: "skirt", label: "Skirts at seams", min: 0, max: 1, step: 1, def: 1, bool: true }
    ],
    make: (v, k) => {
      return createAdaptiveTerrain({
        heightFn: preset.height(v.seed ?? 7),
        amplitude: v.amp ?? preset.amplitude,
        radius: v.radius ?? 20,
        tileSize: v.tile ?? 4,
        maxSegments: v.maxSeg ?? 24,
        skirtDepth: (v.skirt ?? 1) > 0.5 ? 0.4 : 0
      }).geometry;
    },
    adaptive: (v) => ({
      heightFn: preset.height(v.seed ?? 7),
      amplitude: v.amp ?? preset.amplitude,
      radius: v.radius ?? 20,
      tileSize: v.tile ?? 4,
      maxSegments: v.maxSeg ?? 24,
      skirtDepth: (v.skirt ?? 1) > 0.5 ? 0.4 : 0
    })
  };
}
var RAW_SHAPES = [
  {
    id: "box",
    label: "Box",
    group: "Basic",
    note: "width×height×depth, SEGMENTS PER FACE (like three.js BoxGeometry)",
    params: [
      { key: "width", label: "Width X", min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: "height", label: "Height Y", min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: "depth", label: "Depth Z", min: 0.4, max: 2.5, step: 0.05, def: 1.4 },
      { key: "segX", label: "Segments X", min: 1, max: 24, step: 1, def: 6, segment: true },
      { key: "segY", label: "Segments Y", min: 1, max: 24, step: 1, def: 6, segment: true },
      { key: "segZ", label: "Segments Z", min: 1, max: 24, step: 1, def: 6, segment: true }
    ],
    make: (v) => box({
      width: v.width,
      height: v.height,
      depth: v.depth,
      widthSegments: v.segX,
      heightSegments: v.segY,
      depthSegments: v.segZ
    })
  },
  {
    id: "plane",
    label: "Plane",
    group: "Basic",
    note: "A width×height rectangle with INDEPENDENT segments per axis, +Y normal",
    params: [
      { key: "width", label: "Width X", min: 0.5, max: 4, step: 0.1, def: 2.2 },
      { key: "height", label: "Depth Z", min: 0.5, max: 4, step: 0.1, def: 1.6 },
      { key: "segX", label: "Segments X", min: 1, max: 96, step: 1, def: 24, segment: true },
      { key: "segY", label: "Segments Z", min: 1, max: 96, step: 1, def: 16, segment: true }
    ],
    make: (v) => plane({
      width: v.width,
      height: v.height,
      widthSegments: v.segX,
      heightSegments: v.segY
    })
  },
  {
    id: "sphere",
    label: "Sphere",
    group: "Basic",
    note: "UV sphere: widthSegments × heightSegments (like SphereGeometry), poles without holes",
    params: [
      { key: "radius", label: "Radius", min: 0.5, max: 2, step: 0.05, def: 1 },
      { key: "segW", label: "Segments (longitude)", min: 8, max: 256, step: 4, def: 48, segment: true },
      { key: "segH", label: "Bands (latitude)", min: 4, max: 128, step: 2, def: 32, segment: true }
    ],
    make: (v) => sphere({
      radius: v.radius,
      widthSegments: v.segW,
      heightSegments: v.segH
    })
  },
  {
    id: "cylinder",
    label: "Cylinder",
    group: "Basic",
    note: "A truncated cone with caps; rTop=0 — a cone; openEnded — without caps",
    params: [
      { key: "rTop", label: "Top radius", min: 0, max: 1.2, step: 0.05, def: 0.7 },
      { key: "rBot", label: "Bottom radius", min: 0.3, max: 1.2, step: 0.05, def: 0.9 },
      { key: "height", label: "Height", min: 0.6, max: 2.6, step: 0.1, def: 1.8 },
      { key: "segR", label: "Segments (around)", min: 3, max: 256, step: 1, def: 48, segment: true },
      { key: "segH", label: "Bands (height)", min: 1, max: 32, step: 1, def: 1, segment: true },
      { key: "open", label: "No caps (openEnded)", min: 0, max: 1, step: 1, def: 0, bool: true }
    ],
    make: (v) => cylinder({
      radiusTop: v.rTop,
      radiusBottom: v.rBot,
      height: v.height,
      radialSegments: v.segR,
      heightSegments: v.segH,
      openEnded: (v.open ?? 0) > 0.5
    })
  },
  {
    id: "cone",
    label: "Cone",
    group: "Basic",
    note: "An apex without degenerate triangles; openEnded — without the base",
    params: [
      { key: "radius", label: "Radius", min: 0.4, max: 1.2, step: 0.05, def: 0.9 },
      { key: "height", label: "Height", min: 0.8, max: 2.6, step: 0.1, def: 1.8 },
      { key: "segR", label: "Segments (around)", min: 3, max: 256, step: 1, def: 48, segment: true },
      { key: "segH", label: "Bands (height)", min: 1, max: 32, step: 1, def: 1, segment: true },
      { key: "open", label: "Without the base", min: 0, max: 1, step: 1, def: 0, bool: true }
    ],
    make: (v) => cone({
      radius: v.radius,
      height: v.height,
      radialSegments: v.segR,
      heightSegments: v.segH,
      openEnded: (v.open ?? 0) > 0.5
    })
  },
  {
    id: "capsule",
    label: "Capsule",
    group: "Basic",
    note: "Cylinder + hemispheres (height — the cylindrical part, as in three.js)",
    params: [
      { key: "radius", label: "Radius", min: 0.25, max: 0.9, step: 0.05, def: 0.55 },
      { key: "height", label: "Body length", min: 0.4, max: 1.8, step: 0.05, def: 1.1 },
      { key: "segR", label: "Segments (around)", min: 3, max: 128, step: 1, def: 40, segment: true },
      { key: "segH", label: "Bands per hemisphere", min: 2, max: 64, step: 1, def: 12, segment: true }
    ],
    make: (v) => capsule({
      radius: v.radius,
      height: v.height,
      radialSegments: v.segR,
      capSegments: v.segH
    })
  },
  {
    id: "torus",
    label: "Torus",
    group: "Curves",
    note: "A tube of tube around a radius ring; radial — around the tube, tubular — around the axis",
    params: [
      { key: "radius", label: "Ring radius", min: 0.6, max: 1.5, step: 0.05, def: 1 },
      { key: "tube", label: "Tube radius", min: 0.12, max: 0.6, step: 0.02, def: 0.38 },
      { key: "segR", label: "Tube segments", min: 3, max: 96, step: 1, def: 28, segment: true },
      { key: "segT", label: "Ring segments", min: 8, max: 256, step: 4, def: 64, segment: true }
    ],
    make: (v) => torus({
      radius: v.radius,
      tube: v.tube,
      radialSegments: v.segR,
      tubularSegments: v.segT
    })
  },
  {
    id: "knot",
    label: "Knot (p,q)",
    group: "Curves",
    note: "A torus knot: p windings × q loops; change p/q — the knot reconfigures",
    dist: 4.6,
    params: [
      { key: "p", label: "p (windings)", min: 1, max: 5, step: 1, def: 2, integer: true },
      { key: "q", label: "q (loops)", min: 2, max: 7, step: 1, def: 3, integer: true },
      { key: "tube", label: "Tube radius", min: 0.08, max: 0.4, step: 0.02, def: 0.26 },
      { key: "scale", label: "Scale", min: 0.25, max: 0.8, step: 0.05, def: 0.45 },
      { key: "segT", label: "Curve segments", min: 16, max: 640, step: 8, def: 220, segment: true },
      { key: "segR", label: "Tube segments", min: 3, max: 32, step: 1, def: 14, segment: true }
    ],
    make: (v) => torusKnot({
      p: Math.round(v.p ?? 2),
      q: Math.round(v.q ?? 3),
      tube: v.tube,
      scale: v.scale,
      tubularSegments: v.segT,
      radialSegments: v.segR
    })
  },
  {
    id: "tetra",
    label: "Tetrahedron",
    group: "Platonic",
    note: "4 faces, flat shading; detail — subdivision with projection onto the sphere",
    params: [
      { key: "radius", label: "Radius", min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: "detail", label: "Detail (subdivision)", min: 0, max: 4, step: 1, def: 0, integer: true }
    ],
    make: (v) => tetrahedron({ radius: v.radius, detail: v.detail })
  },
  {
    id: "octa",
    label: "Octahedron",
    group: "Platonic",
    note: "8 faces; detail ≥ 1 — a geodesic sphere from the octahedron",
    params: [
      { key: "radius", label: "Radius", min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: "detail", label: "Detail (subdivision)", min: 0, max: 4, step: 1, def: 0, integer: true }
    ],
    make: (v) => octahedron({ radius: v.radius, detail: v.detail })
  },
  {
    id: "icosa",
    label: "Icosahedron",
    group: "Platonic",
    note: "20 faces; detail 1/2/3 — geodesic spheres with 80/320/1280 faces",
    params: [
      { key: "radius", label: "Radius", min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: "detail", label: "Detail (subdivision)", min: 0, max: 4, step: 1, def: 0, integer: true }
    ],
    make: (v) => icosahedron({ radius: v.radius, detail: v.detail })
  },
  {
    id: "dodeca",
    label: "Dodecahedron",
    group: "Platonic",
    note: "12 pentagonal faces (dual to the icosahedron); detail — a sphere-dodeca",
    params: [
      { key: "radius", label: "Radius", min: 0.6, max: 1.6, step: 0.05, def: 1.1 },
      { key: "detail", label: "Detail (subdivision)", min: 0, max: 3, step: 1, def: 0, integer: true }
    ],
    make: (v) => dodecahedron({ radius: v.radius, detail: v.detail })
  },
  {
    id: "disk",
    label: "Disk",
    group: "Other",
    note: "A circle in the XZ plane, +Y normal (CircleGeometry)",
    params: [
      { key: "radius", label: "Radius", min: 0.5, max: 1.6, step: 0.05, def: 1.1 },
      { key: "segs", label: "Segments", min: 3, max: 256, step: 1, def: 64, segment: true }
    ],
    make: (v) => disk({ radius: v.radius, segments: v.segs })
  },
  {
    id: "ring",
    label: "Ring",
    group: "Other",
    note: "Annulus — a flat washer (RingGeometry)",
    params: [
      { key: "inner", label: "Inner R", min: 0.2, max: 0.9, step: 0.05, def: 0.55 },
      { key: "outer", label: "Outer R", min: 0.8, max: 1.6, step: 0.05, def: 1.1 },
      { key: "segs", label: "Segments", min: 3, max: 256, step: 1, def: 64, segment: true }
    ],
    make: (v) => ring({ innerRadius: v.inner, outerRadius: v.outer, segments: v.segs })
  },
  terrainEntry("t-hills", "hills", "A single plane with a heightmap (fBm): the base of the adaptive relief"),
  terrainEntry("t-ridged", "ridged", "Ridged multifractal: sharp ridges"),
  terrainEntry("t-island", "island", "Hills × radial falloff: beach → mountains"),
  terrainEntry("t-dunes", "dunes", "Anisotropic |sin| ridges, wind-blown sands"),
  terrainEntry("t-canyon", "canyon", "Step terraces: table plateaus"),
  terrainEntry("t-volcano", "volcano", "A cone with a crater + a noisy rim"),
  adaptiveEntry("a-hills", "hills", "LOD tiles around the camera: near ones detailed, far ones coarse; skirts at seams"),
  adaptiveEntry("a-ridged", "ridged", "Ridges in LOD rings — sharp ridges fade in the distance"),
  adaptiveEntry("a-island", "island", "An island in an ocean up to the fog: you can see the distance being muted by LOD"),
  adaptiveEntry("a-dunes", "dunes", "Dunes: tile seams keep their skirts under displacement"),
  adaptiveEntry("a-canyon", "canyon", "Canyon: flat plateaus read at any LOD level")
];
var SHAPES = RAW_SHAPES.map(withDetail);
function withDetail(shape) {
  const segParams = shape.params.filter((p) => p.segment === true);
  if (segParams.length === 0)
    return shape;
  const baseMake = shape.make;
  return {
    ...shape,
    make: (values, k) => {
      if (k === 1)
        return baseMake(values, k);
      const scaled = { ...values };
      for (const p of segParams) {
        scaled[p.key] = segmentValue(values[p.key] ?? p.def, k, p.min, p.max);
      }
      return baseMake(scaled, 1);
    }
  };
}
// packages/prims/src/quadtree.ts
var PATCH_CELLS = 32;
var PATCH_VERTEX_COUNT = (PATCH_CELLS + 3) * (PATCH_CELLS + 3);
var PATCH_TRIANGLE_COUNT = (PATCH_CELLS + 2) * (PATCH_CELLS + 2) * 2;
var PATCH_WIRE_EDGE_COUNT = PATCH_CELLS * (PATCH_CELLS + 1) * 2;
var MAX_INSTANCES = 2048;
var LEAF_STACK_CAP = 320;
var leafStack = new Float64Array(LEAF_STACK_CAP * 3);
var leafInstances = new Float32Array(MAX_INSTANCES * 4);

// packages/prims/src/terrainQuadtree.ts
function terrainHills(seed = 7) {
  return (x, z) => fbm2D(x / 900, z / 900, seed, 5) * 34;
}
function terrainRidges(seed = 11) {
  return (x, z) => ridged2D(x / 1100, z / 1100, seed, 5) * 90;
}
function terrainDunes(seed = 5) {
  return (x, z) => Math.abs(Math.sin(x / 260 + fbm2D(x / 2000, z / 2000, seed, 2) * 2)) * 14 + fbm2D(x / 700, z / 700, seed + 1, 3) * 5;
}
function terrainCanyon(seed = 9) {
  const terrace = (v) => Math.round(v * 6) / 6;
  return (x, z) => terrace(fbm2D(x / 1500, z / 1500, seed, 4)) * 120 + fbm2D(x / 300, z / 300, seed + 2, 3) * 6;
}
var terrainQuadtreePresets = [
  { id: "hills", label: "Hills", note: "fBm 5 octaves, amplitude 34 m", heightFn: terrainHills(), amplitude: 34 },
  { id: "ridges", label: "Ridges", note: "ridged fBm, amplitude 90 m", heightFn: terrainRidges(), amplitude: 90 },
  { id: "dunes", label: "Dunes", note: "anisotropic ridges, amplitude 19 m", heightFn: terrainDunes(), amplitude: 19 },
  { id: "canyon", label: "Canyon", note: "terraces with cliffs", heightFn: terrainCanyon(), amplitude: 126 }
];
// packages/gl/src/surface.ts
init_src();
var FULLSCREEN_QUAD = quad();
var PASS_VERT_GLSL = `#version 300 es
layout(location = 0) in vec2 position;
layout(location = 1) in vec2 uv;
out vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}`;
var PASS_VERT_WGSL = `struct RunePassVsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
}
@vertex
fn vsMain(
  @location(0) position : vec2<f32>,
  @location(1) uv : vec2<f32>,
) -> RunePassVsOut {
  var out : RunePassVsOut;
  out.pos = vec4<f32>(position, 0.0, 1.0);
  out.uv = uv;
  return out;
}
`;
function withTarget(command, targetId, clear) {
  const clearFlag = clear ? 1 : 0;
  return {
    id: command.id,
    record(props, frameCtx, writer) {
      writer.emit(OpCode.BindTarget, targetId, clearFlag, 0, 0);
      command.record(props, frameCtx, writer);
    }
  };
}
var BUILTIN_NAMES = ["u_time", "u_resolution", "u_texel"];
function scanBuiltins(fragment) {
  const found = new Set;
  for (const name of BUILTIN_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(fragment))
      found.add(name);
  }
  return found;
}
function createPassBuiltins() {
  return {
    time: new Float32Array(1),
    resolution: new Float32Array(2),
    texel: new Float32Array(2)
  };
}
function applyBuiltins(uniforms, builtins, values, resolutionSource) {
  if (builtins.has("u_time")) {
    uniforms.u_time = (_props, ctx) => {
      values.time[0] = ctx.time;
      return values.time;
    };
  }
  if (builtins.has("u_resolution")) {
    uniforms.u_resolution = () => {
      const [w, h] = resolutionSource();
      values.resolution[0] = w;
      values.resolution[1] = h;
      return values.resolution;
    };
  }
  if (builtins.has("u_texel")) {
    uniforms.u_texel = () => {
      const [w, h] = resolutionSource();
      values.texel[0] = w > 0 ? 1 / w : 0;
      values.texel[1] = h > 0 ? 1 / h : 0;
      return values.texel;
    };
  }
}

// packages/gl/src/canvasHelpers.ts
function isOffscreenCanvas(canvas) {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas)
    return true;
  return !("clientWidth" in canvas);
}
function getCanvasCssSize(canvas) {
  if (isOffscreenCanvas(canvas)) {
    return [canvas.width, canvas.height];
  }
  const css = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (css > 0 && cssH > 0)
    return [css, cssH];
  return [canvas.width || 1, canvas.height || 1];
}
function canvasDpr(canvas, override) {
  if (override !== undefined)
    return override;
  if (isOffscreenCanvas(canvas))
    return 1;
  return typeof window !== "undefined" ? window.devicePixelRatio ?? 1 : 1;
}
function resolveCanvasAny(target) {
  if (typeof target !== "string")
    return target;
  if (typeof document === "undefined") {
    throw new Error("rune: canvas selector requires DOM — pass an element or OffscreenCanvas directly");
  }
  const canvas = document.querySelector(target);
  if (canvas === null) {
    throw new Error(`rune: canvas "${target}" not found — initialization before DOM? ` + "Wrap createRenderer in DOMContentLoaded or pass an element/OffscreenCanvas.");
  }
  return canvas;
}

// packages/gl/src/journalGl.ts
init_src();
function withJournal(gl, journal) {
  return {
    createProgram: (vertex, fragment) => {
      const id = gl.createProgram(vertex, fragment);
      journal.record({ kind: "createProgram", id, vertex, fragment });
      return id;
    },
    useProgram: (id) => gl.useProgram(id),
    createBuffer: (data) => {
      const id = gl.createBuffer(data);
      journal.record({ kind: "createBuffer", id, data });
      return id;
    },
    bindVertexBuffer: (bufferId, location, size, stride, byteOffset, divisor) => gl.bindVertexBuffer(bufferId, location, size, stride, byteOffset, divisor),
    updateBuffer: (bufferId, data, byteOffset) => gl.updateBuffer(bufferId, data, byteOffset),
    setUniformMatrix4: (programId, name, values) => gl.setUniformMatrix4(programId, name, values),
    setUniform4fv: (programId, name, values) => gl.setUniform4fv(programId, name, values),
    setUniform3fv: (programId, name, values) => gl.setUniform3fv(programId, name, values),
    setUniform2fv: (programId, name, values) => gl.setUniform2fv(programId, name, values),
    setUniform1f: (programId, name, value) => gl.setUniform1f(programId, name, value),
    setUniform1i: (programId, name, value) => gl.setUniform1i(programId, name, value),
    createTexture: (width, height, options) => {
      const id = gl.createTexture(width, height, options);
      const format = options?.format === "rgba16f" ? "rgba16float" : options?.format === "rgba32f" ? "rgba32float" : undefined;
      journal.record({ kind: "createTexture", id, width, height, format, options });
      return id;
    },
    texSubImage2D: (textureId, x, y, width, height, bytes) => gl.texSubImage2D(textureId, x, y, width, height, bytes),
    texImage2DFromSource: (textureId, source, options) => {
      gl.texImage2DFromSource(textureId, source, options);
      journal.record({
        kind: "texImage2DFromSource",
        textureId,
        sourceKind: describeSourceKind(source),
        flipY: options?.flipY ?? false
      });
    },
    texSubImage2DFromSource: (textureId, x, y, source, options) => gl.texSubImage2DFromSource(textureId, x, y, source, options),
    texImage2DLevel: (textureId, level, source, options) => gl.texImage2DLevel(textureId, level, source, options),
    bindTexture: (textureOrViewId, unit) => gl.bindTexture(textureOrViewId, unit),
    createTextureView: (textureId, options) => {
      const viewId = gl.createTextureView(textureId, options);
      journal.record({
        kind: "createTextureView",
        id: viewId,
        textureId,
        baseMipLevel: options?.baseMipLevel,
        mipLevelCount: options?.mipLevelCount
      });
      return viewId;
    },
    deleteTextureView: (viewId) => {
      gl.deleteTextureView(viewId);
      journal.record({ kind: "destroyTextureView", id: viewId });
    },
    setViewport: (width, height) => gl.setViewport(width, height),
    setDepthMode: (test, write) => gl.setDepthMode(test, write),
    setCull: (mode) => gl.setCull(mode),
    setBlend: (src, dst, equation) => gl.setBlend(src, dst, equation),
    clear: (color, depth2) => gl.clear(color, depth2),
    drawArrays: (mode, first, count, instances) => gl.drawArrays(mode, first, count, instances),
    createTarget: (textureId, width, height, depth2, color) => {
      const id = gl.createTarget(textureId, width, height, depth2, color);
      journal.record({ kind: "createTarget", id, textureId, width, height, depth: depth2, color });
      return id;
    },
    bindTarget: (targetId, clear) => gl.bindTarget(targetId, clear),
    readTargetPixels: (targetId) => gl.readTargetPixels(targetId),
    deleteTexture: (textureId) => {
      gl.deleteTexture(textureId);
      journal.record({ kind: "destroyTexture", id: textureId });
    },
    deleteTarget: (targetId) => {
      gl.deleteTarget(targetId);
      journal.record({ kind: "destroyTarget", id: targetId });
    },
    deleteProgram: (programId) => {
      gl.deleteProgram(programId);
      journal.record({ kind: "destroyProgram", id: programId });
    },
    deleteBuffer: (bufferId) => {
      gl.deleteBuffer(bufferId);
      journal.record({ kind: "destroyBuffer", id: bufferId });
    },
    createTransformPass: (desc) => gl.createTransformPass(desc),
    runTransformPass: (passId, vertexCount, output) => gl.runTransformPass(passId, vertexCount, output),
    deleteTransformPass: (passId) => gl.deleteTransformPass(passId),
    texSubImage2DBuffer: (textureId, x, y, width, height, bufferId, byteOffset) => gl.texSubImage2DBuffer(textureId, x, y, width, height, bufferId, byteOffset)
  };
}
function replayJournalOn(journal, target, sourceFor) {
  journal.replay((op) => applyOp(op, target, sourceFor));
}
function applyOp(op, gl, sourceFor) {
  switch (op.kind) {
    case "createTexture":
      gl.createTexture(op.width, op.height, {
        ...op.options,
        ...op.format === "rgba16float" || op.format === "rgba32float" ? { format: op.format === "rgba16float" ? "rgba16f" : "rgba32f" } : {}
      });
      break;
    case "createProgram":
      gl.createProgram(op.vertex, op.fragment);
      break;
    case "createBuffer":
      gl.createBuffer(op.data instanceof Float32Array ? op.data : toFloat32Array(op.data));
      break;
    case "createTarget":
      gl.createTarget(op.textureId, op.width, op.height, op.depth, op.color);
      break;
    case "texImage2DFromSource": {
      const source = sourceFor?.(op.sourceKind) ?? null;
      if (source === null)
        break;
      gl.texImage2DFromSource(op.textureId, source, { flipY: op.flipY });
      break;
    }
    case "createTextureView":
      gl.createTextureView(op.textureId, {
        baseMipLevel: op.baseMipLevel,
        mipLevelCount: op.mipLevelCount
      });
      break;
    default:
      break;
  }
}
function describeSourceKind(source) {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap)
    return "ImageBitmap";
  if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)
    return "OffscreenCanvas";
  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement)
    return "HTMLCanvasElement";
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement)
    return "HTMLVideoElement";
  if (typeof source === "object" && source !== null) {
    if ("getContext" in source)
      return "OffscreenCanvas";
    if ("close" in source && "width" in source)
      return "ImageBitmap";
  }
  return source.constructor?.name ?? "unknown";
}

// packages/gl/src/resourceSessionGL.ts
init_src();
var VIEW_ID_BASE = 1e6;
function glFormatFromTextureFormat(fmt) {
  if (fmt === "rgba16float")
    return "rgba16f";
  if (fmt === "rgba32float")
    return "rgba32f";
  return;
}
function textureFormatFromGL(fmt) {
  if (fmt === "rgba16f")
    return "rgba16float";
  if (fmt === "rgba32f")
    return "rgba32float";
  return;
}
function createResourceSessionGL(raw, journal) {
  const texMap = new Map;
  const viewMap = new Map;
  const targetMap = new Map;
  let useCounter = 0;
  const lastUse = new Map;
  const viewParent = new Map;
  const targetParent = new Map;
  const texMeta = new Map;
  let nextTex = 1;
  let nextView = VIEW_ID_BASE;
  let nextTarget = 1;
  function touch(textureId) {
    lastUse.set(textureId, ++useCounter);
  }
  function touchTexOrView(texOrViewId) {
    touch(texOrViewId >= VIEW_ID_BASE ? viewParent.get(texOrViewId) ?? texOrViewId : texOrViewId);
  }
  function seedCounters() {
    nextTex = Math.max(nextTex, journal.maxTextureId() + 1);
    nextView = Math.max(nextView, journal.maxViewId() + 1);
    nextTarget = Math.max(nextTarget, journal.maxTargetId() + 1);
  }
  seedCounters();
  const rawTex = (id) => {
    const mapped = texMap.get(id);
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable textureId=${id}. ` + `The resource was not created in this session (or restore() has not been run after device loss).`);
    }
    return mapped;
  };
  const rawView = (id) => {
    const mapped = viewMap.get(id);
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable viewId=${id}.`);
    }
    return mapped;
  };
  const rawTarget = (id) => {
    const mapped = targetMap.get(id);
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable targetId=${id}.`);
    }
    return mapped;
  };
  const rawTexOrView = (id) => id >= VIEW_ID_BASE ? rawView(id) : rawTex(id);
  const facade = {
    createProgram: (vertex, fragment) => raw.createProgram(vertex, fragment),
    useProgram: (programId) => raw.useProgram(programId),
    createBuffer: (data) => raw.createBuffer(data),
    bindVertexBuffer: (bufferId, location, size, stride, byteOffset, divisor) => raw.bindVertexBuffer(bufferId, location, size, stride, byteOffset, divisor),
    updateBuffer: (bufferId, data, byteOffset) => raw.updateBuffer(bufferId, data, byteOffset),
    setUniformMatrix4: (programId, name, values) => raw.setUniformMatrix4(programId, name, values),
    setUniform4fv: (programId, name, values) => raw.setUniform4fv(programId, name, values),
    setUniform3fv: (programId, name, values) => raw.setUniform3fv(programId, name, values),
    setUniform2fv: (programId, name, values) => raw.setUniform2fv(programId, name, values),
    setUniform1f: (programId, name, value) => raw.setUniform1f(programId, name, value),
    setUniform1i: (programId, name, value) => raw.setUniform1i(programId, name, value),
    createTexture: (width, height, options) => {
      const rawId = raw.createTexture(width, height, options);
      const id = nextTex++;
      texMap.set(id, rawId);
      const format = textureFormatFromGL(options?.format);
      const { format: _glFmt, ...rest } = options ?? {};
      const journalOptions = Object.keys(rest).length > 0 ? rest : undefined;
      texMeta.set(id, { w: width, h: height, mips: options?.mipLevels ?? 1, format });
      touch(id);
      journal.record({ kind: "texture.create", id, width, height, format, options: journalOptions });
      return id;
    },
    texImage2DFromSource: (textureId, source, options) => {
      raw.texImage2DFromSource(rawTex(textureId), source, options);
      touch(textureId);
      const [w, h] = glSourceSize(source);
      const content = journal.storeSource(source, describeSourceKind2(source), w, h);
      journal.record({ kind: "texture.write", id: textureId, content, flipY: options?.flipY ?? false });
    },
    texSubImage2DFromSource: (textureId, x, y, source, options) => {
      raw.texSubImage2DFromSource(rawTex(textureId), x, y, source, options);
      touch(textureId);
      const [w, h] = glSourceSize(source);
      const content = journal.storeSource(source, describeSourceKind2(source), w, h);
      journal.record({ kind: "texture.update", id: textureId, x, y, w, h, content, flipY: options?.flipY ?? false });
    },
    texImage2DLevel: (textureId, level, source, options) => {
      raw.texImage2DLevel(rawTex(textureId), level, source, options);
      touch(textureId);
      const [w, h] = glSourceSize(source);
      const content = journal.storeSource(source, describeSourceKind2(source), w, h);
      journal.record({ kind: "texture.writeMip", id: textureId, level, content, flipY: options?.flipY ?? false });
    },
    texSubImage2D: (textureId, x, y, width, height, bytes) => {
      touch(textureId);
      raw.texSubImage2D(rawTex(textureId), x, y, width, height, bytes);
    },
    bindTexture: (textureOrViewId, unit) => {
      touchTexOrView(textureOrViewId);
      raw.bindTexture(rawTexOrView(textureOrViewId), unit);
    },
    createTextureView: (textureId, options) => {
      const rawViewId = raw.createTextureView(rawTex(textureId), options);
      const id = nextView++;
      viewMap.set(id, rawViewId);
      viewParent.set(id, textureId);
      touch(textureId);
      journal.record({
        kind: "view.create",
        id,
        textureId,
        baseMipLevel: options?.baseMipLevel,
        mipLevelCount: options?.mipLevelCount
      });
      return id;
    },
    deleteTextureView: (viewId) => {
      const mapped = viewMap.get(viewId);
      if (mapped !== undefined)
        raw.deleteTextureView(mapped);
      viewMap.delete(viewId);
      viewParent.delete(viewId);
      journal.record({ kind: "view.destroy", id: viewId });
    },
    createTarget: (textureId, width, height, depth2, color) => {
      const rawId = raw.createTarget(rawTex(textureId), width, height, depth2, color);
      const id = nextTarget++;
      targetMap.set(id, rawId);
      targetParent.set(id, textureId);
      touch(textureId);
      journal.record({ kind: "target.create", id, textureId, width, height, depth: depth2, color });
      return id;
    },
    bindTarget: (targetId, clear) => {
      if (targetId !== 0) {
        const parent = targetParent.get(targetId);
        if (parent !== undefined)
          touch(parent);
      }
      raw.bindTarget(targetId === 0 ? 0 : rawTarget(targetId), clear);
    },
    readTargetPixels: (targetId) => raw.readTargetPixels(targetId === 0 ? 0 : rawTarget(targetId)),
    deleteTarget: (targetId) => {
      const mapped = targetMap.get(targetId);
      if (mapped !== undefined)
        raw.deleteTarget(mapped);
      targetMap.delete(targetId);
      targetParent.delete(targetId);
      journal.record({ kind: "target.destroy", id: targetId });
    },
    deleteTexture: (textureId) => {
      const mapped = texMap.get(textureId);
      if (mapped !== undefined)
        raw.deleteTexture(mapped);
      texMap.delete(textureId);
      texMeta.delete(textureId);
      lastUse.delete(textureId);
      journal.record({ kind: "texture.destroy", id: textureId });
    },
    setViewport: (width, height) => raw.setViewport(width, height),
    setDepthMode: (test, write) => raw.setDepthMode(test, write),
    setCull: (mode) => raw.setCull(mode),
    setBlend: (src, dst, equation) => raw.setBlend(src, dst, equation),
    clear: (color, depth2) => raw.clear(color, depth2),
    drawArrays: (mode, first, count, instances) => raw.drawArrays(mode, first, count, instances),
    deleteProgram: (programId) => raw.deleteProgram(programId),
    deleteBuffer: (bufferId) => raw.deleteBuffer(bufferId),
    createTransformPass: (desc) => raw.createTransformPass(desc),
    runTransformPass: (passId, vertexCount, output) => raw.runTransformPass(passId, vertexCount, output),
    deleteTransformPass: (passId) => raw.deleteTransformPass(passId),
    texSubImage2DBuffer: (textureId, x, y, width, height, bufferId, byteOffset) => raw.texSubImage2DBuffer(rawTex(textureId), x, y, width, height, bufferId, byteOffset)
  };
  function applyOp2(op, acc) {
    switch (op.kind) {
      case "texture.create": {
        const glFormat = glFormatFromTextureFormat(op.format);
        const rawId = raw.createTexture(op.width, op.height, glFormat === undefined ? op.options : { ...op.options, format: glFormat });
        texMap.set(op.id, rawId);
        texMeta.set(op.id, { w: op.width, h: op.height, mips: op.options?.mipLevels ?? 1, format: op.format });
        touch(op.id);
        acc.textureIds.push(op.id);
        acc.opsReplayed++;
        break;
      }
      case "texture.write": {
        const source = journal.getSource(op.content.ref);
        if (source === null || !sourceAlive(source)) {
          acc.skipped++;
          break;
        }
        raw.texImage2DFromSource(rawTex(op.id), source, { flipY: op.flipY });
        touch(op.id);
        acc.contentOps++;
        acc.opsReplayed++;
        break;
      }
      case "texture.update": {
        const source = journal.getSource(op.content.ref);
        if (source === null || !sourceAlive(source)) {
          acc.skipped++;
          break;
        }
        raw.texSubImage2DFromSource(rawTex(op.id), op.x, op.y, source, { flipY: op.flipY });
        touch(op.id);
        acc.contentOps++;
        acc.opsReplayed++;
        break;
      }
      case "texture.writeMip": {
        const source = journal.getSource(op.content.ref);
        if (source === null || !sourceAlive(source)) {
          acc.skipped++;
          break;
        }
        raw.texImage2DLevel(rawTex(op.id), op.level, source, { flipY: op.flipY });
        touch(op.id);
        acc.contentOps++;
        acc.opsReplayed++;
        break;
      }
      case "view.create": {
        const rawViewId = raw.createTextureView(rawTex(op.textureId), {
          baseMipLevel: op.baseMipLevel,
          mipLevelCount: op.mipLevelCount
        });
        viewMap.set(op.id, rawViewId);
        viewParent.set(op.id, op.textureId);
        touch(op.textureId);
        acc.viewIds.push(op.id);
        acc.opsReplayed++;
        break;
      }
      case "target.create": {
        const rawId = raw.createTarget(rawTex(op.textureId), op.width, op.height, op.depth, op.color);
        targetMap.set(op.id, rawId);
        targetParent.set(op.id, op.textureId);
        touch(op.textureId);
        acc.targetIds.push(op.id);
        acc.opsReplayed++;
        break;
      }
      default:
        break;
    }
  }
  function restore(keep) {
    seedCounters();
    texMap.clear();
    viewMap.clear();
    targetMap.clear();
    viewParent.clear();
    targetParent.clear();
    texMeta.clear();
    lastUse.clear();
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [], viewIds: [], targetIds: [] };
    if (keep !== undefined) {
      const sel = selectResidentOps(journal.entries(), keep);
      for (const op of sel.ops)
        applyOp2(op, acc);
      return {
        ...acc,
        deferred: { textures: sel.deferredTextures, views: sel.deferredViews, targets: sel.deferredTargets }
      };
    }
    journal.replay((op) => applyOp2(op, acc));
    return { ...acc };
  }
  function ensureResident(resourceId) {
    if (resourceId >= VIEW_ID_BASE) {
      if (viewMap.has(resourceId))
        return null;
      const sel2 = selectResidentOps(journal.entries(), { viewIds: [resourceId] });
      const acc2 = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [], viewIds: [], targetIds: [] };
      for (const op of sel2.ops)
        applyOp2(op, acc2);
      return { ...acc2 };
    }
    if (texMap.has(resourceId))
      return null;
    const isTexture = journal.entries().some((op) => op.kind === "texture.create" && op.id === resourceId);
    const sel = selectResidentOps(journal.entries(), isTexture ? { textureIds: [resourceId] } : { targetIds: [resourceId] });
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [], viewIds: [], targetIds: [] };
    for (const op of sel.ops)
      applyOp2(op, acc);
    return { ...acc };
  }
  function pinnedTextures(pinned) {
    const pin = new Set(pinned?.textureIds ?? []);
    if (pinned?.viewIds !== undefined || pinned?.targetIds !== undefined) {
      for (const op of journal.entries()) {
        if (op.kind === "view.create" && pinned.viewIds?.includes(op.id))
          pin.add(op.textureId);
        else if (op.kind === "target.create" && pinned.targetIds?.includes(op.id))
          pin.add(op.textureId);
      }
    }
    return pin;
  }
  function residencyEntries() {
    const entries = [];
    for (const id of texMap.keys()) {
      const meta = texMeta.get(id);
      const bytes = meta !== undefined ? estimateTextureBytes(meta.w, meta.h, meta.mips, meta.format) : 0;
      entries.push({ id, bytes, lastUse: lastUse.get(id) ?? 0 });
    }
    return entries;
  }
  function residencyStats() {
    const textures = residencyEntries().sort((a, b) => a.lastUse - b.lastUse || a.id - b.id);
    return {
      textures,
      totalBytes: textures.reduce((sum, e) => sum + e.bytes, 0),
      views: [...viewMap.keys()].sort((a, b) => a - b),
      targets: [...targetMap.keys()].sort((a, b) => a - b)
    };
  }
  function evictLRU(options) {
    const budget = options?.budgetBytes ?? Number.POSITIVE_INFINITY;
    const pin = pinnedTextures(options?.pinned);
    const entries = residencyEntries();
    const plan = selectLRUEvictions(entries, budget, pin);
    const evictedViews = [];
    const evictedTargets = [];
    for (const texId of plan.evictIds) {
      for (const [viewId, parent] of viewParent) {
        if (parent === texId && viewMap.has(viewId)) {
          raw.deleteTextureView(viewMap.get(viewId));
          viewMap.delete(viewId);
          viewParent.delete(viewId);
          evictedViews.push(viewId);
        }
      }
      for (const [targetId, parent] of targetParent) {
        if (parent === texId && targetMap.has(targetId)) {
          raw.deleteTarget(targetMap.get(targetId));
          targetMap.delete(targetId);
          targetParent.delete(targetId);
          evictedTargets.push(targetId);
        }
      }
      const mapped = texMap.get(texId);
      if (mapped !== undefined)
        raw.deleteTexture(mapped);
      texMap.delete(texId);
      texMeta.delete(texId);
      lastUse.delete(texId);
    }
    return {
      textures: plan.evictIds,
      views: evictedViews,
      targets: evictedTargets,
      freedBytes: plan.freedBytes,
      residentBytes: plan.residentBytes,
      residentTextures: [...texMap.keys()].sort((a, b) => a - b)
    };
  }
  return {
    facade,
    get mapping() {
      return texMap;
    },
    rawId(stableId) {
      if (stableId >= VIEW_ID_BASE)
        return viewMap.get(stableId);
      return texMap.get(stableId) ?? targetMap.get(stableId);
    },
    restore,
    ensureResident,
    evictLRU,
    residencyStats
  };
}
function glSourceSize(source) {
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
    return [source.videoWidth || 0, source.videoHeight || 0];
  }
  const s = source;
  if (typeof s.displayWidth === "number" && s.displayWidth > 0)
    return [s.displayWidth, s.displayHeight ?? 0];
  return [s.width ?? 0, s.height ?? 0];
}
function describeSourceKind2(source) {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap)
    return "ImageBitmap";
  if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)
    return "OffscreenCanvas";
  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement)
    return "HTMLCanvasElement";
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement)
    return "HTMLVideoElement";
  if (typeof source === "object" && source !== null) {
    if ("getContext" in source)
      return "OffscreenCanvas";
    if ("close" in source && "width" in source)
      return "ImageBitmap";
  }
  return source.constructor?.name ?? "unknown";
}
function sourceAlive(source) {
  if (source === null || source === undefined)
    return false;
  const s = source;
  if (typeof s.width === "number" && typeof s.height === "number") {
    return s.width > 0 && s.height > 0;
  }
  return true;
}
function applyResOpGL(op, gl, sourceFor) {
  switch (op.kind) {
    case "texture.create": {
      const glFormat = glFormatFromTextureFormat(op.format);
      gl.createTexture(op.width, op.height, glFormat === undefined ? op.options : { ...op.options, format: glFormat });
      break;
    }
    case "texture.write": {
      const source = sourceFor(op.content);
      if (source !== null)
        gl.texImage2DFromSource(op.id, source, { flipY: op.flipY });
      break;
    }
    case "texture.update": {
      const source = sourceFor(op.content);
      if (source !== null)
        gl.texSubImage2DFromSource(op.id, op.x, op.y, source, { flipY: op.flipY });
      break;
    }
    case "texture.writeMip": {
      const source = sourceFor(op.content);
      if (source !== null)
        gl.texImage2DLevel(op.id, op.level, source, { flipY: op.flipY });
      break;
    }
    case "view.create":
      gl.createTextureView(op.textureId, { baseMipLevel: op.baseMipLevel, mipLevelCount: op.mipLevelCount });
      break;
    case "target.create":
      gl.createTarget(op.textureId, op.width, op.height, op.depth, op.color);
      break;
    default:
      break;
  }
}

// packages/gl/src/webgl2Renderer.ts
init_src();

// packages/gl/src/rendererFeed.ts
init_src();
var MSG_FEED_ID = 1;
function fieldInfos(layout) {
  const infos = new Map;
  let offset = 0;
  for (const [name, format] of Object.entries(layout)) {
    infos.set(name, { offset, size: feedFieldSize(format) });
    offset += format === "float32x2" ? 8 : format === "float32x3" ? 12 : format === "float32x4" ? 16 : 4;
  }
  return infos;
}
function coreFeedView(feed, feedId) {
  const u32 = new Uint32Array(feed.buffer);
  const bytes = new Float32Array(feed.buffer, 64, feed.capacity * feed.stride / 4);
  return {
    feedId,
    stride: feed.stride,
    capacity: feed.capacity,
    count: () => Atomics.load(u32, 1),
    bytes: () => bytes,
    recycle: () => {}
  };
}
function createFeedCore(options) {
  const countSignal = signal(0);
  if ("count" in options && typeof options.count === "function") {
    const view = options;
    return {
      channel: null,
      view,
      msgReader: null,
      layout: view.layout,
      stride: view.stride,
      capacity: view.capacity,
      fields: view.layout !== undefined ? fieldInfos(view.layout) : new Map,
      countSignal,
      synced: 0
    };
  }
  const opts = options;
  const mode = opts.mode ?? detectTransport();
  if (mode === "msg") {
    const reader = createMsgFeedReader(MSG_FEED_ID, { layout: opts.layout, capacity: opts.capacity });
    return {
      channel: null,
      view: reader.view,
      msgReader: reader,
      layout: opts.layout,
      stride: feedStride(opts.layout),
      capacity: opts.capacity,
      fields: fieldInfos(opts.layout),
      countSignal,
      synced: 0
    };
  }
  const feed = createFeed({
    layout: opts.layout,
    capacity: opts.capacity,
    policy: opts.policy,
    backing: mode === "memory" ? "local" : "sab"
  });
  return {
    channel: feed,
    view: coreFeedView(feed, MSG_FEED_ID),
    msgReader: null,
    layout: opts.layout,
    stride: feed.stride,
    capacity: feed.capacity,
    fields: fieldInfos(opts.layout),
    countSignal,
    synced: 0
  };
}
function createRendererFeedGL(gl, options) {
  const core = createFeedCore(options);
  const bufferId = gl.createBuffer(core.view.bytes());
  let disposed = false;
  function sync() {
    if (disposed)
      return;
    const published = Math.min(core.view.count(), core.capacity);
    if (published > core.synced) {
      const strideF = core.stride / 4;
      const bytes = core.view.bytes();
      gl.updateBuffer(bufferId, bytes.subarray(core.synced * strideF, published * strideF), core.synced * core.stride);
      core.synced = published;
      core.countSignal.value = published;
    }
    core.view.recycle();
  }
  return {
    get channel() {
      return core.channel;
    },
    get count() {
      return core.countSignal;
    },
    get stride() {
      return core.stride;
    },
    get capacity() {
      return core.capacity;
    },
    attribute: (field, step) => {
      const info = requireField(core, field);
      return { data: core.view.bytes(), size: info.size, stride: core.stride, offset: info.offset, bufferId, step: step ?? "vertex" };
    },
    storage: {
      data: core.view.bytes(),
      stride: core.stride,
      count: core.countSignal
    },
    applyChunks: (chunks) => {
      core.msgReader?.apply(chunks);
    },
    takeRecycled: () => core.msgReader?.takeRecycled() ?? [],
    sync,
    dispose: () => {
      if (disposed)
        return;
      disposed = true;
      gl.deleteBuffer(bufferId);
    }
  };
}
function createRendererFeedGPU(gpu, options) {
  const core = createFeedCore(options);
  let disposed = false;
  function sync() {
    if (disposed)
      return;
    const published = Math.min(core.view.count(), core.capacity);
    if (published > core.synced) {
      gpu.syncVertexBuffer(core.view.bytes(), published * core.stride);
      core.synced = published;
      core.countSignal.value = published;
    }
    core.view.recycle();
  }
  return {
    get channel() {
      return core.channel;
    },
    get count() {
      return core.countSignal;
    },
    get stride() {
      return core.stride;
    },
    get capacity() {
      return core.capacity;
    },
    attribute: (field, step) => {
      const info = requireField(core, field);
      return { data: core.view.bytes(), size: info.size, stride: core.stride, offset: info.offset, step: step ?? "vertex" };
    },
    storage: {
      data: core.view.bytes(),
      stride: core.stride,
      count: core.countSignal
    },
    applyChunks: (chunks) => {
      core.msgReader?.apply(chunks);
    },
    takeRecycled: () => core.msgReader?.takeRecycled() ?? [],
    sync,
    dispose: () => {
      disposed = true;
    }
  };
}
function requireField(core, field) {
  const info = core.fields.get(field);
  if (info === undefined) {
    throw new Error(`rune: feed field "${field}" is not declared in the layout`);
  }
  return info;
}

// packages/gl/src/webgl2Renderer.ts
init_src();
function computeMipLevels(w, h) {
  const minDim = Math.min(w, h);
  if (minDim <= 1)
    return 1;
  return 1 + Math.floor(Math.log2(minDim));
}
var DEFAULT_CLEAR2 = { color: [0.07, 0.08, 0.11, 1], depth: 1 };
function createWebGL2Renderer(options) {
  const canvas = resolveCanvasAny(options.canvas);
  const rawContext = options.createGL === undefined ? acquireWebGL2(canvas) : null;
  const rawGl = options.createGL !== undefined ? options.createGL(canvas) : createRealGL(rawContext, (message) => options.onGlError?.(message));
  const session = options.resources !== undefined ? createResourceSessionGL(rawGl, options.resources) : null;
  const gl = session !== null ? session.facade : options.journal !== undefined ? withJournal(rawGl, options.journal) : rawGl;
  const arena = createUniformArena(64 * 1024);
  const ctx = createCompileContext(arena, "codegen");
  const segments = createSegmentStore(256);
  const clears = [options.clear ?? DEFAULT_CLEAR2];
  const executor = createExecutor({
    gl,
    arena,
    commands: ctx.commands,
    clears,
    segments,
    uniformStrategy: options.uniformStrategy ?? "auto"
  });
  const epoch = createEpoch();
  const layoutGuard = createLayoutGuard();
  const uploads = createUploadScheduler(options.uploads ?? {});
  const transients = createTransientPool();
  const feeds = new Set;
  const builtinValues = createPassBuiltins();
  const writer = createTapeWriter(64);
  const [initW, initH] = getCanvasCssSize(canvas);
  const size = signal([initW, initH]);
  const aspect = derive(() => size.value[0] / size.value[1]);
  const time = signal(0);
  const frameCtx = { time: 0, dt: 0, aspect: 1, size: [1, 1] };
  const lives = [];
  const frameCallbacks = [];
  const startedAt = (options.now ?? defaultNow)();
  let lastNow = startedAt;
  let running = false;
  let cancelScheduled = null;
  let lastCssWidth = -1;
  let lastCssHeight = -1;
  let lastBufferW = -1;
  let lastBufferH = -1;
  let lastDpr = canvasDpr(canvas, options.dpr);
  let dprPollFrame = 0;
  let disposed = false;
  const [startW, startH] = getCanvasCssSize(canvas);
  resize(startW, startH);
  const resizeObserver = observeSize(canvas, options);
  const textureRegistry = makeTextureFinalizationRegistry((textureId) => {
    if (session !== null) {
      const raw = session.rawId(textureId);
      if (raw !== undefined)
        rawGl.deleteTexture(raw);
      return;
    }
    gl.deleteTexture(textureId);
  });
  const ownStatsCollector = options.stats ?? null;
  const statsCollector = ownStatsCollector ?? createStatsCollector(options.now);
  function command(spec) {
    return compileDrawSpec(spec, ctx);
  }
  function surface(surfaceOptions = {}) {
    const width = surfaceOptions.width ?? 512;
    const height = surfaceOptions.height ?? 512;
    const depth2 = surfaceOptions.depth ?? false;
    const color = surfaceOptions.color ?? (options.clear ?? DEFAULT_CLEAR2).color;
    const textureId = gl.createTexture(width, height);
    const targetId = gl.createTarget(textureId, width, height, depth2, color);
    let surfaceDisposed = false;
    const result = {
      targetId,
      texture: { textureId, width, height },
      width,
      height,
      pass: (fragment, passOptions = {}) => createPassCommand(fragment, passOptions, targetId, () => [width, height]),
      capture: (command2, captureOptions = {}) => withTarget(command2, targetId, captureOptions.clear !== false),
      read: () => {
        if (surfaceDisposed) {
          return Promise.reject(new Error("rune: surface.read() after dispose — the surface is already released"));
        }
        try {
          return Promise.resolve({ width, height, data: gl.readTargetPixels(targetId) });
        } catch (e) {
          return Promise.reject(e);
        }
      },
      dispose: () => {
        if (surfaceDisposed)
          return;
        surfaceDisposed = true;
        gl.deleteTarget(targetId);
        gl.deleteTexture(textureId);
      }
    };
    return result;
  }
  function pass(fragment, passOptions = {}) {
    return createPassCommand(fragment, passOptions, 0, () => {
      const [w, h] = size.peek();
      const dprNow = canvasDpr(canvas, options.dpr);
      return [Math.max(1, Math.round(w * dprNow)), Math.max(1, Math.round(h * dprNow))];
    });
  }
  function createPassCommand(fragment, passOptions, targetId, resolutionSource) {
    const builtins = scanBuiltins(fragment);
    const uniforms = { ...passOptions.uniforms };
    applyBuiltins(uniforms, builtins, builtinValues, resolutionSource);
    const textures = {};
    for (const [name, ref] of Object.entries(passOptions.inputs ?? {})) {
      textures[name] = { textureId: ref.textureId };
    }
    const compiled = compileDrawSpec({
      shader: { glsl: { vertex: PASS_VERT_GLSL, fragment } },
      pipeline: { depth: { test: "always", write: false }, raster: { cull: "none" } },
      attributes: {
        position: { data: FULLSCREEN_QUAD.positions, size: 2 },
        uv: { data: FULLSCREEN_QUAD.uvs, size: 2 }
      },
      uniforms,
      textures,
      count: FULLSCREEN_QUAD.vertexCount
    }, ctx);
    return withTarget(compiled, targetId, passOptions.clear === true);
  }
  function texture(width, height, options2) {
    const mipLevels = options2?.mipLevels ?? 1;
    const format = options2?.format;
    const textureId = gl.createTexture(width, height, { mipLevels, maxAnisotropy: options2?.maxAnisotropy, format });
    const bytesPerPixel2 = format === "rgba16f" ? 8 : format === "rgba32f" ? 16 : 4;
    const memBytes = Math.round(width * height * bytesPerPixel2 * (mipLevels > 1 ? 4 / 3 : 1));
    statsCollector?.addMemory(memBytes);
    const handle = makeTextureHandle(textureId, width, height, mipLevels, memBytes);
    textureRegistry.register(handle, textureId);
    return handle;
  }
  function attachTexture(textureId, width, height, mipLevels = 1) {
    return makeTextureHandle(textureId, width, height, Math.max(1, mipLevels), 0);
  }
  function makeTextureViewHandle(viewId, textureId, baseMipLevel, mipLevelCount, onDispose) {
    let viewDisposed = false;
    return {
      viewId,
      textureId,
      baseMipLevel,
      mipLevelCount,
      dispose: () => {
        if (viewDisposed)
          return;
        viewDisposed = true;
        onDispose?.();
        try {
          gl.deleteTextureView(viewId);
        } catch {}
      }
    };
  }
  function attachView(viewId, textureId, baseMipLevel = 0, mipLevelCount) {
    return makeTextureViewHandle(viewId, textureId, baseMipLevel, mipLevelCount);
  }
  function makeTextureHandle(textureId, width, height, mipLevels, memBytes) {
    let manuallyDisposed = false;
    const subViews = new Set;
    const handle = {
      textureId,
      width,
      height,
      mipLevels,
      upload: (source, options2 = {}) => streamTexture(uploads, source, width, height, (tile, bytes) => gl.texSubImage2D(textureId, tile.x, tile.y, tile.width, tile.height, bytes), options2),
      uploadImage: (source, options2) => gl.texImage2DFromSource(textureId, source, options2),
      uploadSubImage: (x, y, source, options2) => gl.texSubImage2DFromSource(textureId, x, y, source, options2),
      uploadMip: (level, source, options2) => gl.texImage2DLevel(textureId, level, source, options2),
      createView: (viewOptions) => {
        const viewId = gl.createTextureView(textureId, viewOptions);
        const view = makeTextureViewHandle(viewId, textureId, viewOptions?.baseMipLevel ?? 0, viewOptions?.mipLevelCount, () => {
          subViews.delete(view);
        });
        subViews.add(view);
        return view;
      },
      dispose: () => {
        if (manuallyDisposed)
          return;
        manuallyDisposed = true;
        for (const view of subViews)
          view.dispose();
        subViews.clear();
        gl.deleteTexture(textureId);
        if (memBytes > 0)
          statsCollector?.subMemory(memBytes);
        textureRegistry.unregister(handle);
      }
    };
    return handle;
  }
  function live(spec, deps = [], props = {}) {
    const compiled = compileDrawSpec(spec, ctx);
    const liveCommand = createLiveCommand(segments, (w) => compiled.record(props, frameCtx, w), deps);
    lives.push(liveCommand);
    return liveCommand;
  }
  function frame(callback) {
    frameCallbacks.push(callback);
    return { cancel: () => removeItem(frameCallbacks, callback) };
  }
  function resize(cssWidth, cssHeight) {
    const dprNow = canvasDpr(canvas, options.dpr);
    if (cssWidth === lastCssWidth && cssHeight === lastCssHeight && dprNow === lastDpr)
      return;
    lastCssWidth = cssWidth;
    lastCssHeight = cssHeight;
    lastDpr = dprNow;
    const bufferWidth = Math.max(1, Math.round(cssWidth * dprNow));
    const bufferHeight = Math.max(1, Math.round(cssHeight * dprNow));
    if (canvas.width !== bufferWidth)
      canvas.width = bufferWidth;
    if (canvas.height !== bufferHeight)
      canvas.height = bufferHeight;
    lastBufferW = canvas.width;
    lastBufferH = canvas.height;
    size.value = [cssWidth, cssHeight];
    gl.setViewport(bufferWidth, bufferHeight);
  }
  function syncCanvasState() {
    const w = canvas.width;
    const h = canvas.height;
    if (w !== lastBufferW || h !== lastBufferH) {
      options.onGlError?.(`canvas state heal: the drawing buffer moved to ${w}x${h} (tracked ${lastBufferW}x${lastBufferH}) without our resize — the viewport re-synced`);
      lastBufferW = w;
      lastBufferH = h;
      lastCssWidth = -1;
      gl.setViewport(w, h);
    }
    if ((++dprPollFrame & 63) === 0 && options.dpr === undefined && !isOffscreenCanvas(canvas) && canvas.clientWidth > 0) {
      const live2 = canvasDpr(canvas, undefined);
      if (live2 !== lastDpr) {
        lastCssWidth = -1;
        resize(canvas.clientWidth, canvas.clientHeight);
      }
    }
  }
  function step(nowMs) {
    updateFrameContext(nowMs);
    statsCollector?.beginFrame();
    transients.beginFrame();
    syncCanvasState();
    try {
      stepFrame();
      frameErrorCount = 0;
    } catch (error) {
      frameErrorCount++;
      options.onGlError?.(`frame error: ${error instanceof Error ? error.message : String(error)}`);
      if (frameErrorCount >= 3) {
        running = false;
        options.onGlError?.(`detected ${frameErrorCount} consecutive frame errors — rendering stopped`);
        return;
      }
    }
    statsCollector?.endFrame();
    drainGlErrors();
  }
  let frameErrorCount = 0;
  function stepFrame() {
    epoch.frame(() => {
      options.transport?.sampleAll();
      for (const feed2 of feeds)
        feed2.sync();
      time.value = frameCtx.time;
      writer.reset();
      writer.emit(OpCode.BeginPass, 0, 0, 0, 0);
      buildFrame(lives, writer);
      emitFrameCallbacks();
      writer.emit(OpCode.EndPass, 0, 0, 0, 0);
      executor.run(writerView(writer));
      uploads.drain();
    });
  }
  let lastGlErrorKey = "";
  function drainGlErrors() {
    if (rawContext === null)
      return;
    const codes = [];
    for (let i = 0;i < 16; i++) {
      const code = rawContext.getError();
      if (code === 0)
        break;
      codes.push(code);
    }
    if (codes.length === 0) {
      lastGlErrorKey = "";
      return;
    }
    const key = codes.join(",");
    if (key === lastGlErrorKey)
      return;
    lastGlErrorKey = key;
    const described = codes.map((c) => `${glErrorName(c)} (0x${c.toString(16)})`).join(", ");
    options.onGlError?.(`GL error: ${described} — an error accumulated in the last frame (texture creation/uploads/draw)`);
  }
  function updateFrameContext(nowMs) {
    frameCtx.time = (nowMs - startedAt) / 1000;
    frameCtx.dt = (nowMs - lastNow) / 1000;
    frameCtx.aspect = aspect.peek();
    frameCtx.size = size.peek();
    lastNow = nowMs;
  }
  function emitFrameCallbacks() {
    for (const callback of [...frameCallbacks])
      callback(frameCtx, recordIntoWriter);
  }
  function recordIntoWriter(command2, props = {}) {
    command2.record(props, frameCtx, writer);
    statsCollector?.addDrawCall();
  }
  function start() {
    if (running)
      return;
    running = true;
    scheduleNext();
  }
  function scheduleNext() {
    const request = options.requestFrame ?? requestFrameDefault;
    cancelScheduled = request((timestamp) => {
      if (!running)
        return;
      step(timestamp);
      scheduleNext();
    });
  }
  function stop() {
    running = false;
    cancelScheduled?.();
    cancelScheduled = null;
  }
  function observeSize(canvas2, options2) {
    if (options2.observeResize === false)
      return null;
    if (isOffscreenCanvas(canvas2))
      return null;
    if (typeof ResizeObserver === "undefined")
      return null;
    const observer = new ResizeObserver(() => {
      if (canvas2.clientWidth <= 0 || canvas2.clientHeight <= 0)
        return;
      const [cssW, cssH] = getCanvasCssSize(canvas2);
      const verdict = layoutGuard.classify(cssW, cssH);
      if (verdict.verdict !== "apply")
        return;
      resize(verdict.cssWidth, verdict.cssHeight);
    });
    observer.observe(canvas2);
    return observer;
  }
  function feed(feedOptions) {
    const rendererFeed = createRendererFeedGL(gl, feedOptions);
    feeds.add(rendererFeed);
    return rendererFeed;
  }
  function dispose() {
    if (disposed)
      return;
    disposed = true;
    stop();
    resizeObserver?.disconnect();
    for (const rendererFeed of feeds)
      rendererFeed.dispose();
    feeds.clear();
  }
  const probedCaps = (() => {
    if (options.caps !== undefined)
      return options.caps;
    if (rawContext === null)
      return null;
    try {
      const query = probeGLCaps(makeGLProbe(rawContext));
      if (query.features.has("timestamp-query")) {
        const timer = createGLGpuTimer(rawContext);
        if (timer !== null) {
          statsCollector.setGpuTimer(timer);
        }
      }
      return createCaps(query, () => statsCollector.snapshot());
    } catch {
      return null;
    }
  })();
  return {
    gl,
    caps: probedCaps,
    size,
    aspect,
    time,
    uploads,
    transients,
    transport: options.transport ?? null,
    feed,
    texture,
    attachTexture,
    attachView,
    restoreResources: session !== null ? (options2) => session.restore(options2?.workingSet) : undefined,
    ensureResident: session !== null ? (resourceId) => session.ensureResident(resourceId) : undefined,
    evictLRU: session !== null ? (options2) => session.evictLRU(options2) : undefined,
    residencyStats: session !== null ? () => session.residencyStats() : undefined,
    command,
    pass,
    surface,
    live,
    frame,
    resize,
    step,
    start,
    stop,
    dispose
  };
}
function acquireWebGL2(canvas) {
  const attempts = [
    { antialias: true, preserveDrawingBuffer: true, alpha: false },
    { antialias: false, preserveDrawingBuffer: true, alpha: false },
    { alpha: false }
  ];
  for (const attributes of attempts) {
    const gl = canvas.getContext("webgl2", attributes);
    if (gl !== null)
      return gl;
  }
  const inIframe = typeof window !== "undefined" && window.self !== window.top;
  throw new Error(inIframe ? "rune: WebGL2 is unavailable inside this preview window (an iframe without GPU access). " + "Open the page directly in the browser — in a new Chrome/Edge/Safari tab." : "rune: WebGL2 is unavailable. Enable hardware acceleration in the browser settings " + "(system → Use hardware acceleration, restart) or open the file in an " + "up-to-date Chrome/Edge/Firefox.");
}
function defaultNow() {
  return performance.now();
}
function glErrorName(code) {
  switch (code) {
    case 1280:
      return "INVALID_ENUM";
    case 1281:
      return "INVALID_VALUE";
    case 1282:
      return "INVALID_OPERATION";
    case 1283:
      return "STACK_OVERFLOW";
    case 1284:
      return "STACK_UNDERFLOW";
    case 1285:
      return "OUT_OF_MEMORY";
    case 1286:
      return "INVALID_FRAMEBUFFER_OPERATION";
    case 37442:
      return "CONTEXT_LOST_WEBGL";
    default:
      return `UNKNOWN_${code}`;
  }
}
function requestFrameDefault(callback) {
  const id = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(id);
}
function removeItem(list, item) {
  const at = list.indexOf(item);
  if (at >= 0)
    list.splice(at, 1);
}
function makeTextureFinalizationRegistry(disposeGpu) {
  if (typeof FinalizationRegistry === "undefined") {
    return { register: () => {}, unregister: () => {} };
  }
  const registry = new FinalizationRegistry((textureId) => {
    try {
      disposeGpu(textureId);
    } catch {}
  });
  return {
    register: (target, heldValue) => registry.register(target, heldValue),
    unregister: (target) => registry.unregister(target)
  };
}

// packages/gl/src/webgpuRenderer.ts
init_src();

// packages/webgpu/src/wgslReflect.ts
function alignOf(type) {
  const arr = arrayOf(type);
  return alignOfBase(arr !== null ? arr.elem : type);
}
function alignOfBase(type) {
  if (type.startsWith("mat4x4"))
    return 16;
  if (type.startsWith("vec4"))
    return 16;
  if (type.startsWith("vec3"))
    return 16;
  if (type.startsWith("vec2"))
    return 8;
  return 4;
}
function sizeOf(type) {
  const arr = arrayOf(type);
  if (arr !== null) {
    const elemSize = sizeOfBase(arr.elem);
    const stride = Math.ceil(elemSize / alignOfBase(arr.elem)) * alignOfBase(arr.elem);
    return stride * arr.count;
  }
  return sizeOfBase(type);
}
function sizeOfBase(type) {
  if (type.startsWith("mat4x4"))
    return 64;
  if (type.startsWith("vec4"))
    return 16;
  if (type.startsWith("vec3"))
    return 12;
  if (type.startsWith("vec2"))
    return 8;
  return 4;
}
function arrayOf(type) {
  const match = /^array\s*<\s*(mat4x4|vec4|vec3|vec2|f32)\s*(?:<\s*f32\s*>)?\s*,\s*(\d+)\s*>$/.exec(type.trim());
  if (match === null)
    return null;
  return { elem: match[1] === "f32" ? "f32" : `${match[1]}<f32>`, count: Number(match[2]) };
}
function reflectWgsl2(wgsl) {
  return {
    uniforms: scanUniforms2(wgsl),
    attributes: [...scanAttributes2(wgsl)].sort(byLocation2),
    textures: scanTextures(wgsl),
    uniformBytes: uniformBytes(scanUniforms2(wgsl))
  };
}
function scanUniforms2(wgsl) {
  const varMatch = /@group\(0\)\s*@binding\(0\)\s*var<uniform>\s+(\w+)\s*:\s*(\w+)/.exec(wgsl);
  if (varMatch === null)
    return [];
  const structName = varMatch[2];
  const structRe = new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`);
  const structMatch = structRe.exec(wgsl);
  if (structMatch === null)
    return [];
  const fields = [];
  let cursor = 0;
  for (const raw of splitStructFields(structMatch[1])) {
    const normalized = raw.trim().replace(/\s+/g, " ");
    const field = /^(\w+)\s*:\s*(.+)$/.exec(normalized);
    if (field === null)
      continue;
    const type = field[2].trim().replace(/,\s*$/, "");
    cursor = align(cursor, alignOf(type));
    fields.push({ name: field[1], offset: cursor, size: sizeOf(type), type });
    cursor += sizeOf(type);
  }
  return fields;
}
function splitStructFields(body) {
  const out = [];
  let depth2 = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "<")
      depth2++;
    else if (ch === ">")
      depth2--;
    if (ch === "," && depth2 === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "")
    out.push(current);
  return out;
}
function scanAttributes2(wgsl) {
  const found = [];
  const vertexFn = /@vertex\s+fn\s+\w+\s*\(([\s\S]*?)\)\s*->/.exec(wgsl);
  if (vertexFn === null)
    return [];
  const re = /@location\((\d+)\)\s*(\w+)\s*:\s*(?:(vec2|vec3|vec4)<f32>|f32)/g;
  for (const match of vertexFn[1].matchAll(re)) {
    const size = match[3] === undefined ? 1 : vecSize2(match[3]);
    found.push({ name: match[2], location: Number(match[1]), size });
  }
  return found;
}
function scanTextures(wgsl) {
  const found = [];
  for (const match of wgsl.matchAll(/@group\(1\)[^\n;]*var\s+(\w+)\s*:\s*(texture_2d<f32>|sampler)/g)) {
    const bMatch = /@binding\((\d+)\)/.exec(match[0]);
    found.push({
      name: match[1],
      kind: match[2] === "sampler" ? "sampler" : "texture_2d",
      binding: bMatch !== null ? Number(bMatch[1]) : -1
    });
  }
  return found;
}
function uniformBytes(fields) {
  if (fields.length === 0)
    return 0;
  const last = fields[fields.length - 1];
  return align(last.offset + last.size, 16);
}
function align(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}
function vecSize2(type) {
  if (type === "vec4")
    return 4;
  if (type === "vec3")
    return 3;
  if (type === "vec2")
    return 2;
  return 1;
}
function byLocation2(a, b) {
  return a.location - b.location;
}
// packages/webgpu/src/sliceArena.ts
var ALIGN = 256;
function createSliceArena(capacityBytes) {
  const bytes = new Uint8Array(capacityBytes);
  const floats = new Float32Array(bytes.buffer);
  let cursor = 0;
  let dirty = [];
  function alloc(sizeBytes) {
    const size = Math.max(ALIGN, Math.ceil(sizeBytes / ALIGN) * ALIGN);
    if (cursor + size > capacityBytes) {
      throw new Error(`rune: slice arena overflowed (${capacityBytes} B)`);
    }
    const offset = cursor;
    cursor += size;
    return offset;
  }
  function allocSlice(sizeBytes) {
    const base = Math.ceil(cursor / ALIGN) * ALIGN;
    if (base + sizeBytes > capacityBytes) {
      throw new Error(`rune: slice arena overflowed (${capacityBytes} B)`);
    }
    cursor = base + sizeBytes;
    return { base, bytes: sizeBytes };
  }
  function slotAt(slice, offset, size) {
    return { offset: slice.base + offset, size };
  }
  function writeVec4(slot, x, y, z, w) {
    const at = slot.offset >> 2;
    if (Math.fround(x) !== floats[at] || Math.fround(y) !== floats[at + 1] || Math.fround(z) !== floats[at + 2] || Math.fround(w) !== floats[at + 3]) {
      floats[at] = x;
      floats[at + 1] = y;
      floats[at + 2] = z;
      floats[at + 3] = w;
      markDirty(slot.offset, slot.offset + slot.size);
    }
  }
  function markDirty(from, to) {
    for (const range of dirty) {
      if (from >= range.from && to <= range.to)
        return;
    }
    dirty.push({ from, to });
  }
  function dirtyRanges() {
    if (dirty.length === 0)
      return [];
    const sorted = [...dirty].sort((a, b) => a.from - b.from);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last !== undefined && range.from - last.to < ALIGN) {
        if (range.to > last.to)
          last.to = range.to;
      } else {
        merged.push({ from: range.from, to: range.to });
      }
    }
    return merged;
  }
  function clearDirty() {
    dirty = [];
  }
  function reset() {
    cursor = 0;
  }
  function used() {
    return cursor;
  }
  return {
    bytes,
    floats,
    alloc,
    allocSlice,
    slotAt,
    writeVec4,
    dirtyRanges,
    clearDirty,
    reset,
    used,
    get usedBytes() {
      return cursor;
    }
  };
}
// packages/webgpu/src/pipeline/pipelineCache.ts
function createPipelineCache() {
  const ids = new Map;
  let next = 1;
  return {
    get size() {
      return next - 1;
    },
    idOf(desc, shaderId, layoutKey) {
      const key = structuralKey(desc, shaderId, layoutKey);
      const known = ids.get(key);
      if (known !== undefined)
        return known;
      const id = next++;
      ids.set(key, id);
      return id;
    }
  };
}
function structuralKey(desc, shaderId, layoutKey) {
  return [
    shaderId,
    depthKey(desc.depth),
    blendKey(desc.blend),
    rasterKey(desc.raster),
    desc.primitive ?? "triangles",
    layoutKey ?? "layout:default"
  ].join("|");
}
function depthKey(depth2) {
  if (depth2 === false)
    return "off";
  return `${depth2?.test ?? "less"}:${depth2?.write === false ? 0 : 1}`;
}
function blendKey(blend) {
  if (blend === false || blend === undefined)
    return "off";
  return `${blend.src}/${blend.dst}/${blend.equation ?? "add"}`;
}
function rasterKey(raster) {
  if (raster === undefined)
    return "off";
  return `${raster.cull ?? "none"}/${raster.frontFace ?? "ccw"}`;
}
// packages/webgpu/src/command.ts
init_src();
function createWgpuContext(arena) {
  let nextPipeline = 1;
  const cache = createPipelineCache();
  const shaderIds = new Map;
  let nextShaderId = 1;
  return {
    arena,
    commands: [],
    pipelineOf(desc, wgsl, layoutKey) {
      let shaderId = shaderIds.get(wgsl);
      if (shaderId === undefined) {
        shaderId = nextShaderId++;
        shaderIds.set(wgsl, shaderId);
      }
      return cache.idOf(desc ?? {}, shaderId, layoutKey);
    },
    nextPipelineId: () => nextPipeline++
  };
}
function compileWgslSpec(spec, ctx) {
  const reflection = reflectWgsl2(spec.shader.wgsl);
  const id = ctx.commands.length;
  const attrOrder = orderedAttributes(reflection, spec);
  const pipelineId = ctx.pipelineOf(spec.pipeline, spec.shader.wgsl, vertexLayoutKey(attrOrder));
  const uniformBytes2 = Math.max(256, reflection.uniformBytes);
  const sliceOffset = ctx.arena.alloc(uniformBytes2);
  const sliceBytes = uniformBytes2;
  const bindings = reflection.uniforms.map((field) => ({
    name: field.name,
    shape: shapeOf(field.type ?? ""),
    slot: { offset: field.offset, size: field.size }
  }));
  const usedBytes = reflection.uniforms.length > 0 ? reflection.uniforms[reflection.uniforms.length - 1].offset + reflection.uniforms[reflection.uniforms.length - 1].size : 0;
  const command = {
    id,
    pipelineId,
    wgsl: spec.shader.wgsl,
    attrOrder,
    pipeline: spec.pipeline ?? {},
    textureIds: boundTextures(reflection, spec),
    fields: reflection.uniforms,
    bindings,
    slice: { base: sliceOffset, size: sliceBytes },
    sliceOffset,
    sliceBytes,
    uniformBytes: usedBytes,
    needsUpload: true,
    pipelineReady: false,
    lastProps: undefined,
    record(props, frameCtx, writer) {
      command.lastProps = props;
      writeUniforms(command, ctx.arena, spec, props, frameCtx);
      const count = resolveNumber2(spec.count, props, frameCtx);
      const instances = spec.instances === undefined ? 1 : resolveNumber2(spec.instances, props, frameCtx);
      writer.emit(OpCode.Draw, id, 0, count, instances);
    }
  };
  ctx.commands.push(command);
  return command;
}
function shapeOf(type) {
  if (type.startsWith("mat4x4"))
    return "m4";
  if (type.startsWith("mat3x3"))
    return "m3";
  if (type.startsWith("mat2x2"))
    return "m2";
  if (type.startsWith("vec4"))
    return "f4";
  if (type.startsWith("vec3"))
    return "f3";
  if (type.startsWith("vec2"))
    return "f2";
  return "f";
}
function resolve2(declared, props, frameCtx) {
  if (declared === undefined)
    return;
  if (typeof declared === "function")
    return declared(props, frameCtx);
  if (typeof declared === "object" && declared !== null && "peek" in declared) {
    return declared.peek();
  }
  return declared;
}
function resolveNumber2(declared, props, frameCtx) {
  const value = resolve2(declared, props, frameCtx);
  return typeof value === "number" ? value : 0;
}
function orderedAttributes(reflection, spec) {
  return reflection.attributes.map((attr) => ({
    data: spec.attributes?.[attr.name]?.data ?? new Float32Array(attr.size),
    size: spec.attributes?.[attr.name]?.size ?? attr.size,
    stride: spec.attributes?.[attr.name]?.stride,
    offset: spec.attributes?.[attr.name]?.offset,
    step: spec.attributes?.[attr.name]?.step,
    bufferId: spec.attributes?.[attr.name]?.bufferId
  }));
}
function vertexLayoutKey(attrOrder) {
  return attrOrder.map((a) => `${a.size}:${a.stride ?? a.size * 4}:${a.offset ?? 0}:${a.step === "instance" ? "i" : "v"}`).join(",");
}
function boundTextures(reflection, spec) {
  const ids = [];
  for (const texture of reflection.textures) {
    if (texture.kind !== "texture_2d")
      continue;
    const handle = spec.textures?.[texture.name];
    if (handle !== undefined)
      ids.push(handle.textureId);
  }
  return ids;
}
function writeUniforms(command, arena, spec, props, frameCtx) {
  for (const field of command.fields) {
    const declared = spec.uniforms?.[field.name];
    if (declared === undefined)
      continue;
    const value = resolve2(declared, props, frameCtx);
    if (value === undefined)
      continue;
    const scalar = typeof value === "number";
    const numbers = scalar ? EMPTY : value;
    const base = (command.sliceOffset + field.offset) / 4;
    let changed = false;
    for (let at = 0;at < field.size / 4; at++) {
      const next = scalar ? at === 0 ? value : 0 : numbers[at] ?? 0;
      if (Math.fround(next) !== arena.floats[base + at]) {
        arena.floats[base + at] = next;
        changed = true;
      }
    }
    if (changed)
      command.needsUpload = true;
  }
}
var EMPTY = [0];
// packages/webgpu/src/executor.ts
function createGpuExecutor(options) {
  const gpu = options.gpu;
  const arena = options.arena;
  const commands = options.commands;
  function run(view) {
    uploadDirtySlices(view);
    for (let at = 0;at < view.count; at++) {
      const op = view.op[at];
      if (op === 1)
        beginPass();
      else if (op === 2)
        drawCommand(commands[view.a[at]], view.c[at], view.d[at]);
      else if (op === 3)
        gpu.endPass();
      else if (op === 4)
        gpu.bindTarget(view.a[at], view.b[at] === 1);
    }
    gpu.submit();
  }
  function uploadDirtySlices(view) {
    for (let at = 0;at < view.count; at++) {
      if (view.op[at] !== 2)
        continue;
      const command = commands[view.a[at]];
      if (command === undefined || !command.needsUpload)
        continue;
      if (command.sliceView === undefined) {
        const bytes = Math.min(command.uniformBytes ?? command.sliceBytes, command.sliceBytes);
        command.sliceView = arena.bytes.subarray(command.sliceOffset, command.sliceOffset + bytes);
      }
      gpu.uploadUniforms(command.sliceOffset, command.sliceView);
      command.needsUpload = false;
    }
  }
  function beginPass() {
    gpu.beginPass(0);
  }
  function drawCommand(command, count, instances) {
    if (command === undefined)
      return;
    if (!command.pipelineReady) {
      gpu.ensurePipeline(command.pipelineId, command.wgsl, command.attrOrder.map((a) => a.stride !== undefined || a.step !== undefined ? { size: a.size, stride: a.stride, offset: a.offset ?? 0, step: a.step } : a.size), command.textureIds.length > 0, command.pipeline);
      command.pipelineReady = true;
    }
    gpu.usePipeline(command.pipelineId);
    gpu.bindUniforms(command.sliceOffset);
    const attrOrder = command.attrOrder;
    for (let slot = 0;slot < attrOrder.length; slot++) {
      const attribute = attrOrder[slot];
      if (attribute.bufferId !== undefined)
        gpu.bindExternalVertexBuffer(slot, attribute.bufferId);
      else
        gpu.bindVertexBuffer(slot, attribute.data, attribute.size);
    }
    for (const textureId of command.textureIds)
      gpu.bindTexture(textureId);
    gpu.draw(count, instances);
  }
  return { run };
}
// packages/webgpu/src/facade.ts
function externalImageSize(source) {
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
    return [source.videoWidth || 0, source.videoHeight || 0];
  }
  const vf = source;
  if (typeof vf.displayWidth === "number" && typeof vf.displayHeight === "number" && vf.displayWidth > 0) {
    return [vf.displayWidth, vf.displayHeight];
  }
  if (typeof vf.codedWidth === "number" && typeof vf.codedHeight === "number" && vf.codedWidth > 0) {
    return [vf.codedWidth, vf.codedHeight];
  }
  const s = source;
  return [s.width ?? 0, s.height ?? 0];
}
// packages/webgpu/src/gpuTimer.ts
function createGpuGpuTimer(device) {
  try {
    if (!device.features.has("timestamp-query"))
      return null;
  } catch {
    return null;
  }
  let querySet;
  try {
    querySet = device.createQuerySet({ type: "timestamp", count: 2 });
  } catch {
    return null;
  }
  const MAP_READ = globalThis.GPUBufferUsage?.MAP_READ ?? 1;
  const COPY_DST = globalThis.GPUBufferUsage?.COPY_DST ?? 8;
  const COPY_SRC = globalThis.GPUBufferUsage?.COPY_SRC ?? 4;
  const QUERY_RESOLVE = globalThis.GPUBufferUsage?.QUERY_RESOLVE ?? 32;
  let resolveBuffer;
  let readBuffer;
  try {
    resolveBuffer = device.createBuffer({
      size: 16,
      usage: QUERY_RESOLVE | COPY_SRC
    });
    readBuffer = device.createBuffer({
      size: 16,
      usage: COPY_DST | MAP_READ
    });
  } catch {
    return null;
  }
  const MAP_READ_MODE = globalThis.GPUMapMode?.READ ?? 1;
  let lastResult = null;
  let pendingResolve = false;
  let mapping = false;
  let alive = true;
  function safeBegin() {
    if (!alive)
      return;
    if (!pendingResolve || mapping)
      return;
    mapping = true;
    readBuffer.mapAsync(MAP_READ_MODE).then(() => {
      try {
        const view = new BigInt64Array(readBuffer.getMappedRange());
        const start = Number(view[0]);
        const end = Number(view[1]);
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          lastResult = (end - start) / 1e6;
        }
        readBuffer.unmap();
      } catch {
        try {
          readBuffer.unmap();
        } catch {}
      } finally {
        mapping = false;
        pendingResolve = false;
      }
    }).catch(() => {
      mapping = false;
      pendingResolve = false;
      alive = false;
    });
  }
  function safeEnd() {}
  function safeResult() {
    if (!alive)
      return null;
    return lastResult;
  }
  function onBeginPass(pass) {
    if (!alive)
      return;
    try {
      pass.writeTimestamp(querySet, 0);
    } catch {
      alive = false;
    }
  }
  function onEndPass(pass) {
    if (!alive)
      return;
    try {
      pass.writeTimestamp(querySet, 1);
    } catch {
      alive = false;
    }
  }
  function onSubmit(encoder) {
    if (!alive)
      return;
    try {
      encoder.resolveQuerySet(querySet, 0, 2, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, 16);
      pendingResolve = true;
    } catch {
      alive = false;
    }
  }
  const timer = {
    begin: safeBegin,
    end: safeEnd,
    result: safeResult
  };
  const handle = { onBeginPass, onEndPass, onSubmit };
  return { timer, handle };
}

// packages/webgpu/src/formats.ts
init_src();
var CORE = true;
var GPU_FORMATS = {
  r8unorm: { gpu: "r8unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  r8snorm: { gpu: "r8snorm", copySrc: CORE, copyDst: CORE, renderAttachment: "texture-formats-tier1", blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  r8uint: { gpu: "r8uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: "texture-formats-tier1" },
  r8sint: { gpu: "r8sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: "texture-formats-tier1" },
  rg8unorm: { gpu: "rg8unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  rg8snorm: { gpu: "rg8snorm", copySrc: CORE, copyDst: CORE, renderAttachment: "texture-formats-tier1", blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  rg8uint: { gpu: "rg8uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  rg8sint: { gpu: "rg8sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  rgba8unorm: { gpu: "rgba8unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE },
  "rgba8unorm-srgb": { gpu: "rgba8unorm-srgb", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  rgba8snorm: { gpu: "rgba8snorm", copySrc: CORE, copyDst: CORE, renderAttachment: "texture-formats-tier1", blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE },
  rgba8uint: { gpu: "rgba8uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: CORE },
  rgba8sint: { gpu: "rgba8sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: CORE },
  bgra8unorm: { gpu: "bgra8unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: "bgra8unorm-storage" },
  "bgra8unorm-srgb": { gpu: "bgra8unorm-srgb", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false, requiredFeature: "core-features-and-limits" },
  r16uint: { gpu: "r16uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: "texture-formats-tier1" },
  r16sint: { gpu: "r16sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: "texture-formats-tier1" },
  r16float: { gpu: "r16float", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: "texture-formats-tier1" },
  rg16uint: { gpu: "rg16uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  rg16sint: { gpu: "rg16sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  rg16float: { gpu: "rg16float", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: false },
  rgba16uint: { gpu: "rgba16uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: CORE },
  rgba16sint: { gpu: "rgba16sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: CORE },
  rgba16float: { gpu: "rgba16float", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE },
  r16unorm: { gpu: "r16unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: false, multisample: true, storageWrite: CORE, requiredFeature: "texture-formats-tier1" },
  r16snorm: { gpu: "r16snorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE, requiredFeature: "texture-formats-tier1" },
  rg16unorm: { gpu: "rg16unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: false, multisample: true, storageWrite: CORE, requiredFeature: "texture-formats-tier1" },
  rg16snorm: { gpu: "rg16snorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE, requiredFeature: "texture-formats-tier1" },
  rgba16unorm: { gpu: "rgba16unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: false, multisample: true, storageWrite: CORE, requiredFeature: "texture-formats-tier1" },
  rgba16snorm: { gpu: "rgba16snorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: CORE, requiredFeature: "texture-formats-tier1" },
  r32uint: { gpu: "r32uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: CORE },
  r32sint: { gpu: "r32sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: CORE },
  r32float: { gpu: "r32float", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: "float32-blendable", filterable: "float32-filterable", multisample: false, storageWrite: CORE },
  rg32uint: { gpu: "rg32uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: false },
  rg32sint: { gpu: "rg32sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: false },
  rg32float: { gpu: "rg32float", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: "float32-blendable", filterable: "float32-filterable", multisample: false, storageWrite: false },
  rgba32uint: { gpu: "rgba32uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: CORE },
  rgba32sint: { gpu: "rgba32sint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: false, storageWrite: CORE },
  rgba32float: { gpu: "rgba32float", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: "float32-blendable", filterable: "float32-filterable", multisample: false, storageWrite: CORE },
  rgb10a2uint: { gpu: "rgb10a2uint", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: "texture-formats-tier1" },
  rgb10a2unorm: { gpu: "rgb10a2unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: CORE, filterable: CORE, multisample: true, storageWrite: "texture-formats-tier1" },
  rg11b10ufloat: { gpu: "rg11b10ufloat", copySrc: CORE, copyDst: CORE, renderAttachment: "rg11b10ufloat-renderable", blendable: "texture-formats-tier1", filterable: CORE, multisample: false, storageWrite: "texture-formats-tier1" },
  rgb9e5ufloat: { gpu: "rgb9e5ufloat", copySrc: CORE, copyDst: CORE, renderAttachment: false, blendable: false, filterable: CORE, multisample: false, storageWrite: false },
  stencil8: { gpu: "stencil8", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  depth16unorm: { gpu: "depth16unorm", copySrc: CORE, copyDst: CORE, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  depth24plus: { gpu: "depth24plus", copySrc: false, copyDst: false, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  "depth24plus-stencil8": { gpu: "depth24plus-stencil8", copySrc: false, copyDst: false, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  depth32float: { gpu: "depth32float", copySrc: CORE, copyDst: false, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  "depth32float-stencil8": { gpu: "depth32float-stencil8", copySrc: CORE, copyDst: false, renderAttachment: CORE, blendable: false, filterable: false, multisample: true, storageWrite: false },
  "bc1-rgba-unorm": bc("bc1-rgba-unorm"),
  "bc1-rgba-unorm-srgb": bc("bc1-rgba-unorm-srgb"),
  "bc2-rgba-unorm": bc("bc2-rgba-unorm"),
  "bc2-rgba-unorm-srgb": bc("bc2-rgba-unorm-srgb"),
  "bc3-rgba-unorm": bc("bc3-rgba-unorm"),
  "bc3-rgba-unorm-srgb": bc("bc3-rgba-unorm-srgb"),
  "bc4-r-unorm": bc("bc4-r-unorm"),
  "bc4-r-snorm": bc("bc4-r-snorm"),
  "bc5-rg-unorm": bc("bc5-rg-unorm"),
  "bc5-rg-snorm": bc("bc5-rg-snorm"),
  "bc6h-rgb-ufloat": bc("bc6h-rgb-ufloat"),
  "bc6h-rgb-float": bc("bc6h-rgb-float"),
  "bc7-rgba-unorm": bc("bc7-rgba-unorm"),
  "bc7-rgba-unorm-srgb": bc("bc7-rgba-unorm-srgb"),
  "etc2-rgb8unorm": etc("etc2-rgb8unorm"),
  "etc2-rgb8unorm-srgb": etc("etc2-rgb8unorm-srgb"),
  "etc2-rgb8a1unorm": etc("etc2-rgb8a1unorm"),
  "etc2-rgb8a1unorm-srgb": etc("etc2-rgb8a1unorm-srgb"),
  "etc2-rgba8unorm": etc("etc2-rgba8unorm"),
  "etc2-rgba8unorm-srgb": etc("etc2-rgba8unorm-srgb"),
  "eac-r11unorm": etc("eac-r11unorm"),
  "eac-r11snorm": etc("eac-r11snorm"),
  "eac-rg11unorm": etc("eac-rg11unorm"),
  "eac-rg11snorm": etc("eac-rg11snorm"),
  ...astcEntries()
};
function bc(gpu) {
  return { gpu, copySrc: CORE, copyDst: CORE, renderAttachment: false, blendable: false, filterable: CORE, multisample: false, storageWrite: false, requiredFeature: "texture-compression-bc" };
}
function etc(gpu) {
  return { gpu, copySrc: CORE, copyDst: CORE, renderAttachment: false, blendable: false, filterable: CORE, multisample: false, storageWrite: false, requiredFeature: "texture-compression-etc2" };
}
function astcEntries() {
  const out = {};
  const sizes = ["4x4", "5x4", "5x5", "6x5", "6x6", "8x5", "8x6", "8x8", "10x5", "10x6", "10x8", "10x10", "12x10", "12x12"];
  for (const size of sizes) {
    for (const suffix of ["unorm", "unorm-srgb"]) {
      const id = `astc-${size}-${suffix}`;
      out[id] = { gpu: id, copySrc: CORE, copyDst: CORE, renderAttachment: false, blendable: false, filterable: CORE, multisample: false, storageWrite: false, requiredFeature: "texture-compression-astc" };
    }
  }
  return out;
}

// packages/webgpu/src/realGPU.ts
async function createRealGPU(canvas, onGpuError) {
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null)
    throw new Error("rune: WebGPU adapter unavailable");
  const requiredFeatures = [];
  if (adapter.features.has("timestamp-query")) {
    requiredFeatures.push("timestamp-query");
  }
  if (adapter.features.has("float32-filterable")) {
    requiredFeatures.push("float32-filterable");
  }
  let device;
  try {
    device = await adapter.requestDevice({ requiredFeatures });
  } catch {
    device = await adapter.requestDevice();
  }
  device.addEventListener("uncapturederror", (event) => {
    onGpuError?.(String(event.error.message ?? event));
  });
  const context = canvas.getContext("webgpu");
  if (context === null)
    throw new Error("rune: webgpu canvas context unavailable");
  const gpuContext = context;
  const format = navigator.gpu.getPreferredCanvasFormat();
  const textures = new Map;
  const textureViews = new Map;
  const pipelines = new Map;
  const vertexBuffers = new Map;
  const textureBindGroups = new Map;
  const targets = new Map;
  let nextTextureId = 1;
  let nextTargetId = 1;
  let nextTextureViewId = 1e6;
  let width = 0;
  let height = 0;
  let canvasClearR = 0.07;
  let canvasClearG = 0.08;
  let canvasClearB = 0.11;
  let canvasClearA = 1;
  let canvasDepthClear = 1;
  let depthTexture = null;
  let depthView = null;
  let ubo = null;
  let uboSize = 0;
  let uboGroup = null;
  let uboBindingWindow = 256;
  let encoder = null;
  let pass = null;
  let currentPipeline = null;
  let currentPipelineId = -1;
  let currentTarget = 0;
  const pendingTextureIds = [];
  const dynamicOffsetScratch = new Uint32Array(1);
  let timerHandle = null;
  const timerBundle = createGpuGpuTimer(device);
  const gpuTimer = timerBundle === null ? null : timerBundle.timer;
  if (timerBundle !== null) {
    timerHandle = timerBundle.handle;
  }
  function configure(w, h) {
    gpuContext.configure({ device, format, alphaMode: "opaque" });
    resize(w, h);
  }
  function resize(w, h) {
    if (w === width && h === height && depthTexture !== null)
      return;
    width = w;
    height = h;
    depthTexture?.destroy();
    depthTexture = device.createTexture({
      size: [w, h],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
    depthView = depthTexture.createView();
  }
  function resolveGpuFormat(id) {
    const info = GPU_FORMATS[id];
    if (info === undefined) {
      throw new TypeError(`WebGPU does not support format '${id}' (GL-only or out of catalog)`);
    }
    return info.gpu;
  }
  function createTexture(w, h, textureFormat = "rgba8unorm", options) {
    const mipLevels = options?.mipLevels ?? 1;
    const gpuFormat = textureFormat === "canvas" ? format : resolveGpuFormat(textureFormat);
    const filterable = textureFormat !== "rgba32float" || device.features.has("float32-filterable");
    const texture = device.createTexture({
      size: [w, h],
      format: gpuFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT,
      mipLevelCount: mipLevels
    });
    let appliedAniso = 1;
    if (mipLevels > 1) {
      const requested = options?.maxAnisotropy ?? 16;
      const limit = 16;
      const clamped = Math.max(1, Math.min(requested, limit));
      appliedAniso = clamped;
    }
    const sampler = device.createSampler({
      magFilter: filterable ? "linear" : "nearest",
      minFilter: filterable ? "linear" : "nearest",
      mipmapFilter: mipLevels > 1 && filterable ? "linear" : "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      ...appliedAniso > 1 ? { maxAnisotropy: appliedAniso } : {}
    });
    const id = nextTextureId++;
    textures.set(id, { texture, sampler, view: texture.createView(), format: gpuFormat, filterable });
    return id;
  }
  function texSubImage2D(textureId, x, y, w, h, bytes) {
    const record = textures.get(textureId);
    if (record === undefined)
      return;
    const bytesPerPixel2 = record.format === "rgba16float" ? 8 : record.format === "rgba32float" ? 16 : 4;
    const rowBytes = w * bytesPerPixel2;
    const alignedRow = Math.ceil(rowBytes / 256) * 256;
    let data = bytes;
    if (alignedRow !== rowBytes && h > 1) {
      data = new Uint8Array(alignedRow * h);
      for (let row = 0;row < h; row++) {
        data.set(bytes.subarray(row * rowBytes, (row + 1) * rowBytes), row * alignedRow);
      }
    }
    device.queue.writeTexture({ texture: record.texture, origin: { x, y, z: 0 } }, data, { bytesPerRow: alignedRow, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });
  }
  function copyExternalImageToTexture(textureId, source, dstX, dstY, copyWidth, copyHeight, flipY) {
    const record = textures.get(textureId);
    if (record === undefined)
      return;
    device.queue.copyExternalImageToTexture({ source, flipY: flipY === true }, { texture: record.texture, mipLevel: 0, origin: { x: dstX, y: dstY, z: 0 }, premultipliedAlpha: false }, { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 });
  }
  function copyExternalImageToTextureMip(textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY) {
    const record = textures.get(textureId);
    if (record === undefined)
      return;
    device.queue.copyExternalImageToTexture({ source, flipY: flipY === true }, { texture: record.texture, mipLevel, origin: { x: dstX, y: dstY, z: 0 }, premultipliedAlpha: false }, { width: copyWidth, height: copyHeight, depthOrArrayLayers: 1 });
  }
  function uploadUniforms(offset, data) {
    const window2 = Math.ceil(data.length / 256) * 256;
    if (window2 > uboBindingWindow) {
      uboBindingWindow = window2;
      uboGroup = null;
    }
    ensureUBO(offset + Math.max(data.length, uboBindingWindow));
    try {
      device.queue.writeBuffer(ubo, offset, data);
    } catch (error) {
      onGpuError?.(`writeBuffer(uniforms, ${data.length} bytes @${offset}) rejected: ${errorMessage(error)}`);
    }
  }
  function ensureUBO(needed) {
    const rounded = Math.ceil(needed / 256) * 256;
    const grow = ubo === null || rounded > uboSize;
    if (!grow && uboGroup !== null)
      return;
    if (grow) {
      const size = Math.max(65536, rounded);
      const next = device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      if (ubo !== null)
        ubo.destroy();
      ubo = next;
      uboSize = size;
      uboGroup = null;
      currentPipeline = null;
      pipelines.clear();
    }
    const layout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true }
      }]
    });
    uboGroup = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: ubo, size: uboBindingWindow } }]
    });
  }
  function ensurePipeline(pipelineId, wgsl, attrs, hasTextures, desc) {
    if (pipelines.has(pipelineId))
      return;
    const record = {
      wgsl,
      attrs,
      hasTextures,
      textureBindings: hasTextures ? group1TextureBindings(wgsl) : [],
      textureCount: hasTextures ? countGroup1TextureBindings(wgsl) : 0,
      desc: desc ?? {},
      variants: new Map
    };
    pipelines.set(pipelineId, record);
    record.variants.set("float", buildPipeline(record, "float"));
  }
  function buildPipeline(record, variant) {
    const wgsl = record.wgsl;
    const attrs = record.attrs;
    const desc = record.desc;
    const module = device.createShaderModule({ code: wgsl });
    module.getCompilationInfo().then((info) => {
      for (const message of info.messages) {
        if (message.type === "error")
          onGpuError?.(`WGSL: ${message.message} (line ${message.lineNum})`);
      }
    }).catch(() => {});
    const group0 = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", hasDynamicOffset: true }
      }]
    });
    const layouts = [group0];
    if (record.hasTextures) {
      const textureEntries = [];
      for (const binding of record.textureBindings.length > 0 ? record.textureBindings : [1]) {
        textureEntries.push({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: variant }
        });
      }
      layouts.push(device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: variant === "float" ? "filtering" : "non-filtering" } },
          ...textureEntries
        ]
      }));
      if (variant === "unfilterable-float" && /\btextureSample\s*\(/.test(wgsl)) {
        onGpuError?.("rgba32float without feature float32-filterable: WGSL calls textureSample — it requires a filterable texture (sampleType float). For unfilterable-float, textureSampleLevel(t, s, uv, level) is allowed — it is valid for filterable textures too (level 0 = base mip).");
      }
    }
    return device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
      vertex: {
        module,
        entryPoint: "vsMain",
        buffers: attrs.map((slot, i) => typeof slot === "number" ? { arrayStride: slot * 4, attributes: [{ shaderLocation: i, offset: 0, format: vertexFormat(slot) }] } : {
          arrayStride: slot.stride ?? slot.size * 4,
          attributes: [{ shaderLocation: i, offset: slot.offset ?? 0, format: vertexFormat(slot.size) }],
          stepMode: slot.step === "instance" ? "instance" : "vertex"
        })
      },
      fragment: {
        module,
        entryPoint: "fsMain",
        targets: [{
          format,
          blend: desc.blend === undefined || desc.blend === false ? undefined : {
            color: { srcFactor: desc.blend.src, dstFactor: desc.blend.dst, operation: desc.blend.equation ?? "add" },
            alpha: { srcFactor: desc.blend.src, dstFactor: desc.blend.dst, operation: desc.blend.equation ?? "add" }
          }
        }]
      },
      primitive: {
        topology: desc.primitive === "triangle-strip" ? "triangle-strip" : "triangle-list",
        cullMode: desc.raster?.cull === "back" || desc.raster?.cull === "front" ? desc.raster.cull : "none",
        frontFace: desc.raster?.frontFace === "cw" ? "cw" : "ccw"
      },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: desc.depth === false ? false : desc.depth?.write ?? true,
        depthCompare: desc.depth === false ? "always" : depthCompareOf(desc.depth?.test)
      }
    });
  }
  function depthCompareOf(test) {
    switch (test) {
      case "never":
        return "never";
      case "equal":
        return "equal";
      case "lequal":
        return "less-equal";
      case "greater":
        return "greater";
      case "notequal":
        return "not-equal";
      case "gequal":
        return "greater-equal";
      case "always":
        return "always";
      default:
        return "less";
    }
  }
  function vertexFormat(size) {
    if (size >= 4)
      return "float32x4";
    if (size === 3)
      return "float32x3";
    if (size === 2)
      return "float32x2";
    return "float32";
  }
  function usePipeline(pipelineId) {
    const record = pipelines.get(pipelineId);
    if (record === undefined)
      return;
    currentPipelineId = pipelineId;
    pendingTextureIds.length = 0;
    setPipelineVariant(record, "float");
  }
  function setPipelineVariant(record, variant) {
    let pipeline = record.variants.get(variant);
    if (pipeline === undefined) {
      pipeline = buildPipeline(record, variant);
      record.variants.set(variant, pipeline);
    }
    if (pipeline === currentPipeline)
      return;
    currentPipeline = pipeline;
    pass?.setPipeline(pipeline);
  }
  function bindUniforms(dynamicOffset) {
    dynamicOffsetScratch[0] = dynamicOffset;
    pass?.setBindGroup(0, uboGroup, dynamicOffsetScratch);
  }
  function bindVertexBuffer(slot, data, _size) {
    let buffer = vertexBuffers.get(data);
    if (buffer === undefined) {
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      guardedWriteVertex(buffer, data, data.byteLength);
      vertexBuffers.set(data, buffer);
    }
    pass?.setVertexBuffer(slot, buffer);
  }
  function syncVertexBuffer(data, byteLength) {
    let buffer = vertexBuffers.get(data);
    if (buffer === undefined) {
      buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      vertexBuffers.set(data, buffer);
    }
    if (byteLength <= 0)
      return;
    guardedWriteVertex(buffer, data, byteLength);
  }
  function guardedWriteVertex(buffer, data, byteLength) {
    const capped = Math.min(byteLength, buffer.size);
    if (capped !== byteLength) {
      onGpuError?.(`writeBuffer(vertex) clamp: ${byteLength} → ${capped} bytes (buffer size ${buffer.size})`);
    }
    if (capped <= 0)
      return;
    try {
      const isSabView = typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer;
      if (isSabView) {
        const copy = new Uint8Array(new ArrayBuffer(capped));
        copy.set(new Uint8Array(data.buffer, data.byteOffset, capped));
        device.queue.writeBuffer(buffer, 0, copy);
        return;
      }
      if (data.byteOffset === 0 && capped === data.byteLength) {
        device.queue.writeBuffer(buffer, 0, data);
        return;
      }
      device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, capped);
    } catch (error) {
      onGpuError?.(`writeBuffer(vertex, ${capped} bytes) rejected: ${errorMessage(error)}`);
    }
  }
  function bindTexture(textureOrViewId) {
    const record = pipelineOfTexture();
    const resolved = resolveTexture(textureOrViewId);
    if (resolved === undefined)
      return;
    if (record !== undefined && record.hasTextures) {
      setPipelineVariant(record, resolved.filterable ? "float" : "unfilterable-float");
    }
    if (pendingTextureIds.length < 32)
      pendingTextureIds.push(textureOrViewId);
  }
  function pipelineOfTexture() {
    return currentPipelineId >= 0 ? pipelines.get(currentPipelineId) : undefined;
  }
  const resolveScratch = { view: null, sampler: null, filterable: false };
  function resolveTexture(textureOrViewId) {
    const subView = textureViews.get(textureOrViewId);
    if (subView !== undefined) {
      const record2 = textures.get(subView.textureId);
      if (record2 === undefined)
        return;
      resolveScratch.view = subView.view;
      resolveScratch.sampler = record2.sampler;
      resolveScratch.filterable = record2.filterable;
      return resolveScratch;
    }
    const record = textures.get(textureOrViewId);
    if (record === undefined)
      return;
    resolveScratch.view = record.view;
    resolveScratch.sampler = record.sampler;
    resolveScratch.filterable = record.filterable;
    return resolveScratch;
  }
  let flushMemoBox = null;
  function flushTextureBindGroup() {
    if (pendingTextureIds.length === 0)
      return;
    if (pass === null) {
      pendingTextureIds.length = 0;
      return;
    }
    const record = pipelineOfTexture();
    const bindings = record !== undefined && record.textureBindings.length > 0 ? record.textureBindings : [1];
    const count = bindings.length;
    const memo = flushMemoBox;
    if (memo !== null && memo.pipelineId === currentPipelineId && memo.count === count && memo.ids.length === pendingTextureIds.length) {
      let same = true;
      for (let at = 0;at < memo.ids.length; at++) {
        if (memo.ids[at] !== pendingTextureIds[at]) {
          same = false;
          break;
        }
      }
      if (same) {
        pass.setBindGroup(1, memo.group);
        pendingTextureIds.length = 0;
        return;
      }
    }
    const key = `${currentPipelineId}:${count}:${pendingTextureIds.join(",")}`;
    let group = textureBindGroups.get(key);
    if (group === undefined) {
      const first = resolveTexture(pendingTextureIds[0]);
      if (first === undefined) {
        pendingTextureIds.length = 0;
        return;
      }
      const variant = first.filterable ? "float" : "unfilterable-float";
      const entries = [{ binding: 0, resource: first.sampler }];
      for (let slot = 0;slot < count; slot++) {
        const id = pendingTextureIds[Math.min(slot, pendingTextureIds.length - 1)];
        const resolved = resolveTexture(id);
        if (resolved === undefined) {
          pendingTextureIds.length = 0;
          return;
        }
        entries.push({ binding: bindings[slot], resource: resolved.view });
      }
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: variant === "float" ? "filtering" : "non-filtering" } },
          ...bindings.map((binding) => ({
            binding,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: variant }
          }))
        ]
      });
      group = device.createBindGroup({ layout, entries });
      textureBindGroups.set(key, group);
    }
    pass.setBindGroup(1, group);
    flushMemoBox = { pipelineId: currentPipelineId, count, ids: pendingTextureIds.slice(), group };
    pendingTextureIds.length = 0;
  }
  function beginPass(_clearIndex) {
    bindTarget(0, true);
  }
  function setCanvasClearColor(color, depth2) {
    const [r, g, b, a] = color;
    if (![r, g, b, a].every((v) => Number.isFinite(v))) {
      throw new Error(`rune: setCanvasClearColor — the color must be finite rgba (got [${r}, ${g}, ${b}, ${a}])`);
    }
    if (depth2 !== undefined && !Number.isFinite(depth2)) {
      throw new Error(`rune: setCanvasClearColor — depth must be a finite number (got ${depth2})`);
    }
    canvasClearR = r;
    canvasClearG = g;
    canvasClearB = b;
    canvasClearA = a;
    canvasDepthClear = depth2 ?? 1;
  }
  function createTarget(textureId, targetWidth, targetHeight, depth2, color) {
    const record = textures.get(textureId);
    if (record === undefined)
      throw new Error(`rune: createTarget — texture ${textureId} not found`);
    let targetDepthView = null;
    let targetDepthTexture = null;
    if (depth2) {
      targetDepthTexture = device.createTexture({
        size: [targetWidth, targetHeight],
        format: "depth24plus",
        usage: GPUTextureUsage.RENDER_ATTACHMENT
      });
      targetDepthView = targetDepthTexture.createView();
    }
    const id = nextTargetId++;
    targets.set(id, { view: record.view, depthView: targetDepthView, depthTexture: targetDepthTexture, color, width: targetWidth, height: targetHeight, textureId });
    return id;
  }
  function bindTarget(targetId, clear) {
    if (targetId === currentTarget && pass !== null && !clear)
      return;
    if (pass !== null) {
      if (timerHandle !== null)
        timerHandle.onEndPass(pass);
      pass.end();
      pass = null;
    }
    currentTarget = targetId;
    encoder ??= device.createCommandEncoder();
    const loadOp = clear ? "clear" : "load";
    let colorView;
    let depthAttachment;
    let clearValue;
    if (targetId === 0) {
      colorView = gpuContext.getCurrentTexture().createView();
      clearValue = { r: canvasClearR, g: canvasClearG, b: canvasClearB, a: canvasClearA };
      depthAttachment = depthView !== null ? {
        view: depthView,
        depthClearValue: canvasDepthClear,
        depthLoadOp: loadOp,
        depthStoreOp: "store"
      } : undefined;
    } else {
      const target = targets.get(targetId);
      if (target === undefined)
        return;
      colorView = target.view;
      clearValue = { r: target.color[0], g: target.color[1], b: target.color[2], a: target.color[3] };
      depthAttachment = target.depthView !== null ? {
        view: target.depthView,
        depthClearValue: 1,
        depthLoadOp: loadOp,
        depthStoreOp: "store"
      } : undefined;
    }
    pass = encoder.beginRenderPass({
      colorAttachments: [{ view: colorView, clearValue, loadOp, storeOp: "store" }],
      depthStencilAttachment: depthAttachment
    });
    if (timerHandle !== null)
      timerHandle.onBeginPass(pass);
    currentPipelineId = -1;
    currentPipeline = null;
  }
  function draw(count, instances) {
    flushTextureBindGroup();
    pass?.draw(count, instances);
  }
  function endPass() {
    if (pass !== null && timerHandle !== null)
      timerHandle.onEndPass(pass);
    pass?.end();
    pass = null;
  }
  function submit() {
    if (encoder === null)
      return;
    if (timerHandle !== null)
      timerHandle.onSubmit(encoder);
    device.queue.submit([encoder.finish()]);
    encoder = null;
  }
  function readTargetPixels(targetId) {
    return new Promise((resolve3, reject) => {
      if (targetId === 0) {
        reject(new Error("rune: readTargetPixels(0) — the canvas cannot be read (a presented texture lives one frame). Read the SURFACE: renderer.surface(...) → capture/passes → surface.read()"));
        return;
      }
      const target = targets.get(targetId);
      if (target === undefined) {
        reject(new Error(`rune: readTargetPixels — target ${targetId} not found (deleted or never created)`));
        return;
      }
      const record = textures.get(target.textureId);
      if (record === undefined) {
        reject(new Error(`rune: readTargetPixels — texture ${target.textureId} of target ${targetId} not found`));
        return;
      }
      try {
        const w = target.width;
        const h = target.height;
        if (pass !== null) {
          if (timerHandle !== null)
            timerHandle.onEndPass(pass);
          pass.end();
          pass = null;
        }
        encoder ??= device.createCommandEncoder();
        const rowBytes = w * 4;
        const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
        const buffer = device.createBuffer({
          size: bytesPerRow * h,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        encoder.copyTextureToBuffer({ texture: record.texture }, { buffer, bytesPerRow, rowsPerImage: h }, [w, h, 1]);
        const swizzle = record.format === "bgra8unorm" || record.format === "bgra8unorm-srgb";
        submit();
        buffer.mapAsync(GPUMapMode.READ).then(() => {
          try {
            const mapped = new Uint8Array(buffer.getMappedRange());
            const out = new Uint8Array(rowBytes * h);
            for (let y = 0;y < h; y++) {
              const src = y * bytesPerRow;
              const dst = y * rowBytes;
              if (swizzle) {
                for (let x = 0;x < rowBytes; x += 4) {
                  out[dst + x] = mapped[src + x + 2];
                  out[dst + x + 1] = mapped[src + x + 1];
                  out[dst + x + 2] = mapped[src + x];
                  out[dst + x + 3] = mapped[src + x + 3];
                }
              } else {
                out.set(mapped.subarray(src, src + rowBytes), dst);
              }
            }
            buffer.unmap();
            buffer.destroy();
            resolve3(out);
          } catch (e) {
            try {
              buffer.destroy();
            } catch {}
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        }, (e) => {
          try {
            buffer.destroy();
          } catch {}
          reject(e instanceof Error ? e : new Error(`readTargetPixels: mapAsync rejected (${String(e)})`));
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
  function deleteTexture(textureId) {
    const record = textures.get(textureId);
    if (record === undefined)
      return;
    if (flushMemoBox !== null && flushMemoBox.ids.includes(textureId))
      flushMemoBox = null;
    for (const key of textureBindGroups.keys()) {
      const parts = key.split(":");
      if (parts.length > 2 && parts[2].split(",").includes(String(textureId))) {
        textureBindGroups.delete(key);
      }
    }
    for (const [viewId, sv] of textureViews) {
      if (sv.textureId === textureId) {
        invalidateTextureViewBindGroups(viewId);
        textureViews.delete(viewId);
      }
    }
    record.texture.destroy();
    textures.delete(textureId);
  }
  function invalidateTextureViewBindGroups(viewId) {
    if (flushMemoBox !== null && flushMemoBox.ids.includes(viewId))
      flushMemoBox = null;
    for (const key of textureBindGroups.keys()) {
      const parts = key.split(":");
      if (parts.length > 2 && parts[2].split(",").includes(String(viewId))) {
        textureBindGroups.delete(key);
      }
    }
  }
  function createTextureView(textureId, options) {
    const record = textures.get(textureId);
    if (record === undefined) {
      throw new Error(`rune: createTextureView — texture ${textureId} not found`);
    }
    const view = record.texture.createView({
      baseMipLevel: options?.baseMipLevel ?? 0,
      mipLevelCount: options?.mipLevelCount,
      baseArrayLayer: options?.baseArrayLayer,
      arrayLayerCount: options?.arrayLayerCount,
      dimension: "2d",
      aspect: "all"
    });
    const viewId = nextTextureViewId++;
    textureViews.set(viewId, { textureId, view });
    return viewId;
  }
  function deleteTextureView(viewId) {
    const sv = textureViews.get(viewId);
    if (sv === undefined)
      return;
    invalidateTextureViewBindGroups(viewId);
    textureViews.delete(viewId);
  }
  function deleteTarget(targetId) {
    const target = targets.get(targetId);
    if (target === undefined)
      return;
    target.depthTexture?.destroy();
    targets.delete(targetId);
  }
  let facadeDisposed = false;
  function installTimer(handle) {
    const prev = timerHandle;
    timerHandle = handle;
    return prev;
  }
  function dispose() {
    if (facadeDisposed)
      return;
    facadeDisposed = true;
    timerHandle = null;
    for (const record of textures.values()) {
      record.texture.destroy();
    }
    textures.clear();
    textureBindGroups.clear();
    textureViews.clear();
    depthTexture?.destroy();
    depthTexture = null;
    depthView = null;
    for (const target of targets.values()) {
      target.depthTexture?.destroy();
    }
    targets.clear();
    ubo?.destroy();
    ubo = null;
    uboSize = 0;
    uboGroup = null;
    uboBindingWindow = 256;
    for (const buf of vertexBuffers.values()) {
      buf.destroy();
    }
    vertexBuffers.clear();
    pipelines.clear();
    encoder = null;
    pass = null;
    currentPipeline = null;
    currentTarget = 0;
    device.destroy();
  }
  const externalBuffers = new Map;
  let nextExternalId = 1;
  function createExternalBuffer(byteLength, usage) {
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
      onGpuError?.(`createExternalBuffer: byteLength must be > 0 (got ${byteLength})`);
      return -1;
    }
    const buffer = device.createBuffer({ size: Math.ceil(byteLength / 4) * 4, usage });
    const id = nextExternalId++;
    externalBuffers.set(id, buffer);
    return id;
  }
  function externalBufferOf(id) {
    return externalBuffers.get(id);
  }
  function writeExternalBuffer(id, data, byteOffset = 0, byteLength = data.byteLength) {
    const buffer = externalBuffers.get(id);
    if (buffer === undefined) {
      onGpuError?.(`writeExternalBuffer(${id}): no such external buffer`);
      return;
    }
    const capped = Math.min(byteLength, buffer.size - byteOffset);
    if (capped !== byteLength) {
      onGpuError?.(`writeExternalBuffer(${id}) clamp: ${byteLength} @${byteOffset} → ${capped} (buffer size ${buffer.size})`);
    }
    if (capped <= 0)
      return;
    try {
      device.queue.writeBuffer(buffer, byteOffset, data.buffer, data.byteOffset, capped);
    } catch (error) {
      onGpuError?.(`writeExternalBuffer(${id}, ${capped} bytes) rejected: ${errorMessage(error)}`);
    }
  }
  function readExternalBuffer(id, byteLength) {
    return new Promise((resolve3, reject) => {
      const buffer = externalBuffers.get(id);
      if (buffer === undefined) {
        reject(new Error(`rune: readExternalBuffer(${id}) — no such external buffer`));
        return;
      }
      const capped = Math.min(byteLength, buffer.size);
      const staging = device.createBuffer({ size: Math.max(16, Math.ceil(capped / 256) * 256), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(buffer, 0, staging, 0, Math.ceil(capped / 4) * 4);
      device.queue.submit([enc.finish()]);
      staging.mapAsync(GPUMapMode.READ).then(() => {
        const bytes = new Uint8Array(staging.getMappedRange().slice(0));
        staging.unmap();
        staging.destroy();
        resolve3(new Float32Array(bytes.buffer, 0, Math.floor(capped / 4)));
      }, (error) => {
        staging.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
  function deleteExternalBuffer(id) {
    const buffer = externalBuffers.get(id);
    if (buffer === undefined)
      return;
    externalBuffers.delete(id);
    buffer.destroy();
  }
  function bindExternalVertexBuffer(slot, bufferId) {
    const buffer = externalBuffers.get(bufferId);
    if (buffer === undefined) {
      onGpuError?.(`bindExternalVertexBuffer(${slot}, ${bufferId}): no such external buffer`);
      return;
    }
    pass?.setVertexBuffer(slot, buffer);
  }
  const computeFamilies = new Map;
  let nextComputeId = 1;
  function createCompute(wgsl, uniformBytes2, bufferIds) {
    const module = device.createShaderModule({ code: wgsl });
    module.getCompilationInfo().then((info) => {
      for (const message of info.messages) {
        if (message.type === "error")
          onGpuError?.(`compute WGSL: ${message.message} (line ${message.lineNum})`);
      }
    }).catch(() => {});
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } }
      ]
    });
    const uniformSize = Math.max(16, Math.ceil(uniformBytes2 / 16) * 16);
    const uniform = device.createBuffer({ size: uniformSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const entries = [{ binding: 0, resource: { buffer: uniform } }];
    for (let b = 0;b < 4; b++) {
      const buffer = externalBuffers.get(bufferIds[b]);
      if (buffer === undefined) {
        onGpuError?.(`createCompute: binding ${b + 1} — no external buffer ${bufferIds[b]}`);
        return -1;
      }
      entries.push({ binding: b + 1, resource: { buffer } });
    }
    const group = device.createBindGroup({ layout, entries });
    const id = nextComputeId++;
    computeFamilies.set(id, { module, layout, group, uniform, uniformBytes: uniformSize, pipelines: new Map });
    return id;
  }
  function deleteCompute(computeId) {
    const family = computeFamilies.get(computeId);
    if (family === undefined)
      return;
    computeFamilies.delete(computeId);
    try {
      family.uniform.destroy();
    } catch {}
  }
  function runCompute(computeId, entry, uniformData, workgroups) {
    const family = computeFamilies.get(computeId);
    if (family === undefined) {
      onGpuError?.(`runCompute(${computeId}): no such compute family`);
      return;
    }
    if (pass !== null) {
      onGpuError?.(`runCompute(${entry}): a render pass is open — compute must run BEFORE the frame's draws (the tape contract: step() in the frame callback, record/draw after)`);
      return;
    }
    let pipeline = family.pipelines.get(entry);
    if (pipeline === undefined) {
      try {
        pipeline = device.createComputePipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [family.layout] }), compute: { module: family.module, entryPoint: entry } });
      } catch (error) {
        onGpuError?.(`createComputePipeline(${entry}) rejected: ${errorMessage(error)}`);
        return;
      }
      family.pipelines.set(entry, pipeline);
    }
    const bytes = Math.min(uniformData.byteLength, family.uniformBytes);
    device.queue.writeBuffer(family.uniform, 0, uniformData.buffer, uniformData.byteOffset, bytes);
    if (uniformData.byteLength > family.uniformBytes) {
      onGpuError?.(`runCompute(${entry}) uniform clamp: ${uniformData.byteLength} → ${family.uniformBytes} bytes (the staging was sized at createCompute)`);
    }
    if (workgroups <= 0)
      return;
    encoder ??= device.createCommandEncoder();
    const cp = encoder.beginComputePass();
    cp.setPipeline(pipeline);
    cp.setBindGroup(0, family.group);
    cp.dispatchWorkgroups(workgroups);
    cp.end();
  }
  return {
    configure,
    resize,
    setCanvasClearColor,
    createTexture,
    texSubImage2D,
    copyExternalImageToTexture,
    copyExternalImageToTextureMip,
    uploadUniforms,
    ensurePipeline,
    usePipeline,
    bindUniforms,
    bindVertexBuffer,
    syncVertexBuffer,
    bindExternalVertexBuffer,
    bindTexture,
    beginPass,
    draw,
    endPass,
    submit,
    createExternalBuffer,
    writeExternalBuffer,
    readExternalBuffer,
    deleteExternalBuffer,
    externalBufferOf,
    createCompute,
    runCompute,
    deleteCompute,
    readTargetPixels,
    createTarget,
    bindTarget,
    deleteTexture,
    deleteTarget,
    createTextureView,
    deleteTextureView,
    dispose,
    installTimer,
    get adapter() {
      return adapter;
    },
    get device() {
      return device;
    },
    get preferredFormat() {
      return format;
    },
    get timer() {
      return gpuTimer;
    }
  };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function countGroup1TextureBindings(wgsl) {
  let count = 0;
  for (const _match of wgsl.matchAll(/@group\(1\)[^\n;]*var\s+\w+\s*:\s*texture_2d/g))
    count++;
  return Math.max(1, count);
}
function group1TextureBindings(wgsl) {
  const found = [];
  for (const match of wgsl.matchAll(/@group\(1\)[^\n;]*var\s+\w+\s*:\s*texture_2d/g)) {
    const bMatch = /@binding\((\d+)\)/.exec(match[0]);
    if (bMatch === null)
      continue;
    const binding = Number(bMatch[1]);
    if (Number.isInteger(binding) && binding >= 0 && !found.includes(binding))
      found.push(binding);
  }
  if (found.length === 0)
    found.push(1);
  return found;
}
// packages/webgpu/src/capsProbe.ts
function probeGPUCaps(probe) {
  const features = new Set;
  const formatMatrix = new Map;
  const paths = new Map;
  const extensions = new Map;
  const limits = {};
  const featureMap = [
    ["astc", "texture-compression-astc"],
    ["etc2", "texture-compression-etc2"],
    ["bc1", "texture-compression-bc"],
    ["bc3", "texture-compression-bc"],
    ["bc7", "texture-compression-bc"],
    ["depth-clamp", "depth-clamping"],
    ["timestamp-query", "timestamp-query"],
    ["pipeline-stats", "pipeline-statistics-query"],
    ["occlusion-query", "occlusion-query"],
    ["bgra8-storage", "bgra8unorm-storage"],
    ["float32-filterable", "float32-filterable"],
    ["rg11b10ufloat-render", "rg11b10ufloat-render"],
    ["shared-exponent", "rgba8snorm-color-render-.."]
  ];
  for (const [feature, gpuName] of featureMap) {
    if (probe.hasFeature(gpuName)) {
      features.add(feature);
      extensions.set(gpuName, true);
    }
  }
  features.add("instancing");
  features.add("depth-texture");
  features.add("offscreen-canvas");
  if (typeof VideoFrame !== "undefined")
    features.add("video-frame");
  const limitNames = [
    "maxTextureDimension1D",
    "maxTextureDimension2D",
    "maxTextureDimension3D",
    "maxTextureArrayLayers",
    "maxBindGroups",
    "maxBindingsPerBindGroup",
    "maxBufferSize",
    "maxDynamicUniformBuffersPerPipelineLayout",
    "maxDynamicStorageBuffersPerPipelineLayout",
    "maxSampledTexturesPerShaderStage",
    "maxSamplersPerShaderStage",
    "maxStorageBuffersPerShaderStage",
    "maxStorageTexturesPerShaderStage",
    "maxUniformBuffersPerShaderStage",
    "maxUniformBufferBindingSize",
    "maxStorageBufferBindingSize",
    "maxVertexBuffers",
    "maxVertexAttributes",
    "maxVertexBufferArrayStride",
    "maxInterStageShaderComponents",
    "maxColorAttachments",
    "maxColorAttachmentBytesPerSample",
    "maxComputeWorkgroupStorageSize",
    "maxComputeInvocationsPerWorkgroup",
    "maxComputeWorkgroupSizeX",
    "maxComputeWorkgroupSizeY",
    "maxComputeWorkgroupSizeZ",
    "maxComputeWorkgroupsPerDimension",
    "maxAnisotropy"
  ];
  for (const name of limitNames) {
    const v = probe.getLimit(name);
    if (typeof v === "number" && Number.isFinite(v)) {
      const alias = name.replace("maxTextureDimension2D", "maxTextureSize2D").replace("maxTextureDimension3D", "maxTextureSize3D").replace("maxTextureDimension1D", "maxTextureSize1D");
      limits[alias] = v;
      limits[name] = v;
    }
  }
  features.add("anisotropic");
  limits["maxAnisotropy"] = 16;
  const msc = probe.getLimit("maxSampleCount");
  if (typeof msc === "number") {
    if (msc >= 2)
      features.add("msaa-2x");
    if (msc >= 4)
      features.add("msaa-4x");
    if (msc >= 8)
      features.add("msaa-8x");
    if (msc >= 16)
      features.add("msaa-16x");
  } else {
    features.add("msaa-2x");
    features.add("msaa-4x");
  }
  const hasFloat32Filter = features.has("float32-filterable");
  const hasRg11b10 = features.has("rg11b10ufloat-render");
  const setFmt = (format, axis, support) => {
    formatMatrix.set(`${format}|${axis}`, support);
  };
  for (const axis of ["sampled", "render", "blend", "filter", "msaa", "storage"]) {
    setFmt("rgba8unorm", axis, "native");
  }
  setFmt("rgba8unorm", "storage", "none");
  for (const axis of ["sampled", "render", "blend", "filter", "msaa"]) {
    setFmt("rgba8unorm-srgb", axis, "native");
  }
  setFmt("rgba8unorm-srgb", "storage", "none");
  for (const axis of ["sampled", "render", "blend", "filter", "msaa"]) {
    setFmt("bgra8unorm", axis, "native");
  }
  setFmt("bgra8unorm", "storage", features.has("bgra8-storage") ? "native" : "none");
  for (const axis of ["sampled", "filter"]) {
    setFmt("r8unorm", axis, "native");
    setFmt("rg8unorm", axis, "native");
  }
  for (const axis of ["render", "blend", "msaa", "storage"]) {
    setFmt("r8unorm", axis, "none");
    setFmt("rg8unorm", axis, "none");
  }
  setFmt("rgba16float", "sampled", "native");
  setFmt("rgba16float", "filter", hasFloat32Filter ? "native" : "none");
  setFmt("rgba16float", "render", hasFloat32Filter ? "native" : "none");
  setFmt("rgba16float", "blend", hasFloat32Filter ? "native" : "none");
  setFmt("rgba16float", "msaa", hasFloat32Filter ? "native" : "none");
  setFmt("rgba16float", "storage", "none");
  setFmt("rgba32float", "sampled", "native");
  setFmt("rgba32float", "filter", hasFloat32Filter ? "native" : "none");
  setFmt("rgba32float", "render", hasFloat32Filter ? "native" : "none");
  setFmt("rgba32float", "blend", hasFloat32Filter ? "native" : "none");
  setFmt("rgba32float", "msaa", "none");
  setFmt("rgba32float", "storage", "none");
  setFmt("rg11b10ufloat", "sampled", "native");
  setFmt("rg11b10ufloat", "filter", "native");
  setFmt("rg11b10ufloat", "render", hasRg11b10 ? "native" : "none");
  setFmt("rg11b10ufloat", "blend", hasRg11b10 ? "native" : "none");
  setFmt("rg11b10ufloat", "msaa", hasRg11b10 ? "native" : "none");
  setFmt("rg11b10ufloat", "storage", "none");
  for (const axis of ["sampled", "render", "msaa"]) {
    setFmt("depth24plus", axis, "native");
  }
  for (const axis of ["filter", "blend", "storage"]) {
    setFmt("depth24plus", axis, "none");
  }
  for (const axis of ["sampled", "render", "msaa"]) {
    setFmt("depth24plus-stencil8", axis, "native");
  }
  for (const axis of ["filter", "blend", "storage"]) {
    setFmt("depth24plus-stencil8", axis, "none");
  }
  paths.set("wgpu-direct", "supported");
  paths.set("wgpu-copy", "supported");
  paths.set("canvas-direct", "supported");
  paths.set("asyncbmp", features.has("offscreen-canvas") ? "supported" : "unsupported");
  return {
    features,
    formatMatrix,
    paths,
    extensions,
    limits,
    backend: "webgpu"
  };
}
function makeGPUProbe(adapter, preferredFormat, device) {
  const features = adapter.features;
  const adapterLimits = adapter.limits;
  const deviceLimits = device?.limits ?? null;
  let infoCache = null;
  const getInfo = () => {
    if (infoCache)
      return infoCache;
    const info = adapter.info;
    if (info && typeof info === "object") {
      infoCache = {
        vendor: info.vendor ?? "",
        architecture: info.architecture ?? "",
        description: info.description ?? ""
      };
    } else {
      infoCache = { vendor: "", architecture: "", description: "" };
    }
    return infoCache;
  };
  return {
    hasFeature: (name) => {
      try {
        return features.has(name);
      } catch {
        return false;
      }
    },
    getLimit: (name) => {
      try {
        const adapterV = adapterLimits[name];
        if (typeof adapterV === "number")
          return adapterV;
        if (deviceLimits !== null) {
          const deviceV = deviceLimits[name];
          if (typeof deviceV === "number")
            return deviceV;
        }
        return;
      } catch {
        return;
      }
    },
    get info() {
      return getInfo();
    },
    preferredFormat
  };
}
// packages/gl/src/webgpuRenderer.ts
init_src();

// packages/gl/src/journalGpu.ts
function withJournalGpu(gpu, journal) {
  const texSizes = new Map;
  return {
    configure: (w, h) => gpu.configure(w, h),
    resize: (w, h) => gpu.resize(w, h),
    setCanvasClearColor: (color, depth2) => gpu.setCanvasClearColor(color, depth2),
    createTexture: (width, height, format, options) => {
      const id = gpu.createTexture(width, height, format, options);
      texSizes.set(id, { w: width, h: height });
      journal.record({ kind: "createTexture", id, width, height, format, options });
      return id;
    },
    texSubImage2D: (textureId, x, y, w, h, bytes) => gpu.texSubImage2D(textureId, x, y, w, h, bytes),
    copyExternalImageToTexture: (textureId, source, dstX, dstY, copyWidth, copyHeight, flipY) => {
      gpu.copyExternalImageToTexture(textureId, source, dstX, dstY, copyWidth, copyHeight, flipY);
      const size = texSizes.get(textureId);
      const isFullTexture = size !== undefined && dstX === 0 && dstY === 0 && copyWidth === size.w && copyHeight === size.h;
      if (isFullTexture) {
        journal.record({
          kind: "texImage2DFromSource",
          textureId,
          sourceKind: describeGpuSourceKind(source),
          flipY: flipY === true
        });
      }
    },
    copyExternalImageToTextureMip: (textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY) => gpu.copyExternalImageToTextureMip(textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY),
    uploadUniforms: (offset, data) => gpu.uploadUniforms(offset, data),
    ensurePipeline: (pipelineId, wgsl, attrSizes, hasTextures) => gpu.ensurePipeline(pipelineId, wgsl, attrSizes, hasTextures),
    usePipeline: (pipelineId) => gpu.usePipeline(pipelineId),
    bindUniforms: (dynamicOffset) => gpu.bindUniforms(dynamicOffset),
    bindVertexBuffer: (slot, data, size) => gpu.bindVertexBuffer(slot, data, size),
    syncVertexBuffer: (data, byteLength) => gpu.syncVertexBuffer(data, byteLength),
    bindExternalVertexBuffer: (slot, bufferId) => gpu.bindExternalVertexBuffer(slot, bufferId),
    createExternalBuffer: (byteLength, usage) => gpu.createExternalBuffer(byteLength, usage),
    writeExternalBuffer: (id, data, byteOffset, byteLength) => gpu.writeExternalBuffer(id, data, byteOffset, byteLength),
    readExternalBuffer: (id, byteLength) => gpu.readExternalBuffer(id, byteLength),
    deleteExternalBuffer: (id) => gpu.deleteExternalBuffer(id),
    externalBufferOf: (id) => gpu.externalBufferOf(id),
    createCompute: (wgsl, uniformBytes2, bufferIds) => gpu.createCompute(wgsl, uniformBytes2, bufferIds),
    runCompute: (computeId, entry, uniformData, workgroups) => gpu.runCompute(computeId, entry, uniformData, workgroups),
    deleteCompute: (computeId) => gpu.deleteCompute(computeId),
    bindTexture: (textureOrViewId) => gpu.bindTexture(textureOrViewId),
    beginPass: (clearIndex) => gpu.beginPass(clearIndex),
    draw: (count, instances) => gpu.draw(count, instances),
    endPass: () => gpu.endPass(),
    submit: () => gpu.submit(),
    createTarget: (textureId, w, h, depth2, color) => {
      const id = gpu.createTarget(textureId, w, h, depth2, color);
      journal.record({ kind: "createTarget", id, textureId, width: w, height: h, depth: depth2, color });
      return id;
    },
    bindTarget: (targetId, clear) => gpu.bindTarget(targetId, clear),
    readTargetPixels: (targetId) => gpu.readTargetPixels(targetId),
    deleteTexture: (textureId) => {
      gpu.deleteTexture(textureId);
      texSizes.delete(textureId);
      journal.record({ kind: "destroyTexture", id: textureId });
    },
    deleteTarget: (targetId) => {
      gpu.deleteTarget(targetId);
      journal.record({ kind: "destroyTarget", id: targetId });
    },
    createTextureView: (textureId, options) => {
      const viewId = gpu.createTextureView(textureId, options);
      journal.record({
        kind: "createTextureView",
        id: viewId,
        textureId,
        baseMipLevel: options?.baseMipLevel,
        mipLevelCount: options?.mipLevelCount
      });
      return viewId;
    },
    deleteTextureView: (viewId) => {
      gpu.deleteTextureView(viewId);
      journal.record({ kind: "destroyTextureView", id: viewId });
    },
    dispose: () => gpu.dispose(),
    installTimer: (handle) => gpu.installTimer(handle),
    get adapter() {
      return gpu.adapter;
    },
    get device() {
      return gpu.device;
    },
    get preferredFormat() {
      return gpu.preferredFormat;
    },
    get timer() {
      return gpu.timer;
    }
  };
}
function replayJournalOnGpu(journal, target, sourceFor) {
  journal.replay((op) => applyGpuOp(op, target, sourceFor));
}
function applyGpuOp(op, gpu, sourceFor) {
  switch (op.kind) {
    case "createTexture":
      gpu.createTexture(op.width, op.height, op.format, op.options);
      break;
    case "createTarget":
      gpu.createTarget(op.textureId, op.width, op.height, op.depth, op.color);
      break;
    case "texImage2DFromSource": {
      const source = sourceFor?.(op.sourceKind) ?? null;
      if (source === null)
        break;
      const [sw, sh] = externalImageSize(source);
      gpu.copyExternalImageToTexture(op.textureId, source, 0, 0, sw, sh, op.flipY);
      break;
    }
    case "createTextureView":
      gpu.createTextureView(op.textureId, {
        baseMipLevel: op.baseMipLevel,
        mipLevelCount: op.mipLevelCount
      });
      break;
    default:
      break;
  }
}
function describeGpuSourceKind(source) {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap)
    return "ImageBitmap";
  if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)
    return "OffscreenCanvas";
  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement)
    return "HTMLCanvasElement";
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement)
    return "HTMLVideoElement";
  if (typeof source === "object" && source !== null) {
    if ("displayWidth" in source && "codedWidth" in source)
      return "VideoFrame";
    if ("getContext" in source)
      return "OffscreenCanvas";
    if ("close" in source && "width" in source)
      return "ImageBitmap";
  }
  return source.constructor?.name ?? "unknown";
}

// packages/gl/src/resourceSessionGPU.ts
init_src();
var VIEW_ID_BASE2 = 1e6;
function createResourceSessionGPU(raw, journal) {
  const texMap = new Map;
  const viewMap = new Map;
  const targetMap = new Map;
  const texSizes = new Map;
  let useCounter = 0;
  const lastUse = new Map;
  const viewParent = new Map;
  const targetParent = new Map;
  const texMips = new Map;
  const texFormats = new Map;
  let nextTex = 1;
  let nextView = VIEW_ID_BASE2;
  let nextTarget = 1;
  function touch(textureId) {
    lastUse.set(textureId, ++useCounter);
  }
  function touchTexOrView(texOrViewId) {
    touch(texOrViewId >= VIEW_ID_BASE2 ? viewParent.get(texOrViewId) ?? texOrViewId : texOrViewId);
  }
  function seedCounters() {
    nextTex = Math.max(nextTex, journal.maxTextureId() + 1);
    nextView = Math.max(nextView, journal.maxViewId() + 1);
    nextTarget = Math.max(nextTarget, journal.maxTargetId() + 1);
  }
  seedCounters();
  const rawTex = (id) => {
    const mapped = texMap.get(id);
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable textureId=${id}. ` + `The resource was not created in this session (or restore() has not been run after device loss).`);
    }
    return mapped;
  };
  const rawView = (id) => {
    const mapped = viewMap.get(id);
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable viewId=${id}.`);
    }
    return mapped;
  };
  const rawTarget = (id) => {
    const mapped = targetMap.get(id);
    if (mapped === undefined) {
      throw new Error(`resourceSession: unknown stable targetId=${id}.`);
    }
    return mapped;
  };
  const rawTexOrView = (id) => id >= VIEW_ID_BASE2 ? rawView(id) : rawTex(id);
  const facade = {
    configure: (w, h) => raw.configure(w, h),
    resize: (w, h) => raw.resize(w, h),
    setCanvasClearColor: (color, depth2) => raw.setCanvasClearColor(color, depth2),
    createTexture: (width, height, format, options) => {
      const rawId = raw.createTexture(width, height, format, options);
      const id = nextTex++;
      texMap.set(id, rawId);
      texSizes.set(id, { w: width, h: height });
      texMips.set(id, options?.mipLevels ?? 1);
      texFormats.set(id, format);
      touch(id);
      journal.record({ kind: "texture.create", id, width, height, format, options });
      return id;
    },
    texSubImage2D: (textureId, x, y, w, h, bytes) => {
      touch(textureId);
      raw.texSubImage2D(rawTex(textureId), x, y, w, h, bytes);
    },
    copyExternalImageToTexture: (textureId, source, dstX, dstY, copyWidth, copyHeight, flipY) => {
      raw.copyExternalImageToTexture(rawTex(textureId), source, dstX, dstY, copyWidth, copyHeight, flipY);
      touch(textureId);
      const size = texSizes.get(textureId);
      const isFull = size !== undefined && dstX === 0 && dstY === 0 && copyWidth === size.w && copyHeight === size.h;
      const kind = describeGpuSourceKind2(source);
      const content = journal.storeSource(source, kind, copyWidth, copyHeight);
      if (isFull) {
        journal.record({ kind: "texture.write", id: textureId, content, flipY: flipY === true });
      } else {
        journal.record({ kind: "texture.update", id: textureId, x: dstX, y: dstY, w: copyWidth, h: copyHeight, content, flipY: flipY === true });
      }
    },
    copyExternalImageToTextureMip: (textureId, mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY) => {
      raw.copyExternalImageToTextureMip(rawTex(textureId), mipLevel, source, dstX, dstY, copyWidth, copyHeight, flipY);
      touch(textureId);
      const kind = describeGpuSourceKind2(source);
      const content = journal.storeSource(source, kind, copyWidth, copyHeight);
      journal.record({ kind: "texture.writeMip", id: textureId, level: mipLevel, content, flipY: flipY === true });
    },
    uploadUniforms: (offset, data) => raw.uploadUniforms(offset, data),
    ensurePipeline: (pipelineId, wgsl, attrSizes, hasTextures) => raw.ensurePipeline(pipelineId, wgsl, attrSizes, hasTextures),
    usePipeline: (pipelineId) => raw.usePipeline(pipelineId),
    bindUniforms: (dynamicOffset) => raw.bindUniforms(dynamicOffset),
    bindVertexBuffer: (slot, data, size) => raw.bindVertexBuffer(slot, data, size),
    syncVertexBuffer: (data, byteLength) => raw.syncVertexBuffer(data, byteLength),
    bindExternalVertexBuffer: (slot, bufferId) => raw.bindExternalVertexBuffer(slot, bufferId),
    createExternalBuffer: (byteLength, usage) => raw.createExternalBuffer(byteLength, usage),
    writeExternalBuffer: (id, data, byteOffset, byteLength) => raw.writeExternalBuffer(id, data, byteOffset, byteLength),
    readExternalBuffer: (id, byteLength) => raw.readExternalBuffer(id, byteLength),
    deleteExternalBuffer: (id) => raw.deleteExternalBuffer(id),
    externalBufferOf: (id) => raw.externalBufferOf(id),
    createCompute: (wgsl, uniformBytes2, bufferIds) => raw.createCompute(wgsl, uniformBytes2, bufferIds),
    runCompute: (computeId, entry, uniformData, workgroups) => raw.runCompute(computeId, entry, uniformData, workgroups),
    deleteCompute: (computeId) => raw.deleteCompute(computeId),
    bindTexture: (textureOrViewId) => {
      touchTexOrView(textureOrViewId);
      raw.bindTexture(rawTexOrView(textureOrViewId));
    },
    beginPass: (clearIndex) => raw.beginPass(clearIndex),
    draw: (count, instances) => raw.draw(count, instances),
    endPass: () => raw.endPass(),
    submit: () => raw.submit(),
    createTarget: (textureId, width, height, depth2, color) => {
      const rawId = raw.createTarget(rawTex(textureId), width, height, depth2, color);
      const id = nextTarget++;
      targetMap.set(id, rawId);
      targetParent.set(id, textureId);
      touch(textureId);
      journal.record({ kind: "target.create", id, textureId, width, height, depth: depth2, color });
      return id;
    },
    bindTarget: (targetId, clear) => {
      if (targetId !== 0) {
        const parent = targetParent.get(targetId);
        if (parent !== undefined)
          touch(parent);
      }
      raw.bindTarget(targetId === 0 ? 0 : rawTarget(targetId), clear);
    },
    readTargetPixels: (targetId) => raw.readTargetPixels(targetId === 0 ? 0 : rawTarget(targetId)),
    deleteTexture: (textureId) => {
      const mapped = texMap.get(textureId);
      if (mapped !== undefined)
        raw.deleteTexture(mapped);
      texMap.delete(textureId);
      texSizes.delete(textureId);
      texMips.delete(textureId);
      texFormats.delete(textureId);
      lastUse.delete(textureId);
      journal.record({ kind: "texture.destroy", id: textureId });
    },
    deleteTarget: (targetId) => {
      const mapped = targetMap.get(targetId);
      if (mapped !== undefined)
        raw.deleteTarget(mapped);
      targetMap.delete(targetId);
      targetParent.delete(targetId);
      journal.record({ kind: "target.destroy", id: targetId });
    },
    createTextureView: (textureId, options) => {
      const rawViewId = raw.createTextureView(rawTex(textureId), options);
      const id = nextView++;
      viewMap.set(id, rawViewId);
      viewParent.set(id, textureId);
      touch(textureId);
      journal.record({
        kind: "view.create",
        id,
        textureId,
        baseMipLevel: options?.baseMipLevel,
        mipLevelCount: options?.mipLevelCount
      });
      return id;
    },
    deleteTextureView: (viewId) => {
      const mapped = viewMap.get(viewId);
      if (mapped !== undefined)
        raw.deleteTextureView(mapped);
      viewMap.delete(viewId);
      viewParent.delete(viewId);
      journal.record({ kind: "view.destroy", id: viewId });
    },
    dispose: () => raw.dispose(),
    installTimer: (handle) => raw.installTimer(handle),
    get adapter() {
      return raw.adapter;
    },
    get device() {
      return raw.device;
    },
    get preferredFormat() {
      return raw.preferredFormat;
    },
    get timer() {
      return raw.timer;
    }
  };
  function applyOp2(op, acc) {
    switch (op.kind) {
      case "texture.create": {
        const rawId = raw.createTexture(op.width, op.height, op.format, op.options);
        texMap.set(op.id, rawId);
        texSizes.set(op.id, { w: op.width, h: op.height });
        texMips.set(op.id, op.options?.mipLevels ?? 1);
        texFormats.set(op.id, op.format);
        touch(op.id);
        acc.textureIds.push(op.id);
        acc.opsReplayed++;
        break;
      }
      case "texture.write": {
        const source = journal.getSource(op.content.ref);
        if (source === null || !gpuSourceAlive(source)) {
          acc.skipped++;
          break;
        }
        raw.copyExternalImageToTexture(rawTex(op.id), source, 0, 0, op.content.width, op.content.height, op.flipY);
        touch(op.id);
        acc.contentOps++;
        acc.opsReplayed++;
        break;
      }
      case "texture.update": {
        const source = journal.getSource(op.content.ref);
        if (source === null || !gpuSourceAlive(source)) {
          acc.skipped++;
          break;
        }
        raw.copyExternalImageToTexture(rawTex(op.id), source, op.x, op.y, op.w, op.h, op.flipY);
        touch(op.id);
        acc.contentOps++;
        acc.opsReplayed++;
        break;
      }
      case "texture.writeMip": {
        const source = journal.getSource(op.content.ref);
        if (source === null || !gpuSourceAlive(source)) {
          acc.skipped++;
          break;
        }
        raw.copyExternalImageToTextureMip(rawTex(op.id), op.level, source, 0, 0, op.content.width, op.content.height, op.flipY);
        touch(op.id);
        acc.contentOps++;
        acc.opsReplayed++;
        break;
      }
      case "view.create": {
        const rawViewId = raw.createTextureView(rawTex(op.textureId), {
          baseMipLevel: op.baseMipLevel,
          mipLevelCount: op.mipLevelCount
        });
        viewMap.set(op.id, rawViewId);
        viewParent.set(op.id, op.textureId);
        touch(op.textureId);
        acc.viewIds.push(op.id);
        acc.opsReplayed++;
        break;
      }
      case "target.create": {
        const rawId = raw.createTarget(rawTex(op.textureId), op.width, op.height, op.depth, op.color);
        targetMap.set(op.id, rawId);
        targetParent.set(op.id, op.textureId);
        touch(op.textureId);
        acc.targetIds.push(op.id);
        acc.opsReplayed++;
        break;
      }
      default:
        break;
    }
  }
  function restore(keep) {
    seedCounters();
    texMap.clear();
    viewMap.clear();
    targetMap.clear();
    viewParent.clear();
    targetParent.clear();
    texSizes.clear();
    texMips.clear();
    texFormats.clear();
    lastUse.clear();
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [], viewIds: [], targetIds: [] };
    if (keep !== undefined) {
      const sel = selectResidentOps(journal.entries(), keep);
      for (const op of sel.ops)
        applyOp2(op, acc);
      return {
        ...acc,
        deferred: { textures: sel.deferredTextures, views: sel.deferredViews, targets: sel.deferredTargets }
      };
    }
    journal.replay((op) => applyOp2(op, acc));
    return { ...acc };
  }
  function ensureResident(resourceId) {
    if (resourceId >= VIEW_ID_BASE2) {
      if (viewMap.has(resourceId))
        return null;
      const sel2 = selectResidentOps(journal.entries(), { viewIds: [resourceId] });
      const acc2 = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [], viewIds: [], targetIds: [] };
      for (const op of sel2.ops)
        applyOp2(op, acc2);
      return { ...acc2 };
    }
    if (texMap.has(resourceId))
      return null;
    const isTexture = journal.entries().some((op) => op.kind === "texture.create" && op.id === resourceId);
    const sel = selectResidentOps(journal.entries(), isTexture ? { textureIds: [resourceId] } : { targetIds: [resourceId] });
    const acc = { opsReplayed: 0, contentOps: 0, skipped: 0, textureIds: [], viewIds: [], targetIds: [] };
    for (const op of sel.ops)
      applyOp2(op, acc);
    return { ...acc };
  }
  function pinnedTextures(pinned) {
    const pin = new Set(pinned?.textureIds ?? []);
    if (pinned?.viewIds !== undefined || pinned?.targetIds !== undefined) {
      for (const op of journal.entries()) {
        if (op.kind === "view.create" && pinned.viewIds?.includes(op.id))
          pin.add(op.textureId);
        else if (op.kind === "target.create" && pinned.targetIds?.includes(op.id))
          pin.add(op.textureId);
      }
    }
    return pin;
  }
  function residencyEntries() {
    const entries = [];
    for (const id of texMap.keys()) {
      const size = texSizes.get(id);
      const bytes = size !== undefined ? estimateTextureBytes(size.w, size.h, texMips.get(id) ?? 1, texFormats.get(id)) : 0;
      entries.push({ id, bytes, lastUse: lastUse.get(id) ?? 0 });
    }
    return entries;
  }
  function residencyStats() {
    const textures = residencyEntries().sort((a, b) => a.lastUse - b.lastUse || a.id - b.id);
    return {
      textures,
      totalBytes: textures.reduce((sum, e) => sum + e.bytes, 0),
      views: [...viewMap.keys()].sort((a, b) => a - b),
      targets: [...targetMap.keys()].sort((a, b) => a - b)
    };
  }
  function evictLRU(options) {
    const budget = options?.budgetBytes ?? Number.POSITIVE_INFINITY;
    const pin = pinnedTextures(options?.pinned);
    const entries = residencyEntries();
    const plan = selectLRUEvictions(entries, budget, pin);
    const evictedViews = [];
    const evictedTargets = [];
    for (const texId of plan.evictIds) {
      for (const [viewId, parent] of viewParent) {
        if (parent === texId && viewMap.has(viewId)) {
          raw.deleteTextureView(viewMap.get(viewId));
          viewMap.delete(viewId);
          viewParent.delete(viewId);
          evictedViews.push(viewId);
        }
      }
      for (const [targetId, parent] of targetParent) {
        if (parent === texId && targetMap.has(targetId)) {
          raw.deleteTarget(targetMap.get(targetId));
          targetMap.delete(targetId);
          targetParent.delete(targetId);
          evictedTargets.push(targetId);
        }
      }
      const mapped = texMap.get(texId);
      if (mapped !== undefined)
        raw.deleteTexture(mapped);
      texMap.delete(texId);
      texSizes.delete(texId);
      texMips.delete(texId);
      texFormats.delete(texId);
      lastUse.delete(texId);
    }
    return {
      textures: plan.evictIds,
      views: evictedViews,
      targets: evictedTargets,
      freedBytes: plan.freedBytes,
      residentBytes: plan.residentBytes,
      residentTextures: [...texMap.keys()].sort((a, b) => a - b)
    };
  }
  return {
    facade,
    get mapping() {
      return texMap;
    },
    rawId(stableId) {
      if (stableId >= VIEW_ID_BASE2)
        return viewMap.get(stableId);
      return texMap.get(stableId) ?? targetMap.get(stableId);
    },
    restore,
    ensureResident,
    evictLRU,
    residencyStats
  };
}
function describeGpuSourceKind2(source) {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap)
    return "ImageBitmap";
  if (typeof OffscreenCanvas !== "undefined" && source instanceof OffscreenCanvas)
    return "OffscreenCanvas";
  if (typeof HTMLCanvasElement !== "undefined" && source instanceof HTMLCanvasElement)
    return "HTMLCanvasElement";
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement)
    return "HTMLVideoElement";
  if (typeof source === "object" && source !== null) {
    if ("displayWidth" in source && "codedWidth" in source)
      return "VideoFrame";
    if ("getContext" in source)
      return "OffscreenCanvas";
    if ("close" in source && "width" in source)
      return "ImageBitmap";
  }
  return source.constructor?.name ?? "unknown";
}
function gpuSourceAlive(source) {
  if (source === null || source === undefined)
    return false;
  const s = source;
  if (typeof s.width === "number" && typeof s.height === "number") {
    return s.width > 0 && s.height > 0;
  }
  return true;
}

// packages/gl/src/webgpuRenderer.ts
var ERROR_STORM_LIMIT = 3;
var DEFAULT_CLEAR3 = { color: [0.07, 0.08, 0.11, 1], depth: 1 };
async function createWebGpuRenderer(options) {
  const canvas = resolveCanvasAny(options.canvas);
  const storm = createErrorStorm(options.onGpuError);
  const rawGpu = options.createGPU !== undefined ? await options.createGPU(canvas, storm.handle) : await createRealGPU(canvas, storm.handle);
  const session = options.resources !== undefined ? createResourceSessionGPU(rawGpu, options.resources) : null;
  const gpu = session !== null ? session.facade : options.journal !== undefined ? withJournalGpu(rawGpu, options.journal) : rawGpu;
  const epoch = createEpoch();
  const layoutGuard = createLayoutGuard();
  const uploads = createUploadScheduler(options.uploads ?? {});
  const transients = createTransientPool();
  const feeds = new Set;
  const builtinValues = createPassBuiltins();
  const writer = createTapeWriter(64);
  const arena = createSliceArena(1 << 16);
  const wgslCtx = createWgpuContext(arena);
  const executor = createGpuExecutor({ gpu, arena, commands: wgslCtx.commands, clears: [] });
  const [initW, initH] = getCanvasCssSize(canvas);
  const size = signal([initW, initH]);
  const aspect = derive(() => size.value[0] / size.value[1]);
  const time = signal(0);
  const frameCtx = { time: 0, dt: 0, aspect: 1, size: [1, 1] };
  const callbacks = [];
  const startedAt = (options.now ?? defaultNow2)();
  let lastNow = startedAt;
  let running = false;
  let cancelScheduled = null;
  let lastCssWidth = -1;
  let lastCssHeight = -1;
  let lastDpr = canvasDpr(canvas, options.dpr);
  await gpu.configure(canvas.width, canvas.height);
  const clear = options.clear ?? DEFAULT_CLEAR3;
  gpu.setCanvasClearColor(clear.color, clear.depth ?? 1);
  const [startW, startH] = getCanvasCssSize(canvas);
  resize(startW, startH);
  const resizeObserver = observeSize(canvas, options);
  let disposed = false;
  function frame(callback) {
    callbacks.push(callback);
    return { cancel: () => removeItem2(callbacks, callback) };
  }
  function command(spec) {
    return compileWgslSpec(spec, wgslCtx);
  }
  function surface(surfaceOptions = {}) {
    const width = surfaceOptions.width ?? 512;
    const height = surfaceOptions.height ?? 512;
    const depth2 = surfaceOptions.depth ?? false;
    const color = surfaceOptions.color ?? DEFAULT_SURFACE_COLOR;
    const textureId = gpu.createTexture(width, height, "canvas");
    const targetId = gpu.createTarget(textureId, width, height, depth2, color);
    let surfaceDisposed = false;
    return {
      targetId,
      texture: { textureId, width, height },
      width,
      height,
      pass: (fragment, passOptions = {}) => createPassCommand(fragment, passOptions, targetId, () => [width, height]),
      capture: (command2, captureOptions = {}) => withTarget(command2, targetId, captureOptions.clear !== false),
      read: () => {
        if (surfaceDisposed) {
          return Promise.reject(new Error("rune: surface.read() after dispose — surface already released"));
        }
        return gpu.readTargetPixels(targetId).then((data) => ({ width, height, data }));
      },
      dispose: () => {
        if (surfaceDisposed)
          return;
        surfaceDisposed = true;
        gpu.deleteTarget(targetId);
        gpu.deleteTexture(textureId);
      }
    };
  }
  function pass(fragment, passOptions = {}) {
    return createPassCommand(fragment, passOptions, 0, () => {
      const [w, h] = size.peek();
      const dprNow = canvasDpr(canvas, options.dpr);
      return [Math.max(1, Math.round(w * dprNow)), Math.max(1, Math.round(h * dprNow))];
    });
  }
  function createPassCommand(fragment, passOptions, targetId, resolutionSource) {
    const inputs = Object.entries(passOptions.inputs ?? {});
    if (inputs.length > 1) {
      throw new Error("rune: v1 WebGPU pass — a single texture input (bind group group 1); use sequential passes for chains");
    }
    const builtins = scanBuiltins(fragment);
    const uniforms = { ...passOptions.uniforms };
    applyBuiltins(uniforms, builtins, builtinValues, resolutionSource);
    const textures = {};
    for (const [name, ref] of inputs) {
      textures[name] = { textureId: ref.textureId };
    }
    const compiled = compileWgslSpec({
      shader: { wgsl: PASS_VERT_WGSL + fragment },
      uniforms,
      attributes: {
        position: { data: FULLSCREEN_QUAD.positions, size: 2 },
        uv: { data: FULLSCREEN_QUAD.uvs, size: 2 }
      },
      textures,
      count: FULLSCREEN_QUAD.vertexCount
    }, wgslCtx);
    return withTarget(compiled, targetId, passOptions.clear === true);
  }
  function recordIntoWriter(command2, props = {}) {
    command2.record(props, frameCtx, writer);
  }
  function resize(cssWidth, cssHeight) {
    const dprNow = canvasDpr(canvas, options.dpr);
    if (cssWidth === lastCssWidth && cssHeight === lastCssHeight && dprNow === lastDpr)
      return;
    lastCssWidth = cssWidth;
    lastCssHeight = cssHeight;
    lastDpr = dprNow;
    const bufferWidth = Math.max(1, Math.round(cssWidth * dprNow));
    const bufferHeight = Math.max(1, Math.round(cssHeight * dprNow));
    if (canvas.width !== bufferWidth)
      canvas.width = bufferWidth;
    if (canvas.height !== bufferHeight)
      canvas.height = bufferHeight;
    size.value = [cssWidth, cssHeight];
    gpu.resize(bufferWidth, bufferHeight);
  }
  function step(nowMs) {
    if (storm.paused)
      return;
    updateFrameContext(nowMs);
    transients.beginFrame();
    try {
      epoch.frame(() => {
        options.transport?.sampleAll();
        for (const feed2 of feeds)
          feed2.sync();
        time.value = frameCtx.time;
        writer.reset();
        writer.emit(OpCode.BeginPass, 0, 0, 0, 0);
        for (const callback of [...callbacks])
          callback(frameCtx, recordIntoWriter);
        writer.emit(OpCode.EndPass, 0, 0, 0, 0);
        executor.run(writerView(writer));
        uploads.drain();
      });
    } catch (error) {
      storm.handle(`frame error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function updateFrameContext(nowMs) {
    frameCtx.time = (nowMs - startedAt) / 1000;
    frameCtx.dt = (nowMs - lastNow) / 1000;
    frameCtx.aspect = aspect.peek();
    frameCtx.size = size.peek();
    lastNow = nowMs;
  }
  function start() {
    if (running)
      return;
    if (storm.paused)
      return;
    running = true;
    scheduleNext();
  }
  function scheduleNext() {
    const request = options.requestFrame ?? defaultRequestFrame;
    cancelScheduled = request((timestamp) => {
      if (!running)
        return;
      step(timestamp);
      scheduleNext();
    });
  }
  function stop() {
    running = false;
    cancelScheduled?.();
    cancelScheduled = null;
  }
  function restart() {
    storm.resume();
    start();
  }
  function observeSize(canvas2, options2) {
    if (options2.observeResize === false)
      return null;
    if (isOffscreenCanvas(canvas2))
      return null;
    if (typeof ResizeObserver === "undefined")
      return null;
    const observer = new ResizeObserver(() => {
      if (canvas2.clientWidth <= 0 || canvas2.clientHeight <= 0)
        return;
      const [cssW, cssH] = getCanvasCssSize(canvas2);
      const verdict = layoutGuard.classify(cssW, cssH);
      if (verdict.verdict !== "apply")
        return;
      resize(verdict.cssWidth, verdict.cssHeight);
    });
    observer.observe(canvas2);
    return observer;
  }
  function feed(feedOptions) {
    const rendererFeed = createRendererFeedGPU(gpu, feedOptions);
    feeds.add(rendererFeed);
    return rendererFeed;
  }
  function dispose() {
    if (disposed)
      return;
    disposed = true;
    stop();
    resizeObserver?.disconnect();
    for (const rendererFeed of feeds)
      rendererFeed.dispose();
    feeds.clear();
    gpu.dispose();
  }
  return { gpu, size, aspect, time, uploads, transients, transport: options.transport ?? null, feed, restoreResources: session !== null ? (options2) => session.restore(options2?.workingSet) : undefined, ensureResident: session !== null ? (resourceId) => session.ensureResident(resourceId) : undefined, evictLRU: session !== null ? (options2) => session.evictLRU(options2) : undefined, residencyStats: session !== null ? () => session.residencyStats() : undefined, command, pass, surface, frame, resize, step, start, stop, restart, dispose };
}
var DEFAULT_SURFACE_COLOR = [0.07, 0.08, 0.11, 1];
function createErrorStorm(report) {
  let count = 0;
  let paused = false;
  return {
    get paused() {
      return paused;
    },
    handle: (message) => {
      if (paused)
        return;
      count++;
      report?.(message);
      if (count >= ERROR_STORM_LIMIT) {
        paused = true;
        report?.(`detected ${count} GPU errors — rendering stopped (storm pause)`);
      }
    },
    resume() {
      count = 0;
      paused = false;
    }
  };
}
function defaultRequestFrame(callback) {
  const id = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(id);
}
function defaultNow2() {
  return performance.now();
}
function removeItem2(list, item) {
  const at = list.indexOf(item);
  if (at >= 0)
    list.splice(at, 1);
}

// packages/gl/src/renderer.ts
init_src();
class BackendResolutionError extends Error {
  decision;
  constructor(decision2) {
    super(decision2.message);
    this.name = "BackendResolutionError";
    this.decision = decision2;
  }
}
function createRenderer(options) {
  const order = normalizeOrder(options.backend);
  const pendingSpecs = [];
  const pendingFrames = [];
  const proxies = [];
  let decision2 = null;
  let inner = null;
  let caps = null;
  let statsCollector = null;
  function requireInner(method) {
    if (inner === null) {
      throw new Error(`rune: renderer.${method}() requires .start(). ` + "First await renderer.start(), then create surfaces/textures/passes.");
    }
    return inner;
  }
  return {
    get size() {
      return requireInner("size").size;
    },
    get aspect() {
      return requireInner("aspect").aspect;
    },
    get time() {
      return requireInner("time").time;
    },
    get uploads() {
      return requireInner("uploads").uploads;
    },
    get transients() {
      return requireInner("transients").transients;
    },
    get inner() {
      return inner;
    },
    get backend() {
      return decision2?.chosen ?? null;
    },
    get decision() {
      return decision2;
    },
    get caps() {
      return caps;
    },
    get transport() {
      return options.transport ?? null;
    },
    feed(feedOptions) {
      return requireInner("feed").feed(feedOptions);
    },
    texture(w, h, options2) {
      const i = requireInner("texture");
      const mipLevels = options2?.mipLevels ?? 1;
      const maxAnisotropy = options2?.maxAnisotropy;
      const format = options2?.format;
      if ("gl" in i) {
        return i.texture(w, h, { mipLevels, maxAnisotropy, format: glFormatFromTextureFormat(format) });
      }
      const gpu = i.gpu;
      const textureId = gpu.createTexture(w, h, format ?? "rgba8unorm", { mipLevels, maxAnisotropy });
      return makeGpuTextureHandle(gpu, textureId, w, h, mipLevels);
    },
    attachTexture(textureId, width, height, mipLevels = 1) {
      const i = requireInner("attachTexture");
      if ("gl" in i)
        return i.attachTexture(textureId, width, height, mipLevels);
      return makeGpuTextureHandle(i.gpu, textureId, width, height, Math.max(1, mipLevels));
    },
    attachView(viewId, textureId, baseMipLevel = 0, mipLevelCount) {
      const i = requireInner("attachView");
      if ("gl" in i)
        return i.attachView(viewId, textureId, baseMipLevel, mipLevelCount);
      return makeGpuTextureViewHandle(i.gpu, viewId, textureId, baseMipLevel, mipLevelCount);
    },
    restoreResources(options2) {
      const i = requireInner("restoreResources");
      const restore = i.restoreResources;
      return restore !== undefined ? restore.call(i, options2) : null;
    },
    ensureResident(resourceId) {
      const i = requireInner("ensureResident");
      const ensure = i.ensureResident;
      return ensure !== undefined ? ensure.call(i, resourceId) : null;
    },
    evictLRU(options2) {
      const i = requireInner("evictLRU");
      const evict = i.evictLRU;
      return evict !== undefined ? evict.call(i, options2) : null;
    },
    residencyStats() {
      const i = requireInner("residencyStats");
      const stats = i.residencyStats;
      return stats !== undefined ? stats.call(i) : null;
    },
    command(spec) {
      if (inner !== null) {
        assertCovers(spec, decision2, "inner");
        return adaptAndCompile(spec, decision2.chosen, inner);
      }
      pendingSpecs.push(spec);
      const proxy = makeProxyCommand();
      proxies.push({ proxy, spec });
      return proxy;
    },
    pass(fragment, passOptions) {
      return requireInner("pass").pass(fragment, passOptions);
    },
    surface(surfaceOptions) {
      return requireInner("surface").surface(surfaceOptions);
    },
    frame(callback) {
      if (inner !== null)
        return inner.frame(callback);
      pendingFrames.push(callback);
      return { cancel: () => removeItem3(pendingFrames, callback) };
    },
    resize(w, h) {
      if (inner === null)
        return;
      inner.resize(w, h);
    },
    step(now) {
      requireInner("step").step(now);
    },
    async start() {
      if (inner !== null) {
        inner.start();
        return;
      }
      const hardware = await probeHardware(options, order);
      decision2 = resolveBackend({ order, specs: pendingSpecs, hardware });
      if (decision2.chosen === null)
        throw new BackendResolutionError(decision2);
      statsCollector = createStatsCollector(options.now ?? (() => performance.now()));
      inner = decision2.chosen === "webgpu" ? await createWebGpuRenderer({
        canvas: options.canvas,
        clear: options.clear,
        createGPU: options.createGPU,
        onGpuError: options.onGpuError,
        requestFrame: options.requestFrame,
        observeResize: options.observeResize,
        now: options.now,
        journal: options.journal,
        resources: options.resources,
        transport: options.transport
      }) : createWebGL2Renderer({
        canvas: options.canvas,
        dpr: options.dpr,
        clear: options.clear,
        uploads: options.uploads,
        createGL: options.createGL,
        onGlError: options.onGlError,
        requestFrame: options.requestFrame,
        observeResize: options.observeResize,
        now: options.now,
        journal: options.journal,
        resources: options.resources,
        stats: statsCollector,
        transport: options.transport
      });
      if ("caps" in inner) {
        caps = inner.caps;
      } else if ("gpu" in inner) {
        const gpu = inner.gpu;
        const adapter = gpu.adapter;
        const device = gpu.device;
        const preferredFormat = gpu.preferredFormat;
        if (adapter !== null) {
          try {
            const query = probeGPUCaps(makeGPUProbe(adapter, preferredFormat, device));
            caps = createCaps(query, () => statsCollector.snapshot());
            const gpuTimer = gpu.timer;
            if (gpuTimer !== null) {
              statsCollector.setGpuTimer(gpuTimer);
            }
          } catch {
            caps = null;
          }
        }
      }
      if (caps && statsCollector) {
        const backendStr = caps.backend;
        const prev = caps;
        caps = {
          has: (f) => prev.has(f),
          format: (f, a) => prev.format(f, a),
          path: (n) => prev.path(n),
          ext: (n) => prev.ext(n),
          stats: () => statsCollector.snapshot(),
          limit: (n) => prev.limit(n),
          get backend() {
            return backendStr;
          },
          invalidate: () => prev.invalidate()
        };
      }
      for (const { proxy, spec } of proxies) {
        const real = adaptAndCompile(spec, decision2.chosen, inner);
        proxy._attach(real);
      }
      for (const cb of pendingFrames)
        inner.frame(cb);
      pendingFrames.length = 0;
      pendingSpecs.length = 0;
      proxies.length = 0;
      inner.start();
    },
    stop() {
      inner?.stop();
    },
    dispose() {
      if (inner === null)
        return;
      const i = inner;
      i.dispose();
    },
    whyBackend() {
      return decision2;
    }
  };
}
function makeGpuTextureHandle(gpu, textureId, w, h, mipLevels) {
  let manuallyDisposed = false;
  const subViews = new Set;
  const handle = {
    textureId,
    width: w,
    height: h,
    mipLevels,
    upload: (source, options) => {
      gpu.texSubImage2D(textureId, 0, 0, w, h, source);
      options?.onProgress?.(1);
      return { progress: 1, cancel: () => {}, done: Promise.resolve() };
    },
    uploadImage: (source, options) => {
      const [sw, sh] = externalImageSize(source);
      gpu.copyExternalImageToTexture(textureId, source, 0, 0, sw, sh, options?.flipY);
    },
    uploadSubImage: (x, y, source, options) => {
      const [sw, sh] = externalImageSize(source);
      gpu.copyExternalImageToTexture(textureId, source, x, y, sw, sh, options?.flipY);
    },
    uploadMip: (level, source, options) => {
      const [sw, sh] = externalImageSize(source);
      gpu.copyExternalImageToTextureMip(textureId, level, source, 0, 0, sw, sh, options?.flipY);
    },
    createView: (viewOptions) => {
      const viewId = gpu.createTextureView(textureId, viewOptions);
      const view = makeGpuTextureViewHandle(gpu, viewId, textureId, viewOptions?.baseMipLevel ?? 0, viewOptions?.mipLevelCount);
      subViews.add(view);
      return view;
    },
    dispose: () => {
      if (manuallyDisposed)
        return;
      manuallyDisposed = true;
      for (const view of subViews)
        view.dispose();
      subViews.clear();
      gpu.deleteTexture(textureId);
    }
  };
  return handle;
}
function makeGpuTextureViewHandle(gpu, viewId, textureId, baseMipLevel, mipLevelCount) {
  let viewDisposed = false;
  return {
    viewId,
    textureId,
    baseMipLevel,
    mipLevelCount,
    dispose: () => {
      if (viewDisposed)
        return;
      viewDisposed = true;
      try {
        gpu.deleteTextureView(viewId);
      } catch {}
    }
  };
}
function normalizeOrder(backend) {
  if (backend === undefined)
    return ["webgpu", "webgl2"];
  if (Array.isArray(backend))
    return backend;
  return [backend];
}
async function probeHardware(options, order) {
  if (options.createGPU !== undefined || options.createGL !== undefined) {
    return {
      webgpu: options.createGPU !== undefined,
      webgl2: options.createGL !== undefined
    };
  }
  const probeGpu = options.probeGpu ?? defaultProbeGpu;
  const probeGl2 = options.probeGl2 ?? defaultProbeGl2;
  return {
    webgpu: order.includes("webgpu") ? await probeGpu() : false,
    webgl2: order.includes("webgl2") ? probeGl2() : false
  };
}
async function defaultProbeGpu() {
  if (typeof navigator === "undefined" || !("gpu" in navigator))
    return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}
function defaultProbeGl2() {
  return typeof WebGL2RenderingContext !== "undefined";
}
function assertCovers(spec, decision2, _when) {
  if (decision2.chosen === null)
    return;
  const need = decision2.chosen === "webgpu" ? "wgsl" : "glsl";
  if (!spec.shader[need]) {
    throw lateRejectError(spec, decision2.chosen);
  }
}
function lateRejectError(spec, backend) {
  const hasOther = backend === "webgl2" ? !!spec.shader.wgsl : !!spec.shader.glsl;
  const other = backend === "webgl2" ? "WGSL" : "GLSL";
  const target = backend === "webgl2" ? "GLSL" : "WGSL";
  const id = spec.id ?? "<no id>";
  const altOrder = backend === "webgl2" ? '["webgpu","webgl2"]' : '["webgl2","webgpu"]';
  if (hasOther) {
    return new Error(`Spec "${id}" has only ${other}, while the active backend is ${backend.toUpperCase()} (no ${target}). ` + `Restart with backend=${altOrder} OR add ${target} to the spec.`);
  }
  return new Error(`Spec "${id}" has neither GLSL nor WGSL. Invalid spec — add at least one shader variant.`);
}
function adaptAndCompile(spec, backend, inner) {
  if (backend === "webgpu") {
    return inner.command({
      shader: { wgsl: spec.shader.wgsl },
      uniforms: spec.uniforms,
      attributes: spec.attributes,
      textures: spec.textures,
      pipeline: spec.pipeline,
      count: spec.count,
      instances: spec.instances
    });
  }
  return inner.command({
    shader: { glsl: spec.shader.glsl },
    pipeline: spec.pipeline,
    attributes: spec.attributes,
    uniforms: spec.uniforms,
    textures: spec.textures,
    count: spec.count,
    instances: spec.instances
  });
}
function makeProxyCommand() {
  let real = null;
  let lastPropsValue = undefined;
  const proxy = {
    id: -1,
    record(props, frameCtx, writer) {
      if (real === null) {
        throw new Error("rune: command.record() called before renderer.start(). First await renderer.start().");
      }
      real.record(props, frameCtx, writer);
      lastPropsValue = props;
    },
    get lastProps() {
      return lastPropsValue;
    },
    set lastProps(v) {
      lastPropsValue = v;
    },
    _attach(realCmd) {
      real = realCmd;
      proxy.id = realCmd.id;
    }
  };
  return proxy;
}
function removeItem3(list, item) {
  const at = list.indexOf(item);
  if (at >= 0)
    list.splice(at, 1);
}
// packages/gl/src/particlesGpu.ts
init_src();

// packages/particles/src/noise.ts
init_src();

// packages/particles/src/ramp.ts
var COMPILED = new WeakMap;

// packages/particles/src/system.ts
var FIELD_NAMES = [
  "px",
  "py",
  "pz",
  "vx",
  "vy",
  "vz",
  "age",
  "life",
  "size",
  "cr",
  "cg",
  "cb",
  "ca",
  "seed",
  "tx",
  "ty",
  "tz"
];
var PARTICLE_FLOATS = FIELD_NAMES.length;
// packages/particles/src/spawn.ts
init_src();
// packages/particles/src/billboards.ts
var SCRATCH = new Float32Array(6);
// packages/particles/src/instances.ts
var SCRATCH2 = new Float32Array(6);
// packages/particles/src/gpuSim.ts
var GPU_STATE_STRIDE = FIELD_NAMES.length;
var GPU_SIM_UNIFORM_BYTES = 144;
var GPU_SIM_UNIFORM_FLOATS = GPU_SIM_UNIFORM_BYTES / 4;
var GPU_SIM_U32_FIELDS = {
  count: 0,
  swapCount: 2,
  forceMask: 32
};
var GPU_SIM_F32_FIELDS = {
  dt: 1,
  drag: 8,
  turbulence: 9,
  attractStrength: 10,
  softening2: 11,
  noiseStrength: 16,
  noiseScale: 17,
  noiseSpeed: 18,
  limit: 19,
  dampen: 20,
  frameJitter: 21,
  tileU: 22,
  tileV: 23
};
var GPU_SIM_VEC4_FIELDS = {
  gravity: 4,
  attractPoint: 12,
  wrapSize: 24,
  wrapCenter: 28
};
var GPU_FORCE_MASK = {
  gravity: 1,
  drag: 2,
  turbulence: 4,
  attract: 8,
  noise: 16,
  limitSpeed: 32,
  wrap: 64
};
function gpuRampLUT(points) {
  if (points.length === 0)
    throw new Error("rune/particles: the GPU sim needs a ramp with at least one point");
  if (points.length > 256) {
    throw new Error(`rune/particles: the GPU sim's ramp is capped at 256 control points (got ${points.length})`);
  }
  const lut = new Float32Array(points.length * 7);
  for (let i = 0;i < points.length; i++) {
    const p = points[i];
    const b = i * 7;
    lut[b] = p.t;
    lut[b + 1] = p.size;
    lut[b + 2] = p.r;
    lut[b + 3] = p.g;
    lut[b + 4] = p.b;
    lut[b + 5] = p.a;
    lut[b + 6] = p.frame ?? 0;
  }
  return lut;
}
function gpuSimWgsl() {
  const perm = Array.from(PERM, (v) => `${v}u`).join(", ");
  const grads = [];
  for (let g = 0;g < 12; g++) {
    grads.push(`vec3<f32>(${GRAD3[g * 3]}, ${GRAD3[g * 3 + 1]}, ${GRAD3[g * 3 + 2]})`);
  }
  return `
// @rune/particles — the GPGPU sim tier (Task 131). The state: the FIELD_NAMES
// rows interleaved (17 floats). The entries: compact (the swap replay),
// advance (the force walk), pack (the instance records).
// The uniform layout mirrors GPU_SIM_* in gpuSim.ts (144 bytes).

struct SimParams {
  count : u32,
  dt : f32,
  swapCount : u32,
  _pad0 : u32,
  gravity : vec4<f32>,
  drag : f32,
  turbulence : f32,
  attractStrength : f32,
  softening2 : f32,
  attractPoint : vec4<f32>,
  noiseStrength : f32,
  noiseScale : f32,
  noiseSpeed : f32,
  limit : f32,
  dampen : f32,
  frameJitter : f32,
  tileU : f32,
  tileV : f32,
  wrapSize : vec4<f32>,
  wrapCenter : vec4<f32>,
  forceMask : u32,
  _pad1 : u32,
  _pad2 : u32,
  _pad3 : u32,
}

@group(0) @binding(0) var<uniform> P : SimParams;
@group(0) @binding(1) var<storage, read_write> state : array<f32>;
@group(0) @binding(2) var<storage, read> swaps : array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> records : array<f32>;
@group(0) @binding(4) var<storage, read> rampLUT : array<f32>;

const FSTRIDE : u32 = ${GPU_STATE_STRIDE}u;
const RSTRIDE : u32 = 16u;

// ── the simplex noise (the SAME table the CPU evaluates — noise.ts) ────────
var<private> SIM_PERM : array<u32, 512> = array<u32, 512>(${perm});
var<private> SIM_GRADS : array<vec3<f32>, 12> = array<vec3<f32>, 12>(${grads.join(", ")});

fn simplex3(v : vec3<f32>) -> f32 {
  let F3 = 0.333333333333;
  let G3 = 0.166666666667;
  let s = (v.x + v.y + v.z) * F3;
  let i = i32(floor(v.x + s));
  let j = i32(floor(v.y + s));
  let k = i32(floor(v.z + s));
  let t = f32(i + j + k) * G3;
  let x0 = v.x - (f32(i) - t);
  let y0 = v.y - (f32(j) - t);
  let z0 = v.z - (f32(k) - t);
  // the simplex containing (x0, y0, z0): the offset ranking
  var i1 = 0; var j1 = 0; var k1 = 0; var i2 = 0; var j2 = 0; var k2 = 0;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  let x1 = x0 - f32(i1) + G3; let y1 = y0 - f32(j1) + G3; let z1 = z0 - f32(k1) + G3;
  let x2 = x0 - f32(i2) + 2.0 * G3; let y2 = y0 - f32(j2) + 2.0 * G3; let z2 = z0 - f32(k2) + 2.0 * G3;
  let x3 = x0 - 1.0 + 3.0 * G3; let y3 = y0 - 1.0 + 3.0 * G3; let z3 = z0 - 1.0 + 3.0 * G3;
  let ii = u32(i & 255); let jj = u32(j & 255); let kk = u32(k & 255);
  var n = 0.0;
  var t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0.0) {
    let g = SIM_PERM[ii + SIM_PERM[jj + SIM_PERM[kk]]] % 12u;
    t0 = t0 * t0;
    n += t0 * t0 * dot(SIM_GRADS[g], vec3<f32>(x0, y0, z0));
  }
  var t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0.0) {
    let g = SIM_PERM[ii + u32(i1) + SIM_PERM[jj + u32(j1) + SIM_PERM[kk + u32(k1)]]] % 12u;
    t1 = t1 * t1;
    n += t1 * t1 * dot(SIM_GRADS[g], vec3<f32>(x1, y1, z1));
  }
  var t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0.0) {
    let g = SIM_PERM[ii + u32(i2) + SIM_PERM[jj + u32(j2) + SIM_PERM[kk + u32(k2)]]] % 12u;
    t2 = t2 * t2;
    n += t2 * t2 * dot(SIM_GRADS[g], vec3<f32>(x2, y2, z2));
  }
  var t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0.0) {
    let g = SIM_PERM[ii + 1u + SIM_PERM[jj + 1u + SIM_PERM[kk + 1u]]] % 12u;
    t3 = t3 * t3;
    n += t3 * t3 * dot(SIM_GRADS[g], vec3<f32>(x3, y3, z3));
  }
  return 32.0 * n;
}

fn wrapAxis(d : f32, size : f32) -> f32 {
  var m = (d + size * 0.5) % size;
  if (m < 0.0) { m += size; }
  return m - size * 0.5;
}

// ── compact: the CPU's swap list, replayed IN ORDER (a single thread — the
// list is per-frame deaths, tens; the order is the CPU compaction's own) ────
@compute @workgroup_size(1)
fn compact(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x != 0u) { return; }
  for (var s = 0u; s < P.swapCount; s++) {
    let pair = swaps[s];
    let dstSlot = pair.x * FSTRIDE;
    let srcSlot = pair.y * FSTRIDE; // 'from' is a RESERVED WGSL keyword
    for (var f = 0u; f < FSTRIDE; f++) {
      state[dstSlot + f] = state[srcSlot + f];
    }
  }
}

// ── advance: the force walk (the reference order: drag → limit → gravity →
// attract → turbulence → noise), the integration, age += dt, the wrap ──────
@compute @workgroup_size(64)
fn advance(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = i * FSTRIDE;
  var px = state[b]; var py = state[b + 1u]; var pz = state[b + 2u];
  var vx = state[b + 3u]; var vy = state[b + 4u]; var vz = state[b + 5u];
  let age = state[b + 6u];
  let seed = state[b + 13u];
  if ((P.forceMask & 2u) != 0u) {
    let k = exp(-P.drag * P.dt);
    vx *= k; vy *= k; vz *= k;
  }
  if ((P.forceMask & 32u) != 0u) {
    let speed = sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > P.limit && speed > 1e-9) {
      var k = 1.0 - ((speed - P.limit) / speed) * P.dampen * P.dt * 20.0;
      if (k < 0.0) { k = 0.0; }
      vx *= k; vy *= k; vz *= k;
    }
  }
  if ((P.forceMask & 1u) != 0u) {
    vx += P.gravity.x * P.dt;
    vy += P.gravity.y * P.dt;
    vz += P.gravity.z * P.dt;
  }
  if ((P.forceMask & 8u) != 0u) {
    let dx = P.attractPoint.x - px;
    let dy = P.attractPoint.y - py;
    let dz = P.attractPoint.z - pz;
    let r2 = dx * dx + dy * dy + dz * dz;
    let r = sqrt(r2);
    if (r > 1e-6) {
      let k = P.attractStrength * P.dt / (r * (r2 + P.softening2));
      vx += dx * k; vy += dy * k; vz += dz * k;
    }
  }
  if ((P.forceMask & 4u) != 0u) {
    let t = age * 5.0 + seed * 37.0;
    vx += sin(t) * P.turbulence * P.dt;
    vy += sin(t * 1.7 + 11.3) * P.turbulence * P.dt;
    vz += cos(t * 0.9 + 4.7) * P.turbulence * P.dt;
  }
  if ((P.forceMask & 16u) != 0u) {
    // the simplex flow — the CPU reference's exact coordinate mapping
    let adrift = age * P.noiseSpeed;
    let so = seed * 13.7;
    let sx = px * P.noiseScale + adrift;
    let sy = py * P.noiseScale;
    let sz = pz * P.noiseScale;
    vx += simplex3(vec3<f32>(sx, sy + so, sz + 5.3)) * P.noiseStrength * P.dt;
    vy += simplex3(vec3<f32>(sx + 11.7, sy + adrift, sz + 9.1 + so)) * P.noiseStrength * P.dt;
    vz += simplex3(vec3<f32>(sx + 3.1, sy + 7.7 + so, sz + adrift)) * P.noiseStrength * P.dt;
  }
  px += vx * P.dt; py += vy * P.dt; pz += vz * P.dt;
  if ((P.forceMask & 64u) != 0u) {
    if (P.wrapSize.x > 0.0) { px = P.wrapCenter.x + wrapAxis(px - P.wrapCenter.x, P.wrapSize.x); }
    if (P.wrapSize.y > 0.0) { py = P.wrapCenter.y + wrapAxis(py - P.wrapCenter.y, P.wrapSize.y); }
    if (P.wrapSize.z > 0.0) { pz = P.wrapCenter.z + wrapAxis(pz - P.wrapCenter.z, P.wrapSize.z); }
  }
  state[b] = px; state[b + 1u] = py; state[b + 2u] = pz;
  state[b + 3u] = vx; state[b + 4u] = vy; state[b + 5u] = vz;
  state[b + 6u] = age + P.dt;
}

// ── pack: the 16-float instance records (packInstances' GPU twin — the
// record layout of the BILLBOARD material / INSTANCE_LAYOUT) ───────────────
@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = i * FSTRIDE;
  let age = state[b + 6u];
  let life = state[b + 7u];
  var t = 0.0;
  if (life > 0.0) { t = age / life; }
  // the ramp LUT (7-float rows: t, size, r, g, b, a, frame) — sampleRamp's
  // exact walk: clamp → binary search → lerp
  let n = arrayLength(&rampLUT) / 7u;
  var size = 1.0; var r = 1.0; var g = 1.0; var bl = 1.0; var a = 1.0; var frame = 0.0;
  if (n == 1u) {
    size = rampLUT[1]; r = rampLUT[2]; g = rampLUT[3]; bl = rampLUT[4]; a = rampLUT[5]; frame = rampLUT[6];
  } else if (t <= rampLUT[0]) {
    size = rampLUT[1]; r = rampLUT[2]; g = rampLUT[3]; bl = rampLUT[4]; a = rampLUT[5]; frame = rampLUT[6];
  } else {
    let lastR = (n - 1u) * 7u;
    if (t >= rampLUT[lastR]) {
      size = rampLUT[lastR + 1u]; r = rampLUT[lastR + 2u]; g = rampLUT[lastR + 3u];
      bl = rampLUT[lastR + 4u]; a = rampLUT[lastR + 5u]; frame = rampLUT[lastR + 6u];
    } else {
      var lo = 0u; var hi = n - 1u;
      var guard = 0u;
      while (hi - lo > 1u && guard < 32u) {
        let mid = (lo + hi) >> 1u;
        if (rampLUT[mid * 7u] <= t) { lo = mid; } else { hi = mid; }
        guard++;
      }
      let ra = lo * 7u; let rb = hi * 7u;
      let span = rampLUT[rb] - rampLUT[ra];
      var k = 0.0;
      if (span > 0.0) { k = (t - rampLUT[ra]) / span; }
      size = rampLUT[ra + 1u] + (rampLUT[rb + 1u] - rampLUT[ra + 1u]) * k;
      r = rampLUT[ra + 2u] + (rampLUT[rb + 2u] - rampLUT[ra + 2u]) * k;
      g = rampLUT[ra + 3u] + (rampLUT[rb + 3u] - rampLUT[ra + 3u]) * k;
      bl = rampLUT[ra + 4u] + (rampLUT[rb + 4u] - rampLUT[ra + 4u]) * k;
      a = rampLUT[ra + 5u] + (rampLUT[rb + 5u] - rampLUT[ra + 5u]) * k;
      frame = rampLUT[ra + 6u] + (rampLUT[rb + 6u] - rampLUT[ra + 6u]) * k;
    }
  }
  let half = state[b + 8u] * size * 0.5;
  let seed = state[b + 13u];
  // the tile origin: frame + seed·jitter → floor → clamp → row-major
  var fr = floor(frame + seed * P.frameJitter);
  // NaN-safe: every NaN comparison is FALSE — !(fr >= 0) catches NaN and
  // the negatives in one branch (WGSL has no isnan builtin)
  if (!(fr >= 0.0)) { fr = 0.0; }
  let maxFrame = P.tileU * P.tileV - 1.0;
  if (fr > maxFrame) { fr = maxFrame; }
  var u0 = 0.0; var v0 = 0.0;
  if (P.tileU >= 1.0 && P.tileV >= 1.0) {
    u0 = (fr % P.tileU) / P.tileU;
    v0 = floor(fr / P.tileU) / P.tileV;
  }
  let o = i * RSTRIDE;
  records[o] = state[b]; records[o + 1u] = state[b + 1u]; records[o + 2u] = state[b + 2u];
  records[o + 3u] = state[b + 3u]; records[o + 4u] = state[b + 4u]; records[o + 5u] = state[b + 5u];
  records[o + 6u] = state[b + 9u] * r; records[o + 7u] = state[b + 10u] * g;
  records[o + 8u] = state[b + 11u] * bl; records[o + 9u] = state[b + 12u] * a;
  records[o + 10u] = half;
  records[o + 11u] = seed * 6.283185307179586;
  records[o + 12u] = age;
  records[o + 13u] = seed;
  records[o + 14u] = u0; records[o + 15u] = v0;
}
`;
}
// packages/particles/src/gpuSimGl.ts
var GPU_GL_TEXELS_PER_PARTICLE = 5;
var GPU_GL_STATE_TEXTURE_W = 2048;
function gpuGlStateTextureH(capacity) {
  return Math.max(1, Math.ceil(capacity * GPU_GL_TEXELS_PER_PARTICLE / GPU_GL_STATE_TEXTURE_W));
}
var GPU_GL_ADVANCE_UNIFORMS = [
  { name: "u_dt", size: 1 },
  { name: "u_gravity", size: 3 },
  { name: "u_drag", size: 1 },
  { name: "u_turbulence", size: 1 },
  { name: "u_attractStrength", size: 1 },
  { name: "u_softening2", size: 1 },
  { name: "u_attractPoint", size: 3 },
  { name: "u_noiseStrength", size: 1 },
  { name: "u_noiseScale", size: 1 },
  { name: "u_noiseSpeed", size: 1 },
  { name: "u_limit", size: 1 },
  { name: "u_dampen", size: 1 },
  { name: "u_wrapSize", size: 3 },
  { name: "u_wrapCenter", size: 3 },
  { name: "u_fDrag", size: 1 },
  { name: "u_fLimit", size: 1 },
  { name: "u_fGravity", size: 1 },
  { name: "u_fAttract", size: 1 },
  { name: "u_fTurb", size: 1 },
  { name: "u_fNoise", size: 1 },
  { name: "u_fWrap", size: 1 }
];
var GPU_GL_ADVANCE_F = {
  dt: 0,
  gravity: 1,
  drag: 4,
  turbulence: 5,
  attractStrength: 6,
  softening2: 7,
  attractPoint: 8,
  noiseStrength: 11,
  noiseScale: 12,
  noiseSpeed: 13,
  limit: 14,
  dampen: 15,
  wrapSize: 16,
  wrapCenter: 19,
  fDrag: 22,
  fLimit: 23,
  fGravity: 24,
  fAttract: 25,
  fTurb: 26,
  fNoise: 27,
  fWrap: 28
};
var GPU_GL_PACK_UNIFORMS = [
  { name: "u_tileU", size: 1 },
  { name: "u_tileV", size: 1 },
  { name: "u_frameJitter", size: 1 },
  { name: "u_rampN", size: 1 }
];
var GPU_GL_PACK_F = {
  tileU: 0,
  tileV: 1,
  frameJitter: 2,
  rampN: 3
};
var GPU_GL_ADVANCE_OUTPUTS = ["v_s0", "v_s1", "v_s2", "v_s3", "v_s4"];
var GPU_GL_PACK_OUTPUTS = ["v_r0", "v_r1", "v_r2", "v_r3"];
function gpuRampLUTTexture(points) {
  if (points.length === 0)
    throw new Error("rune/particles: the GPU sim needs a ramp with at least one point");
  if (points.length > 256) {
    throw new Error(`rune/particles: the GPU sim's ramp is capped at 256 control points (got ${points.length})`);
  }
  const lut = new Float32Array(points.length * 8);
  for (let i = 0;i < points.length; i++) {
    const p = points[i];
    const b = i * 8;
    lut[b] = p.t;
    lut[b + 1] = p.size;
    lut[b + 2] = p.r;
    lut[b + 3] = p.g;
    lut[b + 4] = p.b;
    lut[b + 5] = p.a;
    lut[b + 6] = p.frame ?? 0;
  }
  return lut;
}
function glslPrelude(w) {
  const perm = Array.from(PERM, (v) => `${v}u`).join(", ");
  const grads = [];
  for (let g = 0;g < 12; g++) {
    grads.push(`vec3(${GRAD3[g * 3]}, ${GRAD3[g * 3 + 1]}, ${GRAD3[g * 3 + 2]})`);
  }
  return `
precision highp float;
uniform highp sampler2D u_state;
const int W = ${w};
ivec2 texelOf(int idx) { return ivec2(idx % W, idx / W); }
vec4 fetchState(int slot, int row) { return texelFetch(u_state, texelOf(slot * 5 + row), 0); }
// ── the simplex noise (the SAME table the CPU/WGSL evaluate — noise.ts) ────
const uint PERM_T[512] = uint[512](${perm});
const vec3 GRAD_T[12] = vec3[12](${grads.join(", ")});
float simplex3(vec3 v) {
  const float F3 = 0.333333333333;
  const float G3 = 0.166666666667;
  float s = (v.x + v.y + v.z) * F3;
  int i = int(floor(v.x + s));
  int j = int(floor(v.y + s));
  int k = int(floor(v.z + s));
  float t = float(i + j + k) * G3;
  float x0 = v.x - (float(i) - t);
  float y0 = v.y - (float(j) - t);
  float z0 = v.z - (float(k) - t);
  int i1 = 0; int j1 = 0; int k1 = 0; int i2 = 0; int j2 = 0; int k2 = 0;
  if (x0 >= y0) {
    if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
    else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
  } else {
    if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
  }
  float x1 = x0 - float(i1) + G3; float y1 = y0 - float(j1) + G3; float z1 = z0 - float(k1) + G3;
  float x2 = x0 - float(i2) + 2.0 * G3; float y2 = y0 - float(j2) + 2.0 * G3; float z2 = z0 - float(k2) + 2.0 * G3;
  float x3 = x0 - 1.0 + 3.0 * G3; float y3 = y0 - 1.0 + 3.0 * G3; float z3 = z0 - 1.0 + 3.0 * G3;
  uint ii = uint(i & 255); uint jj = uint(j & 255); uint kk = uint(k & 255);
  float n = 0.0;
  float t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
  if (t0 > 0.0) {
    uint g = PERM_T[ii + PERM_T[jj + PERM_T[kk]]] % 12u;
    t0 = t0 * t0;
    n += t0 * t0 * dot(GRAD_T[g], vec3(x0, y0, z0));
  }
  float t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
  if (t1 > 0.0) {
    uint g = PERM_T[ii + uint(i1) + PERM_T[jj + uint(j1) + PERM_T[kk + uint(k1)]]] % 12u;
    t1 = t1 * t1;
    n += t1 * t1 * dot(GRAD_T[g], vec3(x1, y1, z1));
  }
  float t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
  if (t2 > 0.0) {
    uint g = PERM_T[ii + uint(i2) + PERM_T[jj + uint(j2) + PERM_T[kk + uint(k2)]]] % 12u;
    t2 = t2 * t2;
    n += t2 * t2 * dot(GRAD_T[g], vec3(x2, y2, z2));
  }
  float t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
  if (t3 > 0.0) {
    uint g = PERM_T[ii + 1u + PERM_T[jj + 1u + PERM_T[kk + 1u]]] % 12u;
    t3 = t3 * t3;
    n += t3 * t3 * dot(GRAD_T[g], vec3(x3, y3, z3));
  }
  return 32.0 * n;
}
float wrapAxis(float d, float size) {
  float m = mod(d + size * 0.5, size);
  if (m < 0.0) { m += size; }
  return m - size * 0.5;
}
`;
}
function gpuSimGlAdvanceGlsl() {
  return `#version 300 es
// @rune/particles — the GPGPU TF tier (Task 132): compact+advance, the
// GLSL twin of the WGSL entries. The uniform set mirrors
// GPU_GL_ADVANCE_UNIFORMS (the orchestrator packs them in order).
${glslPrelude(GPU_GL_STATE_TEXTURE_W)}
uniform float u_dt;
uniform vec3 u_gravity;
uniform float u_drag;
uniform float u_turbulence;
uniform float u_attractStrength;
uniform float u_softening2;
uniform vec3 u_attractPoint;
uniform float u_noiseStrength;
uniform float u_noiseScale;
uniform float u_noiseSpeed;
uniform float u_limit;
uniform float u_dampen;
uniform vec3 u_wrapSize;
uniform vec3 u_wrapCenter;
uniform float u_fDrag;
uniform float u_fLimit;
uniform float u_fGravity;
uniform float u_fAttract;
uniform float u_fTurb;
uniform float u_fNoise;
uniform float u_fWrap;
// the provenance: vertex i (the FINAL slot) gathers the pre-state of
// particle a_map[i] (a float — exact for every integer ≤ 2^24).
in float a_map;
// the TF outputs: the 20-float state row (17 fields + 3 pad).
out vec4 v_s0; // px, py, pz, vx
out vec4 v_s1; // vy, vz, age, life
out vec4 v_s2; // size, cr, cg, cb
out vec4 v_s3; // ca, seed, tx, ty
out vec4 v_s4; // tz, pad, pad, pad
void main() {
  int src = int(a_map + 0.5);
  vec4 s0 = fetchState(src, 0);
  vec4 s1 = fetchState(src, 1);
  vec4 s2 = fetchState(src, 2);
  vec4 s3 = fetchState(src, 3);
  vec4 s4 = fetchState(src, 4);
  float px = s0.x; float py = s0.y; float pz = s0.z;
  float vx = s0.w; float vy = s1.x; float vz = s1.y;
  float age = s1.z;
  float seed = s3.y;
  // the force walk — the WGSL advance's exact order
  if (u_fDrag > 0.5) {
    float k = exp(-u_drag * u_dt);
    vx *= k; vy *= k; vz *= k;
  }
  if (u_fLimit > 0.5) {
    float speed = sqrt(vx * vx + vy * vy + vz * vz);
    if (speed > u_limit && speed > 1e-9) {
      float k = 1.0 - ((speed - u_limit) / speed) * u_dampen * u_dt * 20.0;
      if (k < 0.0) { k = 0.0; }
      vx *= k; vy *= k; vz *= k;
    }
  }
  if (u_fGravity > 0.5) {
    vx += u_gravity.x * u_dt;
    vy += u_gravity.y * u_dt;
    vz += u_gravity.z * u_dt;
  }
  if (u_fAttract > 0.5) {
    float dx = u_attractPoint.x - px;
    float dy = u_attractPoint.y - py;
    float dz = u_attractPoint.z - pz;
    float r2 = dx * dx + dy * dy + dz * dz;
    float r = sqrt(r2);
    if (r > 1e-6) {
      float k = u_attractStrength * u_dt / (r * (r2 + u_softening2));
      vx += dx * k; vy += dy * k; vz += dz * k;
    }
  }
  if (u_fTurb > 0.5) {
    float t = age * 5.0 + seed * 37.0;
    vx += sin(t) * u_turbulence * u_dt;
    vy += sin(t * 1.7 + 11.3) * u_turbulence * u_dt;
    vz += cos(t * 0.9 + 4.7) * u_turbulence * u_dt;
  }
  if (u_fNoise > 0.5) {
    // the simplex flow — the CPU/WGSL reference's exact coordinate mapping
    float adrift = age * u_noiseSpeed;
    float so = seed * 13.7;
    float sx = px * u_noiseScale + adrift;
    float sy = py * u_noiseScale;
    float sz = pz * u_noiseScale;
    vx += simplex3(vec3(sx, sy + so, sz + 5.3)) * u_noiseStrength * u_dt;
    vy += simplex3(vec3(sx + 11.7, sy + adrift, sz + 9.1 + so)) * u_noiseStrength * u_dt;
    vz += simplex3(vec3(sx + 3.1, sy + 7.7 + so, sz + adrift)) * u_noiseStrength * u_dt;
  }
  px += vx * u_dt; py += vy * u_dt; pz += vz * u_dt;
  if (u_fWrap > 0.5) {
    if (u_wrapSize.x > 0.0) { px = u_wrapCenter.x + wrapAxis(px - u_wrapCenter.x, u_wrapSize.x); }
    if (u_wrapSize.y > 0.0) { py = u_wrapCenter.y + wrapAxis(py - u_wrapCenter.y, u_wrapSize.y); }
    if (u_wrapSize.z > 0.0) { pz = u_wrapCenter.z + wrapAxis(pz - u_wrapCenter.z, u_wrapSize.z); }
  }
  v_s0 = vec4(px, py, pz, vx);
  v_s1 = vec4(vy, vz, age + u_dt, s1.w);
  v_s2 = s2;
  v_s3 = s3;
  v_s4 = s4;
  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`;
}
function gpuSimGlPackGlsl() {
  return `#version 300 es
// @rune/particles — the GPGPU TF tier (Task 132): the record pack, the
// GLSL twin of the WGSL pack entry. The uniform set mirrors
// GPU_GL_PACK_UNIFORMS.
${glslPrelude(GPU_GL_STATE_TEXTURE_W)}
uniform highp sampler2D u_ramp;
uniform float u_tileU;
uniform float u_tileV;
uniform float u_frameJitter;
uniform float u_rampN;
// the TF outputs: the 16-float instance record (INSTANCE_LAYOUT).
out vec4 v_r0; // px, py, pz, vx
out vec4 v_r1; // vy, vz, cr, cg
out vec4 v_r2; // cb, ca, halfExtent, angle0 (seed·tau)
out vec4 v_r3; // age, seed, u0, v0
// the ramp LUT: 2 texels per point k — (t, size, r, g) at 2k, (b, a, frame, 0) at 2k+1.
vec4 rampA(int k) { return texelFetch(u_ramp, ivec2(k * 2, 0), 0); }
vec4 rampB(int k) { return texelFetch(u_ramp, ivec2(k * 2 + 1, 0), 0); }
float rampT(int k) { return rampA(k).x; }
void main() {
  int i = gl_VertexID;
  vec4 s0 = fetchState(i, 0);
  vec4 s1 = fetchState(i, 1);
  vec4 s2 = fetchState(i, 2);
  vec4 s3 = fetchState(i, 3);
  float age = s1.z;
  float life = s1.w;
  float t = life > 0.0 ? age / life : 0.0;
  // the ramp walk — the WGSL pack's exact semantics: clamp → binary
  // search → lerp (sampleRamp's own walk).
  int n = int(u_rampN + 0.5);
  float size = 1.0; float r = 1.0; float g = 1.0; float b = 1.0; float a = 1.0; float frame = 0.0;
  if (n == 1 || t <= rampT(0)) {
    vec4 ra = rampA(0); vec4 rb = rampB(0);
    size = ra.y; r = ra.z; g = ra.w; b = rb.x; a = rb.y; frame = rb.z;
  } else {
    int last = n - 1;
    if (t >= rampT(last)) {
      vec4 ra = rampA(last); vec4 rb = rampB(last);
      size = ra.y; r = ra.z; g = ra.w; b = rb.x; a = rb.y; frame = rb.z;
    } else {
      int lo = 0; int hi = n - 1;
      for (int guard = 0; guard < 32 && hi - lo > 1; guard++) {
        int mid = (lo + hi) / 2;
        if (rampT(mid) <= t) { lo = mid; } else { hi = mid; }
      }
      float span = rampT(hi) - rampT(lo);
      float k = span > 0.0 ? (t - rampT(lo)) / span : 0.0;
      vec4 raLo = rampA(lo); vec4 rbLo = rampB(lo);
      vec4 raHi = rampA(hi); vec4 rbHi = rampB(hi);
      size = mix(raLo.y, raHi.y, k);
      r = mix(raLo.z, raHi.z, k);
      g = mix(raLo.w, raHi.w, k);
      b = mix(rbLo.x, rbHi.x, k);
      a = mix(rbLo.y, rbHi.y, k);
      frame = mix(rbLo.z, rbHi.z, k);
    }
  }
  float halfExtent = s2.x * size * 0.5;
  float seed = s3.y;
  // the tile origin: frame + seed·jitter → floor → clamp → row-major
  // (NaN-safe: every NaN comparison is false — !(fr >= 0.0) catches NaN
  // and the negatives in one branch).
  float fr = floor(frame + seed * u_frameJitter);
  if (!(fr >= 0.0)) { fr = 0.0; }
  float maxFrame = u_tileU * u_tileV - 1.0;
  if (fr > maxFrame) { fr = maxFrame; }
  float u0 = 0.0; float v0 = 0.0;
  if (u_tileU >= 1.0 && u_tileV >= 1.0) {
    u0 = mod(fr, u_tileU) / u_tileU;
    v0 = floor(fr / u_tileU) / u_tileV;
  }
  v_r0 = s0;
  v_r1 = vec4(s1.x, s1.y, s2.y * r, s2.z * g);
  v_r2 = vec4(s2.w * b, s3.x * a, halfExtent, seed * 6.283185307179586);
  v_r3 = vec4(age, seed, u0, v0);
  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`;
}
// packages/particles/src/trails.ts
var SCRATCH3 = new Float32Array(6);
// packages/particles/src/meshes.ts
var SCRATCH4 = new Float32Array(6);
// packages/particles/src/facade.ts
var MAX_STEP = 1 / 20;
// packages/gl/src/particlesGpuConfig.ts
function readGpuTierConfig(facade) {
  const forces = facade.forces;
  const gravity = forces.gravity ?? [0, 0, 0];
  const attract = forces.attract ?? null;
  const noise = forces.noise ?? null;
  const limit = forces.limitSpeed ?? null;
  const wrap = facade.gpuHandoff?.wrapSize ?? null;
  const render = facade.render;
  const wrapSize = wrap ?? [0, 0, 0];
  return {
    gravity,
    drag: forces.drag,
    turbulence: forces.turbulence,
    attract: attract === null ? { point: [0, 0, 0], strength: 0, softening2: 0 } : {
      point: attract.point,
      strength: attract.strength,
      softening2: (attract.softening ?? 0.25) ** 2
    },
    noise: noise === null ? { strength: 0, scale: 0, speed: 0 } : { strength: noise.strength, scale: noise.scale, speed: noise.speed },
    limit: limit === null ? { limit: 0, dampen: 0 } : { limit: limit.limit, dampen: limit.dampen },
    wrapSize,
    active: {
      gravity: gravity[0] !== 0 || gravity[1] !== 0 || gravity[2] !== 0,
      drag: forces.drag > 0,
      turbulence: forces.turbulence !== 0,
      attract: attract !== null,
      noise: noise !== null && noise.strength !== 0,
      limit: limit !== null,
      wrap: wrap !== null && (wrap[0] > 0 || wrap[1] > 0 || wrap[2] > 0)
    },
    tiles: render.tiles ?? [1, 1],
    frameJitter: render.frameJitter ?? 0
  };
}

// packages/gl/src/particlesGpuGl.ts
function gpuGlProvenance(preCount, swaps, swapCount, prov) {
  for (let i = 0;i < preCount; i++)
    prov[i] = i;
  for (let s = 0;s < swapCount; s++) {
    const to = swaps[s * 2];
    const from = swaps[s * 2 + 1];
    prov[to] = prov[from];
  }
}
function createGpuParticlesTf(facade, gpu) {
  const handoff = facade.gpuHandoff;
  if (handoff === null) {
    throw new Error('rune/gl: createGpuParticlesTf needs a sim:"gpu" facade (this one runs the CPU tier)');
  }
  const ho = handoff;
  const capacity = facade.capacity;
  const W = GPU_GL_STATE_TEXTURE_W;
  const H = gpuGlStateTextureH(capacity);
  const stateTex = gpu.createTexture(W, H, { format: "rgba32f" });
  const lut = gpuRampLUTTexture(facade.ramp.points);
  const rampW = Math.max(2, facade.ramp.points.length * 2);
  const rampTex = gpu.createTexture(rampW, 1, { format: "rgba32f" });
  gpu.texSubImage2D(rampTex, 0, 0, rampW, 1, lut);
  const stateOut = gpu.createBuffer(new Float32Array(W * H * 4));
  const records = gpu.createBuffer(new Float32Array(capacity * 16));
  const mapBuf = gpu.createBuffer(new Float32Array(capacity));
  const advPass = gpu.createPass({
    vertex: gpuSimGlAdvanceGlsl(),
    outputs: GPU_GL_ADVANCE_OUTPUTS,
    attributes: [{ name: "a_map", size: 1, stride: 4 }],
    textures: ["u_state"],
    uniforms: GPU_GL_ADVANCE_UNIFORMS
  });
  const packPass = gpu.createPass({
    vertex: gpuSimGlPackGlsl(),
    outputs: GPU_GL_PACK_OUTPUTS,
    textures: ["u_state", "u_ramp"],
    uniforms: GPU_GL_PACK_UNIFORMS
  });
  ho.attached = true;
  const advUni = gpu.scratch(GPU_GL_ADVANCE_UNIFORMS.reduce((n, u) => n + u.size, 0)).f32;
  const packUni = gpu.scratch(GPU_GL_PACK_UNIFORMS.reduce((n, u) => n + u.size, 0)).f32;
  const packF = GPU_GL_PACK_F;
  const cfg = readGpuTierConfig(facade);
  packUni[packF.tileU] = cfg.tiles[0];
  packUni[packF.tileV] = cfg.tiles[1];
  packUni[packF.frameJitter] = cfg.frameJitter;
  packUni[packF.rampN] = facade.ramp.points.length;
  const A = GPU_GL_ADVANCE_F;
  const a = cfg.active;
  advUni[A.fDrag] = a.drag ? 1 : 0;
  advUni[A.fLimit] = a.limit ? 1 : 0;
  advUni[A.fGravity] = a.gravity ? 1 : 0;
  advUni[A.fAttract] = a.attract ? 1 : 0;
  advUni[A.fTurb] = a.turbulence ? 1 : 0;
  advUni[A.fNoise] = a.noise ? 1 : 0;
  advUni[A.fWrap] = a.wrap ? 1 : 0;
  if (a.gravity) {
    advUni[A.gravity] = cfg.gravity[0];
    advUni[A.gravity + 1] = cfg.gravity[1];
    advUni[A.gravity + 2] = cfg.gravity[2];
  }
  if (a.drag) {
    advUni[A.drag] = cfg.drag;
  }
  if (a.turbulence) {
    advUni[A.turbulence] = cfg.turbulence;
  }
  if (a.attract) {
    advUni[A.attractPoint] = cfg.attract.point[0];
    advUni[A.attractPoint + 1] = cfg.attract.point[1];
    advUni[A.attractPoint + 2] = cfg.attract.point[2];
    advUni[A.attractStrength] = cfg.attract.strength;
    advUni[A.softening2] = cfg.attract.softening2;
  }
  if (a.noise) {
    advUni[A.noiseStrength] = cfg.noise.strength;
    advUni[A.noiseScale] = cfg.noise.scale;
    advUni[A.noiseSpeed] = cfg.noise.speed;
  }
  if (a.limit) {
    advUni[A.limit] = cfg.limit.limit;
    advUni[A.dampen] = cfg.limit.dampen;
  }
  if (a.wrap) {
    advUni[A.wrapSize] = cfg.wrapSize[0];
    advUni[A.wrapSize + 1] = cfg.wrapSize[1];
    advUni[A.wrapSize + 2] = cfg.wrapSize[2];
  }
  const emitPacked = new Float32Array(capacity * 20);
  const prov = new Int32Array(capacity);
  const mapFloats = new Float32Array(capacity);
  function step(dt) {
    const count = facade.count;
    if (count <= 0 && ho.emitCount === 0 && ho.swapCount === 0)
      return;
    advUni[A.dt] = dt;
    const wc = ho.emitOrigin;
    advUni[A.wrapCenter] = wc[0];
    advUni[A.wrapCenter + 1] = wc[1];
    advUni[A.wrapCenter + 2] = wc[2];
    if (ho.emitCount > 0) {
      const rows = ho.emitRows;
      const n = ho.emitCount;
      for (let i = 0;i < n; i++) {
        const s = i * 17;
        const d = i * 20;
        for (let f = 0;f < 17; f++)
          emitPacked[d + f] = rows[s + f];
        emitPacked[d + 17] = 0;
        emitPacked[d + 18] = 0;
        emitPacked[d + 19] = 0;
      }
      const start = ho.emitBase * GPU_GL_TEXELS_PER_PARTICLE;
      const end = start + n * GPU_GL_TEXELS_PER_PARTICLE;
      const y0 = Math.floor(start / W);
      const y1 = Math.floor((end - 1) / W);
      for (let y = y0;y <= y1; y++) {
        const x0 = y === y0 ? start - y * W : 0;
        const x1 = y === y1 ? end - y * W : W;
        const byteOffset = (y * W + x0 - start) * 16;
        const byteLength = (x1 - x0) * 16;
        gpu.texSubImage2D(stateTex, x0, y, x1 - x0, 1, new Float32Array(emitPacked.buffer, byteOffset, byteLength / 4));
      }
    }
    const preCount = ho.emitBase + ho.emitCount;
    gpuGlProvenance(preCount, ho.swaps, ho.swapCount, prov);
    for (let i = 0;i < count; i++)
      mapFloats[i] = prov[i];
    gpu.updateBuffer(mapBuf, mapFloats.subarray(0, count));
    gpu.runPass(advPass, count, {
      bufferId: stateOut,
      attribBuffers: [mapBuf],
      textures: [stateTex],
      uniformData: advUni
    });
    gpu.texSubImage2DBuffer(stateTex, 0, 0, W, H, stateOut, 0);
    gpu.runPass(packPass, count, {
      bufferId: records,
      textures: [stateTex, rampTex],
      uniformData: packUni
    });
  }
  return {
    step,
    get recordsBufferId() {
      return records;
    },
    get stateBufferId() {
      return stateOut;
    },
    dispose() {
      gpu.dispose();
      ho.attached = false;
    }
  };
}

// packages/gl/src/particlesGpu.ts
var WORKGROUP = 64;
function createGpuParticles(facade, backend) {
  const tier = createGpgpu(backend);
  return tier.kind === "transform-feedback" ? createGpuParticlesTf(facade, tier) : createGpuParticlesCompute(facade, tier);
}
function createGpuParticlesCompute(facade, gpu) {
  const handoff = facade.gpuHandoff;
  if (handoff === null) {
    throw new Error('rune/gl: createGpuParticles needs a sim:"gpu" facade (this one runs the CPU tier)');
  }
  const ho = handoff;
  const capacity = facade.capacity;
  const stateId = gpu.createBuffer(GPU_STATE_STRIDE * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST);
  const swapsId = gpu.createBuffer(2 * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST);
  const recordsId = gpu.createBuffer(16 * capacity * 4, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.VERTEX);
  const lut = gpuRampLUT(facade.ramp.points);
  const rampId = gpu.createBuffer(lut.byteLength, GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_DST);
  gpu.writeBuffer(rampId, lut);
  const computeId = gpu.createKernel(gpuSimWgsl(), GPU_SIM_UNIFORM_FLOATS * 4, [stateId, swapsId, recordsId, rampId]);
  if (computeId < 0 || stateId < 0 || swapsId < 0 || recordsId < 0 || rampId < 0) {
    gpu.dispose();
    throw new Error("rune/gl: createGpuParticles — the facade rejected a buffer (see the GPU error log)");
  }
  ho.attached = true;
  const scratch = gpu.scratch(GPU_SIM_UNIFORM_FLOATS);
  const uni = scratch.f32;
  const u32 = scratch.u32;
  const cfg = readGpuTierConfig(facade);
  const F = GPU_SIM_F32_FIELDS;
  const V = GPU_SIM_VEC4_FIELDS;
  const a = cfg.active;
  let mask = 0;
  if (a.gravity) {
    mask |= GPU_FORCE_MASK.gravity;
    uni[V.gravity] = cfg.gravity[0];
    uni[V.gravity + 1] = cfg.gravity[1];
    uni[V.gravity + 2] = cfg.gravity[2];
  }
  if (a.drag) {
    mask |= GPU_FORCE_MASK.drag;
    uni[F.drag] = cfg.drag;
  }
  if (a.turbulence) {
    mask |= GPU_FORCE_MASK.turbulence;
    uni[F.turbulence] = cfg.turbulence;
  }
  if (a.attract) {
    mask |= GPU_FORCE_MASK.attract;
    uni[V.attractPoint] = cfg.attract.point[0];
    uni[V.attractPoint + 1] = cfg.attract.point[1];
    uni[V.attractPoint + 2] = cfg.attract.point[2];
    uni[F.attractStrength] = cfg.attract.strength;
    uni[F.softening2] = cfg.attract.softening2;
  }
  if (a.noise) {
    mask |= GPU_FORCE_MASK.noise;
    uni[F.noiseStrength] = cfg.noise.strength;
    uni[F.noiseScale] = cfg.noise.scale;
    uni[F.noiseSpeed] = cfg.noise.speed;
  }
  if (a.limit) {
    mask |= GPU_FORCE_MASK.limitSpeed;
    uni[F.limit] = cfg.limit.limit;
    uni[F.dampen] = cfg.limit.dampen;
  }
  if (a.wrap) {
    mask |= GPU_FORCE_MASK.wrap;
    uni[V.wrapSize] = cfg.wrapSize[0];
    uni[V.wrapSize + 1] = cfg.wrapSize[1];
    uni[V.wrapSize + 2] = cfg.wrapSize[2];
  }
  uni[F.tileU] = cfg.tiles[0];
  uni[F.tileV] = cfg.tiles[1];
  uni[F.frameJitter] = cfg.frameJitter;
  u32[GPU_SIM_U32_FIELDS.forceMask] = mask;
  const staticMask = mask;
  function step(dt) {
    const count = facade.count;
    if (count <= 0 && ho.emitCount === 0 && ho.swapCount === 0)
      return;
    u32[GPU_SIM_U32_FIELDS.count] = count;
    uni[GPU_SIM_F32_FIELDS.dt] = dt;
    u32[GPU_SIM_U32_FIELDS.swapCount] = ho.swapCount;
    u32[GPU_SIM_U32_FIELDS.forceMask] = staticMask;
    const wc = ho.emitOrigin;
    uni[V.wrapCenter] = wc[0];
    uni[V.wrapCenter + 1] = wc[1];
    uni[V.wrapCenter + 2] = wc[2];
    if (ho.swapCount > 0) {
      gpu.writeBuffer(swapsId, ho.swaps, 0, ho.swapCount * 8);
    }
    if (ho.emitCount > 0) {
      gpu.writeBuffer(stateId, ho.emitRows, ho.emitBase * GPU_STATE_STRIDE * 4, ho.emitCount * GPU_STATE_STRIDE * 4);
    }
    if (ho.swapCount > 0)
      gpu.runKernel(computeId, "compact", uni, 1);
    const workgroups = Math.ceil(count / WORKGROUP);
    if (workgroups > 0) {
      gpu.runKernel(computeId, "advance", uni, workgroups);
      gpu.runKernel(computeId, "pack", uni, workgroups);
    }
  }
  return {
    step,
    get recordsBufferId() {
      return recordsId;
    },
    get stateBufferId() {
      return stateId;
    },
    dispose() {
      gpu.dispose();
      ho.attached = false;
    }
  };
}
// packages/math/src/mat4.ts
function mat4Identity(out) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}
function mat4Translation(out, x, y, z) {
  mat4Identity(out);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}
function mat4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = 2 * far * near / (near - far);
  return out;
}
function mat4RotationX(out, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  mat4Identity(out);
  out[5] = c;
  out[6] = s;
  out[9] = -s;
  out[10] = c;
  return out;
}
function mat4RotationY(out, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  mat4Identity(out);
  out[0] = c;
  out[2] = -s;
  out[8] = s;
  out[10] = c;
  return out;
}
function mat4Multiply(out, a, b) {
  const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
  const a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7];
  const a8 = a[8], a9 = a[9], a10 = a[10], a11 = a[11];
  const a12 = a[12], a13 = a[13], a14 = a[14], a15 = a[15];
  for (let col = 0;col < 4; col++) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    out[col * 4 + 1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    out[col * 4 + 2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    out[col * 4 + 3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
  }
  return out;
}
// packages/gl/src/scene.ts
function show(target, options = {}) {
  const spin = options.spin ?? 0.7;
  const background = options.background ?? [0.07, 0.08, 0.11, 1];
  const albedo = options.albedo ?? [0.35, 0.6, 0.95];
  const renderer = createWebGL2Renderer({
    canvas: target,
    clear: { color: background, depth: 1 },
    createGL: options.createGL,
    requestFrame: options.requestFrame,
    now: options.now,
    observeResize: options.observeResize
  });
  const geometry = cube(1);
  const hasTexture = options.texture !== undefined;
  const VERT = `#version 300 es
layout(location = 0) in vec3 position;
layout(location = 1) in vec3 normal;
${hasTexture ? `layout(location = 2) in vec2 uv;
out vec2 v_uv;` : ""}
uniform mat4 u_mvp;
uniform mat4 u_model;
out vec3 v_normal;
void main() {
  v_normal = mat3(u_model) * normal;
  ${hasTexture ? "v_uv = uv;" : ""}
  gl_Position = u_mvp * vec4(position, 1.0);
}`;
  const FRAG = `#version 300 es
precision mediump float;
in vec3 v_normal;
${hasTexture ? `in vec2 v_uv;
uniform sampler2D u_tex;` : ""}
uniform vec3 u_lightDir;
uniform vec3 u_albedo;
out vec4 o_color;
void main() {
  float lambert = max(dot(normalize(v_normal), normalize(u_lightDir)), 0.0);
  ${hasTexture ? `vec3 tex = texture(u_tex, v_uv).rgb;
  o_color = vec4(tex * (0.3 + lambert * 0.7), 1.0);` : "o_color = vec4(u_albedo * (0.3 + lambert * 0.7), 1.0);"}
}`;
  const attributes = {
    position: { data: geometry.positions, size: 3 },
    normal: { data: geometry.normals, size: 3 }
  };
  if (hasTexture)
    attributes.uv = { data: geometry.uvs, size: 2 };
  const uniforms = {
    u_mvp: (p) => p.mvp,
    u_model: (p) => p.model,
    u_lightDir: [0.5, 0.8, 0.6],
    u_albedo: albedo
  };
  let texture;
  if (hasTexture && options.texture !== undefined) {
    const size = options.textureSize ?? 1024;
    texture = renderer.texture(size, size);
  }
  const textures = hasTexture && texture !== undefined ? { u_tex: texture } : undefined;
  const drawCube = renderer.command({
    shader: { glsl: { vertex: VERT, fragment: FRAG } },
    pipeline: { depth: { test: "less", write: true }, raster: { cull: "back" } },
    attributes,
    uniforms,
    textures,
    count: geometry.vertexCount
  });
  if (texture !== undefined && options.texture !== undefined) {
    texture.upload(options.texture, {
      priority: 3,
      onProgress: options.onProgress
    }).done.catch(() => {});
  }
  const view = new Float32Array(16);
  const projection = new Float32Array(16);
  const viewProj = new Float32Array(16);
  const model = new Float32Array(16);
  const rotX = new Float32Array(16);
  const rotated = new Float32Array(16);
  const mvp = new Float32Array(16);
  let cachedAspect = 0;
  mat4Translation(view, 0, 0, -6);
  renderer.frame((ctx, record) => {
    if (ctx.aspect !== cachedAspect) {
      cachedAspect = ctx.aspect;
      mat4Perspective(projection, Math.PI / 4, ctx.aspect, 0.1, 100);
      mat4Multiply(viewProj, projection, view);
    }
    mat4RotationY(model, ctx.time * spin);
    mat4RotationX(rotX, ctx.time * spin * 0.55);
    mat4Multiply(rotated, model, rotX);
    mat4Multiply(mvp, viewProj, rotated);
    record(drawCube, { mvp, model: rotated });
  });
  setBackendLabel("WebGL2", options.badge);
  if (options.label !== undefined)
    setSceneLabel(options.label);
  renderer.start();
  return {
    renderer,
    stop: () => renderer.stop(),
    pause: () => renderer.stop(),
    resume: () => renderer.start()
  };
}
function setBackendLabel(text, selector = "#backend") {
  if (typeof document === "undefined")
    return;
  const label2 = document.querySelector(selector);
  if (label2 !== null)
    label2.textContent = text;
}
function setSceneLabel(text) {
  if (typeof document === "undefined")
    return;
  const label2 = document.querySelector("#scene-label");
  if (label2 !== null)
    label2.textContent = text;
}
// packages/gl/src/showWebgpu.ts
var WGSL_TEX = `
struct Params {
  u_mvp     : mat4x4<f32>,
  u_model   : mat4x4<f32>,
  u_lightDir : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
  @location(1) uv : vec2<f32>,
}

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inNormal : vec3<f32>,
  @location(2) inUv : vec2<f32>,
) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(inPos, 1.0);
  out.worldNormal = (params.u_model * vec4<f32>(inNormal, 0.0)).xyz;
  out.uv = inUv;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let lambert = max(dot(normalize(frag.worldNormal), normalize(params.u_lightDir.xyz)), 0.0);
  let tex = textureSample(texTexture, texSampler, frag.uv);
  return vec4<f32>(tex.rgb * (0.3 + lambert * 0.7), 1.0);
}`;
var WGSL_FLAT = `
struct Params {
  u_mvp     : mat4x4<f32>,
  u_model   : mat4x4<f32>,
  u_lightDir : vec4<f32>,
  u_albedo   : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
}

@vertex
fn vsMain(
  @location(0) inPos : vec3<f32>,
  @location(1) inNormal : vec3<f32>,
) -> VSOut {
  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(inPos, 1.0);
  out.worldNormal = (params.u_model * vec4<f32>(inNormal, 0.0)).xyz;
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let lambert = max(dot(normalize(frag.worldNormal), normalize(params.u_lightDir.xyz)), 0.0);
  return vec4<f32>(params.u_albedo.rgb * (0.3 + lambert * 0.7), 1.0);
}`;
async function showOnWebGpu(canvas, options) {
  const spin = options.spin ?? 0.7;
  const albedo = options.albedo ?? [0.35, 0.6, 0.95];
  const renderer = await createWebGpuRenderer({
    canvas,
    onGpuError: () => {},
    createGPU: options.createGPU,
    requestFrame: options.requestFrame,
    now: options.now,
    observeResize: options.observeResize
  });
  const geometry = cube(1);
  const hasTexture = options.texture !== undefined;
  let textureId;
  if (hasTexture && options.texture !== undefined) {
    const size = options.textureSize ?? 1024;
    textureId = renderer.gpu.createTexture(size, size);
  }
  const attributes = {
    inPos: { data: geometry.positions, size: 3 },
    inNormal: { data: geometry.normals, size: 3 }
  };
  if (hasTexture)
    attributes.inUv = { data: geometry.uvs, size: 2 };
  const uniforms = {
    u_mvp: (p) => p.mvp,
    u_model: (p) => p.model,
    u_lightDir: [0.5, 0.8, 0.6, 0]
  };
  if (!hasTexture)
    uniforms.u_albedo = [albedo[0], albedo[1], albedo[2], 1];
  const spec = {
    shader: { wgsl: hasTexture ? WGSL_TEX : WGSL_FLAT },
    pipeline: { depth: { test: "less", write: true }, raster: { cull: "back" } },
    uniforms,
    attributes,
    count: geometry.vertexCount
  };
  if (hasTexture && textureId !== undefined) {
    spec.textures = { texTexture: { textureId } };
  }
  const drawCube = renderer.command(spec);
  if (hasTexture && options.texture !== undefined && textureId !== undefined) {
    const { streamTexture: streamTexture2 } = await Promise.resolve().then(() => (init_src(), exports_src));
    streamTexture2(renderer.uploads, options.texture, options.textureSize ?? 1024, options.textureSize ?? 1024, (tile, bytes) => {
      renderer.gpu.texSubImage2D(textureId, tile.x, tile.y, tile.width, tile.height, bytes);
    }, { priority: 3, onProgress: options.onProgress }).done.catch(() => {});
  }
  const view = new Float32Array(16);
  const projection = new Float32Array(16);
  const viewProj = new Float32Array(16);
  const model = new Float32Array(16);
  const rotX = new Float32Array(16);
  const rotated = new Float32Array(16);
  const mvp = new Float32Array(16);
  let cachedAspect = 0;
  mat4Translation(view, 0, 0, -6);
  renderer.frame((ctx, record) => {
    if (ctx.aspect !== cachedAspect) {
      cachedAspect = ctx.aspect;
      mat4Perspective(projection, Math.PI / 4, ctx.aspect, 0.1, 100);
      mat4Multiply(viewProj, projection, view);
    }
    mat4RotationY(model, ctx.time * spin);
    mat4RotationX(rotX, ctx.time * spin * 0.55);
    mat4Multiply(rotated, model, rotX);
    mat4Multiply(mvp, viewProj, rotated);
    record(drawCube, { mvp, model: rotated });
  });
  renderer.start();
  return {
    renderer,
    stop: () => renderer.stop(),
    pause: () => renderer.stop(),
    resume: () => renderer.start()
  };
}

// packages/gl/src/showOn.ts
async function showOn(target, backend, options = {}) {
  return backend === "webgpu" ? bootWebGpu(target, options) : bootWebGl2(target, options);
}
async function bootWebGl2(target, options) {
  try {
    const webgl2 = show(target, options);
    return alive("webgl2", { webgl2 });
  } catch (error) {
    return dead("webgl2", error);
  }
}
async function bootWebGpu(target, options) {
  const canvas = resolveCanvas(target);
  if (!await probeWebGpu()) {
    return dead("webgpu", new Error("WebGPU unavailable: navigator.gpu is missing or no adapter was obtained"));
  }
  try {
    const webgpu = await showOnWebGpu(canvas, options);
    setLabel(options.badge, "WebGPU");
    return alive("webgpu", { webgpu });
  } catch (error) {
    return dead("webgpu", error);
  }
}
function alive(backend, shows) {
  const inner = shows.webgl2 ?? shows.webgpu;
  return {
    backend,
    active: backend,
    ...shows,
    pause: () => inner?.pause(),
    resume: () => inner?.resume(),
    stop: () => inner?.stop()
  };
}
function dead(backend, error) {
  return {
    backend,
    active: null,
    failureReason: error instanceof Error ? error.message : String(error),
    pause: () => {},
    resume: () => {},
    stop: () => {}
  };
}
async function probeWebGpu() {
  if (typeof navigator === "undefined" || !("gpu" in navigator))
    return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return adapter !== null;
  } catch {
    return false;
  }
}
function resolveCanvas(target) {
  if (typeof target !== "string")
    return target;
  if (typeof document === "undefined")
    throw new Error("rune: showOn without DOM requires an element");
  const canvas = document.querySelector(target);
  if (canvas === null)
    throw new Error(`rune: canvas "${target}" not found`);
  return canvas;
}
function setLabel(selector, text) {
  if (typeof document === "undefined")
    return;
  const label2 = document.querySelector(selector ?? "#backend");
  if (label2 !== null)
    label2.textContent = text;
}

// packages/gl/src/showAny.ts
async function showAny(target, options = {}) {
  const canvas = resolveCanvas2(target);
  if (await probeWebGpu()) {
    try {
      const webgpu = await showOnWebGpu(canvas, options);
      setBackendLabel2("WebGPU");
      return { backend: "webgpu", webgpu, stop: () => webgpu.stop() };
    } catch (error) {
      reportFallbackReason(error);
    }
  }
  const fresh = freshCanvas(canvas);
  const webgl2 = show(fresh, options);
  setBackendLabel2("WebGL2 (fallback)", options.badge);
  return { backend: "webgl2", webgl2, stop: () => webgl2.stop() };
}
function resolveCanvas2(target) {
  if (typeof target !== "string")
    return target;
  if (typeof document === "undefined")
    throw new Error("rune: show without DOM requires an element");
  const canvas = document.querySelector(target);
  if (canvas === null)
    throw new Error(`rune: canvas "${target}" not found`);
  return canvas;
}
function freshCanvas(old) {
  const replacement = old.cloneNode(false);
  old.replaceWith(replacement);
  return replacement;
}
function setBackendLabel2(text, selector = "#backend") {
  if (typeof document === "undefined")
    return;
  const label2 = document.querySelector(selector);
  if (label2 !== null)
    label2.textContent = text;
}
function reportFallbackReason(error) {
  if (typeof document === "undefined")
    return;
  const reason = document.querySelector("#reason");
  if (reason === null)
    return;
  reason.style.display = "block";
  reason.textContent = `WebGPU failed to start: ${String(error instanceof Error ? error.message : error)}
Falling back to WebGL2.`;
}
// packages/gl/src/webgpuScope.ts
var WEBUGPU_PROBE_MARKER = "__runeWebgpuProbe";
var WEBUGPU_PROBE_SRC = `self.postMessage({ ${WEBUGPU_PROBE_MARKER}: typeof navigator !== 'undefined' && navigator.gpu !== undefined })`;
function hasGpuApiHere() {
  return typeof navigator !== "undefined" && navigator.gpu !== undefined;
}
function isMainThreadLike() {
  return typeof document !== "undefined";
}
var facts = {
  main: null,
  worker: null,
  probe: "idle",
  pending: null
};
function combineWebgpuScope(main, worker) {
  if (main === null || worker === null)
    return null;
  if (main && worker)
    return "everywhere";
  if (main && !worker)
    return "main-only";
  if (!main && worker)
    return "worker-only";
  return "nowhere";
}
function webgpuAvailability() {
  const here = hasGpuApiHere();
  const mainThread = isMainThreadLike();
  const main = mainThread ? here : facts.main;
  return {
    main,
    worker: facts.worker,
    scope: combineWebgpuScope(main, facts.worker),
    workerProbe: facts.probe,
    mainThread,
    here
  };
}
function reportWebgpuMainFact(hasApi) {
  facts.main = hasApi;
}
function reportWebgpuWorkerFact(hasApi) {
  facts.worker = hasApi;
  facts.probe = "external";
}
function probeWebgpuScope(options = {}) {
  if (facts.worker !== null)
    return Promise.resolve(webgpuAvailability());
  if (facts.pending !== null)
    return facts.pending;
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL?.createObjectURL !== "function") {
    facts.probe = "unsupported";
    return Promise.resolve(webgpuAvailability());
  }
  facts.probe = "pending";
  const promise = new Promise((resolve3) => {
    let worker = null;
    let url = null;
    let settled = false;
    const finish = () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      try {
        worker?.terminate();
      } catch {}
      if (url !== null) {
        try {
          URL.revokeObjectURL(url);
        } catch {}
      }
    };
    const timer = setTimeout(() => {
      facts.probe = "timeout";
      finish();
      resolve3(webgpuAvailability());
    }, options.timeoutMs ?? 3000);
    try {
      url = URL.createObjectURL(new Blob([WEBUGPU_PROBE_SRC], { type: "text/javascript" }));
      worker = new Worker(url);
    } catch {
      facts.probe = "unsupported";
      finish();
      resolve3(webgpuAvailability());
      return;
    }
    worker.onmessage = (event) => {
      const value = event.data?.[WEBUGPU_PROBE_MARKER];
      if (typeof value === "boolean") {
        facts.worker = value;
        facts.probe = "done";
      } else {
        facts.probe = "unsupported";
      }
      finish();
      resolve3(webgpuAvailability());
    };
    worker.onerror = () => {
      facts.probe = "unsupported";
      finish();
      resolve3(webgpuAvailability());
    };
  });
  facts.pending = promise;
  promise.then(() => {
    if (facts.worker === null)
      facts.pending = null;
  });
  return promise;
}
function describeWebgpuScope(a) {
  switch (a.scope) {
    case "everywhere":
      return "WebGPU API is granted everywhere: navigator.gpu exists both in the main thread and in workers.";
    case "main-only":
      return "WebGPU API only in the main thread: workers are not granted navigator.gpu (Chrome on Android, Safari, Firefox). WebGPU rendering in a worker is impossible — only WebGL2 there.";
    case "worker-only":
      return "WebGPU API only in workers: navigator.gpu is missing in the main thread (a rare configuration).";
    case "nowhere":
      return "WebGPU API is missing both in the main thread and in workers — there is no WebGPU in this environment.";
  }
  if (a.workerProbe === "unsupported") {
    return "WebGPU scope unknown: the worker micro-probe did not start (Worker/Blob unavailable or CSP).";
  }
  if (a.workerProbe === "timeout") {
    return "WebGPU scope unknown: the worker micro-probe did not answer in time.";
  }
  if (a.workerProbe === "pending") {
    return "WebGPU scope is being determined: the worker micro-probe is in flight (milliseconds, no GPU initialization).";
  }
  if (a.main === null) {
    return `WebGPU scope unknown: the main-thread fact was not reported (the snapshot was taken outside main; the current thread's fact: navigator.gpu ${a.here ? "present" : "absent"}).`;
  }
  return `WebGPU scope determined partially: main=${a.main ? "yes" : "no"}, worker unknown — call probeWebgpuScope().`;
}
// packages/gl/src/adapters.ts
init_src();
function webgl2Adapter() {
  return {
    kind: "webgl2",
    create: () => createCompileContext(createUniformArena(), "codegen"),
    compile: (context, spec) => {
      const ctx = context;
      const command = compileDrawSpec(toWebgl2Spec(spec), ctx);
      return {
        bindings: command.bindings.map((binding) => binding.name),
        record: (props, frameCtx, writer) => command.record(props, frameCtx, writer)
      };
    }
  };
}
function webgpuAdapter() {
  return {
    kind: "webgpu",
    create: () => createWgpuContext(createSliceArena(1 << 20)),
    compile: (context, spec) => {
      const ctx = context;
      const command = compileWgslSpec(toWebgpuSpec(spec), ctx);
      return {
        bindings: command.bindings.map((binding) => binding.name),
        record: (props, frameCtx, writer) => command.record(props, frameCtx, writer)
      };
    }
  };
}
function toWebgl2Spec(spec) {
  return {
    shader: { glsl: spec.shader.glsl },
    pipeline: spec.pipeline,
    uniforms: spec.uniforms,
    count: spec.count,
    instances: spec.instances
  };
}
function toWebgpuSpec(spec) {
  return {
    shader: { wgsl: spec.shader.wgsl },
    pipeline: spec.pipeline,
    uniforms: spec.uniforms,
    count: spec.count,
    instances: spec.instances
  };
}
// packages/gl/src/harness.ts
function createPortability(adapters, initial = "webgl2") {
  const ops = [];
  const journal = {
    declare: (id) => ops.push({ kind: "declare", id }),
    destroy: (id) => ops.push({ kind: "destroy", id }),
    get length() {
      return ops.length;
    }
  };
  const live = new Map;
  let active = initial;
  let context = adapters[active].create();
  let nextId = 0;
  function compile(spec) {
    const id = nextId++;
    journal.declare(id);
    const entry = { id, spec, compiled: compileOn(adapters, active, context, spec) };
    live.set(id, entry);
    return makeFacade(entry);
  }
  function destroy(command) {
    journal.destroy(command.id);
    live.delete(command.id);
  }
  function switchBackend(kind) {
    active = kind;
    context = adapters[kind].create();
    return replay2();
  }
  function simulateLoss() {
    context = adapters[active].create();
    return replay2();
  }
  function replay2() {
    let recompiled = 0;
    for (const op of ops) {
      if (op.kind === "destroy") {
        live.delete(op.id);
        continue;
      }
      if (!live.has(op.id))
        continue;
      recompiled++;
      const target = live.get(op.id);
      target.compiled = compileOn(adapters, active, context, target.spec);
    }
    return { recompiled, backend: active };
  }
  return {
    get backend() {
      return active;
    },
    journal,
    compile,
    destroy,
    switchBackend,
    simulateLoss
  };
}
function compileOn(adapters, kind, context, spec) {
  return adapters[kind].compile(context, spec);
}
function makeFacade(entry) {
  return {
    id: entry.id,
    record: (props, ctx, writer) => entry.compiled.record(props, ctx, writer)
  };
}
export {
  withJournalGpu,
  withJournal,
  webgpuAvailability,
  webgpuAdapter,
  webgl2Adapter,
  torusKnot,
  torus,
  sphere,
  showOnWebGpu,
  showOn,
  showAny,
  show,
  shaderCoverage,
  resolveCanvasAny,
  resolveBackend,
  reportWebgpuWorkerFact,
  reportWebgpuMainFact,
  replayJournalOnGpu,
  replayJournalOn,
  quad,
  probeWebgpuScope,
  probeWebGpu,
  plane,
  isOffscreenCanvas,
  getCanvasCssSize,
  describeWebgpuScope,
  cube,
  createWebGpuRenderer,
  createWebGL2Renderer,
  createResourceSessionGPU,
  createResourceSessionGL,
  createRendererFeedGPU,
  createRendererFeedGL,
  createRenderer,
  createPortability,
  createGpuParticles,
  computeMipLevels,
  combineWebgpuScope,
  capsule,
  canvasDpr,
  box,
  applyResOpGL,
  WEBUGPU_PROBE_SRC,
  WEBUGPU_PROBE_MARKER,
  BackendResolutionError
};
