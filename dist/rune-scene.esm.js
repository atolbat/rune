// packages/scene/src/layout.ts
var H_MAGIC = 0;
var H_CAPACITY = 1;
var H_NODE_COUNT = 2;
var H_CAMERA_MAX = 3;
var H_CAMERA_COUNT = 4;
var H_INPUT_EPOCH = 5;
var H_OUTPUT_EPOCH = 6;
var H_LAYOUT_EPOCH = 7;
var H_CLOCK = 8;
var H_CMD_FLAGS = 9;
var H_BITS_WORDS = 10;
var H_GROUP_COUNT = 11;
var H_INSTANCE_POOL = 12;
var H_DROPPED_INSTANCES = 13;
var H_STALE_TAKES = 14;
var H_INT_WORDS = 15;
var H_FLOAT_FLOATS = 16;
var H_MAX_INSTANCES = 17;
var H_GROUP_MAX = 18;
var H_COLLECT_LAYOUT_EPOCH = 19;
var H_WORDS = 20;
var SCENE_MAGIC = 861097554;
var CMD_UPDATE_WORLD = 1;
var CMD_CULL = 2;
var CMD_INSTANCES = 4;
var CMD_REFIT = 8;
var CMD_ALL = CMD_UPDATE_WORLD | CMD_CULL | CMD_INSTANCES | CMD_REFIT;
var CMD_STOP = 1 << 30;
var NF_VISIBLE = 1;
var NF_ALIVE = 2;
function sceneBitsWords(capacity) {
  return capacity + 31 >> 5;
}
var tailLayoutEnabled = true;
function setTailLayout(enabled) {
  tailLayoutEnabled = enabled;
}
function tailLayoutOn() {
  return tailLayoutEnabled;
}
function freeListWord(views) {
  return H_WORDS + views.capacity * 13;
}
function createSceneBuffer(options = {}) {
  const capacity = Math.max(1, options.capacity ?? 1024);
  const cameraMax = Math.max(1, options.cameraMax ?? 4);
  const groupMax = Math.max(1, options.groupMax ?? 64);
  const maxInstances = Math.max(0, options.maxInstances ?? capacity);
  const bitsWords = sceneBitsWords(capacity);
  const intWords = H_WORDS + capacity * 13 + 2 + 2 * cameraMax * bitsWords + 2 * cameraMax * groupMax * 2 + groupMax + cameraMax * groupMax + bitsWords + (groupMax + 1) + groupMax;
  const floatFloats = capacity * (3 + 4 + 3 + 16 + 4 + 4) + cameraMax * 24 + 2 * cameraMax * maxInstances * 16;
  const bytes = intWords * 4 + floatFloats * 4;
  const buffer = options.shared === true ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  const headerI = new Int32Array(buffer, 0, H_WORDS);
  headerI[H_MAGIC] = SCENE_MAGIC;
  headerI[H_CAPACITY] = capacity;
  headerI[H_NODE_COUNT] = 0;
  headerI[H_CAMERA_MAX] = cameraMax;
  headerI[H_CAMERA_COUNT] = 0;
  headerI[H_INPUT_EPOCH] = 0;
  headerI[H_OUTPUT_EPOCH] = 0;
  headerI[H_LAYOUT_EPOCH] = 0;
  headerI[H_CLOCK] = 0;
  headerI[H_CMD_FLAGS] = CMD_ALL;
  headerI[H_BITS_WORDS] = bitsWords;
  headerI[H_GROUP_COUNT] = 0;
  headerI[H_INSTANCE_POOL] = maxInstances;
  headerI[H_DROPPED_INSTANCES] = 0;
  headerI[H_STALE_TAKES] = 0;
  headerI[H_INT_WORDS] = intWords;
  headerI[H_FLOAT_FLOATS] = floatFloats;
  headerI[H_MAX_INSTANCES] = maxInstances;
  headerI[H_GROUP_MAX] = groupMax;
  const views = buildSceneViews(buffer);
  views.parent.fill(-1);
  views.firstChild.fill(-1);
  views.nextSibling.fill(-1);
  views.prevSibling.fill(-1);
  views.subtreeEnd.fill(0);
  views.group.fill(-1);
  views.payload.fill(-1);
  views.nodeFlags.fill(0);
  views.instCounts.fill(0);
  views.instOffsets.fill(0);
  views.groupTouch.fill(0);
  views.groupFlip.fill(0);
  views.dirtyBounds.fill(0);
  views.rankOf.fill(0);
  views.gStart.fill(0);
  views.gHidden.fill(0);
  const full = new Int32Array(buffer);
  const freeList = freeListWord(views);
  full[freeList] = capacity > 0 ? 0 : -1;
  full[freeList + 1] = capacity;
  for (let i = 0;i < capacity - 1; i++)
    views.nextSibling[i] = i + 1;
  views.nextSibling[capacity - 1] = -1;
  for (let i = 0;i < capacity; i++) {
    views.quat[i * 4 + 3] = 1;
    views.scale[i * 3] = 1;
    views.scale[i * 3 + 1] = 1;
    views.scale[i * 3 + 2] = 1;
  }
  return buffer;
}
function buildSceneViews(buffer) {
  if (buffer.byteLength < H_WORDS * 4) {
    throw new Error("scene: the buffer is too small for the header");
  }
  const probe = new Int32Array(buffer, 0, H_WORDS);
  if (probe[H_MAGIC] !== SCENE_MAGIC) {
    throw new Error("scene: the buffer is not a scene (magic mismatch)");
  }
  const capacity = probe[H_CAPACITY];
  const cameraMax = probe[H_CAMERA_MAX];
  const groupMax = probe[H_GROUP_MAX];
  const maxInstances = probe[H_MAX_INSTANCES];
  const bitsWords = probe[H_BITS_WORDS];
  const intWords = probe[H_INT_WORDS];
  const floatFloats = probe[H_FLOAT_FLOATS];
  const expectedBytes = intWords * 4 + floatFloats * 4;
  if (buffer.byteLength < expectedBytes) {
    throw new Error(`scene: the buffer is smaller than the layout (${buffer.byteLength} < ${expectedBytes})`);
  }
  const headerI = probe;
  const headerU = new Uint32Array(buffer, 0, H_WORDS);
  let w = H_WORDS;
  const int = (len) => {
    const v = new Int32Array(buffer, w * 4, len);
    w += len;
    return v;
  };
  const uint = (len) => {
    const v = new Uint32Array(buffer, w * 4, len);
    w += len;
    return v;
  };
  const parent = int(capacity);
  const firstChild = int(capacity);
  const nextSibling = int(capacity);
  const prevSibling = int(capacity);
  const order = int(capacity);
  const subtreeEnd = int(capacity);
  const rankOf = int(capacity);
  const group = int(capacity);
  const payload = int(capacity);
  const nodeFlags = int(capacity);
  const generation = int(capacity);
  const localStamp = uint(capacity);
  const worldStamp = uint(capacity);
  int(2);
  const bits = uint(2 * cameraMax * bitsWords);
  const instCounts = int(2 * cameraMax * groupMax);
  const instOffsets = int(2 * cameraMax * groupMax);
  const groupTouch = int(groupMax);
  const groupFlip = int(cameraMax * groupMax);
  const dirtyBounds = uint(bitsWords);
  const gStart = int(groupMax + 1);
  const gHidden = int(groupMax);
  if (w !== intWords) {
    throw new Error(`scene: the int-region layout has drifted (${w} ≠ ${intWords})`);
  }
  let f = intWords;
  const floats = (len) => {
    const v = new Float32Array(buffer, f * 4, len);
    f += len;
    return v;
  };
  const pos = floats(capacity * 3);
  const quat = floats(capacity * 4);
  const scale = floats(capacity * 3);
  const world = floats(capacity * 16);
  const sphereL = floats(capacity * 4);
  const sphereW = floats(capacity * 4);
  const planes = floats(cameraMax * 24);
  const instPool = floats(2 * cameraMax * Math.max(maxInstances, 0) * 16);
  if (f !== intWords + floatFloats) {
    throw new Error(`scene: the float-region layout has drifted (${f} ≠ ${intWords + floatFloats})`);
  }
  return {
    buffer,
    headerI,
    headerU,
    parent,
    firstChild,
    nextSibling,
    prevSibling,
    order,
    subtreeEnd,
    rankOf,
    group,
    payload,
    nodeFlags,
    generation,
    localStamp,
    worldStamp,
    bits,
    instCounts,
    instOffsets,
    groupTouch,
    groupFlip,
    dirtyBounds,
    gStart,
    gHidden,
    pos,
    quat,
    scale,
    world,
    sphereL,
    sphereW,
    planes,
    instPool,
    capacity,
    cameraMax,
    groupMax,
    maxInstances,
    bitsWords
  };
}
// packages/scene/src/groupBounds.ts
var groupSpheres = new WeakMap;
function groupSpheresFor(views) {
  let state = groupSpheres.get(views);
  if (state === undefined) {
    state = {
      spheres: new Float32Array(views.groupMax * 4),
      built: new Int32Array(views.groupMax).fill(-1)
    };
    groupSpheres.set(views, state);
  }
  return state;
}
var sphereBuilds = 0;
function groupSphereBuildCount() {
  return sphereBuilds;
}
function buildGroupSphere(views, g) {
  const n = views.headerI[H_NODE_COUNT];
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
  const { order, group, sphereW, groupTouch } = views;
  const state = groupSpheresFor(views);
  const o4g = g * 4;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let count = 0;
  const useSegment = tailLayoutOn() && g >= 0 && g < groupCount;
  const segFrom = useSegment ? views.gStart[g] : 0;
  const segTo = useSegment ? views.gStart[g + 1] : n;
  for (let r = segFrom;r < segTo; r++) {
    const slot = order[r];
    if (!useSegment && group[slot] !== g)
      continue;
    const o4 = slot * 4;
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2], rad = sphereW[o4 + 3];
    const x0 = cx - rad, x1 = cx + rad, y0 = cy - rad, y1 = cy + rad, z0 = cz - rad, z1 = cz + rad;
    if (x0 < minX)
      minX = x0;
    if (x1 > maxX)
      maxX = x1;
    if (y0 < minY)
      minY = y0;
    if (y1 > maxY)
      maxY = y1;
    if (z0 < minZ)
      minZ = z0;
    if (z1 > maxZ)
      maxZ = z1;
    count++;
  }
  if (count === 0) {
    state.spheres[o4g + 3] = -1;
  } else {
    const cx = (minX + maxX) * 0.5, cy = (minY + maxY) * 0.5, cz = (minZ + maxZ) * 0.5;
    let radius = 0;
    for (let r = segFrom;r < segTo; r++) {
      const slot = order[r];
      if (!useSegment && group[slot] !== g)
        continue;
      const o4 = slot * 4;
      const dx = sphereW[o4] - cx, dy = sphereW[o4 + 1] - cy, dz = sphereW[o4 + 2] - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + sphereW[o4 + 3];
      if (d > radius)
        radius = d;
    }
    state.spheres[o4g] = cx;
    state.spheres[o4g + 1] = cy;
    state.spheres[o4g + 2] = cz;
    state.spheres[o4g + 3] = radius;
  }
  state.built[g] = groupTouch[g];
  sphereBuilds++;
}

// packages/scene/src/culling.ts
var cullMemoEnabled = true;
var cullMemoHits = 0;
var cullMemoMisses = 0;
var cullTailSpheresEnabled = true;
function setCullTailSpheres(enabled) {
  cullTailSpheresEnabled = enabled;
}
var cullMemos = new WeakMap;
function cullMemoFor(views) {
  let memo = cullMemos.get(views);
  if (memo === undefined) {
    const slots = 2 * views.cameraMax;
    memo = {
      clock: new Int32Array(slots).fill(-1),
      epoch: new Int32Array(slots).fill(-1),
      flags: new Uint8Array(slots),
      planes: new Float32Array(slots * 24),
      stats: new Int32Array(slots * 5)
    };
    cullMemos.set(views, memo);
  }
  return memo;
}
function setCullMemo(enabled) {
  cullMemoEnabled = enabled;
}
function cullMemoCounters() {
  return { hits: cullMemoHits, misses: cullMemoMisses };
}
function cullMemoServe(views, bufferIndex, cameraIndex, flagByte, out) {
  const idx = bufferIndex * views.cameraMax + cameraIndex;
  const memo = cullMemoFor(views);
  if (memo.clock[idx] !== views.headerU[H_CLOCK])
    return false;
  if (memo.epoch[idx] !== views.headerI[H_LAYOUT_EPOCH])
    return false;
  if (memo.flags[idx] !== flagByte)
    return false;
  const src = cameraIndex * 24;
  const snap = idx * 24;
  const planes = views.planes;
  const snapPlanes = memo.planes;
  for (let i = 0;i < 24; i++) {
    if (planes[src + i] !== snapPlanes[snap + i])
      return false;
  }
  cullMemoHits++;
  const s = idx * 5;
  const stats = memo.stats;
  if (out !== undefined) {
    out.tested = stats[s];
    out.visible = stats[s + 1];
    out.trivialRejects = stats[s + 2];
    out.trivialAccepts = stats[s + 3];
    out.planeTests = stats[s + 4];
    return true;
  }
  return true;
}
function cullMemoSave(views, bufferIndex, cameraIndex, flagByte, tested, visible, trivialRejects, trivialAccepts, planeTests) {
  const idx = bufferIndex * views.cameraMax + cameraIndex;
  const memo = cullMemoFor(views);
  memo.clock[idx] = views.headerU[H_CLOCK];
  memo.epoch[idx] = views.headerI[H_LAYOUT_EPOCH];
  memo.flags[idx] = flagByte;
  memo.planes.set(views.planes.subarray(cameraIndex * 24, cameraIndex * 24 + 24), idx * 24);
  const s = idx * 5;
  memo.stats[s] = tested;
  memo.stats[s + 1] = visible;
  memo.stats[s + 2] = trivialRejects;
  memo.stats[s + 3] = trivialAccepts;
  memo.stats[s + 4] = planeTests;
  cullMemoMisses++;
}
function cullMemoStatsOf(views, bufferIndex, cameraIndex) {
  const idx = bufferIndex * views.cameraMax + cameraIndex;
  const s = idx * 5;
  const stats = cullMemoFor(views).stats;
  return {
    tested: stats[s],
    visible: stats[s + 1],
    trivialRejects: stats[s + 2],
    trivialAccepts: stats[s + 3],
    planeTests: stats[s + 4]
  };
}
var rangeStack = new Int32Array(8192);
function pushRange(s, e, mask, sp) {
  if (sp + 3 > rangeStack.length) {
    const grown = new Int32Array(rangeStack.length * 2);
    grown.set(rangeStack);
    rangeStack = grown;
  }
  rangeStack[sp] = s;
  rangeStack[sp + 1] = e;
  rangeStack[sp + 2] = mask;
  return sp + 3;
}
function fillBits(bits, base, s, e, on) {
  if (e <= s)
    return;
  const sWord = s >>> 5;
  const eWord = e - 1 >>> 5;
  if (sWord === eWord) {
    const count = e - s;
    const mask = (count >= 32 ? 4294967295 : (1 << count) - 1) << (s & 31);
    if (on)
      bits[base + sWord] |= mask;
    else
      bits[base + sWord] &= ~mask;
    return;
  }
  const sOff = s & 31;
  if (sOff !== 0) {
    const mask = (1 << 32 - sOff) - 1 << sOff;
    if (on)
      bits[base + sWord] |= mask;
    else
      bits[base + sWord] &= ~mask;
  } else {
    bits[base + sWord] = on ? 4294967295 : 0;
  }
  for (let w = sWord + 1;w < eWord; w++) {
    bits[base + w] = on ? 4294967295 : 0;
  }
  const eOff = e & 31;
  if (eOff !== 0) {
    const mask = (1 << eOff) - 1;
    if (on)
      bits[base + eWord] |= mask;
    else
      bits[base + eWord] &= ~mask;
  } else {
    bits[base + eWord] = on ? 4294967295 : 0;
  }
}
function popcountBits(bits, base, words) {
  let count = 0;
  for (let w = 0;w < words; w++) {
    let v = bits[base + w];
    if (v === 0)
      continue;
    v = v - (v >>> 1 & 1431655765);
    v = (v & 858993459) + (v >>> 2 & 858993459);
    v = v + (v >>> 4) & 252645135;
    count += v * 16843009 >>> 24;
  }
  return count;
}
function bitsBase(views, bufferIndex, cameraIndex) {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.bitsWords;
}
function isVisibleRank(views, bufferIndex, cameraIndex, rank) {
  const base = bitsBase(views, bufferIndex, cameraIndex);
  return (views.bits[base + (rank >>> 5)] & 1 << (rank & 31)) !== 0;
}
function splitChildrenOf(order, subtreeEnd, s, e, mask, sp) {
  let r2 = s + 1;
  while (r2 < e) {
    const child = order[r2];
    const childEnd = subtreeEnd[child];
    const end = childEnd > r2 ? childEnd : r2 + 1;
    sp = pushRange(r2, end, mask, sp);
    r2 = end;
  }
  return sp;
}
function cullViewsHierarchical(views, cameraIndex, bufferIndex, out, masks = true, countVisible = true) {
  const flagByte = 4 | (masks ? 1 : 0) | (countVisible ? 2 : 0) | (tailLayoutOn() ? 8 : 0) | (cullTailSpheresEnabled ? 16 : 0);
  if (cullMemoEnabled && cullMemoServe(views, bufferIndex, cameraIndex, flagByte, out)) {
    if (out !== undefined)
      return out;
    return cullMemoStatsOf(views, bufferIndex, cameraIndex);
  }
  const n = views.headerI[H_NODE_COUNT];
  const { order, parent, subtreeEnd, sphereW, bits, planes } = views;
  const base = bitsBase(views, bufferIndex, cameraIndex);
  const pb = cameraIndex * 24;
  const treeN = views.gStart[0];
  let sp = 0;
  for (let r = 0;r < treeN; ) {
    const slot = order[r];
    const end = subtreeEnd[slot];
    if (parent[slot] < 0 && end > r) {
      sp = pushRange(r, end, 63, sp);
      r = end;
    } else {
      r++;
    }
  }
  let tested = 0;
  let trivialRejects = 0;
  let trivialAccepts = 0;
  let planeTests = 0;
  while (sp > 0) {
    sp -= 3;
    const s = rangeStack[sp];
    const e = rangeStack[sp + 1];
    const mask = rangeStack[sp + 2];
    const slot = order[s];
    const leaf = e === s + 1;
    const o4 = slot * 4;
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2];
    const r = sphereW[o4 + 3];
    const enclosing = leaf || r > 0;
    tested++;
    let outside = false;
    let insideAll = true;
    let interMask = 0;
    let m = mask;
    while (m !== 0) {
      const pbIdx = m & -m;
      const i = 31 - Math.clz32(pbIdx);
      m ^= pbIdx;
      const o = pb + i * 4;
      planeTests++;
      const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3];
      if (d < -r) {
        outside = true;
        break;
      }
      if (d < r) {
        interMask |= pbIdx;
        insideAll = false;
      }
    }
    if (outside) {
      if (enclosing) {
        fillBits(bits, base, s, e, false);
        trivialRejects++;
      } else {
        bits[base + (s >>> 5)] &= ~(1 << (s & 31));
        sp = splitChildrenOf(order, subtreeEnd, s, e, mask, sp);
      }
      continue;
    }
    if (insideAll && enclosing) {
      fillBits(bits, base, s, e, true);
      trivialAccepts++;
      continue;
    }
    bits[base + (s >>> 5)] |= 1 << (s & 31);
    if (!leaf)
      sp = splitChildrenOf(order, subtreeEnd, s, e, masks && enclosing ? interMask : mask, sp);
  }
  if (treeN < n) {
    const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
    const state = cullTailSpheresEnabled && groupCount > 0 ? groupSpheresFor(views) : null;
    if (state !== null) {
      const { groupTouch, gStart } = views;
      const spheres = state.spheres;
      const built = state.built;
      for (let g = 0;g < groupCount; g++) {
        const segFrom = gStart[g];
        const segTo = gStart[g + 1];
        if (segTo <= segFrom)
          continue;
        if (groupTouch[g] > built[g])
          buildGroupSphere(views, g);
        const o4g = g * 4;
        const gr = spheres[o4g + 3];
        let segMask = 63;
        if (gr > 0) {
          const gcx = spheres[o4g], gcy = spheres[o4g + 1], gcz = spheres[o4g + 2];
          let gOutside = false;
          let gInsideAll = true;
          let inter = 0;
          for (let i = 0;i < 6; i++) {
            const o = pb + i * 4;
            planeTests++;
            const d = planes[o] * gcx + planes[o + 1] * gcy + planes[o + 2] * gcz + planes[o + 3];
            if (d < -gr) {
              gOutside = true;
              break;
            }
            if (d < gr) {
              inter |= 1 << i;
              gInsideAll = false;
            }
          }
          if (gOutside) {
            fillBits(bits, base, segFrom, segTo, false);
            tested++;
            trivialRejects++;
            continue;
          }
          if (gInsideAll) {
            fillBits(bits, base, segFrom, segTo, true);
            tested++;
            trivialAccepts++;
            continue;
          }
          segMask = inter;
        }
        if (segMask === 63) {
          for (let r = segFrom;r < segTo; r++) {
            const slot = order[r];
            const o4 = slot * 4;
            const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2];
            const rad = sphereW[o4 + 3];
            let vis = true;
            for (let i = 0;i < 6; i++) {
              const o = pb + i * 4;
              planeTests++;
              if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -rad) {
                vis = false;
                break;
              }
            }
            tested++;
            const w = base + (r >>> 5);
            const bit = 1 << (r & 31);
            if (vis)
              bits[w] |= bit;
            else
              bits[w] &= ~bit;
          }
        } else {
          const t0 = (segMask & 1) !== 0, t1 = (segMask & 2) !== 0, t2 = (segMask & 4) !== 0;
          const t3 = (segMask & 8) !== 0, t4 = (segMask & 16) !== 0, t5 = (segMask & 32) !== 0;
          for (let r = segFrom;r < segTo; r++) {
            const o4 = order[r] * 4;
            const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2];
            const rad = sphereW[o4 + 3];
            let vis = true;
            if (t0) {
              planeTests++;
              if (planes[pb] * cx + planes[pb + 1] * cy + planes[pb + 2] * cz + planes[pb + 3] < -rad)
                vis = false;
            }
            if (vis && t1) {
              planeTests++;
              if (planes[pb + 4] * cx + planes[pb + 5] * cy + planes[pb + 6] * cz + planes[pb + 7] < -rad)
                vis = false;
            }
            if (vis && t2) {
              planeTests++;
              if (planes[pb + 8] * cx + planes[pb + 9] * cy + planes[pb + 10] * cz + planes[pb + 11] < -rad)
                vis = false;
            }
            if (vis && t3) {
              planeTests++;
              if (planes[pb + 12] * cx + planes[pb + 13] * cy + planes[pb + 14] * cz + planes[pb + 15] < -rad)
                vis = false;
            }
            if (vis && t4) {
              planeTests++;
              if (planes[pb + 16] * cx + planes[pb + 17] * cy + planes[pb + 18] * cz + planes[pb + 19] < -rad)
                vis = false;
            }
            if (vis && t5) {
              planeTests++;
              if (planes[pb + 20] * cx + planes[pb + 21] * cy + planes[pb + 22] * cz + planes[pb + 23] < -rad)
                vis = false;
            }
            tested++;
            const w = base + (r >>> 5);
            const bit = 1 << (r & 31);
            if (vis)
              bits[w] |= bit;
            else
              bits[w] &= ~bit;
          }
        }
      }
    } else {
      for (let r = treeN;r < n; r++) {
        const slot = order[r];
        const o4 = slot * 4;
        const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2];
        const rad = sphereW[o4 + 3];
        let vis = true;
        for (let i = 0;i < 6; i++) {
          planeTests++;
          const o = pb + i * 4;
          if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -rad) {
            vis = false;
            break;
          }
        }
        tested++;
        const w = base + (r >>> 5);
        const m = 1 << (r & 31);
        if (vis)
          bits[w] |= m;
        else
          bits[w] &= ~m;
      }
    }
  }
  const visible = countVisible ? popcountBits(bits, base, views.bitsWords) : -1;
  if (cullMemoEnabled) {
    cullMemoSave(views, bufferIndex, cameraIndex, flagByte, tested, visible, trivialRejects, trivialAccepts, planeTests);
  }
  if (out !== undefined) {
    out.tested = tested;
    out.visible = visible;
    out.trivialRejects = trivialRejects;
    out.trivialAccepts = trivialAccepts;
    out.planeTests = planeTests;
    return out;
  }
  return {
    tested,
    visible,
    trivialRejects,
    trivialAccepts,
    planeTests
  };
}
function cullViewsBrute(views, cameraIndex, bufferIndex, out) {
  if (cullMemoEnabled && cullMemoServe(views, bufferIndex, cameraIndex, 0, out)) {
    if (out !== undefined)
      return out;
    return cullMemoStatsOf(views, bufferIndex, cameraIndex);
  }
  const n = views.headerI[H_NODE_COUNT];
  const { order, sphereW, bits, planes } = views;
  const base = bitsBase(views, bufferIndex, cameraIndex);
  const pb = cameraIndex * 24;
  let visible = 0;
  let planeTests = 0;
  for (let r = 0;r < n; r++) {
    const slot = order[r];
    const o4 = slot * 4;
    const cx = sphereW[o4], cy = sphereW[o4 + 1], cz = sphereW[o4 + 2];
    const rad = sphereW[o4 + 3];
    let vis = true;
    for (let i = 0;i < 6; i++) {
      planeTests++;
      const o = pb + i * 4;
      if (planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3] < -rad) {
        vis = false;
        break;
      }
    }
    const w = base + (r >>> 5);
    const m = 1 << (r & 31);
    if (vis) {
      bits[w] |= m;
      visible++;
    } else {
      bits[w] &= ~m;
    }
  }
  if (cullMemoEnabled) {
    cullMemoSave(views, bufferIndex, cameraIndex, 0, n, visible, 0, 0, planeTests);
  }
  if (out !== undefined) {
    out.tested = n;
    out.visible = visible;
    out.trivialRejects = 0;
    out.trivialAccepts = 0;
    out.planeTests = planeTests;
    return out;
  }
  return { tested: n, visible, trivialRejects: 0, trivialAccepts: 0, planeTests };
}
function rankNodeVisible(views, rank) {
  const slot = views.order[rank];
  return slot >= 0 && (views.nodeFlags[slot] & NF_VISIBLE) !== 0;
}

// packages/scene/src/instances.ts
var segmentScans = 0;
var blockCopies = 0;
var popcounts = 0;
function tailCounters() {
  return { scans: segmentScans, blocks: blockCopies, popcounts };
}
function popcountRange(bits, base, s, e) {
  const sWord = s >>> 5;
  const eWord = e - 1 >>> 5;
  const sOff = s & 31;
  const eOff = e & 31;
  let count = 0;
  for (let w = sWord;w <= eWord; w++) {
    let v = bits[base + w];
    if (w === sWord && sOff !== 0)
      v &= -1 << sOff;
    if (w === eWord && eOff !== 0)
      v &= (1 << eOff) - 1;
    if (v === 0)
      continue;
    v = v - (v >>> 1 & 1431655765);
    v = (v & 858993459) + (v >>> 2 & 858993459);
    v = v + (v >>> 4) & 252645135;
    count += v * 16843009 >>> 24;
  }
  return count;
}
function allBitsSet(bits, base, s, e) {
  const sWord = s >>> 5;
  const eWord = e - 1 >>> 5;
  const sOff = s & 31;
  const eOff = e & 31;
  const headMask = sOff === 0 ? -1 : -1 << sOff;
  const tailMask = eOff === 0 ? -1 : (1 << eOff) - 1;
  for (let w = sWord;w <= eWord; w++) {
    const m = w === sWord ? sWord === eWord ? headMask & tailMask : headMask : w === eWord ? tailMask : -1;
    if ((bits[base + w] & m) !== m)
      return false;
  }
  return true;
}
var collectMemoEnabled = true;
var collectMemoHits = 0;
var collectMemoMisses = 0;
var collectMemos = new WeakMap;
function collectMemoFor(views) {
  let memo = collectMemos.get(views);
  if (memo === undefined) {
    const slots = 2 * views.cameraMax;
    memo = {
      clock: new Int32Array(slots).fill(-1),
      total: new Int32Array(slots)
    };
    collectMemos.set(views, memo);
  }
  return memo;
}
function setCollectMemo(enabled) {
  collectMemoEnabled = enabled;
}
function collectMemoCounters() {
  return { hits: collectMemoHits, misses: collectMemoMisses };
}
var groupSphereEnabled = true;
var prejectRejects = 0;
var prejectChecks = 0;
function setGroupSphereReject(enabled) {
  groupSphereEnabled = enabled;
}
function groupSphereCounters() {
  return { rejects: prejectRejects, checks: prejectChecks, builds: groupSphereBuildCount() };
}
function groupSphereReject(views, cameraIndex, groupId) {
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
  if (groupId < 0 || groupId >= groupCount)
    return false;
  const { groupTouch, planes } = views;
  const state = groupSpheresFor(views);
  if (groupTouch[groupId] > state.built[groupId])
    buildGroupSphere(views, groupId);
  prejectChecks++;
  const o4 = groupId * 4;
  const r = state.spheres[o4 + 3];
  if (r <= 0)
    return false;
  const pb = cameraIndex * 24;
  const cx = state.spheres[o4], cy = state.spheres[o4 + 1], cz = state.spheres[o4 + 2];
  for (let i = 0;i < 6; i++) {
    const p = pb + i * 4;
    if (planes[p] * cx + planes[p + 1] * cy + planes[p + 2] * cz + planes[p + 3] < -r)
      return true;
  }
  return false;
}
var cursors = new Int32Array(64);
function instBase(views, bufferIndex, cameraIndex) {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.groupMax;
}
function instancePoolBase(views, bufferIndex, cameraIndex) {
  return (bufferIndex * views.cameraMax + cameraIndex) * views.headerI[H_MAX_INSTANCES] * 16;
}
function collectInstancesViews(views, cameraIndex, bufferIndex) {
  const n = views.headerI[H_NODE_COUNT];
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
  const maxInstances = views.headerI[H_MAX_INSTANCES];
  const { order, group, instPool, instCounts, instOffsets, bits, groupTouch, groupFlip, headerI, headerU } = views;
  const bitsBaseV = bitsBase(views, bufferIndex, cameraIndex);
  const countsBase = instBase(views, bufferIndex, cameraIndex);
  const offsetsBase = countsBase;
  const pool = instancePoolBase(views, bufferIndex, cameraIndex);
  const words = views.bitsWords;
  if (cursors.length < groupCount)
    cursors = new Int32Array(groupCount);
  const flipBase = cameraIndex * views.groupMax;
  if (headerI[H_COLLECT_LAYOUT_EPOCH] !== headerI[H_LAYOUT_EPOCH]) {
    headerI[H_COLLECT_LAYOUT_EPOCH] = headerI[H_LAYOUT_EPOCH];
    const stamp = headerU[H_CLOCK] + 1;
    for (let c = 0;c < views.cameraMax; c++) {
      const fb = c * views.groupMax;
      for (let g = 0;g < groupCount; g++)
        groupFlip[fb + g] = stamp;
    }
    for (let g = 0;g < groupCount; g++)
      groupTouch[g] = stamp;
    headerU[H_CLOCK] = stamp;
  } else {
    const prevBase = bitsBase(views, bufferIndex ^ 1, cameraIndex);
    const stamp = headerU[H_CLOCK] + 1;
    let touched = false;
    for (let w = 0;w < words; w++) {
      const cur = bits[bitsBaseV + w];
      const prev = bits[prevBase + w];
      if (cur === prev)
        continue;
      let flips = cur ^ prev;
      const rBase = w << 5;
      while (flips !== 0) {
        const lb = flips & -flips;
        flips ^= lb;
        const r = rBase + 31 - Math.clz32(lb);
        if (r >= n)
          break;
        const g = group[order[r]];
        if (g >= 0 && g < groupCount) {
          groupFlip[flipBase + g] = stamp;
          touched = true;
        }
      }
    }
    if (touched)
      headerU[H_CLOCK] = stamp;
  }
  const memoIdx = bufferIndex * views.cameraMax + cameraIndex;
  const memo = collectMemoEnabled ? collectMemoFor(views) : undefined;
  const memoClock = memo !== undefined ? memo.clock[memoIdx] : 0;
  if (memo !== undefined && memoClock === headerU[H_CLOCK]) {
    collectMemoHits++;
    const cached = memo.total[memoIdx];
    return cached !== undefined ? cached : 0;
  }
  for (let g = 0;g < groupCount; g++)
    instCounts[countsBase + g] = 0;
  const nodeFlags = views.nodeFlags;
  const world = views.world;
  let total = 0;
  if (tailLayoutOn()) {
    for (let g = 0;g < groupCount; g++) {
      cursors[g] = 0;
      const gs = views.gStart[g];
      const ge = views.gStart[g + 1];
      if (gs >= ge)
        continue;
      let count;
      if (views.gHidden[g] === 0) {
        count = popcountRange(bits, bitsBaseV, gs, ge);
        popcounts++;
      } else {
        count = 0;
        for (let w = gs >>> 5;w <= ge - 1 >>> 5; w++) {
          const word = bits[bitsBaseV + w];
          if (word === 0)
            continue;
          const rLo = Math.max(w << 5, gs);
          const rHi = Math.min((w << 5) + 32, ge);
          for (let r = rLo;r < rHi; r++) {
            if ((word & 1 << (r & 31)) === 0)
              continue;
            if ((nodeFlags[views.order[r]] & NF_VISIBLE) !== 0)
              count++;
          }
        }
      }
      instCounts[countsBase + g] = count;
      total += count;
    }
  } else {
    for (let w = 0;w < words; w++) {
      let word = bits[bitsBaseV + w];
      if (word === 0)
        continue;
      const rBase = w << 5;
      while (word !== 0) {
        const lb = word & -word;
        word ^= lb;
        const r = rBase + 31 - Math.clz32(lb);
        if (r >= n)
          break;
        const slot = order[r];
        const g = group[slot];
        if (g < 0 || g >= groupCount)
          continue;
        if ((nodeFlags[slot] & NF_VISIBLE) !== 0)
          instCounts[countsBase + g]++;
      }
    }
    for (let g = 0;g < groupCount; g++)
      total += instCounts[countsBase + g];
  }
  total = 0;
  for (let g = 0;g < groupCount; g++) {
    instOffsets[offsetsBase + g] = total;
    cursors[g] = 0;
    total += instCounts[countsBase + g];
  }
  let dropped = 0;
  if (tailLayoutOn()) {
    for (let g = 0;g < groupCount; g++) {
      const gs = views.gStart[g];
      const ge = views.gStart[g + 1];
      const count = instCounts[countsBase + g];
      if (count === 0)
        continue;
      const off = instOffsets[offsetsBase + g];
      const segLen = ge - gs;
      const hidden = views.gHidden[g];
      if (hidden === 0 && count === segLen && off + segLen <= maxInstances && allBitsSet(bits, bitsBaseV, gs, ge)) {
        instPool.set(world.subarray(gs * 16, ge * 16), pool + off * 16);
        cursors[g] = segLen;
        blockCopies++;
        continue;
      }
      for (let w = gs >>> 5;w <= ge - 1 >>> 5; w++) {
        const word = bits[bitsBaseV + w];
        if (word === 0)
          continue;
        const rLo = Math.max(w << 5, gs);
        const rHi = Math.min((w << 5) + 32, ge);
        for (let r = rLo;r < rHi; r++) {
          if ((word & 1 << (r & 31)) === 0)
            continue;
          if (hidden > 0 && (nodeFlags[views.order[r]] & NF_VISIBLE) === 0)
            continue;
          const dst = off + cursors[g];
          if (dst >= maxInstances) {
            dropped++;
            continue;
          }
          cursors[g]++;
          const src = r * 16;
          const o = pool + dst * 16;
          instPool[o] = world[src];
          instPool[o + 1] = world[src + 1];
          instPool[o + 2] = world[src + 2];
          instPool[o + 3] = world[src + 3];
          instPool[o + 4] = world[src + 4];
          instPool[o + 5] = world[src + 5];
          instPool[o + 6] = world[src + 6];
          instPool[o + 7] = world[src + 7];
          instPool[o + 8] = world[src + 8];
          instPool[o + 9] = world[src + 9];
          instPool[o + 10] = world[src + 10];
          instPool[o + 11] = world[src + 11];
          instPool[o + 12] = world[src + 12];
          instPool[o + 13] = world[src + 13];
          instPool[o + 14] = world[src + 14];
          instPool[o + 15] = world[src + 15];
        }
      }
    }
    segmentScans++;
  } else {
    for (let w = 0;w < words; w++) {
      let word = bits[bitsBaseV + w];
      if (word === 0)
        continue;
      const rBase = w << 5;
      while (word !== 0) {
        const lb = word & -word;
        word ^= lb;
        const r = rBase + 31 - Math.clz32(lb);
        if (r >= n)
          break;
        const slot = order[r];
        const g = group[slot];
        if (g < 0 || g >= groupCount)
          continue;
        if ((nodeFlags[slot] & NF_VISIBLE) === 0)
          continue;
        const dst = instOffsets[offsetsBase + g] + cursors[g];
        if (dst >= maxInstances) {
          dropped++;
          continue;
        }
        cursors[g]++;
        const src = r * 16;
        const o = pool + dst * 16;
        instPool[o] = world[src];
        instPool[o + 1] = world[src + 1];
        instPool[o + 2] = world[src + 2];
        instPool[o + 3] = world[src + 3];
        instPool[o + 4] = world[src + 4];
        instPool[o + 5] = world[src + 5];
        instPool[o + 6] = world[src + 6];
        instPool[o + 7] = world[src + 7];
        instPool[o + 8] = world[src + 8];
        instPool[o + 9] = world[src + 9];
        instPool[o + 10] = world[src + 10];
        instPool[o + 11] = world[src + 11];
        instPool[o + 12] = world[src + 12];
        instPool[o + 13] = world[src + 13];
        instPool[o + 14] = world[src + 14];
        instPool[o + 15] = world[src + 15];
      }
    }
  }
  if (dropped > 0)
    views.headerI[H_DROPPED_INSTANCES] += dropped;
  const collected = total - dropped;
  if (collectMemoEnabled && memo !== undefined) {
    memo.clock[memoIdx] = headerU[H_CLOCK];
    memo.total[memoIdx] = collected;
    collectMemoMisses++;
  }
  return collected;
}
function instanceMatricesView(views, bufferIndex, cameraIndex, group) {
  const base = instBase(views, bufferIndex, cameraIndex);
  const count = Math.max(0, views.instCounts[base + group]);
  const offset = views.instOffsets[base + group];
  const pool = instancePoolBase(views, bufferIndex, cameraIndex);
  return {
    matrices: views.instPool.subarray(pool + offset * 16, pool + (offset + count) * 16),
    count
  };
}
function collectGroupMatrices(views, cameraIndex, bufferIndex, groupId, out) {
  const n = views.headerI[H_NODE_COUNT];
  const { order, group, world, bits, nodeFlags } = views;
  const base = bitsBase(views, bufferIndex, cameraIndex);
  const capacity = out.length >>> 4;
  const wEnd = Math.min(views.bitsWords, n + 31 >>> 5);
  if (groupSphereEnabled && groupSphereReject(views, cameraIndex, groupId)) {
    prejectRejects++;
    return 0;
  }
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
  if (tailLayoutOn() && groupId >= 0 && groupId < groupCount) {
    const gs = views.gStart[groupId];
    const ge = views.gStart[groupId + 1];
    if (gs >= ge)
      return 0;
    const hidden = views.gHidden[groupId];
    if (hidden === 0 && allBitsSet(bits, base, gs, ge)) {
      const k3 = Math.min(ge - gs, capacity);
      out.set(world.subarray(gs * 16, (gs + k3) * 16));
      blockCopies++;
      return k3;
    }
    let k2 = 0;
    scan:
      for (let w = gs >>> 5;w <= ge - 1 >>> 5; w++) {
        const word = bits[base + w];
        if (word === 0)
          continue;
        const rLo = Math.max(w << 5, gs);
        const rHi = Math.min((w << 5) + 32, ge);
        for (let r = rLo;r < rHi; r++) {
          if ((word & 1 << (r & 31)) === 0)
            continue;
          if (hidden > 0) {
            if ((nodeFlags[order[r]] & NF_VISIBLE) === 0)
              continue;
          }
          if (k2 >= capacity)
            break scan;
          const src = r * 16;
          const dst = k2 * 16;
          out[dst] = world[src];
          out[dst + 1] = world[src + 1];
          out[dst + 2] = world[src + 2];
          out[dst + 3] = world[src + 3];
          out[dst + 4] = world[src + 4];
          out[dst + 5] = world[src + 5];
          out[dst + 6] = world[src + 6];
          out[dst + 7] = world[src + 7];
          out[dst + 8] = world[src + 8];
          out[dst + 9] = world[src + 9];
          out[dst + 10] = world[src + 10];
          out[dst + 11] = world[src + 11];
          out[dst + 12] = world[src + 12];
          out[dst + 13] = world[src + 13];
          out[dst + 14] = world[src + 14];
          out[dst + 15] = world[src + 15];
          k2++;
        }
      }
    segmentScans++;
    return k2;
  }
  let k = 0;
  scan:
    for (let w = 0;w < wEnd; w++) {
      const word = bits[base + w];
      if (word === 0)
        continue;
      const rEnd = Math.min((w << 5) + 32, n);
      for (let r = w << 5;r < rEnd; r++) {
        if ((word & 1 << (r & 31)) === 0)
          continue;
        const slot = order[r];
        if (group[slot] !== groupId)
          continue;
        if ((nodeFlags[slot] & NF_VISIBLE) === 0)
          continue;
        if (k >= capacity)
          break scan;
        const src = r * 16;
        const dst = k * 16;
        out[dst] = world[src];
        out[dst + 1] = world[src + 1];
        out[dst + 2] = world[src + 2];
        out[dst + 3] = world[src + 3];
        out[dst + 4] = world[src + 4];
        out[dst + 5] = world[src + 5];
        out[dst + 6] = world[src + 6];
        out[dst + 7] = world[src + 7];
        out[dst + 8] = world[src + 8];
        out[dst + 9] = world[src + 9];
        out[dst + 10] = world[src + 10];
        out[dst + 11] = world[src + 11];
        out[dst + 12] = world[src + 12];
        out[dst + 13] = world[src + 13];
        out[dst + 14] = world[src + 14];
        out[dst + 15] = world[src + 15];
        k++;
      }
    }
  return k;
}
function gpuInstanceSource(views, cameraIndex, bufferIndex, groupId) {
  const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
  const base = bitsBase(views, bufferIndex, cameraIndex);
  if (groupId < 0 || groupId >= groupCount || !tailLayoutOn()) {
    return {
      matrices: views.world.subarray(0, 0),
      instances: 0,
      bits: views.bits.subarray(base, base),
      rankBase: 0,
      gHidden: 0
    };
  }
  const gs = views.gStart[groupId];
  const ge = views.gStart[groupId + 1];
  return {
    matrices: views.world.subarray(gs * 16, ge * 16),
    instances: ge - gs,
    bits: views.bits.subarray(base, base + views.bitsWords),
    rankBase: gs,
    gHidden: views.gHidden[groupId]
  };
}
var INSTANCE_BIT_FILTER_WGSL = `
/** rune: the visibility bit filter (Task 193 theory A — bit-discard).
 * ii = @builtin(instance_index); u_rank0 = the segment's first rank.
 * false -> collapse the instance to clip in the vertex shader. */
fn runeInstanceVisible(u_rank0: u32, ii: u32) -> bool {
  let rank = u_rank0 + ii
  let word = sceneBits[rank >> 5u]
  return (word & (1u << (rank & 31u))) != 0u
}`;

// packages/scene/src/transforms.ts
function markDirtyUp(views, slot) {
  const { parent, dirtyBounds } = views;
  let a = slot;
  while (a >= 0) {
    const w = a >>> 5;
    const m = 1 << (a & 31);
    if ((dirtyBounds[w] & m) !== 0)
      break;
    dirtyBounds[w] |= m;
    a = parent[a];
  }
}
function touchGroup(views, group, stamp) {
  if (group >= 0 && group < views.groupMax)
    views.groupTouch[group] = stamp;
}
function bumpClock(views) {
  const next = views.headerU[H_CLOCK] + 1 >>> 0;
  views.headerU[H_CLOCK] = next;
  return next;
}
var scratch = new Float32Array(16);
var refitStack = new Int32Array(8192);
function pushRefit(s, e, phase, sp) {
  if (sp + 3 > refitStack.length) {
    const grown = new Int32Array(refitStack.length * 2);
    grown.set(refitStack);
    refitStack = grown;
  }
  refitStack[sp] = s;
  refitStack[sp + 1] = e;
  refitStack[sp + 2] = phase;
  return sp + 3;
}
function composeAt(out, o, qx, qy, qz, qw, tx, ty, tz, sx, sy, sz) {
  const x = qx, y = qy, z = qz, w = qw;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[o] = (1 - (yy + zz)) * sx;
  out[o + 1] = (xy + wz) * sx;
  out[o + 2] = (xz - wy) * sx;
  out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy;
  out[o + 5] = (1 - (xx + zz)) * sy;
  out[o + 6] = (yz + wx) * sy;
  out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz;
  out[o + 9] = (yz - wx) * sz;
  out[o + 10] = (1 - (xx + yy)) * sz;
  out[o + 11] = 0;
  out[o + 12] = tx;
  out[o + 13] = ty;
  out[o + 14] = tz;
  out[o + 15] = 1;
}
function mulAffineAt(out, o, a, aBase, b, bBase) {
  const l0 = a[aBase], l1 = a[aBase + 1], l2 = a[aBase + 2];
  const l4 = a[aBase + 4], l5 = a[aBase + 5], l6 = a[aBase + 6];
  const l8 = a[aBase + 8], l9 = a[aBase + 9], l10 = a[aBase + 10];
  const l12 = a[aBase + 12], l13 = a[aBase + 13], l14 = a[aBase + 14];
  out[o] = l0 * b[bBase] + l4 * b[bBase + 1] + l8 * b[bBase + 2];
  out[o + 1] = l1 * b[bBase] + l5 * b[bBase + 1] + l9 * b[bBase + 2];
  out[o + 2] = l2 * b[bBase] + l6 * b[bBase + 1] + l10 * b[bBase + 2];
  out[o + 3] = 0;
  out[o + 4] = l0 * b[bBase + 4] + l4 * b[bBase + 5] + l8 * b[bBase + 6];
  out[o + 5] = l1 * b[bBase + 4] + l5 * b[bBase + 5] + l9 * b[bBase + 6];
  out[o + 6] = l2 * b[bBase + 4] + l6 * b[bBase + 5] + l10 * b[bBase + 6];
  out[o + 7] = 0;
  out[o + 8] = l0 * b[bBase + 8] + l4 * b[bBase + 9] + l8 * b[bBase + 10];
  out[o + 9] = l1 * b[bBase + 8] + l5 * b[bBase + 9] + l9 * b[bBase + 10];
  out[o + 10] = l2 * b[bBase + 8] + l6 * b[bBase + 9] + l10 * b[bBase + 10];
  out[o + 11] = 0;
  out[o + 12] = l0 * b[bBase + 12] + l4 * b[bBase + 13] + l8 * b[bBase + 14] + l12;
  out[o + 13] = l1 * b[bBase + 12] + l5 * b[bBase + 13] + l9 * b[bBase + 14] + l13;
  out[o + 14] = l2 * b[bBase + 12] + l6 * b[bBase + 13] + l10 * b[bBase + 14] + l14;
  out[o + 15] = 1;
}
function sphereWorldAt(views, slot, rank) {
  const w = views.world;
  const w16 = rank * 16;
  const s = views.sphereL;
  const s4 = slot * 4;
  const cx = s[s4], cy = s[s4 + 1], cz = s[s4 + 2], r = s[s4 + 3];
  const out = views.sphereW;
  const o4 = slot * 4;
  out[o4] = w[w16] * cx + w[w16 + 4] * cy + w[w16 + 8] * cz + w[w16 + 12];
  out[o4 + 1] = w[w16 + 1] * cx + w[w16 + 5] * cy + w[w16 + 9] * cz + w[w16 + 13];
  out[o4 + 2] = w[w16 + 2] * cx + w[w16 + 6] * cy + w[w16 + 10] * cz + w[w16 + 14];
  if (r <= 0) {
    out[o4 + 3] = 0;
    return;
  }
  const c0x = w[w16], c0y = w[w16 + 1], c0z = w[w16 + 2];
  const c1x = w[w16 + 4], c1y = w[w16 + 5], c1z = w[w16 + 6];
  const c2x = w[w16 + 8], c2y = w[w16 + 9], c2z = w[w16 + 10];
  const l0 = Math.sqrt(c0x * c0x + c0y * c0y + c0z * c0z);
  const l1 = Math.sqrt(c1x * c1x + c1y * c1y + c1z * c1z);
  const l2 = Math.sqrt(c2x * c2x + c2y * c2y + c2z * c2z);
  const maxScale = l0 > l1 ? l0 > l2 ? l0 : l2 : l1 > l2 ? l1 : l2;
  out[o4 + 3] = r * maxScale;
}
function updateWorldViews(views) {
  const n = views.headerI[H_NODE_COUNT];
  const { order, parent, pos, quat, scale, world, localStamp, worldStamp, headerU, group, rankOf } = views;
  let clock = headerU[H_CLOCK];
  let recomputed = 0;
  for (let r = 0;r < n; r++) {
    const i = order[r];
    const ws = worldStamp[i];
    const p = parent[i];
    if (localStamp[i] <= ws && (p < 0 || worldStamp[p] <= ws))
      continue;
    const i3 = i * 3;
    const i4 = i * 4;
    const r16 = r * 16;
    if (p < 0) {
      composeAt(world, r16, quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3], pos[i3], pos[i3 + 1], pos[i3 + 2], scale[i3], scale[i3 + 1], scale[i3 + 2]);
    } else {
      composeAt(scratch, 0, quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3], pos[i3], pos[i3 + 1], pos[i3 + 2], scale[i3], scale[i3 + 1], scale[i3 + 2]);
      mulAffineAt(world, r16, world, rankOf[p] * 16, scratch, 0);
    }
    sphereWorldAt(views, i, r);
    clock++;
    worldStamp[i] = clock;
    markDirtyUp(views, i);
    touchGroup(views, group[i], clock);
    recomputed++;
  }
  headerU[H_CLOCK] = clock;
  return recomputed;
}
function updateWorldForcedViews(views) {
  const n = views.headerI[H_NODE_COUNT];
  const { order, parent, pos, quat, scale, world, worldStamp, headerU, rankOf } = views;
  let clock = headerU[H_CLOCK];
  for (let r = 0;r < n; r++) {
    const i = order[r];
    const p = parent[i];
    const i3 = i * 3;
    const i4 = i * 4;
    const r16 = r * 16;
    if (p < 0) {
      composeAt(world, r16, quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3], pos[i3], pos[i3 + 1], pos[i3 + 2], scale[i3], scale[i3 + 1], scale[i3 + 2]);
    } else {
      composeAt(scratch, 0, quat[i4], quat[i4 + 1], quat[i4 + 2], quat[i4 + 3], pos[i3], pos[i3 + 1], pos[i3 + 2], scale[i3], scale[i3 + 1], scale[i3 + 2]);
      mulAffineAt(world, r16, world, rankOf[p] * 16, scratch, 0);
    }
    sphereWorldAt(views, i, r);
    clock++;
    worldStamp[i] = clock;
  }
  headerU[H_CLOCK] = clock;
  views.dirtyBounds.fill(4294967295);
  const groupsAll = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
  for (let g = 0;g < groupsAll; g++)
    views.groupTouch[g] = clock;
  return n;
}
function refitGroupBoundsViews(views) {
  const { order, parent, subtreeEnd, sphereL, sphereW, dirtyBounds, group } = views;
  const treeN = views.gStart[0];
  let sp = 0;
  for (let r = 0;r < treeN; ) {
    const slot = order[r];
    const end = subtreeEnd[slot];
    if (parent[slot] < 0) {
      sp = pushRefit(r, end, 0, sp);
      r = end;
    } else {
      r++;
    }
  }
  let refit = 0;
  while (sp > 0) {
    sp -= 3;
    const s = refitStack[sp];
    const e = refitStack[sp + 1];
    const phase = refitStack[sp + 2];
    const i = order[s];
    const w = i >>> 5;
    const m = 1 << (i & 31);
    if (phase === 0) {
      if ((dirtyBounds[w] & m) === 0)
        continue;
      dirtyBounds[w] &= ~m;
      if (e <= s + 1 && views.firstChild[i] < 0)
        continue;
      if (sphereL[i * 4 + 3] <= 0)
        sp = pushRefit(s, e, 1, sp);
      let cr = s + 1;
      while (cr < e) {
        const child = order[cr];
        const childEnd = subtreeEnd[child];
        const end = childEnd > cr ? childEnd : cr + 1;
        sp = pushRefit(cr, end, 0, sp);
        cr = end;
      }
      continue;
    }
    const { firstChild: fcList, nextSibling: nsList } = views;
    let minx = 0, miny = 0, minz = 0, maxx = 0, maxy = 0, maxz = 0;
    let child2 = fcList[i];
    let first = true;
    let singleChild = -1;
    let childCount = 0;
    while (child2 >= 0) {
      const c4 = child2 * 4;
      const cx = sphereW[c4], cy = sphereW[c4 + 1], cz = sphereW[c4 + 2];
      const cr = sphereW[c4 + 3];
      if (first) {
        minx = cx - cr;
        maxx = cx + cr;
        miny = cy - cr;
        maxy = cy + cr;
        minz = cz - cr;
        maxz = cz + cr;
        first = false;
      } else {
        if (cx - cr < minx)
          minx = cx - cr;
        if (cx + cr > maxx)
          maxx = cx + cr;
        if (cy - cr < miny)
          miny = cy - cr;
        if (cy + cr > maxy)
          maxy = cy + cr;
        if (cz - cr < minz)
          minz = cz - cr;
        if (cz + cr > maxz)
          maxz = cz + cr;
      }
      childCount++;
      singleChild = child2;
      child2 = nsList[child2];
    }
    if (first)
      continue;
    const g = group[i];
    if (g >= 0 && g < views.groupMax)
      touchGroup(views, g, bumpClock(views));
    const o4 = i * 4;
    if (childCount === 1) {
      const c4 = singleChild * 4;
      sphereW[o4] = sphereW[c4];
      sphereW[o4 + 1] = sphereW[c4 + 1];
      sphereW[o4 + 2] = sphereW[c4 + 2];
      sphereW[o4 + 3] = sphereW[c4 + 3];
      refit++;
      continue;
    }
    sphereW[o4] = (minx + maxx) * 0.5;
    sphereW[o4 + 1] = (miny + maxy) * 0.5;
    sphereW[o4 + 2] = (minz + maxz) * 0.5;
    sphereW[o4 + 3] = 0.5 * Math.sqrt((maxx - minx) * (maxx - minx) + (maxy - miny) * (maxy - miny) + (maxz - minz) * (maxz - minz));
    refit++;
  }
  if (refit > 0)
    views.headerU[H_CLOCK] = views.headerU[H_CLOCK] + 1 >>> 0;
  return refit;
}
function refitGroupBoundsForcedViews(views) {
  const n = views.headerI[H_NODE_COUNT];
  const { order, subtreeEnd, sphereL, sphereW, firstChild, nextSibling } = views;
  let refit = 0;
  for (let r = n - 1;r >= 0; r--) {
    const i = order[r];
    const e = subtreeEnd[i];
    if (e <= r + 1 && firstChild[i] < 0)
      continue;
    if (sphereL[i * 4 + 3] > 0)
      continue;
    let minx = 0, miny = 0, minz = 0, maxx = 0, maxy = 0, maxz = 0;
    let child = firstChild[i];
    let first = true;
    let singleChild = -1;
    let childCount = 0;
    while (child >= 0) {
      const c4 = child * 4;
      const cx = sphereW[c4], cy = sphereW[c4 + 1], cz = sphereW[c4 + 2];
      const cr = sphereW[c4 + 3];
      if (first) {
        minx = cx - cr;
        maxx = cx + cr;
        miny = cy - cr;
        maxy = cy + cr;
        minz = cz - cr;
        maxz = cz + cr;
        first = false;
      } else {
        if (cx - cr < minx)
          minx = cx - cr;
        if (cx + cr > maxx)
          maxx = cx + cr;
        if (cy - cr < miny)
          miny = cy - cr;
        if (cy + cr > maxy)
          maxy = cy + cr;
        if (cz - cr < minz)
          minz = cz - cr;
        if (cz + cr > maxz)
          maxz = cz + cr;
      }
      childCount++;
      singleChild = child;
      child = nextSibling[child];
    }
    if (first)
      continue;
    const o4 = i * 4;
    if (childCount === 1) {
      const c4 = singleChild * 4;
      sphereW[o4] = sphereW[c4];
      sphereW[o4 + 1] = sphereW[c4 + 1];
      sphereW[o4 + 2] = sphereW[c4 + 2];
      sphereW[o4 + 3] = sphereW[c4 + 3];
      refit++;
      continue;
    }
    sphereW[o4] = (minx + maxx) * 0.5;
    sphereW[o4 + 1] = (miny + maxy) * 0.5;
    sphereW[o4 + 2] = (minz + maxz) * 0.5;
    sphereW[o4 + 3] = 0.5 * Math.sqrt((maxx - minx) * (maxx - minx) + (maxy - miny) * (maxy - miny) + (maxz - minz) * (maxz - minz));
    refit++;
  }
  views.dirtyBounds.fill(0);
  views.headerU[H_CLOCK] = views.headerU[H_CLOCK] + 1 >>> 0;
  const groupsAll = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
  for (let g = 0;g < groupsAll; g++)
    views.groupTouch[g] = views.headerU[H_CLOCK];
  return refit;
}

// packages/scene/src/scene.ts
function createScene(options = {}) {
  const buffer = createSceneBuffer(options);
  return createSceneFromBuffer(buffer);
}
function createSceneFromBuffer(buffer) {
  const views = buildSceneViews(buffer);
  const freeList = freeListWord(views);
  const fullWords = new Int32Array(buffer);
  const shared = typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
  let layoutDirty = true;
  let cullReuseStats = null;
  let cullReuseViews = null;
  let cullReuseResult = null;
  let autoEpoch = 0;
  const autoBufferIndex = () => autoEpoch === 0 ? 0 : autoEpoch - 1 & 1;
  function ensurePacked() {
    if (layoutDirty)
      packInternal();
  }
  function packInternal() {
    const { parent, firstChild, nextSibling, order, subtreeEnd, nodeFlags, headerI, group, rankOf, world, worldStamp, gStart, gHidden } = views;
    const n = views.headerI[H_NODE_COUNT];
    const groupCount = Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
    let stack = packStack;
    if (stack.length < n + 1) {
      stack = packStack = new Int32Array(Math.max(64, (n + 1) * 2));
    }
    let sp = 0;
    let rank = 0;
    const capacity = views.capacity;
    for (let slot = capacity - 1;slot >= 0; slot--) {
      if ((nodeFlags[slot] & NF_ALIVE) !== 0 && parent[slot] < 0) {
        stack[sp++] = slot;
      }
    }
    while (sp > 0) {
      const slot = stack[--sp];
      order[rank] = slot;
      subtreeEnd[slot] = rank + 1;
      rank++;
      if (rank > n)
        break;
      let c = firstChild[slot];
      while (c >= 0) {
        if (sp >= stack.length) {
          const grown = new Int32Array(stack.length * 2);
          grown.set(stack);
          stack = packStack = grown;
        }
        stack[sp++] = c;
        c = nextSibling[c];
      }
    }
    let treeN = n;
    if (tailLayoutOn()) {
      let order2 = packOrder2;
      if (order2.length < n)
        order2 = packOrder2 = new Int32Array(Math.max(64, n * 2));
      let cursor = packCursor;
      if (cursor.length < groupCount + 1)
        cursor = packCursor = new Int32Array(Math.max(8, (groupCount + 1) * 2));
      cursor.fill(0, 0, groupCount + 1);
      for (let r = 0;r < n; r++) {
        const slot = order[r];
        const g = group[slot];
        if (g >= 0 && g < groupCount && firstChild[slot] < 0)
          cursor[g]++;
      }
      let tailTotal = 0;
      for (let g = 0;g < groupCount; g++)
        tailTotal += cursor[g];
      treeN = n - tailTotal;
      let acc = treeN;
      for (let g = 0;g < groupCount; g++) {
        const start = acc;
        acc += cursor[g];
        cursor[g] = start;
        gStart[g] = start;
      }
      gStart[groupCount] = acc;
      for (let g = 0;g < groupCount; g++)
        gHidden[g] = 0;
      let t = 0;
      for (let r = 0;r < n; r++) {
        const slot = order[r];
        const g = group[slot];
        if (g >= 0 && g < groupCount && firstChild[slot] < 0) {
          order2[cursor[g]++] = slot;
          if ((nodeFlags[slot] & NF_VISIBLE) === 0)
            gHidden[g]++;
        } else {
          order2[t++] = slot;
        }
      }
      order.set(order2.subarray(0, n));
    } else {
      for (let g = 0;g <= groupCount; g++)
        gStart[g] = n;
      for (let g = 0;g < groupCount; g++)
        gHidden[g] = 0;
    }
    for (let r = 0;r < n; r++)
      subtreeEnd[order[r]] = r + 1;
    for (let r = n - 1;r >= 0; r--) {
      const slot = order[r];
      const g = group[slot];
      if (treeN < n && g >= 0 && g < groupCount && firstChild[slot] < 0)
        continue;
      const p = parent[slot];
      if (p >= 0 && subtreeEnd[slot] > subtreeEnd[p])
        subtreeEnd[p] = subtreeEnd[slot];
    }
    let w2 = packWorld;
    if (w2.length < n * 16)
      w2 = packWorld = new Float32Array(Math.max(1024 * 16, n * 32));
    for (let r = 0;r < n; r++) {
      const slot = order[r];
      const d = r * 16;
      if (worldStamp[slot] === 0) {
        for (let k = 0;k < 16; k++)
          w2[d + k] = 0;
        w2[d] = 1;
        w2[d + 5] = 1;
        w2[d + 10] = 1;
        w2[d + 15] = 1;
      } else {
        const s = rankOf[slot] * 16;
        for (let k = 0;k < 16; k++)
          w2[d + k] = world[s + k];
      }
    }
    world.set(w2.subarray(0, n * 16));
    for (let r = 0;r < n; r++)
      rankOf[order[r]] = r;
    headerI[H_LAYOUT_EPOCH] = headerI[H_LAYOUT_EPOCH] + 1 | 0;
    layoutDirty = false;
  }
  function takeSlot() {
    const head = fullWords[freeList];
    if (!(head >= 0)) {
      throw new Error(`scene: no free slots (capacity=${views.capacity})`);
    }
    fullWords[freeList] = views.nextSibling[head];
    fullWords[freeList + 1] -= 1;
    return head;
  }
  function releaseSlot(slot) {
    views.nextSibling[slot] = fullWords[freeList];
    views.prevSibling[slot] = -1;
    fullWords[freeList] = slot;
    fullWords[freeList + 1] += 1;
  }
  function detach(slot) {
    const { parent, firstChild, nextSibling, prevSibling } = views;
    const p = parent[slot];
    if (p < 0)
      return;
    if (firstChild[p] === slot) {
      firstChild[p] = nextSibling[slot];
      if (nextSibling[slot] >= 0)
        prevSibling[nextSibling[slot]] = -1;
    } else {
      const prev = prevSibling[slot];
      const next = nextSibling[slot];
      if (prev >= 0)
        nextSibling[prev] = next;
      if (next >= 0)
        prevSibling[next] = prev;
    }
    parent[slot] = -1;
    nextSibling[slot] = -1;
    prevSibling[slot] = -1;
  }
  function attach(slot, parentSlot) {
    const { parent, firstChild, nextSibling, prevSibling } = views;
    const old = firstChild[parentSlot];
    nextSibling[slot] = old;
    prevSibling[slot] = -1;
    if (old >= 0)
      prevSibling[old] = slot;
    firstChild[parentSlot] = slot;
    parent[slot] = parentSlot;
  }
  const scene = {
    views,
    get capacity() {
      return views.capacity;
    },
    get count() {
      return views.headerI[H_NODE_COUNT];
    },
    get backing() {
      return shared ? "shared" : "local";
    },
    get layoutDirty() {
      return layoutDirty;
    },
    create(init = {}) {
      const slot = takeSlot();
      const { pos, quat, scale, group, payload, nodeFlags, sphereL, sphereW, headerU } = views;
      const i3 = slot * 3;
      const i4 = slot * 4;
      const stamp = ++headerU[H_CLOCK];
      views.localStamp[slot] = stamp;
      views.worldStamp[slot] = 0;
      pos[i3] = 0;
      pos[i3 + 1] = 0;
      pos[i3 + 2] = 0;
      quat[i4] = 0;
      quat[i4 + 1] = 0;
      quat[i4 + 2] = 0;
      quat[i4 + 3] = 1;
      scale[i3] = 1;
      scale[i3 + 1] = 1;
      scale[i3 + 2] = 1;
      sphereL[i4] = 0;
      sphereL[i4 + 1] = 0;
      sphereL[i4 + 2] = 0;
      sphereL[i4 + 3] = 0;
      sphereW[i4] = 0;
      sphereW[i4 + 1] = 0;
      sphereW[i4 + 2] = 0;
      sphereW[i4 + 3] = 0;
      group[slot] = init.group ?? -1;
      payload[slot] = init.payload ?? -1;
      nodeFlags[slot] = NF_ALIVE | (init.visible === false ? 0 : NF_VISIBLE);
      if (init.sphere !== undefined) {
        sphereL[i4] = init.sphere[0];
        sphereL[i4 + 1] = init.sphere[1];
        sphereL[i4 + 2] = init.sphere[2];
        sphereL[i4 + 3] = init.sphere[3];
      }
      if (init.position !== undefined) {
        pos[i3] = init.position[0];
        pos[i3 + 1] = init.position[1];
        pos[i3 + 2] = init.position[2];
      }
      if (init.rotation !== undefined) {
        const [qx, qy, qz, qw] = init.rotation;
        const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
        if (len > 0.000000000001) {
          quat[i4] = qx / len;
          quat[i4 + 1] = qy / len;
          quat[i4 + 2] = qz / len;
          quat[i4 + 3] = qw / len;
        }
      }
      if (init.scale !== undefined) {
        scale[i3] = init.scale[0];
        scale[i3 + 1] = init.scale[1];
        scale[i3 + 2] = init.scale[2];
      }
      const p = init.parent ?? -1;
      if (p >= 0) {
        if (p === slot)
          throw new Error("scene: node parent is the node itself");
        if ((views.nodeFlags[p] & NF_ALIVE) === 0)
          throw new Error(`scene: parent ${p} is not alive`);
        let a = p;
        while (a >= 0) {
          if (a === slot)
            throw new Error("scene: setParent would create a cycle");
          a = views.parent[a];
        }
        attach(slot, p);
      }
      views.headerI[H_NODE_COUNT] += 1;
      if (init.group !== undefined && init.group >= 0)
        bumpGroupCount(init.group);
      layoutDirty = true;
      return slot;
    },
    dispose(slot) {
      const { nodeFlags, generation, headerU } = views;
      if ((nodeFlags[slot] & NF_ALIVE) === 0)
        return;
      let c = views.firstChild[slot];
      while (c >= 0) {
        const next = views.nextSibling[c];
        detach(c);
        views.localStamp[c] = ++headerU[H_CLOCK];
        c = next;
      }
      detach(slot);
      nodeFlags[slot] = 0;
      generation[slot] = generation[slot] + 1;
      releaseSlot(slot);
      views.headerI[H_NODE_COUNT] -= 1;
      layoutDirty = true;
    },
    setParent(slot, parentSlot) {
      if ((views.nodeFlags[slot] & NF_ALIVE) === 0)
        throw new Error(`scene: node ${slot} is not alive`);
      if (parentSlot === slot)
        throw new Error("scene: node parent is the node itself");
      if (parentSlot >= 0) {
        if ((views.nodeFlags[parentSlot] & NF_ALIVE) === 0)
          throw new Error(`scene: parent ${parentSlot} is not alive`);
        let a = parentSlot;
        while (a >= 0) {
          if (a === slot)
            throw new Error("scene: setParent would create a cycle");
          a = views.parent[a];
        }
      }
      detach(slot);
      if (parentSlot >= 0)
        attach(slot, parentSlot);
      views.localStamp[slot] = ++views.headerU[H_CLOCK];
      layoutDirty = true;
    },
    parentOf(slot) {
      return views.parent[slot];
    },
    alive(slot) {
      return (views.nodeFlags[slot] & NF_ALIVE) !== 0;
    },
    generation(slot) {
      return views.generation[slot];
    },
    setLocal(slot, init) {
      const { pos, quat, scale, headerU } = views;
      const i3 = slot * 3;
      const i4 = slot * 4;
      let touched = false;
      if (init.position !== undefined) {
        pos[i3] = init.position[0];
        pos[i3 + 1] = init.position[1];
        pos[i3 + 2] = init.position[2];
        touched = true;
      }
      if (init.rotation !== undefined) {
        const [qx, qy, qz, qw] = init.rotation;
        const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
        if (len > 0.000000000001) {
          quat[i4] = qx / len;
          quat[i4 + 1] = qy / len;
          quat[i4 + 2] = qz / len;
          quat[i4 + 3] = qw / len;
        }
        touched = true;
      }
      if (init.scale !== undefined) {
        scale[i3] = init.scale[0];
        scale[i3 + 1] = init.scale[1];
        scale[i3 + 2] = init.scale[2];
        touched = true;
      }
      if (touched)
        views.localStamp[slot] = ++headerU[H_CLOCK];
    },
    setLocalTR(slot, px, py, pz, qx, qy, qz, qw, sx, sy, sz) {
      const { pos, quat, scale, headerU } = views;
      const i3 = slot * 3;
      const i4 = slot * 4;
      pos[i3] = px;
      pos[i3 + 1] = py;
      pos[i3 + 2] = pz;
      const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      if (len > 0.000000000001) {
        quat[i4] = qx / len;
        quat[i4 + 1] = qy / len;
        quat[i4 + 2] = qz / len;
        quat[i4 + 3] = qw / len;
      } else {
        quat[i4] = 0;
        quat[i4 + 1] = 0;
        quat[i4 + 2] = 0;
        quat[i4 + 3] = 1;
      }
      scale[i3] = sx;
      scale[i3 + 1] = sy;
      scale[i3 + 2] = sz;
      views.localStamp[slot] = ++headerU[H_CLOCK];
    },
    setSphereLocal(slot, cx, cy, cz, r) {
      const i4 = slot * 4;
      views.sphereL[i4] = cx;
      views.sphereL[i4 + 1] = cy;
      views.sphereL[i4 + 2] = cz;
      views.sphereL[i4 + 3] = r;
      views.localStamp[slot] = ++views.headerU[H_CLOCK];
    },
    setGroup(slot, group) {
      const old = views.group[slot];
      views.group[slot] = group;
      if (group >= 0)
        bumpGroupCount(group);
      layoutDirty = true;
      const stamp = views.headerU[H_CLOCK] + 1 >>> 0;
      views.headerU[H_CLOCK] = stamp;
      if (old >= 0 && old < views.groupMax)
        views.groupTouch[old] = stamp;
      if (group >= 0 && group < views.groupMax)
        views.groupTouch[group] = stamp;
    },
    setPayload(slot, payload) {
      views.payload[slot] = payload;
    },
    setVisible(slot, visible) {
      const was = (views.nodeFlags[slot] & NF_VISIBLE) !== 0;
      if (visible)
        views.nodeFlags[slot] |= NF_VISIBLE;
      else
        views.nodeFlags[slot] &= ~NF_VISIBLE;
      const g = views.group[slot];
      if (g >= 0 && g < views.groupMax) {
        if (was !== visible && views.firstChild[slot] < 0) {
          views.gHidden[g] += visible ? -1 : 1;
        }
        views.groupTouch[g] = ++views.headerU[H_CLOCK];
      }
    },
    worldMatrix(slot) {
      ensurePacked();
      const r16 = views.rankOf[slot] * 16;
      return views.world.subarray(r16, r16 + 16);
    },
    pack: packInternal,
    updateWorld(force = false) {
      ensurePacked();
      return force ? updateWorldForcedViews(views) : updateWorldViews(views);
    },
    refitGroupBounds() {
      ensurePacked();
      return refitGroupBoundsViews(views);
    },
    refitGroupBoundsForced() {
      ensurePacked();
      return refitGroupBoundsForcedViews(views);
    },
    groupWorldStamp(group) {
      return group >= 0 && group < views.groupMax ? views.groupTouch[group] : 0;
    },
    groupFlipStamp(group, cameraIndex) {
      if (group < 0 || group >= views.groupMax)
        return 0;
      if (cameraIndex < 0 || cameraIndex >= views.cameraMax)
        return 0;
      return views.groupFlip[cameraIndex * views.groupMax + group];
    },
    cull(cameras, opts = {}) {
      ensurePacked();
      const bufferIndex = opts.bufferIndex ?? autoEpoch++ & 1;
      const masks = opts.masks !== false;
      const count = Math.min(cameras.length, views.cameraMax);
      for (let k = 0;k < count; k++) {
        const planes = cameras[k].planes;
        if (planes.length === 24)
          views.planes.set(planes, k * 24);
        else
          views.planes.set(planes.subarray(0, 24), k * 24);
      }
      views.headerI[H_CAMERA_COUNT] = count;
      const out = opts.out;
      if (opts.reuse === true && out === undefined) {
        if (cullReuseResult === null) {
          const records = [];
          for (let k = 0;k < views.cameraMax; k++) {
            records.push({ tested: 0, visible: 0, trivialRejects: 0, trivialAccepts: 0, planeTests: 0 });
          }
          cullReuseStats = records;
          cullReuseViews = [];
          cullReuseResult = { cameraCount: 0, stats: records, bufferIndex: 0 };
        }
        for (let k = 0;k < count; k++) {
          const rec = cullReuseStats[k];
          if (opts.brute === true)
            cullViewsBrute(views, k, bufferIndex, rec);
          else
            cullViewsHierarchical(views, k, bufferIndex, rec, masks);
        }
        const viewsByCount = cullReuseViews;
        let statsView = count < viewsByCount.length ? viewsByCount[count] : undefined;
        if (statsView === undefined) {
          statsView = cullReuseStats.slice(0, count);
          viewsByCount[count] = statsView;
        }
        const reused = cullReuseResult;
        reused.cameraCount = count;
        reused.stats = statsView;
        reused.bufferIndex = bufferIndex;
        return reused;
      }
      const stats = [];
      for (let k = 0;k < count; k++) {
        const reuse = out !== undefined && k < out.length ? out[k] : undefined;
        stats.push(opts.brute === true ? cullViewsBrute(views, k, bufferIndex, reuse) : cullViewsHierarchical(views, k, bufferIndex, reuse, masks));
      }
      return { cameraCount: count, stats, bufferIndex };
    },
    collectInstances(cameraIndex, opts = {}) {
      ensurePacked();
      const bufferIndex = opts.bufferIndex ?? autoBufferIndex();
      return collectInstancesViews(views, cameraIndex, bufferIndex);
    },
    instances(group, opts = {}) {
      return instanceMatricesView(views, opts.bufferIndex ?? autoBufferIndex(), opts.cameraIndex ?? 0, group);
    },
    instanceCountOf(group, cameraIndex, bufferIndex) {
      if (group < 0 || group >= views.groupMax)
        return 0;
      const base = ((bufferIndex ?? autoBufferIndex()) * views.cameraMax + cameraIndex) * views.groupMax;
      return Math.max(0, views.instCounts[base + group]);
    },
    instanceOffsetOf(group, cameraIndex, bufferIndex) {
      if (group < 0 || group >= views.groupMax)
        return 0;
      const base = ((bufferIndex ?? autoBufferIndex()) * views.cameraMax + cameraIndex) * views.groupMax;
      return views.instOffsets[base + group];
    },
    instancePoolBase(cameraIndex, bufferIndex) {
      return instancePoolBase(views, bufferIndex ?? autoBufferIndex(), cameraIndex);
    },
    forEachVisible(cameraIndex, cb, opts = {}) {
      ensurePacked();
      const base = (opts.bufferIndex ?? autoBufferIndex()) * views.cameraMax * views.bitsWords + cameraIndex * views.bitsWords;
      const n = views.headerI[H_NODE_COUNT];
      const { bits, order, nodeFlags } = views;
      let word = bits[base];
      let mask = 1;
      let w = 0;
      for (let r = 0;r < n; r++) {
        if ((word & mask) !== 0) {
          const slot = order[r];
          if ((nodeFlags[slot] & NF_VISIBLE) !== 0)
            cb(slot, r);
        }
        mask <<= 1;
        if (mask === 0) {
          mask = 1;
          w++;
          if (r + 1 < n)
            word = bits[base + w];
        }
      }
    },
    isVisibleRank(cameraIndex, rank, opts = {}) {
      const base = (opts.bufferIndex ?? autoBufferIndex()) * views.cameraMax * views.bitsWords + cameraIndex * views.bitsWords;
      return (views.bits[base + (rank >>> 5)] & 1 << (rank & 31)) !== 0;
    },
    cameraFromNode(camera, slot) {
      ensurePacked();
      const r16 = views.rankOf[slot] * 16;
      return camera.setViewFromWorld(views.world.subarray(r16, r16 + 16));
    }
  };
  function bumpGroupCount(group) {
    const current = views.headerI[H_GROUP_COUNT];
    if (group >= current) {
      if (group >= views.groupMax) {
        throw new Error(`scene: group ${group} is out of groupMax=${views.groupMax}`);
      }
      views.headerI[H_GROUP_COUNT] = group + 1;
    }
  }
  return scene;
}
var packStack = new Int32Array(1024);
var packOrder2 = new Int32Array(1024);
var packCursor = new Int32Array(128);
var packWorld = new Float32Array(1024 * 16);
// packages/math/src/mat4.ts
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
// packages/math/src/mat4Ext.ts
function mat4InvertAffine(out, m) {
  const a00 = m[0], a10 = m[1], a20 = m[2];
  const a01 = m[4], a11 = m[5], a21 = m[6];
  const a02 = m[8], a12 = m[9], a22 = m[10];
  const det = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
  if (Math.abs(det) < 0.000000000001) {
    out.fill(0);
    out[0] = 1;
    out[5] = 1;
    out[10] = 1;
    out[15] = 1;
    return out;
  }
  const inv = 1 / det;
  const i00 = (a11 * a22 - a12 * a21) * inv;
  const i01 = (a02 * a21 - a01 * a22) * inv;
  const i02 = (a01 * a12 - a02 * a11) * inv;
  const i10 = (a12 * a20 - a10 * a22) * inv;
  const i11 = (a00 * a22 - a02 * a20) * inv;
  const i12 = (a02 * a10 - a00 * a12) * inv;
  const i20 = (a10 * a21 - a11 * a20) * inv;
  const i21 = (a01 * a20 - a00 * a21) * inv;
  const i22 = (a00 * a11 - a01 * a10) * inv;
  out[0] = i00;
  out[1] = i10;
  out[2] = i20;
  out[3] = 0;
  out[4] = i01;
  out[5] = i11;
  out[6] = i21;
  out[7] = 0;
  out[8] = i02;
  out[9] = i12;
  out[10] = i22;
  out[11] = 0;
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(i00 * tx + i01 * ty + i02 * tz);
  out[13] = -(i10 * tx + i11 * ty + i12 * tz);
  out[14] = -(i20 * tx + i21 * ty + i22 * tz);
  out[15] = 1;
  return out;
}
function mat4LookAt(out, eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ) {
  let zx = eyeX - centerX, zy = eyeY - centerY, zz = eyeZ - centerZ;
  let len = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = upY * zz - upZ * zy;
  let xy = upZ * zx - upX * zz;
  let xz = upX * zy - upY * zx;
  len = Math.sqrt(xx * xx + xy * xy + xz * xz);
  if (len) {
    xx /= len;
    xy /= len;
    xz /= len;
  }
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eyeX + xy * eyeY + xz * eyeZ);
  out[13] = -(yx * eyeX + yy * eyeY + yz * eyeZ);
  out[14] = -(zx * eyeX + zy * eyeY + zz * eyeZ);
  out[15] = 1;
  return out;
}
function mat4Ortho(out, left, right, bottom, top, near, far) {
  const lr = 1 / (left - right);
  const bt = 1 / (bottom - top);
  const nf = 1 / (near - far);
  out[0] = -2 * lr;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 0;
  out[5] = -2 * bt;
  out[6] = 0;
  out[7] = 0;
  out[8] = 0;
  out[9] = 0;
  out[10] = 2 * nf;
  out[11] = 0;
  out[12] = (left + right) * lr;
  out[13] = (top + bottom) * bt;
  out[14] = (far + near) * nf;
  out[15] = 1;
  return out;
}
// packages/core/src/transport/seqlock.ts
var MAX_READ_ATTEMPTS = 1 << 16;
var atomicsViews = new WeakMap;
// packages/core/src/transport/transport.ts
var byteOffsetCache = new WeakMap;
// packages/core/src/shader/glslReflect.ts
var reflectionCache = new Map;
// packages/core/src/shader/wgslReflect.ts
var reflectionCache2 = new Map;
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
var TEXTURE_FORMATS = {
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
var TEXTURE_FORMAT_IDS = Object.keys(TEXTURE_FORMATS);
// packages/core/src/noise.ts
var F3 = 1 / 3;
var G3 = 1 / 6;
var PERM = buildPerm();
var GRAD3 = new Int8Array([
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
var GRAD_OFF = new Uint8Array(512);
for (let i = 0;i < 512; i++)
  GRAD_OFF[i] = PERM[i] % 12 * 3;
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
// packages/core/src/frustum.ts
var SPHERE_OUTSIDE = 0;
var SPHERE_INTERSECT = 1;
var SPHERE_INSIDE = 2;
function frustumPlanes(viewProj, out) {
  if (viewProj.length !== 16) {
    throw new Error(`rune/core: frustumPlanes — the view-projection is 16 numbers, column-major (got ${viewProj.length})`);
  }
  const o = out ?? new Float32Array(24);
  for (let p = 0;p < 6; p++) {
    const axis = p >> 1;
    const sign = (p & 1) === 0 ? 1 : -1;
    const nx = viewProj[3] + sign * viewProj[axis];
    const ny = viewProj[7] + sign * viewProj[4 + axis];
    const nz = viewProj[11] + sign * viewProj[8 + axis];
    const d = viewProj[15] + sign * viewProj[12 + axis];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const inv = len > 0.000000000001 ? 1 / len : 0;
    o[p * 4] = nx * inv;
    o[p * 4 + 1] = ny * inv;
    o[p * 4 + 2] = nz * inv;
    o[p * 4 + 3] = d * inv;
  }
  return o;
}
function classifySphere(planes, cx, cy, cz, radius) {
  let insideAll = true;
  for (let i = 0;i < 6; i++) {
    const o = i * 4;
    const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3];
    if (d < -radius)
      return SPHERE_OUTSIDE;
    if (d < radius)
      insideAll = false;
  }
  return insideAll ? SPHERE_INSIDE : SPHERE_INTERSECT;
}
// packages/core/src/store.ts
var KIND_BYTES = 4;
function rabMaxBytes(bytes) {
  return Math.min(1 << 30, Math.max(1 << 26, bytes * 16));
}
function makeView(buffer, kind, byteOffset, length) {
  if (kind === "f32")
    return new Float32Array(buffer, byteOffset, length);
  if (kind === "i32")
    return new Int32Array(buffer, byteOffset, length);
  return new Uint32Array(buffer, byteOffset, length);
}
function strideOf(columns) {
  let s = 0;
  for (const c of columns)
    s += c.width;
  return s;
}
function rebuildViews(st) {
  st.views = new Map;
  st.offsets = new Map;
  let byte = 0;
  for (const c of st.columns) {
    st.offsets.set(c.name, byte);
    st.views.set(c.name, makeView(st.buffer, c.kind, byte, c.width * st.capacity));
    byte += c.width * st.capacity * KIND_BYTES;
  }
  st.epoch++;
}
function tryGrowInPlace(st, targetBytes) {
  if (st.shared) {
    const sab = st.buffer;
    if (targetBytes > (sab.growable ? sab.maxByteLength : sab.byteLength))
      return false;
    sab.grow(targetBytes);
    return true;
  }
  const ab = st.buffer;
  if (!ab.resizable || targetBytes > ab.maxByteLength)
    return false;
  ab.resize(targetBytes);
  return true;
}
function reallocate(st, nextCapacity, maxBytes) {
  const bytes = strideOf(st.columns) * nextCapacity * KIND_BYTES;
  const next = st.shared ? maxBytes !== null ? new SharedArrayBuffer(bytes, { maxByteLength: maxBytes }) : new SharedArrayBuffer(bytes) : maxBytes !== null ? new ArrayBuffer(bytes, { maxByteLength: maxBytes }) : new ArrayBuffer(bytes);
  let byte = 0;
  for (const c of st.columns) {
    const src = st.views.get(c.name);
    const len = c.width * st.capacity;
    const dst = makeView(next, c.kind, byte, c.width * nextCapacity);
    dst.set(src.subarray(0, len), 0);
    byte += c.width * nextCapacity * KIND_BYTES;
  }
  st.buffer = next;
  st.capacity = nextCapacity;
  rebuildViews(st);
}
function reserveImpl(st, n) {
  const next = Math.max(n, st.capacity * 2, 16);
  const targetBytes = strideOf(st.columns) * next * KIND_BYTES;
  if (st.growth === "none") {
    throw new Error(`store: the fixed-capacity contract (${st.capacity} records) refuses ${n} — adopt a bigger buffer or declare a growth policy`);
  }
  if (st.growth === "rab" && tryGrowInPlace(st, targetBytes)) {
    st.capacity = next;
    st.dirty = createMarkSetFrom(st.dirty.words(), next);
    rebuildViews(st);
    return;
  }
  const curBytes = strideOf(st.columns) * st.capacity * KIND_BYTES;
  reallocate(st, next, st.growth === "rab" ? Math.max(rabMaxBytes(curBytes), targetBytes) : null);
  st.dirty = createMarkSetFrom(st.dirty.words(), next);
}
function makeStore(st) {
  return {
    get buffer() {
      return st.buffer;
    },
    get capacity() {
      return st.capacity;
    },
    get count() {
      return st.count;
    },
    get growth() {
      return st.growth;
    },
    get epoch() {
      return st.epoch;
    },
    get clock() {
      return st.clock;
    },
    get stride() {
      return strideOf(st.columns);
    },
    get dirtyBytes() {
      return st.dirtyBytes;
    },
    get dirtyCount() {
      return st.dirty.count();
    },
    column(name) {
      const v = st.views.get(name);
      if (v === undefined) {
        throw new Error(`store: no column '${name}' (declared: ${st.columns.map((c) => c.name).join(", ")})`);
      }
      return v;
    },
    columnBytes(name) {
      const off = st.offsets.get(name);
      if (off === undefined)
        throw new Error(`store: no column '${name}'`);
      const c = st.columns.find((x) => x.name === name);
      return { start: off, end: off + c.width * st.capacity * KIND_BYTES };
    },
    recordBytes(name, i0, i1) {
      const off = st.offsets.get(name);
      if (off === undefined)
        throw new Error(`store: no column '${name}'`);
      const c = st.columns.find((x) => x.name === name);
      const hi = Math.max(i0, i1);
      return { start: off + i0 * c.width * KIND_BYTES, end: off + hi * c.width * KIND_BYTES };
    },
    reserve(n) {
      if (n > st.capacity) {
        reserveImpl(st, n);
        st.clock++;
      }
    },
    resize(n) {
      if (n > st.capacity)
        reserveImpl(st, n);
      if (n !== st.count)
        st.clock++;
      st.count = n;
    },
    append() {
      if (st.count >= st.capacity)
        reserveImpl(st, st.count + 1);
      const i = st.count;
      st.count = i + 1;
      st.clock++;
      return i;
    },
    copyRecords(dst, src, n) {
      if (n <= 0 || dst === src)
        return;
      if (dst < 0 || src < 0 || Math.max(dst, src) + n > st.count) {
        throw new Error(`store: copyRecords(dst=${dst}, src=${src}, n=${n}) outruns the live count ${st.count}`);
      }
      for (const c of st.columns) {
        const v = st.views.get(c.name);
        const w = c.width;
        v.set(v.subarray(src * w, (src + n) * w), dst * w);
      }
      st.clock++;
    },
    swapRemove(i) {
      if (i < 0 || i >= st.count)
        throw new Error(`store: swapRemove(${i}) — not a live record (${st.count} live)`);
      const last = st.count - 1;
      if (i !== last) {
        for (const c of st.columns) {
          const v = st.views.get(c.name);
          const w = c.width;
          v.set(v.subarray(last * w, (last + 1) * w), i * w);
        }
      }
      st.count = last;
      st.clock++;
    },
    markRecordDirty(i) {
      if (i < 0 || i >= st.count)
        return;
      if (st.dirty.add(i))
        st.dirtyBytes += strideOf(st.columns) * KIND_BYTES;
    },
    markRecordsDirty(i0, i1) {
      const lo = Math.max(0, i0);
      const hi = Math.min(st.count, i1);
      const per = strideOf(st.columns) * KIND_BYTES;
      for (let i = lo;i < hi; i++) {
        if (st.dirty.add(i))
          st.dirtyBytes += per;
      }
    },
    touchAll() {
      st.dirtyBytes = 0;
      st.dirty.clearAll();
      const per = strideOf(st.columns) * KIND_BYTES;
      for (let i = 0;i < st.count; i++) {
        if (st.dirty.add(i))
          st.dirtyBytes += per;
      }
    },
    takeUploadRanges() {
      return takeRangesImpl(st);
    },
    clearDirty() {
      st.dirty.clearAll();
      st.dirtyBytes = 0;
    },
    bump() {
      st.clock++;
    }
  };
}
var MERGE_GAP = 8;
function takeRangesImpl(st) {
  const out = [];
  if (strideOf(st.columns) === 0 || st.dirty.count() === 0)
    return out;
  const emit = (i0, i1) => {
    for (const c of st.columns) {
      const off = st.offsets.get(c.name);
      out.push({ start: off + i0 * c.width * KIND_BYTES, end: off + i1 * c.width * KIND_BYTES });
    }
  };
  let runStart = -1;
  let runEnd = -1;
  st.dirty.forEachSparse((i) => {
    if (runStart < 0) {
      runStart = i;
      runEnd = i + 1;
      return;
    }
    if (i - runEnd <= MERGE_GAP) {
      runEnd = i + 1;
      return;
    }
    emit(runStart, runEnd);
    runStart = i;
    runEnd = i + 1;
  });
  if (runStart >= 0)
    emit(runStart, runEnd);
  return out;
}
function validateColumns(columns) {
  if (columns.length === 0)
    throw new Error("store: no columns declared");
  const seen = new Set;
  for (const c of columns) {
    if (c.width < 1)
      throw new Error(`store: column '${c.name}' — width must be ≥ 1`);
    if (seen.has(c.name))
      throw new Error(`store: duplicate column '${c.name}'`);
    seen.add(c.name);
  }
}
function adoptStore(buffer, columns, count, byteOffset = 0, regionBytes) {
  validateColumns(columns);
  const stride = strideOf(columns);
  const available = regionBytes !== undefined ? Math.min(regionBytes, buffer.byteLength - byteOffset) : buffer.byteLength - byteOffset;
  const capacity = available / (stride * KIND_BYTES) | 0;
  if (capacity < 1 || byteOffset + capacity * stride * KIND_BYTES > buffer.byteLength) {
    throw new Error(`store: the buffer (${buffer.byteLength}B @${byteOffset}${regionBytes !== undefined ? `, region ${regionBytes}B` : ""}) cannot hold one ${stride}-element record`);
  }
  if (count < 0 || count > capacity) {
    throw new Error(`store: count ${count} outruns the adopted capacity ${capacity}`);
  }
  const st = {
    columns,
    capacity,
    count,
    growth: "none",
    epoch: 0,
    clock: 0,
    buffer,
    views: new Map,
    offsets: new Map,
    dirty: createMarkSet(capacity),
    dirtyBytes: 0,
    shared: typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer
  };
  let byte = byteOffset;
  for (const c of columns) {
    st.offsets.set(c.name, byte);
    st.views.set(c.name, makeView(buffer, c.kind, byte, c.width * capacity));
    byte += c.width * capacity * KIND_BYTES;
  }
  st.epoch++;
  return makeStore(st);
}
function createMarkSet(capacity) {
  const cap = Math.max(1, capacity | 0);
  const bits = new Uint32Array(cap + 31 >> 5);
  return makeMarkSet(cap, bits);
}
function createMarkSetFrom(words, capacity) {
  const cap = Math.max(1, capacity | 0);
  const need = cap + 31 >> 5;
  const bits = new Uint32Array(need);
  bits.set(words.subarray(0, Math.min(need, words.length)));
  return makeMarkSet(cap, bits);
}
function makeMarkSet(cap, bits) {
  let live = 0;
  for (let w = 0;w < bits.length; w++) {
    let v = bits[w];
    if (v === 0)
      continue;
    v = v - (v >>> 1 & 1431655765);
    v = (v & 858993459) + (v >>> 2 & 858993459);
    v = v + (v >>> 4) & 252645135;
    live += v * 16843009 >>> 24;
  }
  return {
    get capacity() {
      return cap;
    },
    add(i) {
      if (i < 0 || i >= cap)
        return false;
      const w = i >>> 5;
      const m = 1 << (i & 31);
      if ((bits[w] & m) !== 0)
        return false;
      bits[w] |= m;
      live++;
      return true;
    },
    remove(i) {
      if (i < 0 || i >= cap)
        return false;
      const w = i >>> 5;
      const m = 1 << (i & 31);
      if ((bits[w] & m) === 0)
        return false;
      bits[w] &= ~m;
      live--;
      return true;
    },
    has(i) {
      if (i < 0 || i >= cap)
        return false;
      return (bits[i >>> 5] & 1 << (i & 31)) !== 0;
    },
    clearAll() {
      bits.fill(0);
      live = 0;
    },
    count() {
      return live;
    },
    density() {
      return live / cap;
    },
    forEachSparse(cb) {
      const words = bits.length;
      for (let w = 0;w < words; w++) {
        let word = bits[w];
        if (word === 0)
          continue;
        const base = w << 5;
        while (word !== 0) {
          const lb = word & -word;
          word ^= lb;
          const i = base + 31 - Math.clz32(lb);
          if (i < cap)
            cb(i);
        }
      }
    },
    forEachDense(cb) {
      for (let i = 0;i < cap; i++) {
        if ((bits[i >>> 5] & 1 << (i & 31)) !== 0)
          cb(i);
      }
    },
    forEach(cb) {
      if (live * 8 < cap)
        this.forEachSparse(cb);
      else
        this.forEachDense(cb);
    },
    words() {
      return bits;
    }
  };
}
// packages/core/src/culling.ts
var FACE_QUADS = (() => {
  const table = [];
  for (let axis = 0;axis < 3; axis++) {
    for (let frontI = 0;frontI < 2; frontI++) {
      const front = frontI === 0;
      const ids = [];
      for (let k = 0;k < 8; k++) {
        const bit = k >> axis & 1;
        if (front ? bit === 0 : bit === 1)
          ids.push(k);
      }
      table[axis * 2 + frontI] = [ids[0], ids[1], ids[3], ids[2]];
    }
  }
  return table;
})();
// packages/core/src/sort.ts
var HIST16 = new Uint32Array(65536);
var HIST11 = new Uint32Array(2048);
var BIT_F32 = new Float32Array(1);
var BIT_U32 = new Uint32Array(BIT_F32.buffer);
// packages/scene/src/frustum.ts
var PLANE_LEFT = 0;
var PLANE_RIGHT = 1;
var PLANE_BOTTOM = 2;
var PLANE_TOP = 3;
var PLANE_NEAR = 4;
var PLANE_FAR = 5;
function extractFrustumPlanes(out, vp) {
  return frustumPlanes(vp, out);
}
function writeCameraPlanes(views, cameraIndex, planes) {
  views.planes.set(planes.subarray(0, 24), cameraIndex * 24);
}

// packages/scene/src/camera.ts
var tmpInverse = new Float32Array(16);
var tmpProjLeft = new Float32Array(16);
function createCamera() {
  const view = new Float32Array(16);
  const projection = new Float32Array(16);
  const viewProjection = new Float32Array(16);
  const planes = new Float32Array(24);
  view[0] = view[5] = view[10] = view[15] = 1;
  const camera = {
    view,
    projection,
    viewProjection,
    planes,
    setPerspective(fovy, aspect, near, far) {
      mat4Perspective(projection, fovy, aspect, near, far);
      refresh();
      return camera;
    },
    setOrtho(left, right, bottom, top, near, far) {
      mat4Ortho(projection, left, right, bottom, top, near, far);
      refresh();
      return camera;
    },
    setViewFromWorld(world) {
      for (let i = 0;i < 16; i++)
        tmpInverse[i] = world[i];
      mat4InvertAffine(view, tmpInverse);
      refresh();
      return camera;
    },
    setObliqueClipPlane(plane) {
      applyObliqueClipPlane(projection, view, plane);
      refresh();
      return camera;
    },
    postMultiplyProjection(m) {
      for (let i = 0;i < 16; i++)
        tmpProjLeft[i] = m[i];
      for (let i = 0;i < 16; i++)
        tmpInverse[i] = projection[i];
      mat4Multiply(projection, tmpProjLeft, tmpInverse);
      refresh();
      return camera;
    },
    setViewLookAt(eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ) {
      mat4LookAt(view, eyeX, eyeY, eyeZ, centerX, centerY, centerZ, upX, upY, upZ);
      refresh();
      return camera;
    }
  };
  function refresh() {
    mat4Multiply(viewProjection, projection, view);
    extractFrustumPlanes(planes, viewProjection);
  }
  camera.setPerspective(Math.PI / 3, 1, 0.1, 100);
  return camera;
}
function applyObliqueClipPlane(projection, view, plane) {
  const [nx, ny, nz, d] = plane;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 0.000000001)
    throw new Error("scene: zero normal of the clip plane");
  const a = nx / len, b = ny / len, c = nz / len, dd = d / len;
  const tx = view[12], ty = view[13], tz = view[14];
  const va = view[0] * a + view[4] * b + view[8] * c;
  const vb = view[1] * a + view[5] * b + view[9] * c;
  const vc = view[2] * a + view[6] * b + view[10] * c;
  const vd = dd - (va * tx + vb * ty + vc * tz);
  let pa = va, pb = vb, pc = vc, pd = vd;
  if (pd > 0) {
    pa = -pa;
    pb = -pb;
    pc = -pc;
    pd = -pd;
  }
  const p = projection;
  const qx = (Math.sign(pa) + p[8]) / p[0];
  const qy = (Math.sign(pb) + p[9]) / p[5];
  const qz = -1;
  const qw = (1 + p[10]) / p[14];
  const denom = pa * qx + pb * qy + pc * qz + pd * qw;
  if (Math.abs(denom) < 0.000000000001)
    throw new Error("scene: oblique plane is degenerate (parallel to the view direction)");
  const s = 2 / denom;
  p[2] = pa * s;
  p[6] = pb * s;
  p[10] = pc * s + 1;
  p[14] = pd * s;
}
// packages/scene/src/renderable.ts
var RENDER_PASS_ORDER = {
  opaque: 0,
  sky: 1,
  mirror: 2,
  transparent: 3,
  overlay: 4
};
function createRenderableRegistry() {
  const meshes = [];
  const materials = [];
  const descs = [];
  const cache = new Map;
  return {
    addMesh(load) {
      const id = meshes.length;
      meshes.push({ id, load });
      return id;
    },
    addMaterial(material) {
      const id = materials.length;
      materials.push({ id, ...material });
      return id;
    },
    add(desc) {
      if (meshes[desc.mesh] === undefined)
        throw new Error(`scene: mesh ${desc.mesh} is not registered`);
      if (materials[desc.material] === undefined)
        throw new Error(`scene: material ${desc.material} is not registered`);
      const id = descs.length;
      descs.push({ id, ...desc });
      return id;
    },
    get(id) {
      return descs[id];
    },
    mesh(id) {
      return meshes[id];
    },
    material(id) {
      return materials[id];
    },
    resolveMesh(meshId) {
      const recipe = meshes[meshId];
      if (recipe === undefined)
        return;
      let resolved = cache.get(meshId);
      if (resolved === undefined) {
        resolved = { meshId, geometry: recipe.load() };
        cache.set(meshId, resolved);
      }
      return resolved;
    },
    get count() {
      return descs.length;
    }
  };
}
// packages/scene/src/worker.ts
var pipelineCullStats = {
  tested: 0,
  visible: -1,
  trivialRejects: 0,
  trivialAccepts: 0,
  planeTests: 0
};
function runScenePipeline(views, bufferIndex) {
  const headerI = views.headerI;
  const cmd = headerI[H_CMD_FLAGS];
  const t0 = now();
  if ((cmd & CMD_UPDATE_WORLD) !== 0)
    updateWorldViews(views);
  if ((cmd & CMD_REFIT) !== 0)
    refitGroupBoundsViews(views);
  if ((cmd & CMD_CULL) !== 0) {
    const cameras = headerI[H_CAMERA_COUNT];
    for (let k = 0;k < cameras; k++)
      cullViewsHierarchical(views, k, bufferIndex, pipelineCullStats, true, false);
  }
  if ((cmd & CMD_INSTANCES) !== 0) {
    const cameras = headerI[H_CAMERA_COUNT];
    for (let k = 0;k < cameras; k++)
      collectInstancesViews(views, k, bufferIndex);
  }
  return now() - t0;
}
function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}
function runSceneWorker(sab, hooks = {}) {
  const views = buildSceneViews(sab);
  const headerI = views.headerI;
  let stopped = false;
  let lastInput = Atomics.load(headerI, H_INPUT_EPOCH);
  const handle = {
    stop() {
      stopped = true;
      Atomics.notify(headerI, H_INPUT_EPOCH);
    }
  };
  while (!stopped) {
    Atomics.wait(headerI, H_INPUT_EPOCH, lastInput, 50);
    if (stopped)
      break;
    if ((Atomics.load(headerI, H_CMD_FLAGS) & CMD_STOP) !== 0)
      break;
    const input = Atomics.load(headerI, H_INPUT_EPOCH);
    const output = Atomics.load(headerI, H_OUTPUT_EPOCH);
    if (output >= input) {
      lastInput = input;
      continue;
    }
    lastInput = input;
    const frameMs = runScenePipeline(views, input & 1);
    Atomics.store(headerI, H_OUTPUT_EPOCH, input);
    hooks.onFrame?.(input, frameMs);
  }
  return handle;
}
// packages/scene/src/mirror.ts
var EMPTY_MATRICES = new Float32Array(0);
function createSceneWorkerBridge(options) {
  const { scene, worker } = options;
  const views = scene.views;
  if (scene.backing !== "shared") {
    throw new Error("scene: the bridge needs a SAB scene (createScene({ shared: true }))");
  }
  if (options.snapshotViews === true && options.snapshotReuse === true) {
    throw new Error("scene: snapshotViews and snapshotReuse are mutually exclusive (views need no ring — the SAB is the ring)");
  }
  let published = 0;
  let freshTakes = 0;
  let staleTakes = 0;
  let lastSnapshot = null;
  let lastSnapshotEpoch = 0;
  let disposed = false;
  const snapshotReuse = options.snapshotReuse === true;
  const snapshotViews = options.snapshotViews === true;
  const ring = snapshotReuse ? [
    { bits: new Uint32Array(views.cameraMax * views.bitsWords), matrices: [] },
    { bits: new Uint32Array(views.cameraMax * views.bitsWords), matrices: [] }
  ] : [];
  let ringNext = 0;
  const ready = new Promise((resolve) => {
    worker.onMessage((message) => {
      const m = message;
      if (m?.type === "scene-ready")
        resolve();
    });
    worker.postMessage({ type: "scene-init", sab: views.buffer });
  });
  function snapshot(views2, epoch, slot) {
    const cameraCount = views2.headerI[H_CAMERA_COUNT];
    const groupCount = Math.min(views2.headerI[H_GROUP_COUNT], views2.groupMax);
    const bufferIndex = epoch & 1;
    const liveWords = views2.headerI[H_NODE_COUNT] + 31 >>> 5;
    const bits = [];
    const instances = [];
    const ringSlot = slot >= 0 ? ring[slot] : undefined;
    const asViews = snapshotViews && ringSlot === undefined;
    for (let k = 0;k < cameraCount; k++) {
      const base = bitsBase(views2, bufferIndex, k);
      if (ringSlot !== undefined) {
        ringSlot.bits.set(views2.bits.subarray(base, base + liveWords), k * views2.bitsWords);
        bits.push(ringSlot.bits.subarray(k * views2.bitsWords, k * views2.bitsWords + liveWords));
      } else if (asViews) {
        bits.push(views2.bits.subarray(base, base + liveWords));
      } else {
        bits.push(views2.bits.slice(base, base + liveWords));
      }
      const perCamera = [];
      const countsBase = (bufferIndex * views2.cameraMax + k) * views2.groupMax;
      const poolBase = (bufferIndex * views2.cameraMax + k) * views2.headerI[H_INSTANCE_POOL] * 16;
      const pool = views2.instPool;
      if (ringSlot !== undefined) {
        let total = 0;
        for (let g = 0;g < groupCount; g++)
          total += Math.max(0, views2.instCounts[countsBase + g]);
        let row = ringSlot.matrices[k] ?? new Float32Array(0);
        if (row.length < total * 16) {
          row = new Float32Array(Math.max(total * 16, row.length * 2, 1024));
        }
        ringSlot.matrices[k] = row;
        for (let g = 0;g < groupCount; g++) {
          const count = Math.max(0, views2.instCounts[countsBase + g]);
          if (count === 0) {
            perCamera.push({ matrices: EMPTY_MATRICES, count: 0 });
            continue;
          }
          const offset = views2.instOffsets[countsBase + g];
          const srcStart = poolBase + offset * 16;
          row.set(pool.subarray(srcStart, srcStart + count * 16), offset * 16);
          perCamera.push({ matrices: row.subarray(offset * 16, offset * 16 + count * 16), count });
        }
      } else if (asViews) {
        for (let g = 0;g < groupCount; g++) {
          const count = Math.max(0, views2.instCounts[countsBase + g]);
          if (count === 0) {
            perCamera.push({ matrices: EMPTY_MATRICES, count: 0 });
            continue;
          }
          const offset = views2.instOffsets[countsBase + g];
          const srcStart = poolBase + offset * 16;
          perCamera.push({ matrices: pool.subarray(srcStart, srcStart + count * 16), count });
        }
      } else {
        for (let g = 0;g < groupCount; g++) {
          const count = Math.max(0, views2.instCounts[countsBase + g]);
          if (count === 0) {
            perCamera.push({ matrices: EMPTY_MATRICES, count: 0 });
            continue;
          }
          const offset = views2.instOffsets[countsBase + g];
          const srcStart = poolBase + offset * 16;
          perCamera.push({
            matrices: pool.slice(srcStart, srcStart + count * 16),
            count
          });
        }
      }
      instances.push(perCamera);
    }
    return { epoch, cameraCount, bits, instances };
  }
  return {
    ready,
    publish(cameras) {
      if (disposed)
        throw new Error("scene: the bridge is already closed");
      if (scene.layoutDirty)
        scene.pack();
      const count = Math.min(cameras.length, views.cameraMax);
      for (let k = 0;k < count; k++) {
        const planes = cameras[k].planes;
        if (planes.length === 24)
          views.planes.set(planes, k * 24);
        else
          views.planes.set(planes.subarray(0, 24), k * 24);
      }
      views.headerI[H_CAMERA_COUNT] = count;
      published++;
      Atomics.store(views.headerI, H_INPUT_EPOCH, published);
      Atomics.notify(views.headerI, H_INPUT_EPOCH);
      return published;
    },
    take() {
      const output = Atomics.load(views.headerI, H_OUTPUT_EPOCH);
      if (output > 0 && output !== lastSnapshotEpoch) {
        const slot = snapshotReuse ? ringNext ^= 1 : -1;
        lastSnapshot = snapshot(views, output, slot);
        lastSnapshotEpoch = output;
        freshTakes++;
        return lastSnapshot;
      }
      staleTakes++;
      views.headerI[H_STALE_TAKES] += 1;
      return lastSnapshot;
    },
    async waitFresh(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;; ) {
        const snap = this.take();
        if (snap !== null && snap.epoch === published)
          return snap;
        if (Date.now() >= deadline)
          return snap;
        await new Promise((r) => setTimeout(r, 1));
      }
    },
    stats() {
      return { published, freshTakes, staleTakes };
    },
    async dispose() {
      if (disposed)
        return;
      disposed = true;
      const flags = Atomics.load(views.headerI, H_CMD_FLAGS);
      Atomics.store(views.headerI, H_CMD_FLAGS, flags | CMD_STOP);
      Atomics.notify(views.headerI, H_INPUT_EPOCH);
      await Promise.race([
        new Promise((r) => setTimeout(r, 100)),
        Promise.resolve(worker.terminate?.()).then(() => {
          return;
        }, () => {
          return;
        })
      ]).then(() => {
        return;
      });
    }
  };
}
// packages/scene/src/storeMirror.ts
function createSceneStoreMirror(scene, bridge) {
  const views = scene.views;
  const locals = adoptStore(views.buffer, [
    { name: "pos", kind: "f32", width: 3 },
    { name: "quat", kind: "f32", width: 4 },
    { name: "scale", kind: "f32", width: 3 }
  ], views.capacity, views.pos.byteOffset, views.capacity * 10 * 4);
  const spheres = adoptStore(views.buffer, [
    { name: "sphereL", kind: "f32", width: 4 },
    { name: "sphereW", kind: "f32", width: 4 }
  ], views.capacity, views.sphereL.byteOffset, views.capacity * 8 * 4);
  const worlds = adoptStore(views.buffer, [{ name: "world", kind: "f32", width: 16 }], Math.max(1, views.headerI[H_NODE_COUNT]), views.world.byteOffset, views.capacity * 16 * 4);
  const rowBytes = Math.max(views.maxInstances, 1) * 16 * 4;
  const pools = [];
  for (let row = 0;row < 2 * views.cameraMax; row++) {
    pools.push(adoptStore(views.buffer, [{ name: "matrix", kind: "f32", width: 16 }], views.maxInstances, views.instPool.byteOffset + row * rowBytes, rowBytes));
  }
  let lastEpoch = -1;
  let clockHeld = 0;
  const observe = (epoch) => {
    if (epoch === lastEpoch)
      return false;
    lastEpoch = epoch;
    clockHeld = views.headerU[H_CLOCK];
    return true;
  };
  const take = () => {
    if (bridge === undefined) {
      throw new Error("scene storeMirror: take() needs the factory's bridge option (the T0 spelling is observe(epoch))");
    }
    const snap = bridge.take();
    if (snap !== null)
      observe(snap.epoch);
    return snap;
  };
  const groupCount = () => Math.min(views.headerI[H_GROUP_COUNT], views.groupMax);
  return {
    locals,
    spheres,
    worlds,
    pool(epoch, camera) {
      if (camera < 0 || camera >= views.cameraMax) {
        throw new Error(`scene storeMirror: pool(epoch, camera=${camera}) — the scene holds ${views.cameraMax} cameras`);
      }
      return pools[(epoch & 1) * views.cameraMax + camera];
    },
    ranges(epoch, camera, watermark) {
      const row = (epoch & 1) * views.cameraMax + camera;
      if (camera < 0 || camera >= views.cameraMax || row >= pools.length) {
        throw new Error(`scene storeMirror: ranges(epoch, camera=${camera}) — the scene holds ${views.cameraMax} cameras`);
      }
      const store = pools[row];
      const countsBase = (epoch & 1) * views.cameraMax + camera;
      const countsBaseWords = countsBase * views.groupMax;
      const flipBase = camera * views.groupMax;
      store.clearDirty();
      const groups = groupCount();
      for (let g = 0;g < groups; g++) {
        if (views.groupTouch[g] <= watermark && views.groupFlip[flipBase + g] <= watermark)
          continue;
        const off = views.instOffsets[countsBaseWords + g];
        const cnt = Math.max(0, views.instCounts[countsBaseWords + g]);
        if (cnt > 0)
          store.markRecordsDirty(off, off + cnt);
      }
      const out = store.takeUploadRanges();
      store.clearDirty();
      return out;
    },
    staticRanges(watermark) {
      locals.clearDirty();
      const flags = views.nodeFlags;
      const stamps = views.localStamp;
      for (let slot = 0;slot < views.capacity; slot++) {
        if ((flags[slot] & NF_ALIVE) === 0)
          continue;
        if (stamps[slot] > watermark)
          locals.markRecordDirty(slot);
      }
      const out = locals.takeUploadRanges();
      locals.clearDirty();
      return out;
    },
    worldRanges(watermark, layoutEpoch) {
      if (scene.layoutDirty)
        scene.pack();
      const n = views.headerI[H_NODE_COUNT];
      worlds.resize(Math.max(1, n));
      worlds.clearDirty();
      if (layoutEpoch !== undefined && layoutEpoch !== views.headerI[H_LAYOUT_EPOCH]) {
        worlds.touchAll();
      } else {
        const order = views.order;
        const stamps = views.worldStamp;
        for (let rank = 0;rank < n; rank++) {
          if (stamps[order[rank]] > watermark)
            worlds.markRecordDirty(rank);
        }
      }
      const out = worlds.takeUploadRanges();
      worlds.clearDirty();
      return out;
    },
    layoutEpoch() {
      return views.headerI[H_LAYOUT_EPOCH];
    },
    observe,
    watermark: () => clockHeld,
    take
  };
}
// packages/scene/src/strategy.ts
var STATIC_NS_PER_NODE = 5.4;
var ANIMATED_NS_PER_NODE = 160;
var INSTANCE_NS = 20;
var WORKER_SYNC_MS = 0.002;
var WORKER_PIPELINE_INFLATION = 2.5;
var MIN_GAIN_MS = 1;
function estimatePipelineMs(inputs) {
  const cameras = Math.max(1, inputs.cameraCount);
  const visible = inputs.visibleInstances ?? 0;
  const base = inputs.nodeCount * STATIC_NS_PER_NODE + inputs.animatedNodes * ANIMATED_NS_PER_NODE + visible * INSTANCE_NS;
  return base * (1 + (cameras - 1) * 0.35) / 1e6;
}
function recommendSceneStrategy(inputs) {
  const budget = inputs.frameBudgetMs ?? 16.7;
  const pipelineMs = estimatePipelineMs(inputs);
  const workerMs = pipelineMs * WORKER_PIPELINE_INFLATION + 1.3;
  if (!inputs.workerAvailable) {
    return {
      offloadToWorker: false,
      reason: "SAB/worker unavailable — T0 pipeline (core transport ladder)",
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs
    };
  }
  if (pipelineMs < WORKER_SYNC_MS + MIN_GAIN_MS) {
    return {
      offloadToWorker: false,
      reason: `pipeline ~${pipelineMs.toFixed(2)} ms < threshold ${MIN_GAIN_MS} ms: synchronization and latency do not pay off, local is cheaper`,
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs
    };
  }
  if (workerMs > budget) {
    return {
      offloadToWorker: false,
      reason: `worker needs ~${workerMs.toFixed(1)} ms > frame budget ${budget} ms: the thread cannot make it in time, overlap impossible`,
      estimatedPipelineMs: pipelineMs,
      estimatedWorkerMs: workerMs
    };
  }
  return {
    offloadToWorker: true,
    reason: `pipeline ~${pipelineMs.toFixed(2)} ms: the worker frees main (handles it in ~${workerMs.toFixed(1)} ms < ${budget} ms), overlap with rendering`,
    estimatedPipelineMs: pipelineMs,
    estimatedWorkerMs: workerMs
  };
}
function measureScenePipeline(scene, cameras, opts = {}) {
  const runs = opts.runs ?? 7;
  scene.pack();
  for (let i = 0;i < runs; i++) {
    scene.updateWorld();
    scene.refitGroupBounds();
    scene.cull(cameras, { reuse: true });
    for (let k = 0;k < cameras.length; k++)
      scene.collectInstances(k);
  }
  const times = [];
  for (let i = 0;i < runs; i++) {
    const t0 = performance.now();
    scene.updateWorld();
    scene.refitGroupBounds();
    scene.cull(cameras, { reuse: true });
    for (let k = 0;k < cameras.length; k++)
      scene.collectInstances(k);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}
export {
  writeCameraPlanes,
  updateWorldViews,
  updateWorldForcedViews,
  tailLayoutOn,
  tailCounters,
  setTailLayout,
  setGroupSphereReject,
  setCullTailSpheres,
  setCullMemo,
  setCollectMemo,
  sceneBitsWords,
  runSceneWorker,
  runScenePipeline,
  refitGroupBoundsViews,
  refitGroupBoundsForcedViews,
  recommendSceneStrategy,
  rankNodeVisible,
  popcountBits,
  measureScenePipeline,
  isVisibleRank,
  instancePoolBase,
  instanceMatricesView,
  groupSphereCounters,
  gpuInstanceSource,
  freeListWord,
  fillBits,
  extractFrustumPlanes,
  estimatePipelineMs,
  cullViewsHierarchical,
  cullViewsBrute,
  cullMemoCounters,
  createSceneWorkerBridge,
  createSceneStoreMirror,
  createSceneFromBuffer,
  createSceneBuffer,
  createScene,
  createRenderableRegistry,
  createCamera,
  collectMemoCounters,
  collectInstancesViews,
  collectGroupMatrices,
  classifySphere,
  buildSceneViews,
  bitsBase,
  applyObliqueClipPlane,
  WORKER_SYNC_MS,
  WORKER_PIPELINE_INFLATION,
  STATIC_NS_PER_NODE,
  SPHERE_OUTSIDE,
  SPHERE_INTERSECT,
  SPHERE_INSIDE,
  SCENE_MAGIC,
  RENDER_PASS_ORDER,
  PLANE_TOP,
  PLANE_RIGHT,
  PLANE_NEAR,
  PLANE_LEFT,
  PLANE_FAR,
  PLANE_BOTTOM,
  NF_VISIBLE,
  NF_ALIVE,
  MIN_GAIN_MS,
  INSTANCE_NS,
  INSTANCE_BIT_FILTER_WGSL,
  H_WORDS,
  H_STALE_TAKES,
  H_OUTPUT_EPOCH,
  H_NODE_COUNT,
  H_MAX_INSTANCES,
  H_MAGIC,
  H_LAYOUT_EPOCH,
  H_INT_WORDS,
  H_INSTANCE_POOL,
  H_INPUT_EPOCH,
  H_GROUP_MAX,
  H_GROUP_COUNT,
  H_FLOAT_FLOATS,
  H_DROPPED_INSTANCES,
  H_COLLECT_LAYOUT_EPOCH,
  H_CMD_FLAGS,
  H_CLOCK,
  H_CAPACITY,
  H_CAMERA_MAX,
  H_CAMERA_COUNT,
  H_BITS_WORDS,
  CMD_UPDATE_WORLD,
  CMD_STOP,
  CMD_REFIT,
  CMD_INSTANCES,
  CMD_CULL,
  CMD_ALL,
  ANIMATED_NS_PER_NODE
};
