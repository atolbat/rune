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
// packages/core/src/random.ts
function hash01(seed, index, salt) {
  let h = Math.imul(seed | 0, 374761393) + Math.imul(index | 0, 668265263) + Math.imul(salt | 0, 2246822519) | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
// packages/particles/src/noise.ts
function validateNoise(noise) {
  if (!Number.isFinite(noise.strength)) {
    throw new Error(`rune/particles: noise.strength must be finite (got ${noise.strength})`);
  }
  if (!Number.isFinite(noise.scale) || noise.scale <= 0) {
    throw new Error(`rune/particles: noise.scale must be a finite > 0 (got ${noise.scale})`);
  }
  if (!Number.isFinite(noise.speed) || noise.speed < 0) {
    throw new Error(`rune/particles: noise.speed must be a finite >= 0 (got ${noise.speed})`);
  }
  return noise;
}

// packages/particles/src/ramp.ts
var CONSTANT_RAMP = { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] };
var RAMP_STRIDE = 6;
var COMPILED = new WeakMap;
function flatRamp(ramp) {
  let flat = COMPILED.get(ramp);
  if (flat === undefined) {
    const pts = ramp.points;
    flat = new Float64Array(pts.length * 7);
    for (let i = 0;i < pts.length; i++) {
      const p = pts[i];
      const b = i * 7;
      flat[b] = p.t;
      flat[b + 1] = p.size;
      flat[b + 2] = p.r;
      flat[b + 3] = p.g;
      flat[b + 4] = p.b;
      flat[b + 5] = p.a;
      flat[b + 6] = p.frame ?? 0;
    }
    COMPILED.set(ramp, flat);
  }
  return flat;
}
function createRamp(points) {
  if (points.length === 0)
    throw new Error("rune/particles: a ramp needs at least one control point");
  let prev = -Infinity;
  for (const p of points) {
    const t = p.t;
    if (!Number.isFinite(t + p.size + p.r + p.g + p.b + p.a)) {
      throw new Error("rune/particles: ramp control points must be finite");
    }
    if (p.frame !== undefined && !Number.isFinite(p.frame)) {
      throw new Error("rune/particles: ramp frame must be finite (the atlas tile index)");
    }
    if (t < 0 || t > 1)
      throw new Error(`rune/particles: ramp t must be in [0, 1] (got ${t})`);
    if (t <= prev)
      throw new Error("rune/particles: ramp control points must be sorted by ascending t");
    prev = t;
  }
  return { points };
}
function sampleRamp(ramp, t, out) {
  const flat = flatRamp(ramp);
  const n = flat.length / 7;
  if (n === 1) {
    out[0] = flat[1];
    out[1] = flat[2];
    out[2] = flat[3];
    out[3] = flat[4];
    out[4] = flat[5];
    out[5] = flat[6];
    return;
  }
  if (t <= flat[0]) {
    out[0] = flat[1];
    out[1] = flat[2];
    out[2] = flat[3];
    out[3] = flat[4];
    out[4] = flat[5];
    out[5] = flat[6];
    return;
  }
  const last = (n - 1) * 7;
  if (t >= flat[last]) {
    out[0] = flat[last + 1];
    out[1] = flat[last + 2];
    out[2] = flat[last + 3];
    out[3] = flat[last + 4];
    out[4] = flat[last + 5];
    out[5] = flat[last + 6];
    return;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (flat[mid * 7] <= t)
      lo = mid;
    else
      hi = mid;
  }
  const a = lo * 7, b = hi * 7;
  const span = flat[b] - flat[a];
  const k = span > 0 ? (t - flat[a]) / span : 0;
  out[0] = flat[a + 1] + (flat[b + 1] - flat[a + 1]) * k;
  out[1] = flat[a + 2] + (flat[b + 2] - flat[a + 2]) * k;
  out[2] = flat[a + 3] + (flat[b + 3] - flat[a + 3]) * k;
  out[3] = flat[a + 4] + (flat[b + 4] - flat[a + 4]) * k;
  out[4] = flat[a + 5] + (flat[b + 5] - flat[a + 5]) * k;
  out[5] = flat[a + 6] + (flat[b + 6] - flat[a + 6]) * k;
}

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
var NO_FORCES = {
  gravity: [0, 0, 0],
  drag: 0,
  turbulence: 0,
  attract: null,
  speedCurve: null,
  collide: null,
  noise: null,
  seek: null,
  limitSpeed: null
};
var MAX_PLANES = 16;
var MAX_SPHERES = 8;
var MAX_BOXES = 8;
var MAX_COLLIDE_EVENTS = 512;
function createParticleSystem(capacity, options = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2 ** 24) {
    throw new Error(`rune/particles: capacity must be an integer in [1, 16777216] (got ${capacity})`);
  }
  const f = {
    px: new Float32Array(capacity),
    py: new Float32Array(capacity),
    pz: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    vz: new Float32Array(capacity),
    age: new Float32Array(capacity),
    life: new Float32Array(capacity),
    size: new Float32Array(capacity),
    cr: new Float32Array(capacity),
    cg: new Float32Array(capacity),
    cb: new Float32Array(capacity),
    ca: new Float32Array(capacity),
    seed: new Float32Array(capacity),
    tx: new Float32Array(capacity),
    ty: new Float32Array(capacity),
    tz: new Float32Array(capacity)
  };
  const out = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 1,
    size: 1,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    seed: 0,
    tx: NaN,
    ty: NaN,
    tz: NaN
  };
  const retireRec = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    age: 0,
    life: 0,
    size: 0,
    r: 0,
    g: 0,
    b: 0,
    a: 0,
    seed: 0
  };
  const onRetire = options.onRetire;
  const onSwap = options.onSwap;
  const curveScratch = new Float32Array(6);
  const curvePrev = new Float32Array(6);
  const flatPlanes = new Float64Array(MAX_PLANES * 8);
  const flatSpheres = new Float64Array(MAX_SPHERES * 8);
  const flatBoxes = new Float64Array(MAX_BOXES * 10);
  const collideEvents = new Float64Array(MAX_COLLIDE_EVENTS * 8);
  let collideEventCount = 0;
  const collideRec = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, plane: 0, sphere: -1, box: -1 };
  let count = 0;
  let spawned = 0;
  let retired = 0;
  let dropped = 0;
  const system = {
    get count() {
      return count;
    },
    get fields() {
      return f;
    },
    get spawned() {
      return spawned;
    },
    get retired() {
      return retired;
    },
    get dropped() {
      return dropped;
    },
    emit(n, fill) {
      if (n <= 0)
        return 0;
      const room = capacity - count;
      const actual = Math.min(n, room);
      if (n > room)
        dropped += n - room;
      for (let i = 0;i < actual; i++) {
        fill(i, out);
        if (!Number.isFinite(out.life) || out.life <= 0) {
          throw new Error(`rune/particles: spawn record has life <= 0 or NaN (slot ${count})`);
        }
        if (!Number.isFinite(out.size) || out.size < 0) {
          throw new Error(`rune/particles: spawn record has size < 0 or NaN (slot ${count})`);
        }
        if (!Number.isFinite(out.x + out.y + out.z + out.vx + out.vy + out.vz + out.r + out.g + out.b + out.a)) {
          throw new Error(`rune/particles: spawn record has NaN in its vectors (slot ${count})`);
        }
        const s = count;
        f.px[s] = out.x;
        f.py[s] = out.y;
        f.pz[s] = out.z;
        f.vx[s] = out.vx;
        f.vy[s] = out.vy;
        f.vz[s] = out.vz;
        f.age[s] = 0;
        f.life[s] = out.life;
        f.size[s] = out.size;
        f.cr[s] = out.r;
        f.cg[s] = out.g;
        f.cb[s] = out.b;
        f.ca[s] = out.a;
        f.seed[s] = Number.isFinite(out.seed) ? out.seed - Math.floor(out.seed) : 0;
        f.tx[s] = Number.isFinite(out.tx) ? out.tx : out.x;
        f.ty[s] = Number.isFinite(out.ty) ? out.ty : out.y;
        f.tz[s] = Number.isFinite(out.tz) ? out.tz : out.z;
        count = s + 1;
      }
      spawned += actual;
      return actual;
    },
    advance(dt, forces) {
      if (count === 0)
        return;
      if (!Number.isFinite(dt) || dt <= 0)
        return;
      const { gravity, drag, turbulence } = forces;
      const gx = gravity[0] ?? 0, gy = gravity[1] ?? 0, gz = gravity[2] ?? 0;
      const dragFactor = drag > 0 ? Math.exp(-drag * dt) : 1;
      const hasTurb = turbulence !== 0 && Number.isFinite(turbulence);
      const at = forces.attract;
      const hasAttract = at !== undefined && at !== null;
      const atx = hasAttract ? at.point[0] ?? 0 : 0;
      const aty = hasAttract ? at.point[1] ?? 0 : 0;
      const atz = hasAttract ? at.point[2] ?? 0 : 0;
      const atS = hasAttract ? at.strength : 0;
      const soft2 = hasAttract ? (at.softening ?? 0.25) ** 2 : 1;
      const killR2 = hasAttract ? (at.killRadius ?? 0) ** 2 : 0;
      const speedCurve = forces.speedCurve ?? null;
      const hasCurve = speedCurve !== null;
      const collide = forces.collide ?? null;
      const planeCount = collide !== null ? Math.min(collide.planes?.length ?? 0, MAX_PLANES) : 0;
      const sphereCount = collide !== null ? Math.min(collide.spheres?.length ?? 0, MAX_SPHERES) : 0;
      const boxCount = collide !== null ? Math.min(collide.boxes?.length ?? 0, MAX_BOXES) : 0;
      const onCollide = collide !== null ? collide.onCollide : undefined;
      const wantEvents = onCollide !== undefined;
      collideEventCount = 0;
      if (planeCount > 0) {
        const planes = collide.planes;
        for (let p = 0;p < planeCount; p++) {
          const plane = planes[p];
          let nx = plane.normal[0] ?? 0, ny = plane.normal[1] ?? 0, nz = plane.normal[2] ?? 0;
          const nl = Math.hypot(nx, ny, nz);
          if (nl < 0.000000000001) {
            nx = 0;
            ny = 1;
            nz = 0;
          } else {
            nx /= nl;
            ny /= nl;
            nz /= nl;
          }
          const b = p * 8;
          flatPlanes[b] = nx;
          flatPlanes[b + 1] = ny;
          flatPlanes[b + 2] = nz;
          flatPlanes[b + 3] = plane.point[0] ?? 0;
          flatPlanes[b + 4] = plane.point[1] ?? 0;
          flatPlanes[b + 5] = plane.point[2] ?? 0;
          flatPlanes[b + 6] = 1 - (plane.friction ?? 0);
          flatPlanes[b + 7] = plane.kill === true ? 1 : 0;
        }
      }
      if (sphereCount > 0) {
        const spheres = collide.spheres;
        for (let s = 0;s < sphereCount; s++) {
          const sp = spheres[s];
          const b = s * 8;
          flatSpheres[b] = sp.center[0] ?? 0;
          flatSpheres[b + 1] = sp.center[1] ?? 0;
          flatSpheres[b + 2] = sp.center[2] ?? 0;
          flatSpheres[b + 3] = sp.radius;
          flatSpheres[b + 4] = sp.restitution;
          flatSpheres[b + 5] = 1 - (sp.friction ?? 0);
          flatSpheres[b + 6] = sp.kill === true ? 1 : 0;
        }
      }
      if (boxCount > 0) {
        const boxes = collide.boxes;
        for (let q = 0;q < boxCount; q++) {
          const bx = boxes[q];
          const b = q * 10;
          flatBoxes[b] = bx.center[0] ?? 0;
          flatBoxes[b + 1] = bx.center[1] ?? 0;
          flatBoxes[b + 2] = bx.center[2] ?? 0;
          flatBoxes[b + 3] = bx.half[0] ?? 0;
          flatBoxes[b + 4] = bx.half[1] ?? 0;
          flatBoxes[b + 5] = bx.half[2] ?? 0;
          flatBoxes[b + 6] = bx.restitution;
          flatBoxes[b + 7] = 1 - (bx.friction ?? 0);
          flatBoxes[b + 8] = bx.kill === true ? 1 : 0;
        }
      }
      const noise = forces.noise ?? null;
      const hasNoise = noise !== null && noise.strength !== 0;
      const nStrength = hasNoise ? noise.strength : 0;
      const nScale = hasNoise ? noise.scale : 1;
      const nSpeed = hasNoise ? noise.speed : 0;
      const seek = forces.seek ?? null;
      const hasSeek = seek !== null;
      const seekK = hasSeek ? seek.strength : 0;
      const seekC = hasSeek ? seek.damping : 0;
      const limitSpeed = forces.limitSpeed ?? null;
      const hasLimit = limitSpeed !== null;
      const lsLimit = hasLimit ? limitSpeed.limit : 0;
      const lsDampen = hasLimit ? limitSpeed.dampen : 0;
      let i = count - 1;
      while (i >= 0) {
        const age = f.age[i] + dt;
        const life = f.life[i];
        let vx = f.vx[i], vy = f.vy[i], vz = f.vz[i];
        if (hasCurve) {
          const t = life > 0 ? age / life : 0;
          sampleRamp(speedCurve, t, curveScratch);
          const tPrev = life > 0 ? Math.max(0, (age - dt) / life) : 0;
          sampleRamp(speedCurve, tPrev, curvePrev);
          const k = Math.max(0.000001, curveScratch[0]) / Math.max(0.000001, curvePrev[0]);
          vx *= k;
          vy *= k;
          vz *= k;
        }
        if (dragFactor !== 1) {
          vx *= dragFactor;
          vy *= dragFactor;
          vz *= dragFactor;
        }
        if (hasLimit) {
          const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
          if (speed > lsLimit && speed > 0.000000001) {
            let k = 1 - (speed - lsLimit) / speed * lsDampen * dt * 20;
            if (k < 0)
              k = 0;
            vx *= k;
            vy *= k;
            vz *= k;
          }
        }
        vx += gx * dt;
        vy += gy * dt;
        vz += gz * dt;
        if (hasAttract) {
          const dx = atx - f.px[i], dy = aty - f.py[i], dz = atz - f.pz[i];
          const r2 = dx * dx + dy * dy + dz * dz;
          const r = Math.sqrt(r2);
          if (r > 0.000001) {
            const k = atS * dt / (r * (r2 + soft2));
            vx += dx * k;
            vy += dy * k;
            vz += dz * k;
          }
          if (killR2 > 0 && r2 < killR2)
            f.life[i] = 0;
        }
        if (hasTurb) {
          const ph = f.seed[i] * 37;
          const t = age * 5 + ph;
          vx += Math.sin(t) * turbulence * dt;
          vy += Math.sin(t * 1.7 + 11.3) * turbulence * dt;
          vz += Math.cos(t * 0.9 + 4.7) * turbulence * dt;
        }
        if (hasNoise) {
          const px = f.px[i], py = f.py[i], pz = f.pz[i];
          const adrift = age * nSpeed;
          const so = f.seed[i] * 13.7;
          const sx = px * nScale + adrift, sy = py * nScale, sz = pz * nScale;
          vx += simplex3(sx, sy + so, sz + 5.3) * nStrength * dt;
          vy += simplex3(sx + 11.7, sy + adrift, sz + 9.1 + so) * nStrength * dt;
          vz += simplex3(sx + 3.1, sy + 7.7 + so, sz + adrift) * nStrength * dt;
        }
        if (hasSeek) {
          vx += ((f.tx[i] - f.px[i]) * seekK - vx * seekC) * dt;
          vy += ((f.ty[i] - f.py[i]) * seekK - vy * seekC) * dt;
          vz += ((f.tz[i] - f.pz[i]) * seekK - vz * seekC) * dt;
        }
        f.px[i] += vx * dt;
        f.py[i] += vy * dt;
        f.pz[i] += vz * dt;
        for (let p = 0;p < planeCount; p++) {
          const b = p * 8;
          const nx = flatPlanes[b], ny = flatPlanes[b + 1], nz = flatPlanes[b + 2];
          const d = (f.px[i] - flatPlanes[b + 3]) * nx + (f.py[i] - flatPlanes[b + 4]) * ny + (f.pz[i] - flatPlanes[b + 5]) * nz;
          if (d >= 0)
            continue;
          const vn = vx * nx + vy * ny + vz * nz;
          if (vn >= 0)
            continue;
          const e = collide.planes[p].restitution;
          const rlx = vx - (1 + e) * vn * nx;
          const rly = vy - (1 + e) * vn * ny;
          const rlz = vz - (1 + e) * vn * nz;
          const keep = flatPlanes[b + 6];
          const vnn = rlx * nx + rly * ny + rlz * nz;
          vx = vnn * nx + keep * (rlx - vnn * nx);
          vy = vnn * ny + keep * (rly - vnn * ny);
          vz = vnn * nz + keep * (rlz - vnn * nz);
          const push = -d + 0.0001;
          f.px[i] += push * nx;
          f.py[i] += push * ny;
          f.pz[i] += push * nz;
          if (flatPlanes[b + 7] === 1)
            f.life[i] = 0;
          if (wantEvents && collideEventCount < MAX_COLLIDE_EVENTS) {
            const eb = collideEventCount * 8;
            collideEvents[eb] = f.px[i];
            collideEvents[eb + 1] = f.py[i];
            collideEvents[eb + 2] = f.pz[i];
            collideEvents[eb + 3] = vx;
            collideEvents[eb + 4] = vy;
            collideEvents[eb + 5] = vz;
            collideEvents[eb + 6] = 0;
            collideEvents[eb + 7] = p;
            collideEventCount++;
          }
        }
        for (let s = 0;s < sphereCount; s++) {
          const b = s * 8;
          let nx = f.px[i] - flatSpheres[b], ny = f.py[i] - flatSpheres[b + 1], nz = f.pz[i] - flatSpheres[b + 2];
          const R = flatSpheres[b + 3];
          const r2 = nx * nx + ny * ny + nz * nz;
          if (r2 >= R * R)
            continue;
          const r = Math.sqrt(r2);
          if (r < 0.000001) {
            nx = 0;
            ny = 1;
            nz = 0;
          } else {
            nx /= r;
            ny /= r;
            nz /= r;
          }
          const vn = vx * nx + vy * ny + vz * nz;
          if (vn >= 0)
            continue;
          const e = flatSpheres[b + 4];
          const rlx = vx - (1 + e) * vn * nx;
          const rly = vy - (1 + e) * vn * ny;
          const rlz = vz - (1 + e) * vn * nz;
          const keep = flatSpheres[b + 5];
          const vnn = rlx * nx + rly * ny + rlz * nz;
          vx = vnn * nx + keep * (rlx - vnn * nx);
          vy = vnn * ny + keep * (rly - vnn * ny);
          vz = vnn * nz + keep * (rlz - vnn * nz);
          const push = R - r + 0.0001;
          f.px[i] += push * nx;
          f.py[i] += push * ny;
          f.pz[i] += push * nz;
          if (flatSpheres[b + 6] === 1)
            f.life[i] = 0;
          if (wantEvents && collideEventCount < MAX_COLLIDE_EVENTS) {
            const eb = collideEventCount * 8;
            collideEvents[eb] = f.px[i];
            collideEvents[eb + 1] = f.py[i];
            collideEvents[eb + 2] = f.pz[i];
            collideEvents[eb + 3] = vx;
            collideEvents[eb + 4] = vy;
            collideEvents[eb + 5] = vz;
            collideEvents[eb + 6] = 1;
            collideEvents[eb + 7] = s;
            collideEventCount++;
          }
        }
        for (let q = 0;q < boxCount; q++) {
          const b = q * 10;
          const lx = f.px[i] - flatBoxes[b], ly = f.py[i] - flatBoxes[b + 1], lz = f.pz[i] - flatBoxes[b + 2];
          const hx = flatBoxes[b + 3], hy = flatBoxes[b + 4], hz = flatBoxes[b + 5];
          if (Math.abs(lx) >= hx || Math.abs(ly) >= hy || Math.abs(lz) >= hz)
            continue;
          const px = hx - Math.abs(lx), py = hy - Math.abs(ly), pz = hz - Math.abs(lz);
          let nx = 0, ny = 0, nz = 0, surf = hx;
          const mn = Math.min(px, py, pz);
          if (mn === py) {
            surf = hy;
            ny = Math.sign(ly) || 1;
          } else if (mn === pz) {
            surf = hz;
            nz = Math.sign(lz) || 1;
          } else {
            nx = Math.sign(lx) || 1;
          }
          const vn = vx * nx + vy * ny + vz * nz;
          if (vn >= 0)
            continue;
          const e = flatBoxes[b + 6];
          const rlx = vx - (1 + e) * vn * nx;
          const rly = vy - (1 + e) * vn * ny;
          const rlz = vz - (1 + e) * vn * nz;
          const keep = flatBoxes[b + 7];
          const vnn = rlx * nx + rly * ny + rlz * nz;
          vx = vnn * nx + keep * (rlx - vnn * nx);
          vy = vnn * ny + keep * (rly - vnn * ny);
          vz = vnn * nz + keep * (rlz - vnn * nz);
          const push = surf - Math.abs(nx ? lx : ny ? ly : lz) + 0.0001;
          f.px[i] += push * nx;
          f.py[i] += push * ny;
          f.pz[i] += push * nz;
          if (flatBoxes[b + 8] === 1)
            f.life[i] = 0;
          if (wantEvents && collideEventCount < MAX_COLLIDE_EVENTS) {
            const eb = collideEventCount * 8;
            collideEvents[eb] = f.px[i];
            collideEvents[eb + 1] = f.py[i];
            collideEvents[eb + 2] = f.pz[i];
            collideEvents[eb + 3] = vx;
            collideEvents[eb + 4] = vy;
            collideEvents[eb + 5] = vz;
            collideEvents[eb + 6] = 2;
            collideEvents[eb + 7] = q;
            collideEventCount++;
          }
        }
        if (age >= f.life[i]) {
          if (onRetire !== undefined) {
            retireRec.x = f.px[i];
            retireRec.y = f.py[i];
            retireRec.z = f.pz[i];
            retireRec.vx = vx;
            retireRec.vy = vy;
            retireRec.vz = vz;
            retireRec.age = age;
            retireRec.life = life;
            retireRec.size = f.size[i];
            retireRec.r = f.cr[i];
            retireRec.g = f.cg[i];
            retireRec.b = f.cb[i];
            retireRec.a = f.ca[i];
            retireRec.seed = f.seed[i];
            onRetire(retireRec);
          }
          const last = count - 1;
          if (last !== i) {
            if (onSwap !== undefined)
              onSwap(i, last);
            f.px[i] = f.px[last];
            f.py[i] = f.py[last];
            f.pz[i] = f.pz[last];
            f.vx[i] = f.vx[last];
            f.vy[i] = f.vy[last];
            f.vz[i] = f.vz[last];
            f.age[i] = f.age[last];
            f.life[i] = f.life[last];
            f.size[i] = f.size[last];
            f.cr[i] = f.cr[last];
            f.cg[i] = f.cg[last];
            f.cb[i] = f.cb[last];
            f.ca[i] = f.ca[last];
            f.seed[i] = f.seed[last];
            f.tx[i] = f.tx[last];
            f.ty[i] = f.ty[last];
            f.tz[i] = f.tz[last];
          }
          count = last;
          retired++;
        } else {
          f.age[i] = age;
          f.vx[i] = vx;
          f.vy[i] = vy;
          f.vz[i] = vz;
        }
        i--;
      }
      if (collideEventCount > 0 && onCollide !== undefined) {
        for (let e = 0;e < collideEventCount; e++) {
          const b = e * 8;
          collideRec.x = collideEvents[b];
          collideRec.y = collideEvents[b + 1];
          collideRec.z = collideEvents[b + 2];
          collideRec.vx = collideEvents[b + 3];
          collideRec.vy = collideEvents[b + 4];
          collideRec.vz = collideEvents[b + 5];
          const kind = collideEvents[b + 6], idx = collideEvents[b + 7];
          collideRec.plane = kind === 0 ? idx : -1;
          collideRec.sphere = kind === 1 ? idx : -1;
          collideRec.box = kind === 2 ? idx : -1;
          onCollide(collideRec);
        }
        collideEventCount = 0;
      }
    },
    clear() {
      retired += count;
      count = 0;
    },
    advanceLedger(dt) {
      if (count === 0)
        return;
      if (!Number.isFinite(dt) || dt <= 0)
        return;
      let i = count - 1;
      while (i >= 0) {
        const age = f.age[i] + dt;
        const life = f.life[i];
        if (age >= life) {
          if (onRetire !== undefined) {
            retireRec.x = f.px[i];
            retireRec.y = f.py[i];
            retireRec.z = f.pz[i];
            retireRec.vx = f.vx[i];
            retireRec.vy = f.vy[i];
            retireRec.vz = f.vz[i];
            retireRec.age = age;
            retireRec.life = life;
            retireRec.size = f.size[i];
            retireRec.r = f.cr[i];
            retireRec.g = f.cg[i];
            retireRec.b = f.cb[i];
            retireRec.a = f.ca[i];
            retireRec.seed = f.seed[i];
            onRetire(retireRec);
          }
          const last = count - 1;
          if (last !== i) {
            if (onSwap !== undefined)
              onSwap(i, last);
            f.px[i] = f.px[last];
            f.py[i] = f.py[last];
            f.pz[i] = f.pz[last];
            f.vx[i] = f.vx[last];
            f.vy[i] = f.vy[last];
            f.vz[i] = f.vz[last];
            f.age[i] = f.age[last];
            f.life[i] = f.life[last];
            f.size[i] = f.size[last];
            f.cr[i] = f.cr[last];
            f.cg[i] = f.cg[last];
            f.cb[i] = f.cb[last];
            f.ca[i] = f.ca[last];
            f.seed[i] = f.seed[last];
            f.tx[i] = f.tx[last];
            f.ty[i] = f.ty[last];
            f.tz[i] = f.tz[last];
          }
          count = last;
          retired++;
        } else {
          f.age[i] = age;
        }
        i--;
      }
    }
  };
  return system;
}
// packages/particles/src/spawn.ts
var TAU = 6.283185307179586;
var S_DIR = 1;
var S_SPD = 2;
var S_LIFE = 3;
var S_SIZE = 4;
var S_COL = 5;
var S_SEED = 6;
var S_P0 = 7;
var S_P1 = 8;
var S_P2 = 9;
var S_TARGET = 10;
var S_SCAT0 = 11;
var S_SCAT1 = 12;
var S_PATH0 = 13;
var S_PATH1 = 14;
var S_PATH2 = 15;
var S_PATH3 = 16;
function createSpawner(desc) {
  const shape = desc.shape;
  const velocity = desc.velocity;
  const speed = rangeOf(desc.speed, "speed");
  const life = rangeOf(desc.life, "life");
  const size = rangeOf(desc.size, "size");
  if (life[0] <= 0)
    throw new Error("rune/particles: spawner life must be > 0 (a zero-life particle is born dead)");
  if (size[0] < 0)
    throw new Error("rune/particles: spawner size must be >= 0");
  const seed = (desc.seed ?? 1) | 0;
  const c0 = desc.color[0], c1 = desc.color[1];
  const ox = shape.kind === "line" ? shape.from[0] : shape.kind === "path" ? shape.points[0] : shape.origin[0];
  const oy = shape.kind === "line" ? shape.from[1] : shape.kind === "path" ? shape.points[1] : shape.origin[1];
  const oz = shape.kind === "line" ? shape.from[2] : shape.kind === "path" ? shape.points[2] : shape.origin[2];
  let ax = 0, ay = 0, az = 1;
  let lineLen = 0;
  const hasAxis = shape.kind === "cone" || shape.kind === "disc" || shape.kind === "line" || shape.kind === "hemisphere" || shape.kind === "donut" || shape.kind === "rectangle" || shape.kind === "grid";
  if (hasAxis) {
    const vx = shape.kind === "line" ? shape.to[0] - ox : shape.axis[0];
    const vy = shape.kind === "line" ? shape.to[1] - oy : shape.axis[1];
    const vz = shape.kind === "line" ? shape.to[2] - oz : shape.axis[2];
    const l = Math.hypot(vx, vy, vz);
    if (l === 0 || !Number.isFinite(l))
      throw new Error("rune/particles: the shape axis (or the line endpoints) must be a finite non-zero vector");
    ax = vx / l;
    ay = vy / l;
    az = vz / l;
    if (shape.kind === "line")
      lineLen = l;
  }
  let lineLattice = false, lineCount = 0;
  if (shape.kind === "line") {
    const sp = shape.spacing ?? 0.25;
    if (shape.spacing !== undefined && (!Number.isFinite(sp) || sp <= 0)) {
      throw new Error(`rune/particles: line spacing must be a finite > 0 (got ${shape.spacing})`);
    }
    if (shape.count !== undefined && (!Number.isInteger(shape.count) || shape.count < 1)) {
      throw new Error(`rune/particles: line count must be an integer >= 1 (got ${shape.count})`);
    }
    lineLattice = shape.mode === "lattice";
    lineCount = lineLattice ? shape.count ?? Math.max(1, Math.round(lineLen / sp)) : 0;
  }
  let rMin = 0, rMax = 0;
  if (shape.kind === "sphere" || shape.kind === "disc" || shape.kind === "hemisphere") {
    [rMin, rMax] = rangeOf(shape.radius, "radius");
    if (rMin < 0)
      throw new Error("rune/particles: shape radius must be >= 0");
  }
  let halfAngle = 0, baseRadius = 0, lenMin = 0, lenMax = 0;
  if (shape.kind === "cone") {
    halfAngle = shape.halfAngle;
    if (!(halfAngle >= 0 && halfAngle < Math.PI / 2))
      throw new Error("rune/particles: cone halfAngle must be in [0, π/2)");
    baseRadius = shape.baseRadius;
    if (baseRadius < 0)
      throw new Error("rune/particles: cone baseRadius must be >= 0");
    [lenMin, lenMax] = rangeOf(shape.length, "length");
  }
  let hemArc = TAU;
  if (shape.kind === "hemisphere") {
    hemArc = shape.arc ?? TAU;
    if (!Number.isFinite(hemArc) || hemArc <= 0)
      throw new Error(`rune/particles: hemisphere arc must be a finite > 0 (got ${hemArc})`);
  }
  let donR = 0, tubeMin = 0, tubeMax = 0, donArc = TAU;
  if (shape.kind === "donut") {
    donR = shape.radius;
    if (!Number.isFinite(donR) || donR <= 0)
      throw new Error(`rune/particles: donut radius must be a finite > 0 (got ${donR})`);
    [tubeMin, tubeMax] = rangeOf(shape.tube, "tube");
    if (tubeMin < 0)
      throw new Error("rune/particles: donut tube must be >= 0");
    donArc = shape.arc ?? TAU;
    if (!Number.isFinite(donArc) || donArc <= 0)
      throw new Error(`rune/particles: donut arc must be a finite > 0 (got ${donArc})`);
  }
  let rectW = 0, rectH = 0;
  if (shape.kind === "rectangle") {
    rectW = shape.width;
    rectH = shape.height;
    if (!Number.isFinite(rectW) || rectW < 0 || !Number.isFinite(rectH) || rectH < 0) {
      throw new Error(`rune/particles: rectangle width/height must be finite >= 0 (got ${rectW}×${rectH})`);
    }
  }
  let gridW = 0, gridH = 0, gridRows = 0, gridCols = 0, gridLattice = false;
  if (shape.kind === "grid") {
    gridW = shape.width;
    gridH = shape.height;
    gridRows = Math.floor(shape.rows);
    gridCols = Math.floor(shape.columns);
    gridLattice = shape.mode === "lattice";
    if (!Number.isFinite(gridW) || gridW <= 0 || !Number.isFinite(gridH) || gridH <= 0) {
      throw new Error(`rune/particles: grid width/height must be finite > 0 (got ${gridW}×${gridH})`);
    }
    if (!Number.isInteger(gridRows) || gridRows < 1 || !Number.isInteger(gridCols) || gridCols < 1) {
      throw new Error(`rune/particles: grid rows/columns must be integers >= 1 (got ${gridRows}×${gridCols})`);
    }
  }
  let pathPts = null;
  let pathDirs = null;
  let pathPerp = null;
  let pathSegs = 0, pathLattice = false, pathScatter = 0;
  if (shape.kind === "path") {
    const pts = shape.points;
    if (!Array.isArray(pts) && !(pts instanceof Float64Array) && !(pts instanceof Float32Array)) {
      throw new Error("rune/particles: path points must be a flat array of xyz triples");
    }
    if (pts.length < 6 || pts.length % 3 !== 0) {
      throw new Error(`rune/particles: path needs >= 2 points as a flat xyz array (got ${pts.length} numbers)`);
    }
    let allFinite = true;
    for (let k = 0;k < pts.length; k++) {
      if (!Number.isFinite(pts[k])) {
        allFinite = false;
        break;
      }
    }
    if (!allFinite)
      throw new Error("rune/particles: path points must all be finite");
    pathSegs = pts.length / 3 - 1;
    pathLattice = shape.mode === "lattice";
    pathScatter = shape.scatter ?? 0;
    if (!Number.isFinite(pathScatter) || pathScatter < 0) {
      throw new Error(`rune/particles: path scatter must be a finite >= 0 (got ${shape.scatter})`);
    }
    pathPts = Float64Array.from(pts);
    pathDirs = new Float64Array(pathSegs * 3);
    pathPerp = pathScatter > 0 ? new Float64Array(pathSegs * 6) : null;
    for (let s = 0;s < pathSegs; s++) {
      const b = s * 3;
      const dx = pts[b + 3] - pts[b], dy = pts[b + 4] - pts[b + 1], dz = pts[b + 5] - pts[b + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l === 0 || !Number.isFinite(l)) {
        throw new Error(`rune/particles: path segment ${s} has zero length (points ${s} and ${s + 1} coincide) — no direction to emit along`);
      }
      const ndx = dx / l, ndy = dy / l, ndz = dz / l;
      pathDirs[b] = ndx;
      pathDirs[b + 1] = ndy;
      pathDirs[b + 2] = ndz;
      if (pathPerp !== null) {
        let p1x = ndz, p1y = 0, p1z = -ndx;
        let pl = Math.hypot(p1x, p1y, p1z);
        if (pl < 0.000001) {
          p1x = 1;
          p1y = 0;
          p1z = 0;
          pl = 1;
        }
        p1x /= pl;
        p1z /= pl;
        pathPerp[b * 2] = p1x;
        pathPerp[b * 2 + 1] = p1y;
        pathPerp[b * 2 + 2] = p1z;
        pathPerp[b * 2 + 3] = ndy * p1z - ndz * p1y;
        pathPerp[b * 2 + 4] = ndz * p1x - ndx * p1z;
        pathPerp[b * 2 + 5] = ndx * p1y - ndy * p1x;
      }
    }
  }
  let arms = 0, armSpread = 0.35, twist = 0;
  if (shape.kind === "disc" && shape.arms !== undefined) {
    arms = shape.arms;
    if (!Number.isInteger(arms) || arms < 1)
      throw new Error(`rune/particles: disc arms must be an integer >= 1 (got ${arms})`);
    armSpread = shape.armSpread ?? 0.35;
    if (!Number.isFinite(armSpread) || armSpread < 0)
      throw new Error(`rune/particles: disc armSpread must be a finite >= 0 (got ${armSpread})`);
    twist = shape.twist ?? 0;
    if (!Number.isFinite(twist))
      throw new Error(`rune/particles: disc twist must be finite (got ${twist})`);
  }
  let speedRef = 0, speedPower = 0;
  if (desc.speedByRadius !== undefined) {
    speedRef = desc.speedByRadius.ref;
    speedPower = desc.speedByRadius.power;
    if (!Number.isFinite(speedRef) || speedRef <= 0)
      throw new Error(`rune/particles: speedByRadius.ref must be a finite > 0 (got ${speedRef})`);
    if (!Number.isFinite(speedPower))
      throw new Error(`rune/particles: speedByRadius.power must be finite (got ${speedPower})`);
  }
  const colorByRadius = desc.colorByRadius === true;
  if (colorByRadius && shape.kind !== "disc" && shape.kind !== "sphere" && shape.kind !== "hemisphere") {
    throw new Error("rune/particles: colorByRadius needs the sphere, disc or hemisphere shape (the radius range drives the mix)");
  }
  let fx = 0, fy = 0, fz = 1;
  if (velocity.mode === "fixed") {
    const l = Math.hypot(velocity.dir[0], velocity.dir[1], velocity.dir[2]);
    if (l === 0 || !Number.isFinite(l))
      throw new Error("rune/particles: fixed velocity dir must be a finite non-zero vector");
    fx = velocity.dir[0] / l;
    fy = velocity.dir[1] / l;
    fz = velocity.dir[2] / l;
  } else if (velocity.mode === "lobe" && shape.kind !== "cone") {
    throw new Error("rune/particles: velocity mode 'lobe' needs the cone shape (its halfAngle defines the fan)");
  } else if (velocity.mode === "axis" && !hasAxis && shape.kind !== "path") {
    throw new Error("rune/particles: velocity mode 'axis' needs a shape with an axis (cone/disc/line/hemisphere/donut/rectangle/grid) or the path shape (its LOCAL segment direction)");
  } else if (velocity.mode === "tangential" && shape.kind !== "disc" && shape.kind !== "sphere" && shape.kind !== "donut" && shape.kind !== "hemisphere") {
    throw new Error("rune/particles: velocity mode 'tangential' needs the disc, sphere, donut or hemisphere shape");
  }
  let t1x = -az, t1y = 0, t1z = ax;
  let tl = Math.hypot(t1x, t1y, t1z);
  if (tl < 0.000001) {
    t1x = 1;
    t1y = 0;
    t1z = 0;
    tl = 1;
  }
  t1x /= tl;
  t1y /= tl;
  t1z /= tl;
  const t2x = ay * t1z - az * t1y, t2y = az * t1x - ax * t1z, t2z = ax * t1y - ay * t1x;
  let imgLit = null;
  let tgx = 0, tgy = 0, tgz = 0;
  let imgTx = 0, imgTy = 0, imgTz = 0, imgUx = 0, imgUy = 0, imgUz = 0;
  let imgW = 0, imgH = 0, imgWorldW = 0, imgWorldH = 0;
  let imgOx = 0, imgOy = 0, imgOz = 0;
  if (desc.target !== undefined) {
    const target = desc.target;
    if (target.mode === "point") {
      tgx = target.point[0];
      tgy = target.point[1];
      tgz = target.point[2];
      if (!Number.isFinite(tgx + tgy + tgz))
        throw new Error("rune/particles: target point must be three finite numbers");
    } else {
      const mask = target.mask;
      imgW = mask.width;
      imgH = mask.height;
      if (!Number.isInteger(imgW) || imgW < 1 || imgW > 65535 || !Number.isInteger(imgH) || imgH < 1 || imgH > 65535) {
        throw new Error(`rune/particles: target mask must be 1..65535 per side (got ${imgW}×${imgH})`);
      }
      if (mask.data.length < imgW * imgH) {
        throw new Error(`rune/particles: target mask data is ${mask.data.length} bytes — the ${imgW}×${imgH} mask needs ${imgW * imgH}`);
      }
      if (!Number.isFinite(target.width) || target.width <= 0 || !Number.isFinite(target.height) || target.height <= 0) {
        throw new Error(`rune/particles: target width/height must be finite > 0 (got ${target.width}×${target.height})`);
      }
      if (!Number.isFinite(target.origin[0] + target.origin[1] + target.origin[2])) {
        throw new Error("rune/particles: target origin must be three finite numbers");
      }
      let tax = target.axis[0], tay = target.axis[1], taz = target.axis[2];
      const tal = Math.hypot(tax, tay, taz);
      if (tal === 0 || !Number.isFinite(tal))
        throw new Error("rune/particles: target axis must be a finite non-zero vector");
      tax /= tal;
      tay /= tal;
      taz /= tal;
      let utx = taz, uty = 0, utz = -tax;
      let utl = Math.hypot(utx, uty, utz);
      if (utl < 0.000001) {
        utx = 1;
        uty = 0;
        utz = 0;
        utl = 1;
      }
      utx /= utl;
      uty /= utl;
      utz /= utl;
      imgUx = tay * utz - taz * uty;
      imgUy = taz * utx - tax * utz;
      imgUz = tax * uty - tay * utx;
      imgTx = utx;
      imgTy = uty;
      imgTz = utz;
      imgOx = target.origin[0];
      imgOy = target.origin[1];
      imgOz = target.origin[2];
      imgWorldW = target.width;
      imgWorldH = target.height;
      const lit = [];
      const data = mask.data;
      for (let y = 0;y < imgH; y++) {
        for (let x = 0;x < imgW; x++) {
          if (data[y * imgW + x] >= 128)
            lit.push(y << 16 | x);
        }
      }
      if (lit.length === 0)
        throw new Error("rune/particles: target mask has no lit pixels (≥ 128) — nothing to seek");
      imgLit = new Uint32Array(lit);
    }
  }
  return function spawner(index, out) {
    const u = hash01(seed, index, S_DIR);
    const v = hash01(seed, index, S_DIR + 100);
    let px = ox, py = oy, pz = oz;
    let dx = fx, dy = fy, dz = fz;
    if (shape.kind === "sphere") {
      const z = 1 - 2 * u;
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = TAU * v;
      dx = s * Math.cos(phi);
      dy = s * Math.sin(phi);
      dz = z;
      const r = rMin + (rMax - rMin) * hash01(seed, index, S_P0);
      px = ox + dx * r;
      py = oy + dy * r;
      pz = oz + dz * r;
    } else if (shape.kind === "cone") {
      const cosHalf = Math.cos(halfAngle);
      const z = 1 - (1 - cosHalf) * u;
      const s = Math.sqrt(Math.max(0, 1 - z * z));
      const phi = TAU * v;
      dx = ax * z + (t1x * Math.cos(phi) + t2x * Math.sin(phi)) * s;
      dy = ay * z + (t1y * Math.cos(phi) + t2y * Math.sin(phi)) * s;
      dz = az * z + (t1z * Math.cos(phi) + t2z * Math.sin(phi)) * s;
      const rr = baseRadius * Math.sqrt(hash01(seed, index, S_P0));
      const rphi = TAU * hash01(seed, index, S_P1);
      const stretch = lenMin + (lenMax - lenMin) * hash01(seed, index, S_P2);
      const cx = Math.cos(rphi) * rr, cy = Math.sin(rphi) * rr;
      px = ox + t1x * cx + t2x * cy + ax * stretch;
      py = oy + t1y * cx + t2y * cy + ay * stretch;
      pz = oz + t1z * cx + t2z * cy + az * stretch;
    } else if (shape.kind === "disc") {
      const r2 = rMin * rMin + (rMax * rMax - rMin * rMin) * u;
      const rr = Math.sqrt(r2);
      let phi;
      if (arms > 0) {
        const arm = Math.floor(hash01(seed, index, S_P0) * arms);
        const scatter = (hash01(seed, index, S_P1) - 0.5) * 2 * armSpread;
        const tR = (rr - rMin) / Math.max(0.000001, rMax - rMin);
        phi = arm * (TAU / arms) + twist * tR + scatter;
      } else {
        phi = TAU * v;
      }
      px = ox + (t1x * Math.cos(phi) + t2x * Math.sin(phi)) * rr;
      py = oy + (t1y * Math.cos(phi) + t2y * Math.sin(phi)) * rr;
      pz = oz + (t1z * Math.cos(phi) + t2z * Math.sin(phi)) * rr;
    } else if (shape.kind === "hemisphere") {
      const cosTheta = u;
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      const phi = hemArc * v;
      const r = rMin + (rMax - rMin) * hash01(seed, index, S_P0);
      dx = ax * cosTheta + (t1x * Math.cos(phi) + t2x * Math.sin(phi)) * sinTheta;
      dy = ay * cosTheta + (t1y * Math.cos(phi) + t2y * Math.sin(phi)) * sinTheta;
      dz = az * cosTheta + (t1z * Math.cos(phi) + t2z * Math.sin(phi)) * sinTheta;
      px = ox + dx * r;
      py = oy + dy * r;
      pz = oz + dz * r;
    } else if (shape.kind === "donut") {
      const phi = donArc * u;
      const tr = tubeMin + (tubeMax - tubeMin) * hash01(seed, index, S_P0);
      const psi = TAU * hash01(seed, index, S_P1);
      const cphi = Math.cos(phi), sphi = Math.sin(phi);
      const cpsi = Math.cos(psi), spsi = Math.sin(psi);
      const rrx = t1x * cphi + t2x * sphi, rry = t1y * cphi + t2y * sphi, rrz = t1z * cphi + t2z * sphi;
      px = ox + rrx * (donR + tr * cpsi) + ax * (tr * spsi);
      py = oy + rry * (donR + tr * cpsi) + ay * (tr * spsi);
      pz = oz + rrz * (donR + tr * cpsi) + az * (tr * spsi);
    } else if (shape.kind === "rectangle") {
      const hx = (u - 0.5) * rectW, hy = (v - 0.5) * rectH;
      px = ox + t1x * hx + t2x * hy;
      py = oy + t1y * hx + t2y * hy;
      pz = oz + t1z * hx + t2z * hy;
    } else if (shape.kind === "grid") {
      let col, row;
      if (gridLattice) {
        col = index % gridCols;
        row = Math.floor(index / gridCols) % gridRows;
      } else {
        col = Math.floor(hash01(seed, index, S_P0) * gridCols);
        row = Math.floor(hash01(seed, index, S_P1) * gridRows);
      }
      const gx = ((col + 0.5) / gridCols - 0.5) * gridW;
      const gy = ((row + 0.5) / gridRows - 0.5) * gridH;
      px = ox + t1x * gx + t2x * gy;
      py = oy + t1y * gx + t2y * gy;
      pz = oz + t1z * gx + t2z * gy;
    } else if (shape.kind === "line") {
      const lu = lineLattice ? (index % lineCount + 0.5) / lineCount : u;
      px = ox + (shape.to[0] - ox) * lu;
      py = oy + (shape.to[1] - oy) * lu;
      pz = oz + (shape.to[2] - oz) * lu;
    } else if (shape.kind === "path") {
      let seg;
      if (pathLattice)
        seg = (index % pathSegs + pathSegs) % pathSegs;
      else
        seg = Math.min(pathSegs - 1, Math.floor(hash01(seed, index, S_PATH0) * pathSegs));
      const b = seg * 3;
      const t = hash01(seed, index, S_PATH1);
      px = pathPts[b] + (pathPts[b + 3] - pathPts[b]) * t;
      py = pathPts[b + 1] + (pathPts[b + 4] - pathPts[b + 1]) * t;
      pz = pathPts[b + 2] + (pathPts[b + 5] - pathPts[b + 2]) * t;
      if (velocity.mode === "axis") {
        dx = pathDirs[b];
        dy = pathDirs[b + 1];
        dz = pathDirs[b + 2];
      }
      if (pathScatter > 0) {
        const pb = seg * 6;
        const rr = pathScatter * Math.sqrt(hash01(seed, index, S_PATH2));
        const th = TAU * hash01(seed, index, S_PATH3);
        const cth = Math.cos(th) * rr, sth = Math.sin(th) * rr;
        px += pathPerp[pb] * cth + pathPerp[pb + 3] * sth;
        py += pathPerp[pb + 1] * cth + pathPerp[pb + 4] * sth;
        pz += pathPerp[pb + 2] * cth + pathPerp[pb + 5] * sth;
      }
    }
    if (velocity.mode === "radial") {
      dx = px - ox;
      dy = py - oy;
      dz = pz - oz;
      const l = Math.hypot(dx, dy, dz);
      if (l > 0.000000000001) {
        dx /= l;
        dy /= l;
        dz /= l;
      } else {
        const theta = TAU * hash01(seed, index, S_SCAT0);
        const cphi = 2 * hash01(seed, index, S_SCAT1) - 1;
        const sphi = Math.sqrt(Math.max(0, 1 - cphi * cphi));
        dx = sphi * Math.cos(theta);
        dy = sphi * Math.sin(theta);
        dz = cphi;
      }
    } else if (velocity.mode === "axis" && shape.kind !== "path") {
      dx = ax;
      dy = ay;
      dz = az;
    } else if (velocity.mode === "tangential") {
      const rx = px - ox, ry = py - oy, rz = pz - oz;
      dx = ay * rz - az * ry;
      dy = az * rx - ax * rz;
      dz = ax * ry - ay * rx;
      const l = Math.hypot(dx, dy, dz);
      if (l > 0.000000000001) {
        dx /= l;
        dy /= l;
        dz /= l;
      } else {
        dx = ax;
        dy = ay;
        dz = az;
      }
    }
    let spd = speed[0] + (speed[1] - speed[0]) * hash01(seed, index, S_SPD);
    if (speedRef > 0) {
      const rdx = px - ox, rdy = py - oy, rdz = pz - oz;
      const rad = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
      spd *= Math.pow(speedRef / Math.max(rad, 0.01), speedPower);
    }
    let mix = hash01(seed, index, S_COL);
    if (colorByRadius) {
      const rdx = px - ox, rdy = py - oy, rdz = pz - oz;
      const rad = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz);
      mix = Math.min(1, Math.max(0, (rad - rMin) / Math.max(0.000001, rMax - rMin)));
    }
    if (imgLit !== null) {
      const lit = imgLit[Math.min(imgLit.length - 1, Math.floor(hash01(seed, index, S_TARGET) * imgLit.length))];
      const mx = ((lit & 65535) + 0.5) / imgW - 0.5;
      const my = ((lit >>> 16) + 0.5) / imgH - 0.5;
      const wx = mx * imgWorldW;
      const wy = -my * imgWorldH;
      out.tx = imgOx + imgTx * wx + imgUx * wy;
      out.ty = imgOy + imgTy * wx + imgUy * wy;
      out.tz = imgOz + imgTz * wx + imgUz * wy;
    } else if (desc.target !== undefined && desc.target.mode === "point") {
      out.tx = tgx;
      out.ty = tgy;
      out.tz = tgz;
    } else {
      out.tx = NaN;
      out.ty = NaN;
      out.tz = NaN;
    }
    out.x = px;
    out.y = py;
    out.z = pz;
    out.vx = dx * spd;
    out.vy = dy * spd;
    out.vz = dz * spd;
    out.life = life[0] + (life[1] - life[0]) * hash01(seed, index, S_LIFE);
    out.size = size[0] + (size[1] - size[0]) * hash01(seed, index, S_SIZE);
    out.r = c0[0] + (c1[0] - c0[0]) * mix;
    out.g = c0[1] + (c1[1] - c0[1]) * mix;
    out.b = c0[2] + (c1[2] - c0[2]) * mix;
    out.a = c0[3] + (c1[3] - c0[3]) * mix;
    out.seed = hash01(seed, index, S_SEED);
  };
}
function rangeOf(range, name) {
  const min = range[0], max = range[1];
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new Error(`rune/particles: spawner ${name} range must be [min <= max], finite (got [${min}, ${max}])`);
  }
  return [min, max];
}
// packages/particles/src/billboards.ts
var SOUP_STRIDE = 9;
var VERTS_PER_PARTICLE = 6;
function fillBillboards(system, basis, out, options = {}) {
  const ramp = options.ramp ?? CONSTANT_RAMP;
  const spin = options.spin ?? 0;
  const mode = options.mode ?? "camera";
  const f = system.fields;
  const count = system.count;
  const rx = basis.right[0], ry = basis.right[1], rz = basis.right[2];
  const ux = basis.up[0], uy = basis.up[1], uz = basis.up[2];
  const fx = basis.forward?.[0] ?? 0, fy = basis.forward?.[1] ?? 0, fz = basis.forward?.[2] ?? -1;
  const s = SCRATCH;
  const tiles = options.tiles;
  const tileU = tiles !== undefined ? tiles[0] : 1;
  const tileV = tiles !== undefined ? tiles[1] : 1;
  const useAtlas = tiles !== undefined;
  const frameJitter = options.frameJitter ?? 0;
  if (useAtlas && (!Number.isInteger(tileU) || tileU < 1 || !Number.isInteger(tileV) || tileV < 1)) {
    throw new Error(`rune/particles: billboard tiles must be integers >= 1 (got [${tileU}, ${tileV}])`);
  }
  const maxFrame = tileU * tileV - 1;
  let hzx = fz, hzy = 0, hzz = -fx;
  let hl = Math.hypot(hzx, hzy, hzz);
  if (hl < 0.000001) {
    hzx = 1;
    hzy = 0;
    hzz = 0;
    hl = 1;
  }
  hzx /= hl;
  hzy /= hl;
  hzz /= hl;
  const hfx = fx, hfy = 0, hfz = fz;
  let hfl = Math.hypot(hfx, hfy, hfz);
  if (hfl < 0.000001) {
    hfl = 1;
  }
  const gx = hfx / hfl, gy = 0, gz = hfz / hfl;
  const speedFactor = options.speedFactor ?? 0;
  const lengthFactor = options.lengthFactor ?? 1;
  const axisOpt = options.axis ?? "random";
  let oax = 0, oay = 0, oaz = 1;
  const axisRandom = axisOpt === "random";
  if (!axisRandom) {
    const a = axisOpt;
    const al = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
    if (al < 0.000000000001 || !Number.isFinite(al)) {
      throw new Error("rune/particles: the oriented axis must be a finite non-zero vector");
    }
    oax = (a[0] ?? 0) / al;
    oay = (a[1] ?? 0) / al;
    oaz = (a[2] ?? 0) / al;
  }
  const spin3d = options.spin3d ?? 0;
  let at = 0;
  const order = options.order;
  const ordered = order !== undefined && order !== null;
  const n = ordered ? order.length : count;
  for (let j = 0;j < n; j++) {
    const i = ordered ? order[j] : j;
    const age = f.age[i];
    const life = f.life[i];
    const t = life > 0 ? age / life : 0;
    sampleRamp(ramp, t, s);
    const half = f.size[i] * s[0] * 0.5;
    if (half <= 0)
      continue;
    const cr = f.cr[i] * s[1], cg = f.cg[i] * s[2], cb = f.cb[i] * s[3], ca = f.ca[i] * s[4];
    const px = f.px[i], py = f.py[i], pz = f.pz[i];
    let u0 = 0, v0 = 0, uS = 1, vS = 1;
    if (useAtlas) {
      let frame = Math.floor(s[5] + (frameJitter > 0 ? f.seed[i] * frameJitter : 0));
      if (!Number.isFinite(frame))
        frame = 0;
      if (frame < 0)
        frame = 0;
      if (frame > maxFrame)
        frame = maxFrame;
      u0 = frame % tileU / tileU;
      v0 = Math.floor(frame / tileU) / tileV;
      uS = 1 / tileU;
      vS = 1 / tileV;
    }
    if (mode === "camera") {
      let c1 = 1, s1 = 0, c2 = 0, s2 = 1;
      if (spin !== 0 || f.seed[i] !== 0) {
        const ang2 = f.seed[i] * 6.283185307179586 + age * spin;
        const cos = Math.cos(ang2), sin = Math.sin(ang2);
        c1 = cos;
        s1 = sin;
        c2 = -sin;
        s2 = cos;
      }
      const o0x2 = c1 * -half + c2 * -half, o0y2 = s1 * -half + s2 * -half;
      const o1x2 = c1 * half + c2 * -half, o1y2 = s1 * half + s2 * -half;
      const o2x2 = c1 * half + c2 * half, o2y2 = s1 * half + s2 * half;
      const o3x2 = c1 * -half + c2 * half, o3y2 = s1 * -half + s2 * half;
      at = vert(out, at, px + o0x2 * rx + o0y2 * ux, py + o0x2 * ry + o0y2 * uy, pz + o0x2 * rz + o0y2 * uz, u0, v0, cr, cg, cb, ca);
      at = vert(out, at, px + o1x2 * rx + o1y2 * ux, py + o1x2 * ry + o1y2 * uy, pz + o1x2 * rz + o1y2 * uz, u0 + uS, v0, cr, cg, cb, ca);
      at = vert(out, at, px + o2x2 * rx + o2y2 * ux, py + o2x2 * ry + o2y2 * uy, pz + o2x2 * rz + o2y2 * uz, u0 + uS, v0 + vS, cr, cg, cb, ca);
      at = vert(out, at, px + o0x2 * rx + o0y2 * ux, py + o0x2 * ry + o0y2 * uy, pz + o0x2 * rz + o0y2 * uz, u0, v0, cr, cg, cb, ca);
      at = vert(out, at, px + o2x2 * rx + o2y2 * ux, py + o2x2 * ry + o2y2 * uy, pz + o2x2 * rz + o2y2 * uz, u0 + uS, v0 + vS, cr, cg, cb, ca);
      at = vert(out, at, px + o3x2 * rx + o3y2 * ux, py + o3x2 * ry + o3y2 * uy, pz + o3x2 * rz + o3y2 * uz, u0, v0 + vS, cr, cg, cb, ca);
      continue;
    }
    if (mode === "vertical" || mode === "horizontal") {
      const arx = hzx, ary = hzy, arz = hzz;
      const auy = mode === "vertical" ? 1 : gy;
      const aux = mode === "vertical" ? 0 : gx;
      const auz = mode === "vertical" ? 0 : gz;
      const o0x2 = -half * arx + -half * aux, o0y2 = -half * ary + -half * auy, o0z2 = -half * arz + -half * auz;
      const o1x2 = half * arx + -half * aux, o1y2 = half * ary + -half * auy, o1z2 = half * arz + -half * auz;
      const o2x2 = half * arx + half * aux, o2y2 = half * ary + half * auy, o2z2 = half * arz + half * auz;
      const o3x2 = -half * arx + half * aux, o3y2 = -half * ary + half * auy, o3z2 = -half * arz + half * auz;
      at = vert3(out, at, px, py, pz, o0x2, o0y2, o0z2, u0, v0, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, o1x2, o1y2, o1z2, u0 + uS, v0, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, o2x2, o2y2, o2z2, u0 + uS, v0 + vS, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, o0x2, o0y2, o0z2, u0, v0, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, o2x2, o2y2, o2z2, u0 + uS, v0 + vS, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, o3x2, o3y2, o3z2, u0, v0 + vS, cr, cg, cb, ca);
      continue;
    }
    if (mode === "stretched") {
      const vx = f.vx[i], vy = f.vy[i], vz = f.vz[i];
      const vlen = Math.hypot(vx, vy, vz);
      if (vlen < 0.0001) {
        at = cameraQuad(out, at, px, py, pz, half, rx, ry, rz, ux, uy, uz, u0, v0, uS, vS, cr, cg, cb, ca);
        continue;
      }
      const dx = vx / vlen, dy = vy / vlen, dz = vz / vlen;
      let sx = fy * dz - fz * dy, sy = fz * dx - fx * dz, sz = fx * dy - fy * dx;
      let sl = Math.hypot(sx, sy, sz);
      if (sl < 0.000001) {
        sx = dy;
        sy = -dx;
        sz = 0;
        sl = Math.hypot(sx, sy, sz) || 1;
      }
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const sizeFull = f.size[i] * s[0];
      const tail = (vlen * speedFactor + lengthFactor) * sizeFull;
      const halfW = half;
      const h0x = -sx * halfW, h0y = -sy * halfW, h0z = -sz * halfW;
      const h1x = sx * halfW, h1y = sy * halfW, h1z = sz * halfW;
      const t0x = -dx * tail - sx * halfW, t0y = -dy * tail - sy * halfW, t0z = -dz * tail - sz * halfW;
      const t1x = -dx * tail + sx * halfW, t1y = -dy * tail + sy * halfW, t1z = -dz * tail + sz * halfW;
      at = vert3(out, at, px, py, pz, h0x, h0y, h0z, u0, v0, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, t0x, t0y, t0z, u0 + uS, v0, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, t1x, t1y, t1z, u0 + uS, v0 + vS, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, h0x, h0y, h0z, u0, v0, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, t1x, t1y, t1z, u0 + uS, v0 + vS, cr, cg, cb, ca);
      at = vert3(out, at, px, py, pz, h1x, h1y, h1z, u0, v0 + vS, cr, cg, cb, ca);
      continue;
    }
    let ax2 = oax, ay2 = oay, az2 = oaz;
    if (axisRandom) {
      const sd = f.seed[i];
      const s1 = sd * 7.31 - Math.floor(sd * 7.31);
      const s2 = sd * 3.77 - Math.floor(sd * 3.77);
      const zc = 1 - 2 * s1;
      const rc = Math.sqrt(Math.max(0, 1 - zc * zc));
      const phi = 6.283185307179586 * s2;
      ax2 = rc * Math.cos(phi);
      ay2 = rc * Math.sin(phi);
      az2 = zc;
    }
    const ang = f.seed[i] * 6.283185307179586 + age * spin3d;
    const c = Math.cos(ang), sn = Math.sin(ang), tt = 1 - c;
    const m00 = tt * ax2 * ax2 + c, m01 = tt * ax2 * ay2 - sn * az2;
    const m10 = tt * ax2 * ay2 + sn * az2, m11 = tt * ay2 * ay2 + c;
    const m20 = tt * ax2 * az2 - sn * ay2, m21 = tt * ay2 * az2 + sn * ax2;
    const o0x = m00 * -half + m01 * -half, o0y = m10 * -half + m11 * -half, o0z = m20 * -half + m21 * -half;
    const o1x = m00 * half + m01 * -half, o1y = m10 * half + m11 * -half, o1z = m20 * half + m21 * -half;
    const o2x = m00 * half + m01 * half, o2y = m10 * half + m11 * half, o2z = m20 * half + m21 * half;
    const o3x = m00 * -half + m01 * half, o3y = m10 * -half + m11 * half, o3z = m20 * -half + m21 * half;
    at = vert3(out, at, px, py, pz, o0x, o0y, o0z, u0, v0, cr, cg, cb, ca);
    at = vert3(out, at, px, py, pz, o1x, o1y, o1z, u0 + uS, v0, cr, cg, cb, ca);
    at = vert3(out, at, px, py, pz, o2x, o2y, o2z, u0 + uS, v0 + vS, cr, cg, cb, ca);
    at = vert3(out, at, px, py, pz, o0x, o0y, o0z, u0, v0, cr, cg, cb, ca);
    at = vert3(out, at, px, py, pz, o2x, o2y, o2z, u0 + uS, v0 + vS, cr, cg, cb, ca);
    at = vert3(out, at, px, py, pz, o3x, o3y, o3z, u0, v0 + vS, cr, cg, cb, ca);
  }
  return at / SOUP_STRIDE;
}
var SCRATCH = new Float32Array(6);
function cameraQuad(out, at, px, py, pz, half, rx, ry, rz, ux, uy, uz, u0, v0, uS, vS, cr, cg, cb, ca) {
  const aX = -half, aY = -half, bX = half, bY = -half, cX = half, cY = half, dX = -half, dY = half;
  at = vert(out, at, px + aX * rx + aY * ux, py + aX * ry + aY * uy, pz + aX * rz + aY * uz, u0, v0, cr, cg, cb, ca);
  at = vert(out, at, px + bX * rx + bY * ux, py + bX * ry + bY * uy, pz + bX * rz + bY * uz, u0 + uS, v0, cr, cg, cb, ca);
  at = vert(out, at, px + cX * rx + cY * ux, py + cX * ry + cY * uy, pz + cX * rz + cY * uz, u0 + uS, v0 + vS, cr, cg, cb, ca);
  at = vert(out, at, px + aX * rx + aY * ux, py + aX * ry + aY * uy, pz + aX * rz + aY * uz, u0, v0, cr, cg, cb, ca);
  at = vert(out, at, px + cX * rx + cY * ux, py + cX * ry + cY * uy, pz + cX * rz + cY * uz, u0 + uS, v0 + vS, cr, cg, cb, ca);
  at = vert(out, at, px + dX * rx + dY * ux, py + dX * ry + dY * uy, pz + dX * rz + dY * uz, u0, v0 + vS, cr, cg, cb, ca);
  return at;
}
function vert(out, at, x, y, z, u, v, cr, cg, cb, ca) {
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = z;
  out[at + 3] = u;
  out[at + 4] = v;
  out[at + 5] = cr;
  out[at + 6] = cg;
  out[at + 7] = cb;
  out[at + 8] = ca;
  return at + SOUP_STRIDE;
}
function vert3(out, at, px, py, pz, ox, oy, oz, u, v, cr, cg, cb, ca) {
  out[at] = px + ox;
  out[at + 1] = py + oy;
  out[at + 2] = pz + oz;
  out[at + 3] = u;
  out[at + 4] = v;
  out[at + 5] = cr;
  out[at + 6] = cg;
  out[at + 7] = cb;
  out[at + 8] = ca;
  return at + SOUP_STRIDE;
}
// packages/particles/src/instances.ts
var INSTANCE_STRIDE = 16;
var INSTANCE_LAYOUT = {
  pos: { size: 3, offset: 0 },
  vel: { size: 3, offset: 3 },
  color: { size: 4, offset: 6 },
  par: { size: 4, offset: 10 },
  uv0: { size: 2, offset: 14 }
};
function packInstances(system, out, options = {}) {
  const ramp = options.ramp ?? CONSTANT_RAMP;
  const tiles = options.tiles;
  const tileU = tiles !== undefined ? tiles[0] : 1;
  const tileV = tiles !== undefined ? tiles[1] : 1;
  const useAtlas = tiles !== undefined;
  if (useAtlas && (!Number.isInteger(tileU) || tileU < 1 || !Number.isInteger(tileV) || tileV < 1)) {
    throw new Error(`rune/particles: billboard tiles must be integers >= 1 (got [${tileU}, ${tileV}])`);
  }
  const maxFrame = tileU * tileV - 1;
  const frameJitter = options.frameJitter ?? 0;
  const f = system.fields;
  const count = system.count;
  const s = SCRATCH2;
  let n = 0;
  const order = options.order;
  const ordered = order !== undefined && order !== null;
  const total = ordered ? order.length : count;
  for (let j = 0;j < total; j++) {
    const i = ordered ? order[j] : j;
    const age = f.age[i];
    const life = f.life[i];
    const t = life > 0 ? age / life : 0;
    sampleRamp(ramp, t, s);
    const half = f.size[i] * s[0] * 0.5;
    if (half <= 0)
      continue;
    let u0 = 0, v0 = 0;
    if (useAtlas) {
      let frame = Math.floor(s[5] + (frameJitter > 0 ? f.seed[i] * frameJitter : 0));
      if (!Number.isFinite(frame))
        frame = 0;
      if (frame < 0)
        frame = 0;
      if (frame > maxFrame)
        frame = maxFrame;
      u0 = frame % tileU / tileU;
      v0 = Math.floor(frame / tileU) / tileV;
    }
    const at = n * INSTANCE_STRIDE;
    out[at] = f.px[i];
    out[at + 1] = f.py[i];
    out[at + 2] = f.pz[i];
    out[at + 3] = f.vx[i];
    out[at + 4] = f.vy[i];
    out[at + 5] = f.vz[i];
    out[at + 6] = f.cr[i] * s[1];
    out[at + 7] = f.cg[i] * s[2];
    out[at + 8] = f.cb[i] * s[3];
    out[at + 9] = f.ca[i] * s[4];
    out[at + 10] = half;
    out[at + 11] = f.seed[i] * 6.283185307179586;
    out[at + 12] = age;
    out[at + 13] = f.seed[i];
    out[at + 14] = u0;
    out[at + 15] = v0;
    n++;
  }
  return n;
}
var SCRATCH2 = new Float32Array(6);
// packages/particles/src/sort.ts
function sortDepthBackToFront(fields, count, forward, indices, keys) {
  if (count <= 0)
    return 0;
  const fx = forward[0], fy = forward[1], fz = forward[2];
  for (let i = 0;i < count; i++) {
    indices[i] = i;
    keys[i] = fx * fields.px[i] + fy * fields.py[i] + fz * fields.pz[i];
  }
  indices.subarray(0, count).sort((a, b) => keys[b] - keys[a] || b - a);
  return count;
}
// packages/particles/src/gpuEmit.ts
var GPU_EMIT_SHAPE = {
  point: 0,
  sphere: 1,
  cone: 2,
  disc: 3,
  hemisphere: 4,
  donut: 5,
  rectangle: 6,
  grid: 7,
  line: 8
};
var GPU_EMIT_VEL = {
  fixed: 1,
  radial: 2,
  axis: 3,
  tangential: 4,
  lobe: 5
};
var GPU_EMIT_SALTS = {
  dir: 1,
  spd: 2,
  life: 3,
  size: 4,
  col: 5,
  seed: 6,
  p0: 7,
  p1: 8,
  p2: 9,
  scat0: 11,
  scat1: 12
};
var TAU2 = 6.283185307179586;
var GPU_EMIT_BASE = 36;
var GPU_EMIT_U32_FIELDS = {
  emitBase: 36,
  emitCount: 37,
  streamBase: 38,
  emitMask: 39,
  shapeKind: 40,
  velMode: 41,
  seed: 42
};
var GPU_EMIT_MASK = { on: 1 };
var GPU_EMIT_VEC4_FIELDS = {
  shapeOrigin: 44,
  atOrigin: 48,
  axis: 52,
  t1: 56,
  t2: 60,
  fixedDir: 64,
  radius: 68,
  cone: 72,
  donut: 76,
  misc: 80,
  misc2: 84,
  lineTo: 88,
  speed: 92,
  sizeInherit: 96,
  color0: 100,
  color1: 104,
  emitterV: 108
};
function emitFrame(ax, ay, az) {
  let t1x = -az, t1y = 0, t1z = ax;
  let tl = Math.hypot(t1x, t1y, t1z);
  if (tl < 0.000001) {
    t1x = 1;
    t1y = 0;
    t1z = 0;
    tl = 1;
  }
  t1x /= tl;
  t1y /= tl;
  t1z /= tl;
  const t2x = ay * t1z - az * t1y, t2y = az * t1x - ax * t1z, t2z = ax * t1y - ay * t1x;
  return { t1: [t1x, t1y, t1z], t2: [t2x, t2y, t2z] };
}
function readGpuEmitConfig(desc) {
  const shape = desc.shape;
  const velocity = desc.velocity;
  if (shape.kind === "path") {
    throw new Error('rune/particles: emit:"gpu" rejects the path shape (the per-segment direction/scatter data is CPU-side — take a line or disc emitter, or sim:"cpu")');
  }
  if (shape.kind === "line" && shape.mode === "lattice") {
    throw new Error('rune/particles: emit:"gpu" rejects the line lattice (its station mapping is CALL-local — a GPU window spans calls; take the random line, or sim:"cpu")');
  }
  if (shape.kind === "grid" && shape.mode === "lattice") {
    throw new Error('rune/particles: emit:"gpu" rejects the grid lattice (its cell mapping is CALL-local — a GPU window spans calls; take the random grid, or sim:"cpu")');
  }
  if (desc.speedByRadius !== undefined) {
    throw new Error('rune/particles: emit:"gpu" rejects speedByRadius (the radial speed modulation stays CPU-side in v1 — emit over a plain speed range, or sim:"cpu")');
  }
  if (desc.colorByRadius === true) {
    throw new Error('rune/particles: emit:"gpu" rejects colorByRadius (the radius-driven mix stays CPU-side in v1 — take the per-particle hash mix, or sim:"cpu")');
  }
  if (desc.target !== undefined) {
    throw new Error('rune/particles: emit:"gpu" rejects the seek target (the seek force is already CPU-tier territory on sim:"gpu")');
  }
  const shapeKind = GPU_EMIT_SHAPE[shape.kind];
  const velMode = GPU_EMIT_VEL[velocity.mode];
  if (shapeKind === undefined) {
    throw new Error(`rune/particles: emit:"gpu" — unknown shape kind ${JSON.stringify(shape.kind)}`);
  }
  if (velMode === undefined) {
    throw new Error(`rune/particles: emit:"gpu" — unknown velocity mode ${JSON.stringify(velocity.mode)}`);
  }
  const ox = shape.kind === "line" ? shape.from[0] : shape.origin[0];
  const oy = shape.kind === "line" ? shape.from[1] : shape.origin[1];
  const oz = shape.kind === "line" ? shape.from[2] : shape.origin[2];
  let ax = 0, ay = 0, az = 1;
  let lineTo = null;
  if (shape.kind === "line") {
    const vx = shape.to[0] - ox, vy = shape.to[1] - oy, vz = shape.to[2] - oz;
    const l = Math.hypot(vx, vy, vz);
    if (l === 0 || !Number.isFinite(l)) {
      throw new Error('rune/particles: emit:"gpu" — the line endpoints must be a finite non-zero vector (createSpawner validated this; a mid-flight desc mutation broke it)');
    }
    ax = vx / l;
    ay = vy / l;
    az = vz / l;
    lineTo = [shape.to[0], shape.to[1], shape.to[2]];
  } else if (shape.kind === "cone" || shape.kind === "disc" || shape.kind === "hemisphere" || shape.kind === "donut" || shape.kind === "rectangle" || shape.kind === "grid") {
    const l = Math.hypot(shape.axis[0], shape.axis[1], shape.axis[2]);
    if (l === 0 || !Number.isFinite(l)) {
      throw new Error('rune/particles: emit:"gpu" — the shape axis must be a finite non-zero vector (createSpawner validated this; a mid-flight desc mutation broke it)');
    }
    ax = shape.axis[0] / l;
    ay = shape.axis[1] / l;
    az = shape.axis[2] / l;
  }
  const { t1, t2 } = emitFrame(ax, ay, az);
  let fx = 0, fy = 0, fz = 1;
  if (velocity.mode === "fixed") {
    const l = Math.hypot(velocity.dir[0], velocity.dir[1], velocity.dir[2]);
    if (l === 0 || !Number.isFinite(l)) {
      throw new Error('rune/particles: emit:"gpu" — the fixed velocity dir must be finite non-zero (createSpawner validated this; a mid-flight desc mutation broke it)');
    }
    fx = velocity.dir[0] / l;
    fy = velocity.dir[1] / l;
    fz = velocity.dir[2] / l;
  }
  let rMin = 0, rMax = 0, hemArc = TAU2, donR = 0;
  if (shape.kind === "sphere" || shape.kind === "disc" || shape.kind === "hemisphere") {
    rMin = shape.radius[0];
    rMax = shape.radius[1];
  }
  if (shape.kind === "hemisphere")
    hemArc = shape.arc ?? TAU2;
  let cosHalf = 0, baseRadius = 0, lenMin = 0, lenMax = 0;
  if (shape.kind === "cone") {
    cosHalf = Math.cos(shape.halfAngle);
    baseRadius = shape.baseRadius;
    lenMin = shape.length[0];
    lenMax = shape.length[1];
  }
  let tubeMin = 0, tubeMax = 0, donArc = TAU2;
  if (shape.kind === "donut") {
    donR = shape.radius;
    tubeMin = shape.tube[0];
    tubeMax = shape.tube[1];
    donArc = shape.arc ?? TAU2;
  }
  let rectW = 0, rectH = 0;
  if (shape.kind === "rectangle") {
    rectW = shape.width;
    rectH = shape.height;
  }
  let gridW = 0, gridH = 0, gridRows = 1, gridCols = 1;
  if (shape.kind === "grid") {
    gridW = shape.width;
    gridH = shape.height;
    gridRows = Math.floor(shape.rows);
    gridCols = Math.floor(shape.columns);
  }
  let arms = 0, armSpread = 0.35, twist = 0;
  if (shape.kind === "disc" && shape.arms !== undefined) {
    arms = shape.arms;
    armSpread = shape.armSpread ?? 0.35;
    twist = shape.twist ?? 0;
  }
  const c0 = desc.color[0], c1 = desc.color[1];
  return {
    shapeKind,
    velMode,
    seed: (desc.seed ?? 1) | 0,
    shapeOrigin: [ox, oy, oz],
    axis: [ax, ay, az],
    t1,
    t2,
    fixedDir: [fx, fy, fz],
    lineTo,
    rMin,
    rMax,
    hemArc,
    donR,
    cosHalf,
    baseRadius,
    lenMin,
    lenMax,
    tubeMin,
    tubeMax,
    donArc,
    arms,
    armSpread,
    twist,
    rectW,
    rectH,
    gridW,
    gridH,
    gridRows,
    gridCols,
    speedMin: desc.speed[0],
    speedMax: desc.speed[1],
    lifeMin: desc.life[0],
    lifeMax: desc.life[1],
    sizeMin: desc.size[0],
    sizeMax: desc.size[1],
    color0: [c0[0], c0[1], c0[2], c0[3]],
    color1: [c1[0], c1[1], c1[2], c1[3]]
  };
}
function gpuEmitPackStatic(f32, u32, cfg) {
  const U = GPU_EMIT_U32_FIELDS;
  const V = GPU_EMIT_VEC4_FIELDS;
  u32[U.shapeKind] = cfg.shapeKind;
  u32[U.velMode] = cfg.velMode;
  u32[U.seed] = cfg.seed >>> 0;
  u32[U.emitMask] = GPU_EMIT_MASK.on;
  f32[V.shapeOrigin] = cfg.shapeOrigin[0];
  f32[V.shapeOrigin + 1] = cfg.shapeOrigin[1];
  f32[V.shapeOrigin + 2] = cfg.shapeOrigin[2];
  f32[V.axis] = cfg.axis[0];
  f32[V.axis + 1] = cfg.axis[1];
  f32[V.axis + 2] = cfg.axis[2];
  f32[V.t1] = cfg.t1[0];
  f32[V.t1 + 1] = cfg.t1[1];
  f32[V.t1 + 2] = cfg.t1[2];
  f32[V.t2] = cfg.t2[0];
  f32[V.t2 + 1] = cfg.t2[1];
  f32[V.t2 + 2] = cfg.t2[2];
  f32[V.fixedDir] = cfg.fixedDir[0];
  f32[V.fixedDir + 1] = cfg.fixedDir[1];
  f32[V.fixedDir + 2] = cfg.fixedDir[2];
  f32[V.radius] = cfg.rMin;
  f32[V.radius + 1] = cfg.rMax;
  f32[V.radius + 2] = cfg.hemArc;
  f32[V.radius + 3] = cfg.donR;
  f32[V.cone] = cfg.cosHalf;
  f32[V.cone + 1] = cfg.baseRadius;
  f32[V.cone + 2] = cfg.lenMin;
  f32[V.cone + 3] = cfg.lenMax;
  f32[V.donut] = cfg.tubeMin;
  f32[V.donut + 1] = cfg.tubeMax;
  f32[V.donut + 2] = cfg.donArc;
  f32[V.donut + 3] = cfg.arms;
  f32[V.misc] = cfg.armSpread;
  f32[V.misc + 1] = cfg.twist;
  f32[V.misc + 2] = cfg.rectW;
  f32[V.misc + 3] = cfg.rectH;
  f32[V.misc2] = cfg.gridW;
  f32[V.misc2 + 1] = cfg.gridH;
  f32[V.misc2 + 2] = cfg.gridRows;
  f32[V.misc2 + 3] = cfg.gridCols;
  if (cfg.lineTo !== null) {
    f32[V.lineTo] = cfg.lineTo[0];
    f32[V.lineTo + 1] = cfg.lineTo[1];
    f32[V.lineTo + 2] = cfg.lineTo[2];
  }
  f32[V.speed] = cfg.speedMin;
  f32[V.speed + 1] = cfg.speedMax;
  f32[V.speed + 2] = cfg.lifeMin;
  f32[V.speed + 3] = cfg.lifeMax;
  f32[V.sizeInherit] = cfg.sizeMin;
  f32[V.sizeInherit + 1] = cfg.sizeMax;
  f32[V.color0] = cfg.color0[0];
  f32[V.color0 + 1] = cfg.color0[1];
  f32[V.color0 + 2] = cfg.color0[2];
  f32[V.color0 + 3] = cfg.color0[3];
  f32[V.color1] = cfg.color1[0];
  f32[V.color1 + 1] = cfg.color1[1];
  f32[V.color1 + 2] = cfg.color1[2];
  f32[V.color1 + 3] = cfg.color1[3];
}
function gpuEmitLife(cfg, globalIndex) {
  return cfg.lifeMin + (cfg.lifeMax - cfg.lifeMin) * hash01(cfg.seed, globalIndex, GPU_EMIT_SALTS.life);
}
function gpuEmitRowModel(cfg, i, atOrigin, emitterV, inheritK, out) {
  const sd = cfg.seed;
  const gi = i;
  const u = hash01(sd, gi, GPU_EMIT_SALTS.dir);
  const v = hash01(sd, gi, GPU_EMIT_SALTS.dir + 100);
  let px = cfg.shapeOrigin[0], py = cfg.shapeOrigin[1], pz = cfg.shapeOrigin[2];
  let dx = cfg.fixedDir[0], dy = cfg.fixedDir[1], dz = cfg.fixedDir[2];
  const S = GPU_EMIT_SALTS;
  if (cfg.shapeKind === GPU_EMIT_SHAPE.sphere) {
    const z = 1 - 2 * u;
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = TAU2 * v;
    dx = s * Math.cos(phi);
    dy = s * Math.sin(phi);
    dz = z;
    const r = cfg.rMin + (cfg.rMax - cfg.rMin) * hash01(sd, gi, S.p0);
    px = cfg.shapeOrigin[0] + dx * r;
    py = cfg.shapeOrigin[1] + dy * r;
    pz = cfg.shapeOrigin[2] + dz * r;
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.cone) {
    const z = 1 - (1 - cfg.cosHalf) * u;
    const s = Math.sqrt(Math.max(0, 1 - z * z));
    const phi = TAU2 * v;
    const { axis: a, t1, t2 } = cfg;
    dx = a[0] * z + (t1[0] * Math.cos(phi) + t2[0] * Math.sin(phi)) * s;
    dy = a[1] * z + (t1[1] * Math.cos(phi) + t2[1] * Math.sin(phi)) * s;
    dz = a[2] * z + (t1[2] * Math.cos(phi) + t2[2] * Math.sin(phi)) * s;
    const rr = cfg.baseRadius * Math.sqrt(hash01(sd, gi, S.p0));
    const rphi = TAU2 * hash01(sd, gi, S.p1);
    const stretch = cfg.lenMin + (cfg.lenMax - cfg.lenMin) * hash01(sd, gi, S.p2);
    const cx = Math.cos(rphi) * rr, cy = Math.sin(rphi) * rr;
    px = cfg.shapeOrigin[0] + t1[0] * cx + t2[0] * cy + a[0] * stretch;
    py = cfg.shapeOrigin[1] + t1[1] * cx + t2[1] * cy + a[1] * stretch;
    pz = cfg.shapeOrigin[2] + t1[2] * cx + t2[2] * cy + a[2] * stretch;
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.disc) {
    const r2 = cfg.rMin * cfg.rMin + (cfg.rMax * cfg.rMax - cfg.rMin * cfg.rMin) * u;
    const rr = Math.sqrt(r2);
    let phi;
    if (cfg.arms > 0) {
      const arm = Math.floor(hash01(sd, gi, S.p0) * cfg.arms);
      const scatter = (hash01(sd, gi, S.p1) - 0.5) * 2 * cfg.armSpread;
      const tR = (rr - cfg.rMin) / Math.max(0.000001, cfg.rMax - cfg.rMin);
      phi = arm * (TAU2 / cfg.arms) + cfg.twist * tR + scatter;
    } else {
      phi = TAU2 * v;
    }
    const { t1, t2 } = cfg;
    px = cfg.shapeOrigin[0] + (t1[0] * Math.cos(phi) + t2[0] * Math.sin(phi)) * rr;
    py = cfg.shapeOrigin[1] + (t1[1] * Math.cos(phi) + t2[1] * Math.sin(phi)) * rr;
    pz = cfg.shapeOrigin[2] + (t1[2] * Math.cos(phi) + t2[2] * Math.sin(phi)) * rr;
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.hemisphere) {
    const cosTheta = u;
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = cfg.hemArc * v;
    const { axis: a, t1, t2 } = cfg;
    dx = a[0] * cosTheta + (t1[0] * Math.cos(phi) + t2[0] * Math.sin(phi)) * sinTheta;
    dy = a[1] * cosTheta + (t1[1] * Math.cos(phi) + t2[1] * Math.sin(phi)) * sinTheta;
    dz = a[2] * cosTheta + (t1[2] * Math.cos(phi) + t2[2] * Math.sin(phi)) * sinTheta;
    const r = cfg.rMin + (cfg.rMax - cfg.rMin) * hash01(sd, gi, S.p0);
    px = cfg.shapeOrigin[0] + dx * r;
    py = cfg.shapeOrigin[1] + dy * r;
    pz = cfg.shapeOrigin[2] + dz * r;
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.donut) {
    const phi = cfg.donArc * u;
    const tr = cfg.tubeMin + (cfg.tubeMax - cfg.tubeMin) * hash01(sd, gi, S.p0);
    const psi = TAU2 * hash01(sd, gi, S.p1);
    const cphi = Math.cos(phi), sphi = Math.sin(phi);
    const cpsi = Math.cos(psi), spsi = Math.sin(psi);
    const { t1, t2, axis: a } = cfg;
    const rrx = t1[0] * cphi + t2[0] * sphi, rry = t1[1] * cphi + t2[1] * sphi, rrz = t1[2] * cphi + t2[2] * sphi;
    px = cfg.shapeOrigin[0] + rrx * (cfg.donR + tr * cpsi) + a[0] * (tr * spsi);
    py = cfg.shapeOrigin[1] + rry * (cfg.donR + tr * cpsi) + a[1] * (tr * spsi);
    pz = cfg.shapeOrigin[2] + rrz * (cfg.donR + tr * cpsi) + a[2] * (tr * spsi);
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.rectangle) {
    const hx = (u - 0.5) * cfg.rectW, hy = (v - 0.5) * cfg.rectH;
    const { t1, t2 } = cfg;
    px = cfg.shapeOrigin[0] + t1[0] * hx + t2[0] * hy;
    py = cfg.shapeOrigin[1] + t1[1] * hx + t2[1] * hy;
    pz = cfg.shapeOrigin[2] + t1[2] * hx + t2[2] * hy;
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.grid) {
    const col = Math.floor(hash01(sd, gi, S.p0) * cfg.gridCols);
    const row = Math.floor(hash01(sd, gi, S.p1) * cfg.gridRows);
    const gx = ((col + 0.5) / cfg.gridCols - 0.5) * cfg.gridW;
    const gy = ((row + 0.5) / cfg.gridRows - 0.5) * cfg.gridH;
    const { t1, t2 } = cfg;
    px = cfg.shapeOrigin[0] + t1[0] * gx + t2[0] * gy;
    py = cfg.shapeOrigin[1] + t1[1] * gx + t2[1] * gy;
    pz = cfg.shapeOrigin[2] + t1[2] * gx + t2[2] * gy;
  } else if (cfg.shapeKind === GPU_EMIT_SHAPE.line) {
    const lu = u;
    const to = cfg.lineTo;
    px = cfg.shapeOrigin[0] + (to[0] - cfg.shapeOrigin[0]) * lu;
    py = cfg.shapeOrigin[1] + (to[1] - cfg.shapeOrigin[1]) * lu;
    pz = cfg.shapeOrigin[2] + (to[2] - cfg.shapeOrigin[2]) * lu;
  }
  if (cfg.velMode === GPU_EMIT_VEL.radial) {
    dx = px - cfg.shapeOrigin[0];
    dy = py - cfg.shapeOrigin[1];
    dz = pz - cfg.shapeOrigin[2];
    const l = Math.hypot(dx, dy, dz);
    if (l > 0.000000000001) {
      dx /= l;
      dy /= l;
      dz /= l;
    } else {
      const theta = TAU2 * hash01(sd, gi, S.scat0);
      const cphi = 2 * hash01(sd, gi, S.scat1) - 1;
      const sphi = Math.sqrt(Math.max(0, 1 - cphi * cphi));
      dx = sphi * Math.cos(theta);
      dy = sphi * Math.sin(theta);
      dz = cphi;
    }
  } else if (cfg.velMode === GPU_EMIT_VEL.axis) {
    dx = cfg.axis[0];
    dy = cfg.axis[1];
    dz = cfg.axis[2];
  } else if (cfg.velMode === GPU_EMIT_VEL.tangential) {
    const rx = px - cfg.shapeOrigin[0], ry = py - cfg.shapeOrigin[1], rz = pz - cfg.shapeOrigin[2];
    dx = cfg.axis[1] * rz - cfg.axis[2] * ry;
    dy = cfg.axis[2] * rx - cfg.axis[0] * rz;
    dz = cfg.axis[0] * ry - cfg.axis[1] * rx;
    const l = Math.hypot(dx, dy, dz);
    if (l > 0.000000000001) {
      dx /= l;
      dy /= l;
      dz /= l;
    } else {
      dx = cfg.axis[0];
      dy = cfg.axis[1];
      dz = cfg.axis[2];
    }
  }
  const spd = cfg.speedMin + (cfg.speedMax - cfg.speedMin) * hash01(sd, gi, S.spd);
  const mixC = hash01(sd, gi, S.col);
  const life = cfg.lifeMin + (cfg.lifeMax - cfg.lifeMin) * hash01(sd, gi, S.life);
  const size = cfg.sizeMin + (cfg.sizeMax - cfg.sizeMin) * hash01(sd, gi, S.size);
  const seedF = hash01(sd, gi, S.seed);
  const wx = px + atOrigin[0], wy = py + atOrigin[1], wz = pz + atOrigin[2];
  out[0] = wx;
  out[1] = wy;
  out[2] = wz;
  out[3] = dx * spd + emitterV[0] * inheritK;
  out[4] = dy * spd + emitterV[1] * inheritK;
  out[5] = dz * spd + emitterV[2] * inheritK;
  out[6] = 0;
  out[7] = life;
  out[8] = size;
  out[9] = cfg.color0[0] + (cfg.color1[0] - cfg.color0[0]) * mixC;
  out[10] = cfg.color0[1] + (cfg.color1[1] - cfg.color0[1]) * mixC;
  out[11] = cfg.color0[2] + (cfg.color1[2] - cfg.color0[2]) * mixC;
  out[12] = cfg.color0[3] + (cfg.color1[3] - cfg.color0[3]) * mixC;
  out[13] = seedF;
  out[14] = wx;
  out[15] = wy;
  out[16] = wz;
}

// packages/particles/src/gpuSim.ts
var GPU_STATE_STRIDE = FIELD_NAMES.length;
var GPU_SIM_UNIFORM_BYTES = 448;
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
var GPU_SIM_ENTRIES = ["emit", "compact", "advance", "pack"];
var GPU_SORT_UNIFORM_FLOATS = 36;
var GPU_SORT_U32_FIELDS = {
  count: 0,
  padN: 1,
  renderMask: 2
};
var GPU_SORT_F32_FIELDS = {
  forward: 4,
  planes: 8,
  tileU: 32,
  tileV: 33,
  frameJitter: 34,
  rampMaxSize: 35
};
var GPU_SORT_RENDER_MASK = { cull: 1 };
var GPU_SORT_PAD_KEY = 1000000000000000000000000000000;
var GPU_SORT_SENTINEL = 33554432;
var GPU_SORT_ENTRIES = ["sortKeys", "bitonic", "sortStep", "pack"];
function gpuSortPadCount(count) {
  if (!Number.isFinite(count) || count < 0) {
    throw new Error(`rune/particles: gpuSortPadCount — count must be a finite number ≥ 0 (got ${count})`);
  }
  if (count <= 1)
    return 1;
  return 1 << Math.ceil(Math.log2(count));
}
function gpuSortPassSequence(padN, run) {
  for (let k = 2;k <= padN; k <<= 1) {
    for (let j = k >> 1;j > 0; j >>= 1)
      run(k, j);
  }
}
function gpuRampMaxSize(points) {
  let max = 1;
  for (const p of points)
    if (p.size > max)
      max = p.size;
  return max;
}
function gpuRenderFrustum(viewProj, out) {
  if (viewProj.length !== 16) {
    throw new Error(`rune/particles: gpuRenderFrustum — the view-projection is 16 numbers, column-major (got ${viewProj.length})`);
  }
  const o = out ?? new Float32Array(24);
  const m = viewProj;
  for (let p = 0;p < 6; p++) {
    const axis = p >> 1;
    const sign = (p & 1) === 0 ? 1 : -1;
    const nx = m[3] + sign * m[axis];
    const ny = m[7] + sign * m[4 + axis];
    const nz = m[11] + sign * m[8 + axis];
    const d = m[15] + sign * m[12 + axis];
    const len = Math.hypot(nx, ny, nz);
    const inv = len > 0.000000000001 ? 1 / len : 0;
    o[p * 4] = nx * inv;
    o[p * 4 + 1] = ny * inv;
    o[p * 4 + 2] = nz * inv;
    o[p * 4 + 3] = d * inv;
  }
  return o;
}
var PACK_BODY_WGSL = `
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
  records[o] = state[b]; records[o + 1u] = state[b + 1u]; records[o + 2u] = state[b + 2u];
  records[o + 3u] = state[b + 3u]; records[o + 4u] = state[b + 4u]; records[o + 5u] = state[b + 5u];
  records[o + 6u] = state[b + 9u] * r; records[o + 7u] = state[b + 10u] * g;
  records[o + 8u] = state[b + 11u] * bl; records[o + 9u] = state[b + 12u] * a;
  records[o + 10u] = half;
  records[o + 11u] = seed * 6.283185307179586;
  records[o + 12u] = age;
  records[o + 13u] = seed;
  records[o + 14u] = u0; records[o + 15u] = v0;
`;
function gpuSimWgsl() {
  const perm = Array.from(PERM, (v) => `${v}u`).join(", ");
  const grads = [];
  for (let g = 0;g < 12; g++) {
    grads.push(`vec3<f32>(${GRAD3[g * 3]}, ${GRAD3[g * 3 + 1]}, ${GRAD3[g * 3 + 2]})`);
  }
  return `
// @rune/particles — the GPGPU sim tier (Task 131; Task 135: the emit entry
// — the GPU-side emission). The state: the FIELD_NAMES rows interleaved
// (17 floats). The entries: emit (the hash-RNG append pass), compact (the
// swap replay), advance (the force walk), pack (the instance records).
// The uniform layout mirrors GPU_SIM_* in gpuSim.ts (448 bytes — the emit
// block rides the same frame-constant uniform).

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
  // Task 135 — THE EMIT BLOCK (gpuEmit.ts's layout: 36 floats of forces,
  // then this — the byte offset 144 is 16-aligned, a legal vec4 boundary).
  // emitBase/emitCount: the pre-compaction window; streamBase: the window's
  // first GLOBAL stream index (the hash domain); emitMask: 1 = on.
  emitBase : u32,
  emitCount : u32,
  streamBase : u32,
  emitMask : u32,
  shapeKind : u32,
  velMode : u32,
  seed : u32,
  _padE : u32,
  shapeOrigin : vec4<f32>,  // the spawner's own origin (static)
  atOrigin : vec4<f32>,     // the at() offset (per frame)
  axis : vec4<f32>,
  t1 : vec4<f32>,           // the orthonormal frame (cross(axis, up) / cross(axis, t1))
  t2 : vec4<f32>,
  fixedDir : vec4<f32>,
  radius : vec4<f32>,       // (rMin, rMax, hemArc, donR)
  cone : vec4<f32>,         // (cosHalf, baseRadius, lenMin, lenMax)
  donut : vec4<f32>,        // (tubeMin, tubeMax, donArc, arms)
  misc : vec4<f32>,         // (armSpread, twist, rectW, rectH)
  misc2 : vec4<f32>,        // (gridW, gridH, gridRows, gridCols)
  lineTo : vec4<f32>,
  speed : vec4<f32>,        // (speedMin, speedMax, lifeMin, lifeMax)
  sizeInherit : vec4<f32>,  // (sizeMin, sizeMax, inheritK, _)
  color0 : vec4<f32>,
  color1 : vec4<f32>,
  emitterV : vec4<f32>,     // the inherit source (per frame)
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

// ── Task 135 — the integer hash (@rune/core random.ts's hash01, bit-
//    identical in u32: Math.imul wraps mod 2^32 exactly like WGSL's u32
//    arithmetic; the quotient's f32 rounding may flip the last ULP of a
//    lerp — the 1-ULP parity class, invisible at life/size scales) ────────
fn hash01f(seed : u32, index : u32, salt : u32) -> f32 {
  var h = seed * 374761393u + index * 668265263u + salt * 2246822519u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}

// ── emit: THE GPU-SIDE EMISSION (Task 135) — the hash-RNG append pass.
// Thread i writes the newborn row at slot (emitBase + i): the SAME spawner
// math the CPU reference evaluates (spawn.ts's closed-form shapes, the
// SAME salt streams — GPU_EMIT_SALTS), the position/velocity/color/seed
// GPU-authoritative from birth. Runs BEFORE the compact replay, exactly
// where the CPU emit-block upload used to land. ─────────────────────────
@compute @workgroup_size(64)
fn emit(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if ((P.emitMask & 1u) == 0u) { return; }
  if (i >= P.emitCount) { return; }
  let slot = P.emitBase + i;
  let gi = P.streamBase + i; // the GLOBAL stream index — the hash domain
  let sd = P.seed;
  let u = hash01f(sd, gi, ${GPU_EMIT_SALTS.dir}u);
  let v = hash01f(sd, gi, ${GPU_EMIT_SALTS.dir + 100}u);
  var px = P.shapeOrigin.x; var py = P.shapeOrigin.y; var pz = P.shapeOrigin.z;
  var dx = P.fixedDir.x; var dy = P.fixedDir.y; var dz = P.fixedDir.z;

  if (P.shapeKind == 1u) { // sphere — a uniform direction + the radius band
    let z = 1.0 - 2.0 * u;
    let s = sqrt(max(0.0, 1.0 - z * z));
    let phi = 6.283185307179586 * v;
    dx = s * cos(phi); dy = s * sin(phi); dz = z;
    let r = P.radius.x + (P.radius.y - P.radius.x) * hash01f(sd, gi, ${GPU_EMIT_SALTS.p0}u);
    px = P.shapeOrigin.x + dx * r; py = P.shapeOrigin.y + dy * r; pz = P.shapeOrigin.z + dz * r;
  } else if (P.shapeKind == 2u) { // cone — the fan-compressed lobe + the base disc
    let z = 1.0 - (1.0 - P.cone.x) * u;
    let s = sqrt(max(0.0, 1.0 - z * z));
    let phi = 6.283185307179586 * v;
    dx = P.axis.x * z + (P.t1.x * cos(phi) + P.t2.x * sin(phi)) * s;
    dy = P.axis.y * z + (P.t1.y * cos(phi) + P.t2.y * sin(phi)) * s;
    dz = P.axis.z * z + (P.t1.z * cos(phi) + P.t2.z * sin(phi)) * s;
    let rr = P.cone.y * sqrt(hash01f(sd, gi, ${GPU_EMIT_SALTS.p0}u));
    let rphi = 6.283185307179586 * hash01f(sd, gi, ${GPU_EMIT_SALTS.p1}u);
    let stretch = P.cone.z + (P.cone.w - P.cone.z) * hash01f(sd, gi, ${GPU_EMIT_SALTS.p2}u);
    let cx = cos(rphi) * rr; let cy = sin(rphi) * rr;
    px = P.shapeOrigin.x + P.t1.x * cx + P.t2.x * cy + P.axis.x * stretch;
    py = P.shapeOrigin.y + P.t1.y * cx + P.t2.y * cy + P.axis.y * stretch;
    pz = P.shapeOrigin.z + P.t1.z * cx + P.t2.z * cy + P.axis.z * stretch;
  } else if (P.shapeKind == 3u) { // disc — the area-uniform annulus (+ the arms)
    let r2 = P.radius.x * P.radius.x + (P.radius.y * P.radius.y - P.radius.x * P.radius.x) * u;
    let rr = sqrt(r2);
    var phi = 6.283185307179586 * v;
    if (P.donut.w >= 1.0) { // arms
      let arm = floor(hash01f(sd, gi, ${GPU_EMIT_SALTS.p0}u) * P.donut.w);
      let scatter = (hash01f(sd, gi, ${GPU_EMIT_SALTS.p1}u) - 0.5) * 2.0 * P.misc.x;
      let tR = (rr - P.radius.x) / max(1e-6, P.radius.y - P.radius.x);
      phi = arm * (6.283185307179586 / P.donut.w) + P.misc.y * tR + scatter;
    }
    px = P.shapeOrigin.x + (P.t1.x * cos(phi) + P.t2.x * sin(phi)) * rr;
    py = P.shapeOrigin.y + (P.t1.y * cos(phi) + P.t2.y * sin(phi)) * rr;
    pz = P.shapeOrigin.z + (P.t1.z * cos(phi) + P.t2.z * sin(phi)) * rr;
  } else if (P.shapeKind == 4u) { // hemisphere — the area-correct dome
    let cosTheta = u;
    let sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    let phi = P.radius.z * v;
    dx = P.axis.x * cosTheta + (P.t1.x * cos(phi) + P.t2.x * sin(phi)) * sinTheta;
    dy = P.axis.y * cosTheta + (P.t1.y * cos(phi) + P.t2.y * sin(phi)) * sinTheta;
    dz = P.axis.z * cosTheta + (P.t1.z * cos(phi) + P.t2.z * sin(phi)) * sinTheta;
    let r = P.radius.x + (P.radius.y - P.radius.x) * hash01f(sd, gi, ${GPU_EMIT_SALTS.p0}u);
    px = P.shapeOrigin.x + dx * r; py = P.shapeOrigin.y + dy * r; pz = P.shapeOrigin.z + dz * r;
  } else if (P.shapeKind == 5u) { // donut — the ring + the tube circle
    let phi = P.donut.z * u;
    let tr = P.donut.x + (P.donut.y - P.donut.x) * hash01f(sd, gi, ${GPU_EMIT_SALTS.p0}u);
    let psi = 6.283185307179586 * hash01f(sd, gi, ${GPU_EMIT_SALTS.p1}u);
    let cphi = cos(phi); let sphi = sin(phi); let cpsi = cos(psi); let spsi = sin(psi);
    let rrx = P.t1.x * cphi + P.t2.x * sphi;
    let rry = P.t1.y * cphi + P.t2.y * sphi;
    let rrz = P.t1.z * cphi + P.t2.z * sphi;
    px = P.shapeOrigin.x + rrx * (P.radius.w + tr * cpsi) + P.axis.x * (tr * spsi);
    py = P.shapeOrigin.y + rry * (P.radius.w + tr * cpsi) + P.axis.y * (tr * spsi);
    pz = P.shapeOrigin.z + rrz * (P.radius.w + tr * cpsi) + P.axis.z * (tr * spsi);
  } else if (P.shapeKind == 6u) { // rectangle — the plane patch ⊥ axis
    let hx = (u - 0.5) * P.misc.z; let hy = (v - 0.5) * P.misc.w;
    px = P.shapeOrigin.x + P.t1.x * hx + P.t2.x * hy;
    py = P.shapeOrigin.y + P.t1.y * hx + P.t2.y * hy;
    pz = P.shapeOrigin.z + P.t1.z * hx + P.t2.z * hy;
  } else if (P.shapeKind == 7u) { // grid — the hash-picked cell ('random')
    let col = floor(hash01f(sd, gi, ${GPU_EMIT_SALTS.p0}u) * P.misc2.w);
    let row = floor(hash01f(sd, gi, ${GPU_EMIT_SALTS.p1}u) * P.misc2.z);
    let gx = ((col + 0.5) / P.misc2.w - 0.5) * P.misc2.x;
    let gy = ((row + 0.5) / P.misc2.z - 0.5) * P.misc2.y;
    px = P.shapeOrigin.x + P.t1.x * gx + P.t2.x * gy;
    py = P.shapeOrigin.y + P.t1.y * gx + P.t2.y * gy;
    pz = P.shapeOrigin.z + P.t1.z * gx + P.t2.z * gy;
  } else if (P.shapeKind == 8u) { // line — the uniform span ('random')
    px = P.shapeOrigin.x + (P.lineTo.x - P.shapeOrigin.x) * u;
    py = P.shapeOrigin.y + (P.lineTo.y - P.shapeOrigin.y) * u;
    pz = P.shapeOrigin.z + (P.lineTo.z - P.shapeOrigin.z) * u;
  }

  // the velocity mode overrides (radial/tangential read the SHAPE-LOCAL
  // position — the at() translation comes after, the CPU's own order)
  if (P.velMode == 2u) { // radial
    let rx = px - P.shapeOrigin.x; let ry = py - P.shapeOrigin.y; let rz = pz - P.shapeOrigin.z;
    let l = sqrt(rx * rx + ry * ry + rz * rz);
    if (l > 1e-12) {
      dx = rx / l; dy = ry / l; dz = rz / l;
    } else {
      // the degenerate scatter (Task 124's fix — a uniform random direction)
      let theta = 6.283185307179586 * hash01f(sd, gi, ${GPU_EMIT_SALTS.scat0}u);
      let cphi = 2.0 * hash01f(sd, gi, ${GPU_EMIT_SALTS.scat1}u) - 1.0;
      let sphi = sqrt(max(0.0, 1.0 - cphi * cphi));
      dx = sphi * cos(theta); dy = sphi * sin(theta); dz = cphi;
    }
  } else if (P.velMode == 3u) { // axis
    dx = P.axis.x; dy = P.axis.y; dz = P.axis.z;
  } else if (P.velMode == 4u) { // tangential — cross(axis, radial)
    let rx = px - P.shapeOrigin.x; let ry = py - P.shapeOrigin.y; let rz = pz - P.shapeOrigin.z;
    dx = P.axis.y * rz - P.axis.z * ry;
    dy = P.axis.z * rx - P.axis.x * rz;
    dz = P.axis.x * ry - P.axis.y * rx;
    let l = sqrt(dx * dx + dy * dy + dz * dz);
    if (l > 1e-12) { dx = dx / l; dy = dy / l; dz = dz / l; }
    else { dx = P.axis.x; dy = P.axis.y; dz = P.axis.z; }
  }
  // velMode 1 (fixed) / 5 (lobe): keep the shape branch's direction

  let spd = P.speed.x + (P.speed.y - P.speed.x) * hash01f(sd, gi, ${GPU_EMIT_SALTS.spd}u);
  let mixC = hash01f(sd, gi, ${GPU_EMIT_SALTS.col}u);
  let life = P.speed.z + (P.speed.w - P.speed.z) * hash01f(sd, gi, ${GPU_EMIT_SALTS.life}u);
  let size = P.sizeInherit.x + (P.sizeInherit.y - P.sizeInherit.x) * hash01f(sd, gi, ${GPU_EMIT_SALTS.size}u);
  let seedF = hash01f(sd, gi, ${GPU_EMIT_SALTS.seed}u);
  let k = P.sizeInherit.z; // inheritK

  let b = slot * FSTRIDE;
  state[b] = px + P.atOrigin.x;
  state[b + 1u] = py + P.atOrigin.y;
  state[b + 2u] = pz + P.atOrigin.z;
  state[b + 3u] = dx * spd + P.emitterV.x * k;
  state[b + 4u] = dy * spd + P.emitterV.y * k;
  state[b + 5u] = dz * spd + P.emitterV.z * k;
  state[b + 6u] = 0.0; // age — born this frame
  state[b + 7u] = life;
  state[b + 8u] = size;
  state[b + 9u] = P.color0.x + (P.color1.x - P.color0.x) * mixC;
  state[b + 10u] = P.color0.y + (P.color1.y - P.color0.y) * mixC;
  state[b + 11u] = P.color0.z + (P.color1.z - P.color0.z) * mixC;
  state[b + 12u] = P.color0.w + (P.color1.w - P.color0.w) * mixC;
  state[b + 13u] = seedF;
  state[b + 14u] = state[b]; // tx/ty/tz: no target → the spawn position
  state[b + 15u] = state[b + 1u];
  state[b + 16u] = state[b + 2u];
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
// record layout of the BILLBOARD material / INSTANCE_LAYOUT; the body is
// PACK_BODY_WGSL — SHARED with the sort family's sorted pack entry) ──────
@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let b = i * FSTRIDE;
  let o = i * RSTRIDE;
${PACK_BODY_WGSL}}
`;
}
function gpuSortWgsl() {
  return `
// @rune/particles — Task 134: the GPU render tier (the sort/cull family).
// The SAME four buffers as the sim family, one slot shifted: the pairs ride
// binding 1 (rw), the state drops to binding 2 (ro — read only).

struct SortParams {
  count : u32,
  padN : u32,
  renderMask : u32,
  _pad0 : u32,
  forward : vec4<f32>,
  planes : array<vec4<f32>, 6>,
  tileU : f32,
  tileV : f32,
  frameJitter : f32,
  rampMaxSize : f32,
}

@group(0) @binding(0) var<uniform> P : SortParams;
@group(0) @binding(1) var<storage, read_write> pairs : array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> state : array<f32>;
@group(0) @binding(3) var<storage, read_write> records : array<f32>;
@group(0) @binding(4) var<storage, read> rampLUT : array<f32>;

const FSTRIDE : u32 = ${GPU_STATE_STRIDE}u;
const RSTRIDE : u32 = 16u;
const PAD_KEY : f32 = ${GPU_SORT_PAD_KEY};
const SENTINEL : f32 = ${GPU_SORT_SENTINEL}.0;

// ── sortKeys: the (key, index) pairs — the negated depth for the visible
// live, the sentinel pair for the culled and the pads ───────────────────
@compute @workgroup_size(64)
fn sortKeys(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.padN) { return; }
  var key = PAD_KEY;
  var idx = SENTINEL;
  if (i < P.count) {
    let b = i * FSTRIDE;
    let px = state[b]; let py = state[b + 1u]; let pz = state[b + 2u];
    var visible = true;
    if ((P.renderMask & 1u) != 0u) {
      // the conservative sphere: spawnSize · rampMax · 0.5 ≥ every drawn
      // extent — a sprite never pops at the screen edge
      let radius = state[b + 8u] * P.rampMaxSize * 0.5;
      for (var pl = 0u; pl < 6u; pl++) {
        let plane = P.planes[pl];
        if (plane.x * px + plane.y * py + plane.z * pz + plane.w <= -radius) {
          visible = false;
        }
      }
    }
    if (visible) {
      key = -(P.forward.x * px + P.forward.y * py + P.forward.z * pz);
      idx = f32(i);
    }
  }
  pairs[i] = vec2<f32>(key, idx);
  // thread 0 seeds the SELF-DRIVING network state: records[0] = k,
  // records[1] = j (the first canonical pass is (2, 1)). The pack entry
  // overwrites the records AFTER the network — the scratch is safe.
  if (i == 0u) {
    records[0] = 2.0;
    records[1] = 1.0;
  }
}

// ── bitonic: ONE compare-exchange — the (k, j) of this pass read from the
// records head (the self-driving state); the low thread of (i, i^j) swaps
// the pair when it violates the block's direction ((i & k) == 0 →
// ascending). The pairs are disjoint per pass — in-place, no hazard ──────
@compute @workgroup_size(64)
fn bitonic(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.padN) { return; }
  let k = u32(records[0]);
  let j = u32(records[1]);
  if (k == 0u || k > P.padN) { return; } // done (a defensive no-op)
  let p = i ^ j;
  if (p <= i) { return; }
  let a = pairs[i];
  let b = pairs[p];
  let asc = (i & k) == 0u;
  if ((a.x > b.x) == asc) {
    pairs[i] = b;
    pairs[p] = a;
  }
}

// ── sortStep: the network's clock — ONE thread advances (k, j) to the
// next pass of the canonical sequence: j > 1 → (k, j/2); j == 1 →
// (2k, k); k > padN → done (0, 0). The GLSL twin walks the SAME sequence
// through per-pass uniforms (the GL facade sets them at pass EXECUTION
// time — the batched-encoder collapse is a WebGPU compute shape) ───────
@compute @workgroup_size(1)
fn sortStep(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x != 0u) { return; }
  var k = u32(records[0]);
  var j = u32(records[1]);
  if (k == 0u || k > P.padN) { return; }
  if (j > 1u) {
    j = j >> 1u;
  } else {
    k = k << 1u;
    j = k >> 1u;
  }
  if (k > P.padN) { k = 0u; j = 0u; }
  records[0] = f32(k);
  records[1] = f32(j);
}

// ── pack (the sorted twin): the record of slot i gathers the state of
// pairs[i].y — a SENTINEL writes the zero record (half extent 0, the
// degenerate instance that draws nothing) ───────────────────────────────
@compute @workgroup_size(64)
fn pack(@builtin(global_invocation_id) gid : vec3<u32>) {
  let i = gid.x;
  if (i >= P.count) { return; }
  let o = i * RSTRIDE;
  let m = pairs[i].y;
  if (m >= SENTINEL) {
    for (var f = 0u; f < RSTRIDE; f++) { records[o + f] = 0.0; }
    return;
  }
  let b = u32(m) * FSTRIDE;
${PACK_BODY_WGSL}}
`;
}
// packages/particles/src/gpuSimGl.ts
var GPU_GL_STATE_STRIDE = 20;
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
var GPU_GL_SORTKEYS_UNIFORMS = [
  { name: "u_count", size: 1 },
  { name: "u_cull", size: 1 },
  { name: "u_forward", size: 3 },
  { name: "u_p0", size: 4 },
  { name: "u_p1", size: 4 },
  { name: "u_p2", size: 4 },
  { name: "u_p3", size: 4 },
  { name: "u_p4", size: 4 },
  { name: "u_p5", size: 4 },
  { name: "u_radiusK", size: 1 }
];
var GPU_GL_SORTKEYS_F = {
  count: 0,
  cull: 1,
  forward: 2,
  planes: 5,
  radiusK: 29
};
var GPU_GL_BITONIC_UNIFORMS = [
  { name: "u_k", size: 1 },
  { name: "u_j", size: 1 }
];
var GPU_GL_BITONIC_F = {
  k: 0,
  j: 1
};
var GPU_GL_SORT_OUTPUTS = ["v_pair"];
var GPU_GL_SORT_PAD_KEY = 1000000000000000000000000000000;
var GPU_GL_SORT_SENTINEL = 33554432;
function gpuGlPairsTextureH(capacity) {
  return Math.max(1, Math.ceil((1 << Math.ceil(Math.log2(Math.max(2, capacity)))) / GPU_GL_STATE_TEXTURE_W));
}
function glslSortPrelude() {
  return `
precision highp float;
const int W = ${GPU_GL_STATE_TEXTURE_W};
ivec2 texelOf(int idx) { return ivec2(idx % W, idx / W); }
`;
}
function packBodyGlsl(slot) {
  return `  vec4 s0 = fetchState(${slot}, 0);
  vec4 s1 = fetchState(${slot}, 1);
  vec4 s2 = fetchState(${slot}, 2);
  vec4 s3 = fetchState(${slot}, 3);
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
`;
}
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
${packBodyGlsl("i")}  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`;
}
function gpuSimGlSortKeysGlsl() {
  return `#version 300 es
// @rune/particles — Task 134: the GPU render tier, the sortKeys pass. The
// uniform set mirrors GPU_GL_SORTKEYS_UNIFORMS.
${glslSortPrelude()}
uniform highp sampler2D u_state;
vec4 fetchState(int slot, int row) { return texelFetch(u_state, texelOf(slot * 5 + row), 0); }
uniform float u_count;
uniform float u_cull;
uniform vec3 u_forward;
uniform vec4 u_p0;
uniform vec4 u_p1;
uniform vec4 u_p2;
uniform vec4 u_p3;
uniform vec4 u_p4;
uniform vec4 u_p5;
uniform float u_radiusK;
// the TF output: ONE vec4 row per pair — (key, index, 0, 0).
out vec4 v_pair;
const float PAD_KEY = ${GPU_GL_SORT_PAD_KEY};
const float SENTINEL = ${GPU_GL_SORT_SENTINEL}.0;
bool planeOut(vec4 p, vec3 pos, float radius) {
  return dot(p.xyz, pos) + p.w <= -radius;
}
void main() {
  int i = gl_VertexID;
  float key = PAD_KEY;
  float idx = SENTINEL;
  if (float(i) < u_count) {
    vec4 s0 = fetchState(i, 0); // px, py, pz, vx
    vec4 s2 = fetchState(i, 2); // size, cr, cg, cb
    bool visible = true;
    if (u_cull > 0.5) {
      // the conservative sphere: size · rampMax · 0.5 ≥ every drawn extent
      float radius = s2.x * u_radiusK;
      if (planeOut(u_p0, s0.xyz, radius)) visible = false;
      if (planeOut(u_p1, s0.xyz, radius)) visible = false;
      if (planeOut(u_p2, s0.xyz, radius)) visible = false;
      if (planeOut(u_p3, s0.xyz, radius)) visible = false;
      if (planeOut(u_p4, s0.xyz, radius)) visible = false;
      if (planeOut(u_p5, s0.xyz, radius)) visible = false;
    }
    if (visible) {
      key = -(u_forward.x * s0.x + u_forward.y * s0.y + u_forward.z * s0.z);
      idx = float(i);
    }
  }
  v_pair = vec4(key, idx, 0.0, 0.0);
  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`;
}
function gpuSimGlBitonicGlsl() {
  return `#version 300 es
// @rune/particles — Task 134: the GPU render tier, ONE bitonic
// compare-exchange pass. The uniform set mirrors GPU_GL_BITONIC_UNIFORMS.
${glslSortPrelude()}
uniform highp sampler2D u_pairs;
uniform float u_k;
uniform float u_j;
out vec4 v_pair;
void main() {
  int i = gl_VertexID;
  int p = i ^ int(u_j + 0.5);
  vec4 va = texelFetch(u_pairs, texelOf(i), 0);
  vec4 vb = texelFetch(u_pairs, texelOf(p), 0);
  bool asc = (i & int(u_k + 0.5)) == 0;
  // the smaller-KEY and larger-KEY pair of the two (the index rides along)
  vec4 lo = va.x <= vb.x ? va : vb;
  vec4 hi = va.x <= vb.x ? vb : va;
  if (i < p) { v_pair = asc ? lo : hi; } else { v_pair = asc ? hi : lo; }
  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`;
}
function gpuSimGlPackSortedGlsl() {
  return `#version 300 es
// @rune/particles — Task 134: the GPU render tier, the sorted record pack
// (the WGSL sort family's pack twin). The uniform set mirrors
// GPU_GL_PACK_UNIFORMS.
${glslPrelude(GPU_GL_STATE_TEXTURE_W)}
uniform highp sampler2D u_ramp;
uniform highp sampler2D u_pairs;
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
  vec4 pr = texelFetch(u_pairs, texelOf(i), 0);
  if (pr.y >= ${GPU_GL_SORT_SENTINEL}.0) {
    // the pad/cull sentinel — the ZERO record (a degenerate instance)
    v_r0 = vec4(0.0);
    v_r1 = vec4(0.0);
    v_r2 = vec4(0.0);
    v_r3 = vec4(0.0);
    gl_Position = vec4(0.0, 0.0, 0.5, 1.0);
    return;
  }
  int slot = int(pr.y + 0.5);
${packBodyGlsl("slot")}  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`;
}
var GPU_GL_EMIT_UNIFORMS = [
  { name: "u_emitBase", size: 1 },
  { name: "u_emitCount", size: 1 },
  { name: "u_streamLo", size: 1 },
  { name: "u_streamHi", size: 1 },
  { name: "u_shapeKind", size: 1 },
  { name: "u_velMode", size: 1 },
  { name: "u_seedLo", size: 1 },
  { name: "u_seedHi", size: 1 },
  { name: "u_shapeOrigin", size: 3 },
  { name: "u_atOrigin", size: 3 },
  { name: "u_axis", size: 3 },
  { name: "u_t1", size: 3 },
  { name: "u_t2", size: 3 },
  { name: "u_fixedDir", size: 3 },
  { name: "u_lineTo", size: 3 },
  { name: "u_radius", size: 4 },
  { name: "u_cone", size: 4 },
  { name: "u_donut", size: 4 },
  { name: "u_misc", size: 4 },
  { name: "u_misc2", size: 4 },
  { name: "u_speed", size: 4 },
  { name: "u_sizeInherit", size: 3 },
  { name: "u_color0", size: 4 },
  { name: "u_color1", size: 4 },
  { name: "u_emitterV", size: 3 }
];
var GPU_GL_EMIT_F = {
  emitBase: 0,
  emitCount: 1,
  streamLo: 2,
  streamHi: 3,
  shapeKind: 4,
  velMode: 5,
  seedLo: 6,
  seedHi: 7,
  shapeOrigin: 8,
  atOrigin: 11,
  axis: 14,
  t1: 17,
  t2: 20,
  fixedDir: 23,
  lineTo: 26,
  radius: 29,
  cone: 33,
  donut: 37,
  misc: 41,
  misc2: 45,
  speed: 49,
  sizeInherit: 53,
  color0: 56,
  color1: 60,
  emitterV: 64
};
function gpuSimGlEmitGlsl() {
  const S = GPU_EMIT_SALTS;
  return `#version 300 es
// @rune/particles — Task 135: the GPU-side emission, the GLSL twin of the
// WGSL emit entry. The uniform set mirrors GPU_GL_EMIT_UNIFORMS (the
// orchestrator packs them in order).
precision highp float;
uniform float u_emitBase;
uniform float u_emitCount;
uniform float u_streamLo;
uniform float u_streamHi;
uniform float u_shapeKind;
uniform float u_velMode;
uniform float u_seedLo;
uniform float u_seedHi;
uniform vec3 u_shapeOrigin;
uniform vec3 u_atOrigin;
uniform vec3 u_axis;
uniform vec3 u_t1;
uniform vec3 u_t2;
uniform vec3 u_fixedDir;
uniform vec3 u_lineTo;
uniform vec4 u_radius;     // (rMin, rMax, hemArc, donR)
uniform vec4 u_cone;       // (cosHalf, baseRadius, lenMin, lenMax)
uniform vec4 u_donut;      // (tubeMin, tubeMax, donArc, arms)
uniform vec4 u_misc;       // (armSpread, twist, rectW, rectH)
uniform vec4 u_misc2;      // (gridW, gridH, gridRows, gridCols)
uniform vec4 u_speed;      // (speedMin, speedMax, lifeMin, lifeMax)
uniform vec3 u_sizeInherit; // (sizeMin, sizeMax, inheritK)
uniform vec4 u_color0;
uniform vec4 u_color1;
uniform vec3 u_emitterV;
// the TF outputs: the 20-float state row (17 fields + 3 pad).
out vec4 v_s0; // px, py, pz, vx
out vec4 v_s1; // vy, vz, age, life
out vec4 v_s2; // size, cr, cg, cb
out vec4 v_s3; // ca, seed, tx, ty
out vec4 v_s4; // tz, pad, pad, pad

// @rune/core random.ts's hash01 — bit-identical in uint (GLSL ES 3.00's
// uint arithmetic wraps mod 2^32 exactly like Math.imul; the quotient's
// f32 rounding is the same 1-ULP class as the WGSL twin)
float hash01f(uint sd, uint gi, uint salt) {
  uint h = sd * 374761393u + gi * 668265263u + salt * 2246822519u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return float(h) / 4294967296.0;
}

const float TAU = 6.283185307179586;

void main() {
  // the 32-bit hash domain from the two float halves (exact to 2^24 each —
  // the halves are 16-bit, the recombination is pure uint) PLUS the
  // window-local vertex index: gi = streamBase + i (the WGSL twin's own
  // streamBase + i — every newborn is its own hash draw)
  uint gi = uint(gl_VertexID) + ((uint(u_streamHi + 0.5) << 16u) | uint(u_streamLo + 0.5));
  uint sd = (uint(u_seedHi + 0.5) << 16u) | uint(u_seedLo + 0.5);
  int shapeKind = int(u_shapeKind + 0.5);
  int velMode = int(u_velMode + 0.5);

  float u = hash01f(sd, gi, ${S.dir}u);
  float v = hash01f(sd, gi, ${S.dir + 100}u);
  vec3 p = u_shapeOrigin;
  vec3 d = u_fixedDir;

  if (shapeKind == 1) { // sphere — a uniform direction + the radius band
    float z = 1.0 - 2.0 * u;
    float s = sqrt(max(0.0, 1.0 - z * z));
    float phi = TAU * v;
    d = vec3(s * cos(phi), s * sin(phi), z);
    float r = u_radius.x + (u_radius.y - u_radius.x) * hash01f(sd, gi, ${S.p0}u);
    p = u_shapeOrigin + d * r;
  } else if (shapeKind == 2) { // cone — the fan-compressed lobe + the base disc
    float z = 1.0 - (1.0 - u_cone.x) * u;
    float s = sqrt(max(0.0, 1.0 - z * z));
    float phi = TAU * v;
    d = u_axis * z + (u_t1 * cos(phi) + u_t2 * sin(phi)) * s;
    float rr = u_cone.y * sqrt(hash01f(sd, gi, ${S.p0}u));
    float rphi = TAU * hash01f(sd, gi, ${S.p1}u);
    float stretch = u_cone.z + (u_cone.w - u_cone.z) * hash01f(sd, gi, ${S.p2}u);
    vec2 c = vec2(cos(rphi) * rr, sin(rphi) * rr);
    p = u_shapeOrigin + u_t1 * c.x + u_t2 * c.y + u_axis * stretch;
  } else if (shapeKind == 3) { // disc — the area-uniform annulus (+ the arms)
    float r2 = u_radius.x * u_radius.x + (u_radius.y * u_radius.y - u_radius.x * u_radius.x) * u;
    float rr = sqrt(r2);
    float phi = TAU * v;
    if (u_donut.w >= 1.0) { // arms
      float arm = floor(hash01f(sd, gi, ${S.p0}u) * u_donut.w);
      float scatter = (hash01f(sd, gi, ${S.p1}u) - 0.5) * 2.0 * u_misc.x;
      float tR = (rr - u_radius.x) / max(1e-6, u_radius.y - u_radius.x);
      phi = arm * (TAU / u_donut.w) + u_misc.y * tR + scatter;
    }
    p = u_shapeOrigin + (u_t1 * cos(phi) + u_t2 * sin(phi)) * rr;
  } else if (shapeKind == 4) { // hemisphere — the area-correct dome
    float cosTheta = u;
    float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
    float phi = u_radius.z * v;
    d = u_axis * cosTheta + (u_t1 * cos(phi) + u_t2 * sin(phi)) * sinTheta;
    float r = u_radius.x + (u_radius.y - u_radius.x) * hash01f(sd, gi, ${S.p0}u);
    p = u_shapeOrigin + d * r;
  } else if (shapeKind == 5) { // donut — the ring + the tube circle
    float phi = u_donut.z * u;
    float tr = u_donut.x + (u_donut.y - u_donut.x) * hash01f(sd, gi, ${S.p0}u);
    float psi = TAU * hash01f(sd, gi, ${S.p1}u);
    vec3 radial = u_t1 * cos(phi) + u_t2 * sin(phi);
    p = u_shapeOrigin + radial * (u_radius.w + tr * cos(psi)) + u_axis * (tr * sin(psi));
  } else if (shapeKind == 6) { // rectangle — the plane patch ⊥ axis
    vec2 h = vec2((u - 0.5) * u_misc.z, (v - 0.5) * u_misc.w);
    p = u_shapeOrigin + u_t1 * h.x + u_t2 * h.y;
  } else if (shapeKind == 7) { // grid — the hash-picked cell ('random')
    float col = floor(hash01f(sd, gi, ${S.p0}u) * u_misc2.w);
    float row = floor(hash01f(sd, gi, ${S.p1}u) * u_misc2.z);
    vec2 g = vec2((col + 0.5) / u_misc2.w - 0.5, (row + 0.5) / u_misc2.z - 0.5);
    p = u_shapeOrigin + u_t1 * (g.x * u_misc2.x) + u_t2 * (g.y * u_misc2.y);
  } else if (shapeKind == 8) { // line — the uniform span ('random')
    p = u_shapeOrigin + (u_lineTo - u_shapeOrigin) * u;
  }

  // the velocity mode overrides (radial/tangential read the SHAPE-LOCAL
  // position — the at() translation comes after, the CPU's own order)
  if (velMode == 2) { // radial
    vec3 r = p - u_shapeOrigin;
    float l = length(r);
    if (l > 1e-12) {
      d = r / l;
    } else {
      // the degenerate scatter (Task 124's fix — a uniform random direction)
      float theta = TAU * hash01f(sd, gi, ${S.scat0}u);
      float cphi = 2.0 * hash01f(sd, gi, ${S.scat1}u) - 1.0;
      float sphi = sqrt(max(0.0, 1.0 - cphi * cphi));
      d = vec3(sphi * cos(theta), sphi * sin(theta), cphi);
    }
  } else if (velMode == 3) { // axis
    d = u_axis;
  } else if (velMode == 4) { // tangential — cross(axis, radial)
    vec3 r = p - u_shapeOrigin;
    d = cross(u_axis, r);
    float l = length(d);
    if (l > 1e-12) { d = d / l; } else { d = u_axis; }
  }
  // velMode 1 (fixed) / 5 (lobe): keep the shape branch's direction

  float spd = u_speed.x + (u_speed.y - u_speed.x) * hash01f(sd, gi, ${S.spd}u);
  float mixC = hash01f(sd, gi, ${S.col}u);
  float life = u_speed.z + (u_speed.w - u_speed.z) * hash01f(sd, gi, ${S.life}u);
  float size = u_sizeInherit.x + (u_sizeInherit.y - u_sizeInherit.x) * hash01f(sd, gi, ${S.size}u);
  float seedF = hash01f(sd, gi, ${S.seed}u);

  vec3 w = p + u_atOrigin;
  vec3 vel = d * spd + u_emitterV * u_sizeInherit.z;
  vec4 col = mix(u_color0, u_color1, mixC);
  v_s0 = vec4(w, vel.x);                       // px, py, pz, vx
  v_s1 = vec4(vel.y, vel.z, 0.0, life);        // vy, vz, age 0, life
  v_s2 = vec4(size, col.r, col.g, col.b);      // size, cr, cg, cb
  v_s3 = vec4(col.a, seedF, w.x, w.y);         // ca, seed, tx, ty (no target — the spawn position)
  v_s4 = vec4(w.z, 0.0, 0.0, 0.0);            // tz + the pad
  gl_Position = vec4(0.0, 0.0, 0.5, 1.0); // never rasterized (discard on)
}
`;
}
// packages/particles/src/trails.ts
function createTrailHistory(capacity, options = {}) {
  const points = options.points ?? 24;
  const step = options.step ?? 1 / 30;
  if (!Number.isInteger(points) || points < 2 || points > 1024) {
    throw new Error(`rune/particles: trail points must be an integer in [2, 1024] (got ${points})`);
  }
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`rune/particles: trail step must be a finite > 0 (got ${step})`);
  }
  const hx = new Float32Array(capacity * points * 3);
  const heads = new Uint16Array(capacity);
  const counts = new Uint16Array(capacity);
  const lastAge = new Float32Array(capacity);
  let acc = 0;
  const stride = points * 3;
  return {
    points,
    step,
    hx,
    heads,
    counts,
    record(system, dt) {
      const f = system.fields;
      const n = system.count;
      acc += dt;
      let doRecord = false;
      if (acc >= step) {
        acc = acc > step * 4 ? step : acc;
        doRecord = true;
        acc -= step;
      }
      for (let i = 0;i < n; i++) {
        const age = f.age[i];
        if (age <= dt + 0.000001 || age < lastAge[i] - 0.000001) {
          heads[i] = 0;
          counts[i] = 1;
          const b = i * stride;
          hx[b] = f.px[i];
          hx[b + 1] = f.py[i];
          hx[b + 2] = f.pz[i];
          lastAge[i] = age;
          continue;
        }
        lastAge[i] = age;
        if (counts[i] === 0) {
          heads[i] = 0;
          counts[i] = 1;
          const b = i * stride;
          hx[b] = f.px[i];
          hx[b + 1] = f.py[i];
          hx[b + 2] = f.pz[i];
        }
        if (doRecord) {
          const head = (heads[i] + 1) % points;
          heads[i] = head;
          if (counts[i] < points)
            counts[i]++;
          const b = i * stride + head * 3;
          hx[b] = f.px[i];
          hx[b + 1] = f.py[i];
          hx[b + 2] = f.pz[i];
        }
      }
    },
    handleSwap(to, from) {
      if (to === from)
        return;
      const src = from * stride;
      const dst = to * stride;
      for (let k = 0;k < stride; k++)
        hx[dst + k] = hx[src + k];
      heads[to] = heads[from];
      counts[to] = counts[from];
      lastAge[to] = lastAge[from];
    }
  };
}
var SCRATCH3 = new Float32Array(6);
function fillTrails(system, history, basis, out, options = {}) {
  const ramp = options.ramp ?? CONSTANT_RAMP;
  const lengthCap = options.length ?? Infinity;
  const widthK = options.width ?? 1;
  const f = system.fields;
  const count = system.count;
  const points = history.points;
  const { hx, heads, counts } = history;
  const stride = points * 3;
  const fx = basis.forward[0], fy = basis.forward[1], fz = basis.forward[2];
  const s = SCRATCH3;
  let at = 0;
  for (let i = 0;i < count; i++) {
    const histCount = counts[i];
    if (histCount < 1)
      continue;
    const t = f.life[i] > 0 ? f.age[i] / f.life[i] : 0;
    sampleRamp(ramp, t, s);
    const halfW = Math.max(0, f.size[i] * s[0] * widthK * 0.5);
    if (halfW <= 0)
      continue;
    const headX = f.px[i], headY = f.py[i], headZ = f.pz[i];
    const cr = f.cr[i] * s[1], cg = f.cg[i] * s[2], cb = f.cb[i] * s[3], ca = f.ca[i] * s[4];
    const maxK = Math.min(histCount, points);
    let K = 0;
    for (let k = 1;k <= maxK; k++) {
      const idx = (heads[i] - (k - 1) + points * 2) % points;
      const b = i * stride + idx * 3;
      const dxx = hx[b] - headX, dyy = hx[b + 1] - headY, dzz = hx[b + 2] - headZ;
      if (Math.hypot(dxx, dyy, dzz) > lengthCap)
        break;
      K = k;
    }
    if (K < 1)
      continue;
    let prevX = headX, prevY = headY, prevZ = headZ;
    let prevSX = 0, prevSY = 0, prevSZ = 0, prevW = 0;
    let prevValid = false;
    for (let k = 1;k <= K; k++) {
      const idx = (heads[i] - (k - 1) + points * 2) % points;
      const b = i * stride + idx * 3;
      const curX = hx[b], curY = hx[b + 1], curZ = hx[b + 2];
      let nextX = curX, nextY = curY, nextZ = curZ;
      if (k < K) {
        const nIdx = (heads[i] - k + points * 2) % points;
        const nb = i * stride + nIdx * 3;
        nextX = hx[nb];
        nextY = hx[nb + 1];
        nextZ = hx[nb + 2];
      }
      let dirX = nextX - prevX, dirY = nextY - prevY, dirZ = nextZ - prevZ;
      const dl = Math.hypot(dirX, dirY, dirZ);
      if (dl < 0.000000001) {
        dirX = fx;
        dirY = fy;
        dirZ = fz;
      } else {
        dirX /= dl;
        dirY /= dl;
        dirZ /= dl;
      }
      let sx = fy * dirZ - fz * dirY, sy = fz * dirX - fx * dirZ, sz = fx * dirY - fy * dirX;
      let sl = Math.hypot(sx, sy, sz);
      if (sl < 0.000001) {
        sx = dirY;
        sy = -dirX;
        sz = 0;
        sl = Math.hypot(sx, sy, sz) || 1;
      }
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const w = halfW * (1 - k / K);
      if (prevValid) {
        const u0 = (k - 1) / K, u1 = k / K;
        const a = ca * (1 - u0 * 0.85);
        const bA = ca * (1 - u1 * 0.85);
        const pLx = prevX - prevSX * prevW, pLy = prevY - prevSY * prevW, pLz = prevZ - prevSZ * prevW;
        const pRx = prevX + prevSX * prevW, pRy = prevY + prevSY * prevW, pRz = prevZ + prevSZ * prevW;
        const cLx = curX - sx * w, cLy = curY - sy * w, cLz = curZ - sz * w;
        const cRx = curX + sx * w, cRy = curY + sy * w, cRz = curZ + sz * w;
        at = tv(out, at, pLx, pLy, pLz, u0, 0, cr, cg, cb, a);
        at = tv(out, at, pRx, pRy, pRz, u0, 1, cr, cg, cb, a);
        at = tv(out, at, cLx, cLy, cLz, u1, 0, cr, cg, cb, bA);
        at = tv(out, at, cLx, cLy, cLz, u1, 0, cr, cg, cb, bA);
        at = tv(out, at, pRx, pRy, pRz, u0, 1, cr, cg, cb, a);
        at = tv(out, at, cRx, cRy, cRz, u1, 1, cr, cg, cb, bA);
      }
      prevX = curX;
      prevY = curY;
      prevZ = curZ;
      prevSX = sx;
      prevSY = sy;
      prevSZ = sz;
      prevW = w;
      prevValid = true;
    }
  }
  return at / SOUP_STRIDE;
}
function tv(out, at, x, y, z, u, v, cr, cg, cb, ca) {
  out[at] = x;
  out[at + 1] = y;
  out[at + 2] = z;
  out[at + 3] = u;
  out[at + 4] = v;
  out[at + 5] = cr;
  out[at + 6] = cg;
  out[at + 7] = cb;
  out[at + 8] = ca;
  return at + SOUP_STRIDE;
}
// packages/particles/src/meshes.ts
var MESH_STRIDE = 12;
var SCRATCH4 = new Float32Array(6);
function fillMeshes(system, geometry, out, options = {}) {
  const ramp = options.ramp ?? CONSTANT_RAMP;
  const spin = options.spin ?? 0;
  const axisOpt = options.axis ?? "random";
  const f = system.fields;
  const count = system.count;
  const g = geometry.positions;
  const gn = geometry.normals ?? null;
  const gu = geometry.uvs ?? null;
  const vCount = geometry.vertexCount;
  if (g.length < vCount * 3) {
    throw new Error(`rune/particles: mesh geometry positions too short (${g.length} floats for ${vCount} verts)`);
  }
  const s = SCRATCH4;
  let oax = 0, oay = 0, oaz = 1;
  const axisRandom = axisOpt === "random";
  if (!axisRandom) {
    const a = axisOpt;
    const al = Math.hypot(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
    if (al < 0.000000000001 || !Number.isFinite(al)) {
      throw new Error("rune/particles: the mesh axis must be a finite non-zero vector");
    }
    oax = (a[0] ?? 0) / al;
    oay = (a[1] ?? 0) / al;
    oaz = (a[2] ?? 0) / al;
  }
  let at = 0;
  for (let i = 0;i < count; i++) {
    const t = f.life[i] > 0 ? f.age[i] / f.life[i] : 0;
    sampleRamp(ramp, t, s);
    const scale = f.size[i] * s[0];
    if (scale <= 0)
      continue;
    const cr = f.cr[i] * s[1], cg = f.cg[i] * s[2], cb = f.cb[i] * s[3], ca = f.ca[i] * s[4];
    const px = f.px[i], py = f.py[i], pz = f.pz[i];
    let ax2 = oax, ay2 = oay, az2 = oaz;
    if (axisRandom) {
      const sd = f.seed[i];
      const s1 = sd * 7.31 - Math.floor(sd * 7.31);
      const s2 = sd * 3.77 - Math.floor(sd * 3.77);
      const zc = 1 - 2 * s1;
      const rc = Math.sqrt(Math.max(0, 1 - zc * zc));
      const phi = 6.283185307179586 * s2;
      ax2 = rc * Math.cos(phi);
      ay2 = rc * Math.sin(phi);
      az2 = zc;
    }
    const ang = f.seed[i] * 6.283185307179586 + f.age[i] * spin;
    const c = Math.cos(ang), sn = Math.sin(ang), tt = 1 - c;
    const m00 = tt * ax2 * ax2 + c, m01 = tt * ax2 * ay2 - sn * az2, m02 = tt * ax2 * az2 + sn * ay2;
    const m10 = tt * ax2 * ay2 + sn * az2, m11 = tt * ay2 * ay2 + c, m12 = tt * ay2 * az2 - sn * ax2;
    const m20 = tt * ax2 * az2 - sn * ay2, m21 = tt * ay2 * az2 + sn * ax2, m22 = tt * az2 * az2 + c;
    for (let v = 0;v < vCount; v++) {
      const b3 = v * 3;
      const gx = g[b3], gy = g[b3 + 1], gz = g[b3 + 2];
      out[at] = px + (m00 * gx + m01 * gy + m02 * gz) * scale;
      out[at + 1] = py + (m10 * gx + m11 * gy + m12 * gz) * scale;
      out[at + 2] = pz + (m20 * gx + m21 * gy + m22 * gz) * scale;
      if (gn !== null) {
        out[at + 3] = m00 * gn[b3] + m01 * gn[b3 + 1] + m02 * gn[b3 + 2];
        out[at + 4] = m10 * gn[b3] + m11 * gn[b3 + 1] + m12 * gn[b3 + 2];
        out[at + 5] = m20 * gn[b3] + m21 * gn[b3 + 1] + m22 * gn[b3 + 2];
      } else {
        out[at + 3] = 0;
        out[at + 4] = 0;
        out[at + 5] = 1;
      }
      if (gu !== null) {
        out[at + 6] = gu[v * 2];
        out[at + 7] = gu[v * 2 + 1];
      } else {
        out[at + 6] = 0;
        out[at + 7] = 0;
      }
      out[at + 8] = cr;
      out[at + 9] = cg;
      out[at + 10] = cb;
      out[at + 11] = ca;
      at += MESH_STRIDE;
    }
  }
  return at / MESH_STRIDE;
}
// packages/particles/src/field.ts
function createGrassField(desc) {
  const count = desc.count;
  if (!Number.isInteger(count) || count < 1 || count > 2000000) {
    throw new Error(`rune/particles: grass count must be an integer in [1, 2M] (got ${count})`);
  }
  const radius = desc.radius;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`rune/particles: grass radius must be a finite > 0 (got ${radius})`);
  }
  const [hMin, hMax] = desc.height;
  if (!Number.isFinite(hMin + hMax) || hMin <= 0 || hMax < hMin) {
    throw new Error(`rune/particles: grass height must be [min > 0 <= max] (got [${hMin}, ${hMax}])`);
  }
  const wRange = desc.width ?? [0.06, 0.12];
  const [wMin, wMax] = wRange;
  if (!Number.isFinite(wMin + wMax) || wMin <= 0 || wMax < wMin) {
    throw new Error(`rune/particles: grass width must be [min > 0 <= max] (got [${wMin}, ${wMax}])`);
  }
  const mask = desc.mask;
  if (mask !== undefined && typeof mask !== "function") {
    throw new Error(`rune/particles: grass mask must be a function (x, z) → [0, 1] (got ${typeof mask})`);
  }
  const groundY = desc.groundY ?? 0;
  const c0 = desc.color?.[0] ?? [0.16, 0.34, 0.1];
  const c1 = desc.color?.[1] ?? [0.42, 0.55, 0.18];
  const fade = desc.fade ?? radius * 0.9;
  if (!Number.isFinite(fade) || fade <= 0) {
    throw new Error(`rune/particles: grass fade must be a finite > 0 (got ${fade})`);
  }
  const fadeBand = desc.fadeBand ?? 0.35;
  if (!Number.isFinite(fadeBand) || fadeBand <= 0 || fadeBand >= 1) {
    throw new Error(`rune/particles: grass fadeBand must be in (0, 1) (got ${fadeBand})`);
  }
  const seed = (desc.seed ?? 1) | 0;
  const cap = Math.min(count, 2000000);
  const pos = new Float32Array(cap * 3);
  const par = new Float32Array(cap * 4);
  const tint = new Float32Array(cap * 4);
  let n = 0;
  let tries = 0;
  const maxTries = cap * 5;
  while (n < cap && tries < maxTries) {
    const rr = radius * Math.sqrt(hash01(seed, tries, 21));
    const ang = 6.283185307179586 * hash01(seed, tries, 22);
    const x = Math.cos(ang) * rr;
    const z = Math.sin(ang) * rr;
    let w = 1;
    if (mask !== undefined) {
      w = mask(x, z);
      if (!Number.isFinite(w))
        w = 1;
      if (w < 0)
        w = 0;
      if (w > 1)
        w = 1;
      if (w < 1 && hash01(seed, tries, 41) >= w) {
        tries++;
        continue;
      }
    }
    pos[n * 3] = x;
    pos[n * 3 + 1] = groundY;
    pos[n * 3 + 2] = z;
    par[n * 4] = (hMin + (hMax - hMin) * hash01(seed, tries, 23)) * (0.55 + 0.45 * w);
    par[n * 4 + 1] = 6.283185307179586 * hash01(seed, tries, 24);
    par[n * 4 + 2] = hash01(seed, tries, 25);
    par[n * 4 + 3] = wMin + (wMax - wMin) * hash01(seed, tries, 26);
    const mix = hash01(seed, tries, 27);
    tint[n * 4] = c0[0] + (c1[0] - c0[0]) * mix;
    tint[n * 4 + 1] = c0[1] + (c1[1] - c0[1]) * mix;
    tint[n * 4 + 2] = c0[2] + (c1[2] - c0[2]) * mix;
    tint[n * 4 + 3] = (0.8 + 0.4 * hash01(seed, tries, 28)) * (0.75 + 0.35 * w);
    n++;
    tries++;
  }
  return { pos, par, tint, count: n, fade, glsl: glslOf(fade, fadeBand), wgsl: wgslOf(fade, fadeBand) };
}
function glslOf(fade, band) {
  const F = fade.toFixed(2);
  const B = (fade * band).toFixed(2);
  const vertex = `#version 300 es
// The grass vertex: one quad per blade from gl_VertexID, cylindrical
// billboard, the gust field + the per-blade flutter bend.
layout(location = 0) in vec3 i_pos;
layout(location = 1) in vec4 i_par;
layout(location = 2) in vec4 i_tint;
uniform mat4 u_mvp;
uniform vec3 u_camPos;
uniform float u_time;
uniform vec4 u_wind; // (dirX, dirZ, strength, gustiness)
out vec2 v_uv;
out vec4 v_tint;
out float v_fade;

const vec2 CORNERS[6] = vec2[6](vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(1.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(0.0, 0.0));

void main() {
  vec2 cu = CORNERS[gl_VertexID];
  float t = cu.y; // 0 at the base, 1 at the tip
  float h = i_par.x, lean = i_par.y, phase = i_par.z, width = i_par.w;

  // THE GUST FIELD (Task 128 — the "wind as WAVES" upgrade): the wind's
  // bend DIRECTION now SWINGS with a traveling wave (the gust front
  // visibly rolls across the field — not just the amplitude pulsing with
  // every blade leaning the same way). Two waves with SHORT wavelengths
  // (~9.7 and ~11 units — 5+ crests visible at once over a 60-unit field)
  // crossing at an angle, plus a swing term that steers the bend around
  // the wind axis, plus the per-blade flutter.
  float waveA = sin(dot(i_pos.xz, vec2(0.63, 0.44)) - u_time * 2.1);
  float waveB = sin(dot(i_pos.xz, vec2(-0.42, 0.55)) + u_time * 1.4);
  float gust = 0.5 + 0.5 * (waveA + 0.6 * waveB) / 1.6; // 0..1 envelope
  float flutter = sin(u_time * (2.2 + phase * 1.5) + phase * 6.28318);
  // the swing: the bend direction wobbles ±~20° around the wind axis,
  // phase-shifted in space (the wave reads as a rolling front)
  float swing = 0.36 * sin(dot(i_pos.xz, vec2(0.5, -0.33)) - u_time * 1.5);
  vec2 windDir = normalize(u_wind.xy + vec2(1e-4, 0.0));
  vec2 bendDir = normalize(windDir + vec2(-windDir.y, windDir.x) * swing);
  float bendK = u_wind.z * (0.35 + 0.65 * gust) + u_wind.w * flutter;

  // The static lean (a fixed per-blade tilt) and the wind bend, both
  // growing with t^2 (a blade bends at the top, not the base).
  float b = t * t;
  vec2 leanDir = vec2(cos(lean), sin(lean)) * (0.35 * b);
  vec2 windOff = bendDir * (bendK * 0.5 * b);

  // Cylindrical billboard: face the camera around world Y, anchored.
  vec3 toCam = u_camPos - i_pos;
  vec3 right = normalize(vec3(-toCam.z, 0.0, toCam.x));
  vec3 world = i_pos + right * ((cu.x - 0.5) * width)
             + vec3(0.0, t * h, 0.0)
             + vec3(leanDir.x + windOff.x, 0.0, leanDir.y + windOff.y);

  gl_Position = u_mvp * vec4(world, 1.0);
  v_uv = vec2(cu.x, t);
  v_tint = i_tint;
  v_fade = clamp((${F} - length(u_camPos - i_pos)) / ${B}, 0.0, 1.0);
}`;
  const fragment = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec4 v_tint;
in float v_fade;
uniform sampler2D u_tex;
out vec4 o_color;
void main() {
  vec4 texel = texture(u_tex, v_uv);
  // The blade gradient: dark base -> bright tip (the texture owns it).
  // THE SMOOTH FAR FADE (the density LOD): near (v_fade = 1) the classic
  // hard silhouette mask; through the fade band each pixel survives with
  // probability ~ v_fade — a screen-door dissolve driven by interleaved
  // gradient noise. At range a blade is a few pixels, so the stochastic
  // holes average into a smooth density falloff — no hard pop at the
  // fade distance, no sorting, no blending, depth-write stays on.
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (texel.a < 0.5 || n > v_fade) discard;
  o_color = vec4(texel.rgb * v_tint.rgb * v_tint.a, 1.0);
}`;
  return { vertex, fragment };
}
function wgslOf(fade, band) {
  const F = fade.toFixed(2);
  const B = (fade * band).toFixed(2);
  return `
struct Params {
  u_mvp : mat4x4<f32>,
  u_camPos : vec4<f32>,
  u_time : f32,
  u_wind : vec4<f32>,
}
@group(0) @binding(0) var<uniform> params : Params;
@group(1) @binding(0) var texSampler : sampler;
@group(1) @binding(1) var texTexture : texture_2d<f32>;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) tint : vec4<f32>,
  @location(2) fade : f32,
}

@vertex
fn vsMain(@builtin(vertex_index) vi : u32,
          @location(0) i_pos : vec3<f32>,
          @location(1) i_par : vec4<f32>,
          @location(2) i_tint : vec4<f32>) -> VSOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0), vec2<f32>(1.0, 0.0),
                                     vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 0.0));
  let cu = corners[vi];
  let t = cu.y;
  let h = i_par.x;
  let lean = i_par.y;
  let phase = i_par.z;
  let width = i_par.w;

  // THE GUST FIELD — the WGSL twin of the GLSL wave/swing upgrade (the
  // bend direction rolls with the traveling fronts, ~5 crests at once).
  let waveA = sin(dot(i_pos.xz, vec2<f32>(0.63, 0.44)) - params.u_time * 2.1);
  let waveB = sin(dot(i_pos.xz, vec2<f32>(-0.42, 0.55)) + params.u_time * 1.4);
  let gust = 0.5 + 0.5 * (waveA + 0.6 * waveB) / 1.6;
  let flutter = sin(params.u_time * (2.2 + phase * 1.5) + phase * 6.28318);
  let swing = 0.36 * sin(dot(i_pos.xz, vec2<f32>(0.5, -0.33)) - params.u_time * 1.5);
  let windDir = normalize(params.u_wind.xy + vec2<f32>(1e-4, 0.0));
  let bendDir = normalize(windDir + vec2<f32>(-windDir.y, windDir.x) * swing);
  let bendK = params.u_wind.z * (0.35 + 0.65 * gust) + params.u_wind.w * flutter;

  let b = t * t;
  let leanDir = vec2<f32>(cos(lean), sin(lean)) * (0.35 * b);
  let windOff = bendDir * (bendK * 0.5 * b);

  let toCam = params.u_camPos.xyz - i_pos;
  var right = vec3<f32>(-toCam.z, 0.0, toCam.x);
  let rl = length(right);
  if (rl < 1e-6) { right = vec3<f32>(1.0, 0.0, 0.0); } else { right = right / rl; }
  let world = i_pos + right * ((cu.x - 0.5) * width)
            + vec3<f32>(0.0, t * h, 0.0)
            + vec3<f32>(leanDir.x + windOff.x, 0.0, leanDir.y + windOff.y);

  var out : VSOut;
  out.pos = params.u_mvp * vec4<f32>(world, 1.0);
  out.uv = vec2<f32>(cu.x, t);
  out.tint = i_tint;
  out.fade = clamp((${F} - length(params.u_camPos.xyz - i_pos)) / ${B}, 0.0, 1.0);
  return out;
}

@fragment
fn fsMain(frag : VSOut) -> @location(0) vec4<f32> {
  let texel = textureSample(texTexture, texSampler, frag.uv);
  // THE SMOOTH FAR FADE — the WGSL twin of the GLSL screen-door dissolve
  // (interleaved gradient noise vs. the blade's fade factor; near = the
  // hard silhouette mask, far = stochastic thinning into the ground).
  let n = fract(52.9829189 * fract(dot(frag.pos.xy, vec2<f32>(0.06711056, 0.00583715))));
  if (texel.a < 0.5 || n > frag.fade) { discard; }
  return vec4<f32>(texel.rgb * frag.tint.rgb * frag.tint.a, 1.0);
}`;
}
// packages/particles/src/validate.ts
function validateAttractor(at) {
  if (at === undefined || at === null)
    return null;
  const { point, strength, softening } = at;
  if (!Array.isArray(point) || point.length !== 3 || !point.every((v) => Number.isFinite(v))) {
    throw new Error(`rune/particles: attract.point must be three finite numbers (got ${JSON.stringify(point)})`);
  }
  if (!Number.isFinite(strength)) {
    throw new Error(`rune/particles: attract.strength must be finite (got ${strength}; negative = repulsion) — NaN is not an infinite attractor`);
  }
  const soft = softening ?? 0.25;
  if (!Number.isFinite(soft) || soft <= 0) {
    throw new Error(`rune/particles: attract.softening must be finite > 0 (got ${softening}; it caps the force at the center — without it the integrator NaNs)`);
  }
  const kill = at.killRadius ?? 0;
  if (!Number.isFinite(kill) || kill < 0) {
    throw new Error(`rune/particles: attract.killRadius must be a finite >= 0 (got ${at.killRadius}; particles inside the sphere are consumed)`);
  }
  return at;
}
function validateCollision(collide) {
  if (collide === undefined || collide === null)
    return null;
  const shapeCount = (collide.planes?.length ?? 0) + (collide.spheres?.length ?? 0) + (collide.boxes?.length ?? 0);
  if (shapeCount === 0) {
    throw new Error("rune/particles: collide needs at least one plane, sphere or box (a collision set with no shapes is a silent no-op)");
  }
  if (collide.planes !== undefined && !Array.isArray(collide.planes)) {
    throw new Error(`rune/particles: collide.planes must be an array (got ${typeof collide.planes})`);
  }
  if (collide.spheres !== undefined && !Array.isArray(collide.spheres)) {
    throw new Error(`rune/particles: collide.spheres must be an array (got ${typeof collide.spheres})`);
  }
  if (collide.boxes !== undefined && !Array.isArray(collide.boxes)) {
    throw new Error(`rune/particles: collide.boxes must be an array (got ${typeof collide.boxes})`);
  }
  if ((collide.planes?.length ?? 0) > MAX_PLANES) {
    throw new Error(`rune/particles: collide.planes is capped at ${MAX_PLANES} (got ${collide.planes.length}) — the flat scratch is sized to the cap`);
  }
  if ((collide.spheres?.length ?? 0) > MAX_SPHERES) {
    throw new Error(`rune/particles: collide.spheres is capped at ${MAX_SPHERES} (got ${collide.spheres.length}) — the flat scratch is sized to the cap`);
  }
  if ((collide.boxes?.length ?? 0) > MAX_BOXES) {
    throw new Error(`rune/particles: collide.boxes is capped at ${MAX_BOXES} (got ${collide.boxes.length}) — the flat scratch is sized to the cap`);
  }
  for (const plane of collide.planes ?? []) {
    if (!Array.isArray(plane.normal) || plane.normal.length !== 3 || !plane.normal.every((v) => Number.isFinite(v))) {
      throw new Error(`rune/particles: a collision plane normal must be three finite numbers (got ${JSON.stringify(plane.normal)})`);
    }
    if (Math.hypot(plane.normal[0], plane.normal[1], plane.normal[2]) < 0.000000000001) {
      throw new Error("rune/particles: a collision plane normal must be non-zero");
    }
    if (!Array.isArray(plane.point) || plane.point.length !== 3 || !plane.point.every((v) => Number.isFinite(v))) {
      throw new Error(`rune/particles: a collision plane point must be three finite numbers (got ${JSON.stringify(plane.point)})`);
    }
    if (!Number.isFinite(plane.restitution) || plane.restitution < 0 || plane.restitution > 1) {
      throw new Error(`rune/particles: plane restitution must be in [0, 1] (got ${plane.restitution})`);
    }
    const fr = plane.friction ?? 0;
    if (!Number.isFinite(fr) || fr < 0 || fr > 1) {
      throw new Error(`rune/particles: plane friction must be in [0, 1] (got ${fr})`);
    }
    if (plane.kill !== undefined && typeof plane.kill !== "boolean") {
      throw new Error(`rune/particles: plane kill must be a boolean (got ${JSON.stringify(plane.kill)}; true = the particle retires on contact)`);
    }
  }
  for (const sphere of collide.spheres ?? []) {
    if (!Array.isArray(sphere.center) || sphere.center.length !== 3 || !sphere.center.every((v) => Number.isFinite(v))) {
      throw new Error(`rune/particles: a collision sphere center must be three finite numbers (got ${JSON.stringify(sphere.center)})`);
    }
    if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) {
      throw new Error(`rune/particles: a collision sphere radius must be a finite > 0 (got ${sphere.radius})`);
    }
    if (!Number.isFinite(sphere.restitution) || sphere.restitution < 0 || sphere.restitution > 1) {
      throw new Error(`rune/particles: sphere restitution must be in [0, 1] (got ${sphere.restitution})`);
    }
    const fr = sphere.friction ?? 0;
    if (!Number.isFinite(fr) || fr < 0 || fr > 1) {
      throw new Error(`rune/particles: sphere friction must be in [0, 1] (got ${fr})`);
    }
    if (sphere.kill !== undefined && typeof sphere.kill !== "boolean") {
      throw new Error(`rune/particles: sphere kill must be a boolean (got ${JSON.stringify(sphere.kill)})`);
    }
  }
  for (const box of collide.boxes ?? []) {
    if (!Array.isArray(box.center) || box.center.length !== 3 || !box.center.every((v) => Number.isFinite(v))) {
      throw new Error(`rune/particles: a collision box center must be three finite numbers (got ${JSON.stringify(box.center)})`);
    }
    if (!Array.isArray(box.half) || box.half.length !== 3 || !box.half.every((v) => Number.isFinite(v) && v > 0)) {
      throw new Error(`rune/particles: a collision box half must be three finite numbers > 0 (got ${JSON.stringify(box.half)}; [1.6, 0.9, 1.6] = a 3.2×1.8×3.2 crate)`);
    }
    if (!Number.isFinite(box.restitution) || box.restitution < 0 || box.restitution > 1) {
      throw new Error(`rune/particles: box restitution must be in [0, 1] (got ${box.restitution})`);
    }
    const fr = box.friction ?? 0;
    if (!Number.isFinite(fr) || fr < 0 || fr > 1) {
      throw new Error(`rune/particles: box friction must be in [0, 1] (got ${fr})`);
    }
    if (box.kill !== undefined && typeof box.kill !== "boolean") {
      throw new Error(`rune/particles: box kill must be a boolean (got ${JSON.stringify(box.kill)})`);
    }
  }
  if (collide.onCollide !== undefined && typeof collide.onCollide !== "function") {
    throw new Error(`rune/particles: collide.onCollide must be a function (got ${typeof collide.onCollide}; called per contact after the integration walk — the splash hook)`);
  }
  return collide;
}
function validateSeek(seek) {
  if (seek === undefined || seek === null)
    return null;
  if (!Number.isFinite(seek.strength) || seek.strength <= 0) {
    throw new Error(`rune/particles: seek.strength must be a finite > 0 (got ${seek.strength})`);
  }
  if (!Number.isFinite(seek.damping) || seek.damping < 0) {
    throw new Error(`rune/particles: seek.damping must be a finite >= 0 (got ${seek.damping}; ≈ 2·√strength is critically damped)`);
  }
  return seek;
}
function validateLimitSpeed(ls) {
  if (ls === undefined || ls === null)
    return null;
  if (!Number.isFinite(ls.limit) || ls.limit < 0) {
    throw new Error(`rune/particles: limitSpeed.limit must be a finite >= 0 (got ${ls.limit})`);
  }
  if (!Number.isFinite(ls.dampen) || ls.dampen < 0 || ls.dampen > 1) {
    throw new Error(`rune/particles: limitSpeed.dampen must be in [0, 1] (got ${ls.dampen}; their dampen)`);
  }
  return ls;
}
function validateInherit(k) {
  if (k === undefined)
    return 0;
  if (!Number.isFinite(k) || k < 0) {
    throw new Error(`rune/particles: inheritVelocity must be a finite >= 0 (got ${k}; the fraction of the emitter's velocity a newborn rides)`);
  }
  return k;
}
function validateRateOverDistance(r) {
  if (r === undefined)
    return 0;
  if (!Number.isFinite(r) || r < 0) {
    throw new Error(`rune/particles: rateOverDistance must be a finite >= 0 (got ${r}; particles per world unit the emitter travels)`);
  }
  return r;
}
function validateWrap(wrap) {
  if (wrap === undefined || wrap === null)
    return null;
  const size = wrap.size;
  if (!Array.isArray(size) || size.length !== 3 || !size.every((v) => Number.isFinite(v) && v >= 0)) {
    throw new Error(`rune/particles: wrap.size must be three finite numbers >= 0, 0 disables the axis (got ${JSON.stringify(size)})`);
  }
  return [size[0], size[1], size[2]];
}
function validateBurst(burst) {
  if (!Number.isFinite(burst.time) || burst.time < 0) {
    throw new Error(`rune/particles: burst time must be a finite >= 0 (got ${burst.time})`);
  }
  if (!Number.isInteger(burst.count) || burst.count < 1) {
    throw new Error(`rune/particles: burst count must be an integer >= 1 (got ${burst.count})`);
  }
  if (!Number.isInteger(burst.cycle) || burst.cycle < 0) {
    throw new Error(`rune/particles: burst cycle must be an integer >= 0 (0 = repeating; got ${burst.cycle})`);
  }
  if (!Number.isFinite(burst.interval) || burst.interval <= 0) {
    throw new Error(`rune/particles: burst interval must be a finite > 0 (got ${burst.interval})`);
  }
  if (!Number.isFinite(burst.probability) || burst.probability < 0 || burst.probability > 1) {
    throw new Error(`rune/particles: burst probability must be in [0, 1] (got ${burst.probability})`);
  }
  return burst;
}

// packages/particles/src/facade.ts
var MAX_STEP = 1 / 20;
function createParticles(desc) {
  const capacity = desc.capacity;
  const render = desc.render ?? { kind: "billboard" };
  const ramp = desc.ramp ?? CONSTANT_RAMP;
  const spin = desc.spin ?? 0;
  const forces = {
    gravity: desc.forces?.gravity ?? NO_FORCES.gravity,
    drag: desc.forces?.drag ?? NO_FORCES.drag,
    turbulence: desc.forces?.turbulence ?? NO_FORCES.turbulence,
    attract: validateAttractor(desc.forces?.attract),
    speedCurve: desc.forces?.speedCurve ?? null,
    collide: validateCollision(desc.forces?.collide),
    noise: desc.forces?.noise !== undefined && desc.forces?.noise !== null ? validateNoise(desc.forces.noise) : null,
    seek: validateSeek(desc.forces?.seek),
    limitSpeed: validateLimitSpeed(desc.forces?.limitSpeed)
  };
  const wrap = validateWrap(desc.wrap);
  const wrapX = wrap !== null && wrap[0] > 0 ? wrap[0] : 0;
  const wrapY = wrap !== null && wrap[1] > 0 ? wrap[1] : 0;
  const wrapZ = wrap !== null && wrap[2] > 0 ? wrap[2] : 0;
  const hasWrap = wrapX > 0 || wrapY > 0 || wrapZ > 0;
  const kind = render.kind;
  let history = null;
  if (kind === "trail") {
    history = createTrailHistory(capacity, render);
  }
  const sortOn = render.sort === true;
  if (sortOn && kind !== "billboard") {
    throw new Error(`rune/particles: render.sort is a billboard-kind option (a ${kind} layer cannot take a painter's order — trails are one continuous ribbon, meshes resolve through the depth buffer)`);
  }
  const cullOn = render.cull === true;
  if (cullOn && kind !== "billboard") {
    throw new Error(`rune/particles: render.cull is a billboard-kind option (a ${kind} layer's records are not per-particle gates — the frustum test lives in the GPU render tier)`);
  }
  const sim = desc.sim ?? "cpu";
  const gpuMode = sim === "gpu";
  let gpuHandoff = null;
  let gpuSwaps = null;
  let gpuSwapCount = 0;
  let gpuSynced = 0;
  let gpuStreamSynced = 0;
  const emitMode = desc.emit ?? "cpu";
  if (emitMode !== "cpu" && emitMode !== "gpu") {
    throw new Error(`rune/particles: emit must be 'cpu' or 'gpu' (got ${JSON.stringify(emitMode)})`);
  }
  const emitGpu = emitMode === "gpu";
  if (emitGpu && !gpuMode) {
    throw new Error(`rune/particles: emit:"gpu" requires sim:"gpu" (the hash-RNG append pass is the GPGPU tier's own kernel — there is no CPU-tier form)`);
  }
  if (gpuMode) {
    if (kind !== "billboard" || render.draw !== "instance") {
      throw new Error('rune/particles: sim:"gpu" requires render { kind: "billboard", draw: "instance" } (the GPU tier packs the instance records itself — the soup/trail/mesh kinds are CPU-baked)');
    }
    if (desc.onRetire !== undefined) {
      throw new Error('rune/particles: sim:"gpu" rejects onRetire (the death site lives on the GPU — the sub-emitter family stays on the CPU tier)');
    }
    if (forces.collide !== null) {
      throw new Error('rune/particles: sim:"gpu" rejects collide (the bounce response needs the CPU positions; the contact events are CPU-blind — the rain/splash family stays on the CPU tier)');
    }
    if (forces.seek !== null) {
      throw new Error('rune/particles: sim:"gpu" rejects seek (the targets are dynamic CPU writes — retargeting would need strided per-frame uploads; the sequencer family stays on the CPU tier)');
    }
    if (forces.speedCurve !== null) {
      throw new Error('rune/particles: sim:"gpu" rejects forces.speedCurve (the telescoping rescale stays CPU-side in v1 — the rocket class keeps sim:"cpu")');
    }
    if ((forces.attract ?? null) !== null && (forces.attract?.killRadius ?? 0) > 0) {
      throw new Error('rune/particles: sim:"gpu" rejects attract.killRadius (the sink retires via positions — CPU-blind on the GPU tier; the vortex drain stays on the CPU tier)');
    }
    if ((desc.prewarm ?? 0) > 0) {
      throw new Error('rune/particles: sim:"gpu" rejects prewarm (the GPU state cannot be fast-forwarded synchronously — emit a burst and let a few frames pass instead)');
    }
    gpuSwaps = new Uint32Array(2 * capacity);
    gpuHandoff = {
      attached: false,
      emitRows: emitGpu ? new Float32Array(0) : new Float32Array(GPU_STATE_STRIDE * capacity),
      emitBase: 0,
      emitCount: 0,
      emitStreamBase: 0,
      emitterV: [0, 0, 0],
      emitInheritK: 0,
      swaps: gpuSwaps,
      swapCount: 0,
      emitOrigin: [0, 0, 0],
      wrapSize: hasWrap ? [wrapX, wrapY, wrapZ] : null
    };
  }
  if (cullOn && !gpuMode) {
    throw new Error(`rune/particles: render.cull is the GPU tier's frustum gate (the CPU tier bakes every live particle — take sim:"gpu" + createGpuParticles; see gpuSim's sort family)`);
  }
  const system = createParticleSystem(capacity, {
    onRetire: desc.onRetire,
    onSwap: gpuSwaps !== null ? (to, from) => {
      if (gpuSwapCount < gpuSwaps.length / 2) {
        const at = gpuSwapCount * 2;
        gpuSwaps[at] = to;
        gpuSwaps[at + 1] = from;
        gpuSwapCount++;
      }
    } : history !== null ? history.handleSwap : undefined
  });
  let spawner = createSpawner(desc.spawner ?? DEFAULT_SPAWNER);
  const spawnerDescRef = desc.spawner ?? DEFAULT_SPAWNER;
  let emitLedgerLifeMin = 0, emitLedgerLifeMax = 1, emitLedgerSeed = 1;
  function trackEmitLedger(d) {
    emitLedgerLifeMin = d.life[0];
    emitLedgerLifeMax = d.life[1];
    emitLedgerSeed = (d.seed ?? 1) | 0;
  }
  trackEmitLedger(spawnerDescRef);
  let ratePerSecond = desc.rate ?? 0;
  let carry = 0;
  const inheritK = validateInherit(desc.inheritVelocity);
  const rateOverDist = validateRateOverDistance(desc.rateOverDistance);
  let distCarry = 0;
  let lastOx = 0, lastOy = 0, lastOz = 0;
  let emitterVx = 0, emitterVy = 0, emitterVz = 0;
  const origin = [0, 0, 0];
  let r00 = 1, r01 = 0, r02 = 0;
  let r10 = 0, r11 = 1, r12 = 0;
  let r20 = 0, r21 = 0, r22 = 1;
  let oriented = false;
  let streamIndex = 0;
  const emitWrap = (index, out) => {
    spawner(streamIndex + index, out);
    if (oriented) {
      const { x, y, z } = out;
      out.x = x * r00 + y * r01 + z * r02;
      out.y = x * r10 + y * r11 + z * r12;
      out.z = x * r20 + y * r21 + z * r22;
      const { vx, vy, vz } = out;
      out.vx = vx * r00 + vy * r01 + vz * r02;
      out.vy = vx * r10 + vy * r11 + vz * r12;
      out.vz = vx * r20 + vy * r21 + vz * r22;
    }
    out.x += origin[0];
    out.y += origin[1];
    out.z += origin[2];
    if (inheritK > 0) {
      out.vx += emitterVx * inheritK;
      out.vy += emitterVy * inheritK;
      out.vz += emitterVz * inheritK;
    }
  };
  const emitStream = (n) => {
    const spawnedCount = emitGpu ? system.emit(n, emitLedgerFill) : system.emit(n, emitWrap);
    streamIndex += spawnedCount;
    return spawnedCount;
  };
  const emitLedgerFill = (index, out) => {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    out.vx = 0;
    out.vy = 0;
    out.vz = 0;
    out.life = emitLedgerLifeMin + (emitLedgerLifeMax - emitLedgerLifeMin) * hash01(emitLedgerSeed, streamIndex + index, GPU_EMIT_SALTS.life);
    out.size = 1;
    out.r = 1;
    out.g = 1;
    out.b = 1;
    out.a = 1;
    out.seed = 0;
    out.tx = 0;
    out.ty = 0;
    out.tz = 0;
  };
  let soupFloats;
  let stride;
  let layout;
  let drawFormat = "soup";
  if (kind === "mesh") {
    const geo = render.geometry;
    const vertsPer = geo.vertexCount;
    if (!Number.isInteger(vertsPer) || vertsPer < 3) {
      throw new Error(`rune/particles: mesh geometry needs >= 3 vertices (got ${vertsPer})`);
    }
    soupFloats = capacity * vertsPer * MESH_STRIDE;
    stride = MESH_STRIDE;
    layout = { position: { size: 3, offset: 0 }, normal: { size: 3, offset: 3 }, uv: { size: 2, offset: 6 }, color: { size: 4, offset: 8 } };
  } else if (kind === "trail") {
    const points = history.points;
    soupFloats = capacity * points * VERTS_PER_PARTICLE * SOUP_STRIDE;
    stride = SOUP_STRIDE;
    layout = { position: { size: 3, offset: 0 }, uv: { size: 2, offset: 3 }, color: { size: 4, offset: 5 } };
  } else {
    const draw = render.draw === "instance" ? "instance" : "soup";
    drawFormat = draw;
    if (draw === "instance") {
      soupFloats = capacity * INSTANCE_STRIDE;
      stride = INSTANCE_STRIDE;
      layout = { position: { size: 3, offset: INSTANCE_LAYOUT.pos.offset }, uv: { size: 2, offset: INSTANCE_LAYOUT.uv0.offset }, color: { size: 4, offset: INSTANCE_LAYOUT.color.offset } };
    } else {
      soupFloats = capacity * VERTS_PER_PARTICLE * SOUP_STRIDE;
      stride = SOUP_STRIDE;
      layout = { position: { size: 3, offset: 0 }, uv: { size: 2, offset: 3 }, color: { size: 4, offset: 5 } };
    }
  }
  const vertices = new Float32Array(soupFloats);
  const view = {
    vertices,
    vertexCount: 0,
    stride,
    layout,
    draw: drawFormat,
    instanceCount: 0,
    instanceLayout: drawFormat === "instance" ? INSTANCE_LAYOUT : null
  };
  const sortIndices = sortOn ? new Int32Array(capacity) : null;
  const sortKeys = sortOn ? new Float32Array(capacity) : null;
  const sortOrder = sortOn ? new Array(capacity).fill(0) : null;
  let time = 0;
  const bursts = (desc.bursts ?? []).map((burst) => validateBurst(burst));
  const burstState = bursts.map((burst, index) => ({
    next: burst.time,
    firesLeft: burst.cycle === 0 ? Infinity : burst.cycle,
    cycle: 0,
    index
  }));
  const scheduleSeed = (desc.spawner?.seed ?? 1) | 0;
  const prewarm = desc.prewarm ?? 0;
  if (prewarm > 0) {
    if (!Number.isFinite(prewarm) || prewarm > 3600) {
      throw new Error(`rune/particles: prewarm must be a finite seconds count <= 3600 (got ${prewarm})`);
    }
    const steps = Math.ceil(prewarm * 60);
    for (let i = 0;i < steps; i++)
      advanceInternal(1 / 60);
  }
  const facade = {
    get count() {
      return system.count;
    },
    get capacity() {
      return capacity;
    },
    get fields() {
      return system.fields;
    },
    get render() {
      return render;
    },
    get spin() {
      return spin;
    },
    get forces() {
      return forces;
    },
    get ramp() {
      return ramp;
    },
    get gpuHandoff() {
      return gpuHandoff;
    },
    get emitGpu() {
      return emitGpu;
    },
    get spawnerDesc() {
      return spawnerDescRef;
    },
    rate(perSecond, sp) {
      if (!Number.isFinite(perSecond) || perSecond < 0) {
        throw new Error(`rune/particles: rate must be a finite >= 0 (got ${perSecond})`);
      }
      ratePerSecond = perSecond;
      if (sp !== undefined) {
        if (emitGpu) {
          throw new Error(`rune/particles: replacing the spawner at runtime is not supported with emit:"gpu" (the kernel's static spawner interpretation is packed at attach — recreate the facade; rate(x) without a spawner is fine)`);
        }
        spawner = createSpawner(sp);
      }
      return facade;
    },
    burst(n, sp) {
      if (sp !== undefined) {
        if (emitGpu) {
          throw new Error(`rune/particles: replacing the spawner at runtime is not supported with emit:"gpu" (the kernel's static spawner interpretation is packed at attach — recreate the facade; burst(n) without a spawner is fine)`);
        }
        spawner = createSpawner(sp);
      }
      return emitStream(n);
    },
    at(x, y, z) {
      if (!Number.isFinite(x + y + z)) {
        throw new Error(`rune/particles: at() needs three finite numbers (got ${x}, ${y}, ${z})`);
      }
      origin[0] = x;
      origin[1] = y;
      origin[2] = z;
      return facade;
    },
    orient(m) {
      if (emitGpu && m !== null) {
        throw new Error(`rune/particles: orient() is not supported with emit:"gpu" (the kernel's generation runs in the spawner's own axes — keep emit:"cpu" for rigid attachments)`);
      }
      if (m === null) {
        r00 = 1;
        r01 = 0;
        r02 = 0;
        r10 = 0;
        r11 = 1;
        r12 = 0;
        r20 = 0;
        r21 = 0;
        r22 = 1;
        oriented = false;
        return facade;
      }
      const n = m.length;
      if (n !== 9 && n !== 16) {
        throw new Error(`rune/particles: orient() takes a column-major 3×3 or 4×4 matrix, or null (got ${n} numbers)`);
      }
      const c = n === 16 ? 4 : 3;
      const v00 = m[0], v10 = m[1], v20 = m[2];
      const v01 = m[c], v11 = m[c + 1], v21 = m[c + 2];
      const v02 = m[c * 2], v12 = m[c * 2 + 1], v22 = m[c * 2 + 2];
      if (![v00, v10, v20, v01, v11, v21, v02, v12, v22].every(Number.isFinite)) {
        throw new Error("rune/particles: orient() matrix entries must all be finite");
      }
      r00 = v00;
      r01 = v01;
      r02 = v02;
      r10 = v10;
      r11 = v11;
      r12 = v12;
      r20 = v20;
      r21 = v21;
      r22 = v22;
      oriented = true;
      return facade;
    },
    advance(dt) {
      advanceInternal(dt);
      return facade;
    },
    view(basis, options) {
      if (kind === "mesh") {
        const renderOpts = render;
        const o = options?.mesh ?? {};
        view.vertexCount = fillMeshes(system, render.geometry, vertices, {
          ramp,
          axis: o.axis ?? renderOpts.axis,
          spin: o.spin ?? renderOpts.spin
        });
      } else if (kind === "trail") {
        const renderOpts = render;
        const o = options?.trail ?? {};
        view.vertexCount = fillTrails(system, history, withForward(basis), vertices, {
          ramp,
          length: o.length ?? renderOpts.length,
          width: o.width ?? renderOpts.width
        });
      } else {
        const renderOpts = render;
        const o = options?.billboard ?? {};
        let order = null;
        if (sortOn) {
          const forward = basis.forward;
          if (forward === undefined) {
            throw new Error("rune/particles: render.sort needs the camera basis forward (the depth key is dot(forward, position) — pass a full CameraBasis)");
          }
          const n = sortDepthBackToFront(system.fields, system.count, forward, sortIndices, sortKeys);
          for (let i = 0;i < n; i++)
            sortOrder[i] = sortIndices[i];
          sortOrder.length = n;
          order = sortOrder;
        }
        if (gpuMode) {
          view.vertexCount = system.count;
          view.instanceCount = system.count;
        } else if (drawFormat === "instance") {
          const packOpts = {
            ramp,
            tiles: o.tiles ?? renderOpts.tiles,
            frameJitter: o.frameJitter ?? renderOpts.frameJitter,
            order
          };
          view.vertexCount = packInstances(system, vertices, packOpts);
          view.instanceCount = view.vertexCount;
        } else {
          view.vertexCount = fillBillboards(system, basis, vertices, {
            ramp,
            spin,
            mode: o.mode ?? renderOpts.mode ?? "camera",
            tiles: o.tiles ?? renderOpts.tiles,
            speedFactor: o.speedFactor ?? renderOpts.speedFactor,
            lengthFactor: o.lengthFactor ?? renderOpts.lengthFactor,
            axis: o.axis ?? renderOpts.axis,
            spin3d: o.spin3d ?? renderOpts.spin3d,
            frameJitter: o.frameJitter ?? renderOpts.frameJitter,
            order
          });
          view.instanceCount = 0;
        }
      }
      return view;
    },
    billboards(basis) {
      return facade.view(basis);
    },
    stats() {
      const out = { count: system.count, capacity, spawned: system.spawned, retired: system.retired, dropped: system.dropped };
      return out;
    },
    clear() {
      system.clear();
      carry = 0;
      distCarry = 0;
      if (gpuHandoff !== null) {
        gpuHandoff.emitBase = 0;
        gpuHandoff.emitCount = 0;
        gpuHandoff.emitStreamBase = 0;
        gpuHandoff.swapCount = 0;
        gpuSwapCount = 0;
        gpuSynced = 0;
        gpuStreamSynced = 0;
      }
      return facade;
    }
  };
  function advanceGpu(dt) {
    const handoff = gpuHandoff;
    if (!handoff.attached) {
      throw new Error('rune/particles: sim:"gpu" needs the GPU backend — createGpuParticles(facade, gpuOrGlFacade) from @rune/gl (WebGPU: the compute tier; WebGL2: the transform-feedback tier)');
    }
    const emitBase = gpuSynced;
    handoff.emitBase = emitBase;
    handoff.emitCount = 0;
    handoff.emitStreamBase = gpuStreamSynced;
    gpuSwapCount = 0;
    handoff.emitOrigin[0] = origin[0];
    handoff.emitOrigin[1] = origin[1];
    handoff.emitOrigin[2] = origin[2];
    handoff.emitInheritK = inheritK;
    handoff.emitterV[0] = emitterVx;
    handoff.emitterV[1] = emitterVy;
    handoff.emitterV[2] = emitterVz;
    if (inheritK > 0 || rateOverDist > 0) {
      const mdx = origin[0] - lastOx, mdy = origin[1] - lastOy, mdz = origin[2] - lastOz;
      const moved = Math.hypot(mdx, mdy, mdz);
      if (moved > MAX_EMITTER_STEP) {
        emitterVx = 0;
        emitterVy = 0;
        emitterVz = 0;
      } else {
        emitterVx = mdx / dt;
        emitterVy = mdy / dt;
        emitterVz = mdz / dt;
        if (rateOverDist > 0 && moved > 0) {
          distCarry += moved * rateOverDist;
          const whole = Math.floor(distCarry);
          if (whole > 0) {
            distCarry -= whole;
            emitStream(whole);
          }
        }
      }
      lastOx = origin[0];
      lastOy = origin[1];
      lastOz = origin[2];
    }
    if (ratePerSecond > 0) {
      carry += ratePerSecond * dt;
      const whole = Math.floor(carry);
      if (whole > 0) {
        carry -= whole;
        emitStream(whole);
      }
    }
    for (const state of burstState) {
      const burst = bursts[state.index];
      let guard = 0;
      while (time >= state.next && state.firesLeft > 0 && guard++ < 64) {
        if (hash01(scheduleSeed, state.index * 7919 + 13, state.cycle) < burst.probability) {
          emitStream(burst.count);
        }
        state.firesLeft--;
        state.cycle++;
        state.next += burst.interval;
      }
    }
    const n = system.count - emitBase;
    if (n > 0) {
      if (!emitGpu) {
        const f = system.fields;
        const rows = handoff.emitRows;
        for (let i = 0;i < n; i++) {
          const s = emitBase + i;
          const at = i * GPU_STATE_STRIDE;
          rows[at] = f.px[s];
          rows[at + 1] = f.py[s];
          rows[at + 2] = f.pz[s];
          rows[at + 3] = f.vx[s];
          rows[at + 4] = f.vy[s];
          rows[at + 5] = f.vz[s];
          rows[at + 6] = f.age[s];
          rows[at + 7] = f.life[s];
          rows[at + 8] = f.size[s];
          rows[at + 9] = f.cr[s];
          rows[at + 10] = f.cg[s];
          rows[at + 11] = f.cb[s];
          rows[at + 12] = f.ca[s];
          rows[at + 13] = f.seed[s];
          rows[at + 14] = f.tx[s];
          rows[at + 15] = f.ty[s];
          rows[at + 16] = f.tz[s];
        }
      }
      handoff.emitCount = n;
    }
    if (emitGpu) {
      system.advanceLedger(dt);
    } else if (dt > MAX_STEP) {
      const steps = Math.min(600, Math.ceil(dt / MAX_STEP));
      const h = dt / steps;
      for (let s = 0;s < steps; s++)
        system.advance(h, NO_FORCES);
    } else {
      system.advance(dt, NO_FORCES);
    }
    handoff.swapCount = gpuSwapCount;
    gpuSynced = system.count;
    gpuStreamSynced = streamIndex;
    time += dt;
  }
  function advanceInternal(dt) {
    if (!Number.isFinite(dt) || dt <= 0)
      return;
    if (gpuMode) {
      advanceGpu(dt);
      return;
    }
    if (inheritK > 0 || rateOverDist > 0) {
      const mdx = origin[0] - lastOx, mdy = origin[1] - lastOy, mdz = origin[2] - lastOz;
      const moved = Math.hypot(mdx, mdy, mdz);
      if (moved > MAX_EMITTER_STEP) {
        emitterVx = 0;
        emitterVy = 0;
        emitterVz = 0;
      } else {
        emitterVx = mdx / dt;
        emitterVy = mdy / dt;
        emitterVz = mdz / dt;
        if (rateOverDist > 0 && moved > 0) {
          distCarry += moved * rateOverDist;
          const whole = Math.floor(distCarry);
          if (whole > 0) {
            distCarry -= whole;
            emitStream(whole);
          }
        }
      }
      lastOx = origin[0];
      lastOy = origin[1];
      lastOz = origin[2];
    }
    if (ratePerSecond > 0) {
      carry += ratePerSecond * dt;
      const whole = Math.floor(carry);
      if (whole > 0) {
        carry -= whole;
        emitStream(whole);
      }
    }
    for (const state of burstState) {
      const burst = bursts[state.index];
      let guard = 0;
      while (time >= state.next && state.firesLeft > 0 && guard++ < 64) {
        if (hash01(scheduleSeed, state.index * 7919 + 13, state.cycle) < burst.probability) {
          emitStream(burst.count);
        }
        state.firesLeft--;
        state.cycle++;
        state.next += burst.interval;
      }
    }
    if (dt > MAX_STEP) {
      const steps = Math.min(600, Math.ceil(dt / MAX_STEP));
      const h = dt / steps;
      for (let s = 0;s < steps; s++)
        system.advance(h, forces);
    } else {
      system.advance(dt, forces);
    }
    if (hasWrap) {
      const f = system.fields;
      const n = system.count;
      const cx = origin[0], cy = origin[1], cz = origin[2];
      for (let i = 0;i < n; i++) {
        if (wrapX > 0)
          f.px[i] = cx + wrapAxis(f.px[i] - cx, wrapX);
        if (wrapY > 0)
          f.py[i] = cy + wrapAxis(f.py[i] - cy, wrapY);
        if (wrapZ > 0)
          f.pz[i] = cz + wrapAxis(f.pz[i] - cz, wrapZ);
      }
    }
    time += dt;
    if (history !== null)
      history.record(system, dt);
  }
  function withForward(basis) {
    if (basis.forward !== undefined) {
      return { right: basis.right, up: basis.up, forward: basis.forward };
    }
    const { right: r, up: u } = basis;
    const cx = r[1] * u[2] - r[2] * u[1];
    const cy = r[2] * u[0] - r[0] * u[2];
    const cz = r[0] * u[1] - r[1] * u[0];
    return { right: r, up: u, forward: [-cx, -cy, -cz] };
  }
  return facade;
}
var DEFAULT_SPAWNER = {
  shape: { kind: "sphere", origin: [0, 0, 0], radius: [0.2, 0.6] },
  velocity: { mode: "radial" },
  speed: [1, 2],
  life: [1, 2],
  size: [0.1, 0.2],
  color: [[1, 1, 1, 1], [0.8, 0.9, 1, 0.6]]
};
var MAX_EMITTER_STEP = 25;
function wrapAxis(d, size) {
  let m = (d + size * 0.5) % size;
  if (m < 0)
    m += size;
  return m - size * 0.5;
}
export {
  validateNoise,
  sortDepthBackToFront,
  simplex3,
  sampleRamp,
  readGpuEmitConfig,
  packInstances,
  hash01,
  gpuSortWgsl,
  gpuSortPassSequence,
  gpuSortPadCount,
  gpuSimWgsl,
  gpuSimGlSortKeysGlsl,
  gpuSimGlPackSortedGlsl,
  gpuSimGlPackGlsl,
  gpuSimGlEmitGlsl,
  gpuSimGlBitonicGlsl,
  gpuSimGlAdvanceGlsl,
  gpuRenderFrustum,
  gpuRampMaxSize,
  gpuRampLUTTexture,
  gpuRampLUT,
  gpuGlStateTextureH,
  gpuGlPairsTextureH,
  gpuEmitRowModel,
  gpuEmitPackStatic,
  gpuEmitLife,
  fillTrails,
  fillMeshes,
  fillBillboards,
  createTrailHistory,
  createSpawner,
  createRamp,
  createParticles,
  createParticleSystem,
  createGrassField,
  VERTS_PER_PARTICLE,
  SOUP_STRIDE,
  RAMP_STRIDE,
  PARTICLE_FLOATS,
  NO_FORCES,
  MESH_STRIDE,
  MAX_SPHERES,
  MAX_PLANES,
  MAX_BOXES,
  INSTANCE_STRIDE,
  INSTANCE_LAYOUT,
  GPU_STATE_STRIDE,
  GPU_SORT_UNIFORM_FLOATS,
  GPU_SORT_U32_FIELDS,
  GPU_SORT_SENTINEL,
  GPU_SORT_RENDER_MASK,
  GPU_SORT_PAD_KEY,
  GPU_SORT_F32_FIELDS,
  GPU_SORT_ENTRIES,
  GPU_SIM_VEC4_FIELDS,
  GPU_SIM_UNIFORM_FLOATS,
  GPU_SIM_UNIFORM_BYTES,
  GPU_SIM_U32_FIELDS,
  GPU_SIM_F32_FIELDS,
  GPU_SIM_ENTRIES,
  GPU_GL_TEXELS_PER_PARTICLE,
  GPU_GL_STATE_TEXTURE_W,
  GPU_GL_STATE_STRIDE,
  GPU_GL_SORT_SENTINEL,
  GPU_GL_SORT_PAD_KEY,
  GPU_GL_SORT_OUTPUTS,
  GPU_GL_SORTKEYS_UNIFORMS,
  GPU_GL_SORTKEYS_F,
  GPU_GL_PACK_UNIFORMS,
  GPU_GL_PACK_OUTPUTS,
  GPU_GL_PACK_F,
  GPU_GL_EMIT_UNIFORMS,
  GPU_GL_EMIT_F,
  GPU_GL_BITONIC_UNIFORMS,
  GPU_GL_BITONIC_F,
  GPU_GL_ADVANCE_UNIFORMS,
  GPU_GL_ADVANCE_OUTPUTS,
  GPU_GL_ADVANCE_F,
  GPU_FORCE_MASK,
  GPU_EMIT_VEL,
  GPU_EMIT_VEC4_FIELDS,
  GPU_EMIT_U32_FIELDS,
  GPU_EMIT_SHAPE,
  GPU_EMIT_SALTS,
  GPU_EMIT_MASK,
  GPU_EMIT_BASE,
  FIELD_NAMES,
  CONSTANT_RAMP
};
