// packages/particles/src/noise.ts
var F3 = 1 / 3;
var G3 = 1 / 6;
var PERM = buildPerm();
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
  const pts = ramp.points;
  const n = pts.length;
  if (n === 1) {
    const p = pts[0];
    out[0] = p.size;
    out[1] = p.r;
    out[2] = p.g;
    out[3] = p.b;
    out[4] = p.a;
    out[5] = p.frame ?? 0;
    return;
  }
  if (t <= pts[0].t) {
    const p = pts[0];
    out[0] = p.size;
    out[1] = p.r;
    out[2] = p.g;
    out[3] = p.b;
    out[4] = p.a;
    out[5] = p.frame ?? 0;
    return;
  }
  if (t >= pts[n - 1].t) {
    const p = pts[n - 1];
    out[0] = p.size;
    out[1] = p.r;
    out[2] = p.g;
    out[3] = p.b;
    out[4] = p.a;
    out[5] = p.frame ?? 0;
    return;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (pts[mid].t <= t)
      lo = mid;
    else
      hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const span = b.t - a.t;
  const k = span > 0 ? (t - a.t) / span : 0;
  out[0] = a.size + (b.size - a.size) * k;
  out[1] = a.r + (b.r - a.r) * k;
  out[2] = a.g + (b.g - a.g) * k;
  out[3] = a.b + (b.b - a.b) * k;
  out[4] = a.a + (b.a - a.a) * k;
  out[5] = (a.frame ?? 0) + ((b.frame ?? 0) - (a.frame ?? 0)) * k;
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
  const collideEvents = new Float64Array(MAX_COLLIDE_EVENTS * 7);
  let collideEventCount = 0;
  const collideRec = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, plane: 0 };
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
      const planeCount = collide !== null ? Math.min(collide.planes.length, MAX_PLANES) : 0;
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
            const eb = collideEventCount * 7;
            collideEvents[eb] = f.px[i];
            collideEvents[eb + 1] = f.py[i];
            collideEvents[eb + 2] = f.pz[i];
            collideEvents[eb + 3] = vx;
            collideEvents[eb + 4] = vy;
            collideEvents[eb + 5] = vz;
            collideEvents[eb + 6] = p;
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
          const b = e * 7;
          collideRec.x = collideEvents[b];
          collideRec.y = collideEvents[b + 1];
          collideRec.z = collideEvents[b + 2];
          collideRec.vx = collideEvents[b + 3];
          collideRec.vy = collideEvents[b + 4];
          collideRec.vz = collideEvents[b + 5];
          collideRec.plane = collideEvents[b + 6];
          onCollide(collideRec);
        }
        collideEventCount = 0;
      }
    },
    clear() {
      retired += count;
      count = 0;
    }
  };
  return system;
}
// packages/particles/src/spawn.ts
function hash01(seed, index, salt) {
  let h = Math.imul(seed | 0, 374761393) + Math.imul(index | 0, 668265263) + Math.imul(salt | 0, 2246822519) | 0;
  h = Math.imul(h ^ h >>> 13, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
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
      px = ox + (shape.to[0] - ox) * u;
      py = oy + (shape.to[1] - oy) * u;
      pz = oz + (shape.to[2] - oz) * u;
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
  for (let i = 0;i < count; i++) {
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
var SCRATCH2 = new Float32Array(6);
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
  const s = SCRATCH2;
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
var SCRATCH3 = new Float32Array(6);
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
  const s = SCRATCH3;
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
  const pos = new Float32Array(count * 3);
  const par = new Float32Array(count * 4);
  const tint = new Float32Array(count * 4);
  for (let i = 0;i < count; i++) {
    const rr = radius * Math.sqrt(hash01(seed, i, 21));
    const ang = 6.283185307179586 * hash01(seed, i, 22);
    pos[i * 3] = Math.cos(ang) * rr;
    pos[i * 3 + 1] = groundY;
    pos[i * 3 + 2] = Math.sin(ang) * rr;
    par[i * 4] = hMin + (hMax - hMin) * hash01(seed, i, 23);
    par[i * 4 + 1] = 6.283185307179586 * hash01(seed, i, 24);
    par[i * 4 + 2] = hash01(seed, i, 25);
    par[i * 4 + 3] = wMin + (wMax - wMin) * hash01(seed, i, 26);
    const mix = hash01(seed, i, 27);
    tint[i * 4] = c0[0] + (c1[0] - c0[0]) * mix;
    tint[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * mix;
    tint[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * mix;
    tint[i * 4 + 3] = 0.8 + 0.4 * hash01(seed, i, 28);
  }
  return { pos, par, tint, count, fade, glsl: glslOf(fade, fadeBand), wgsl: wgslOf(fade, fadeBand) };
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

  // The gust field: two TRAVELING waves across the field (the wind reads
  // as waves crossing, not a uniform wiggle) + the per-blade flutter.
  float wave = sin(dot(i_pos.xz, vec2(0.35, 0.22)) - u_time * 1.7)
             + 0.55 * sin(dot(i_pos.xz, vec2(-0.21, 0.4)) + u_time * 1.1);
  float flutter = sin(u_time * (2.2 + phase * 1.5) + phase * 6.28318);
  float bendK = u_wind.z * (0.55 + 0.45 * wave) + u_wind.w * flutter;

  // The static lean (a fixed per-blade tilt) and the wind bend, both
  // growing with t^2 (a blade bends at the top, not the base).
  float b = t * t;
  vec2 leanDir = vec2(cos(lean), sin(lean)) * (0.35 * b);
  vec2 windOff = u_wind.xy * (bendK * 0.45 * b);

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

  let wave = sin(dot(i_pos.xz, vec2<f32>(0.35, 0.22)) - params.u_time * 1.7)
           + 0.55 * sin(dot(i_pos.xz, vec2<f32>(-0.21, 0.4)) + params.u_time * 1.1);
  let flutter = sin(params.u_time * (2.2 + phase * 1.5) + phase * 6.28318);
  let bendK = params.u_wind.z * (0.55 + 0.45 * wave) + params.u_wind.w * flutter;

  let b = t * t;
  let leanDir = vec2<f32>(cos(lean), sin(lean)) * (0.35 * b);
  let windOff = params.u_wind.xy * (bendK * 0.45 * b);

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
  const kind = render.kind;
  let history = null;
  if (kind === "trail") {
    history = createTrailHistory(capacity, render);
  }
  const system = createParticleSystem(capacity, {
    onRetire: desc.onRetire,
    onSwap: history !== null ? history.handleSwap : undefined
  });
  let spawner = createSpawner(desc.spawner ?? DEFAULT_SPAWNER);
  let ratePerSecond = desc.rate ?? 0;
  let carry = 0;
  const inheritK = validateInherit(desc.inheritVelocity);
  const rateOverDist = validateRateOverDistance(desc.rateOverDistance);
  const wrap = validateWrap(desc.wrap);
  const wrapX = wrap !== null && wrap[0] > 0 ? wrap[0] : 0;
  const wrapY = wrap !== null && wrap[1] > 0 ? wrap[1] : 0;
  const wrapZ = wrap !== null && wrap[2] > 0 ? wrap[2] : 0;
  const hasWrap = wrapX > 0 || wrapY > 0 || wrapZ > 0;
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
    const spawnedCount = system.emit(n, emitWrap);
    streamIndex += spawnedCount;
    return spawnedCount;
  };
  let soupFloats;
  let stride;
  let layout;
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
    soupFloats = capacity * VERTS_PER_PARTICLE * SOUP_STRIDE;
    stride = SOUP_STRIDE;
    layout = { position: { size: 3, offset: 0 }, uv: { size: 2, offset: 3 }, color: { size: 4, offset: 5 } };
  }
  const vertices = new Float32Array(soupFloats);
  const view = { vertices, vertexCount: 0, stride, layout };
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
    rate(perSecond, sp) {
      if (!Number.isFinite(perSecond) || perSecond < 0) {
        throw new Error(`rune/particles: rate must be a finite >= 0 (got ${perSecond})`);
      }
      ratePerSecond = perSecond;
      if (sp !== undefined)
        spawner = createSpawner(sp);
      return facade;
    },
    burst(n, sp) {
      if (sp !== undefined)
        spawner = createSpawner(sp);
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
        view.vertexCount = fillBillboards(system, basis, vertices, {
          ramp,
          spin,
          mode: o.mode ?? renderOpts.mode ?? "camera",
          tiles: o.tiles ?? renderOpts.tiles,
          speedFactor: o.speedFactor ?? renderOpts.speedFactor,
          lengthFactor: o.lengthFactor ?? renderOpts.lengthFactor,
          axis: o.axis ?? renderOpts.axis,
          spin3d: o.spin3d ?? renderOpts.spin3d,
          frameJitter: o.frameJitter ?? renderOpts.frameJitter
        });
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
      return facade;
    }
  };
  function advanceInternal(dt) {
    if (!Number.isFinite(dt) || dt <= 0)
      return;
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
function wrapAxis(d, size) {
  let m = (d + size * 0.5) % size;
  if (m < 0)
    m += size;
  return m - size * 0.5;
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
  if (!Array.isArray(collide.planes) || collide.planes.length === 0) {
    throw new Error("rune/particles: collide.planes must be a non-empty array (a collision set with no planes is a silent no-op)");
  }
  if (collide.planes.length > MAX_PLANES) {
    throw new Error(`rune/particles: collide.planes is capped at ${MAX_PLANES} (got ${collide.planes.length}) — the flat scratch is sized to the cap`);
  }
  for (const plane of collide.planes) {
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
export {
  validateNoise,
  simplex3,
  sampleRamp,
  hash01,
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
  MAX_PLANES,
  FIELD_NAMES,
  CONSTANT_RAMP
};
