// packages/particles/src/system.ts
var NO_FORCES = { gravity: [0, 0, 0], drag: 0, turbulence: 0 };
function createParticleSystem(capacity) {
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
    seed: new Float32Array(capacity)
  };
  const out = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, r: 1, g: 1, b: 1, a: 1, seed: 0 };
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
      let i = count - 1;
      while (i >= 0) {
        const age = f.age[i] + dt;
        let vx = f.vx[i], vy = f.vy[i], vz = f.vz[i];
        if (dragFactor !== 1) {
          vx *= dragFactor;
          vy *= dragFactor;
          vz *= dragFactor;
        }
        vx += gx * dt;
        vy += gy * dt;
        vz += gz * dt;
        if (hasTurb) {
          const ph = f.seed[i] * 37;
          const t = age * 5 + ph;
          vx += Math.sin(t) * turbulence * dt;
          vy += Math.sin(t * 1.7 + 11.3) * turbulence * dt;
          vz += Math.cos(t * 0.9 + 4.7) * turbulence * dt;
        }
        f.px[i] += vx * dt;
        f.py[i] += vy * dt;
        f.pz[i] += vz * dt;
        if (age >= f.life[i]) {
          const last = count - 1;
          if (last !== i) {
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
  const ox = shape.kind === "line" ? shape.from[0] : shape.origin[0];
  const oy = shape.kind === "line" ? shape.from[1] : shape.origin[1];
  const oz = shape.kind === "line" ? shape.from[2] : shape.origin[2];
  let ax = 0, ay = 0, az = 1;
  const hasAxis = shape.kind === "cone" || shape.kind === "disc" || shape.kind === "line";
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
  if (shape.kind === "sphere" || shape.kind === "disc") {
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
  if (colorByRadius && shape.kind !== "disc" && shape.kind !== "sphere") {
    throw new Error("rune/particles: colorByRadius needs the sphere or disc shape (the radius range drives the mix)");
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
  } else if (velocity.mode === "axis" && !hasAxis) {
    throw new Error("rune/particles: velocity mode 'axis' needs a shape with an axis (cone/disc/line)");
  } else if (velocity.mode === "tangential" && shape.kind !== "disc" && shape.kind !== "sphere") {
    throw new Error("rune/particles: velocity mode 'tangential' needs the disc or sphere shape");
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
    } else if (shape.kind === "line") {
      px = ox + (shape.to[0] - ox) * u;
      py = oy + (shape.to[1] - oy) * u;
      pz = oz + (shape.to[2] - oz) * u;
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
        dx = ax;
        dy = ay;
        dz = az;
      }
    } else if (velocity.mode === "axis") {
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
// packages/particles/src/ramp.ts
var CONSTANT_RAMP = { points: [{ t: 0, size: 1, r: 1, g: 1, b: 1, a: 1 }] };
function createRamp(points) {
  if (points.length === 0)
    throw new Error("rune/particles: a ramp needs at least one control point");
  let prev = -Infinity;
  for (const p of points) {
    const t = p.t;
    if (!Number.isFinite(t + p.size + p.r + p.g + p.b + p.a)) {
      throw new Error("rune/particles: ramp control points must be finite");
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
    return;
  }
  if (t <= pts[0].t) {
    const p = pts[0];
    out[0] = p.size;
    out[1] = p.r;
    out[2] = p.g;
    out[3] = p.b;
    out[4] = p.a;
    return;
  }
  if (t >= pts[n - 1].t) {
    const p = pts[n - 1];
    out[0] = p.size;
    out[1] = p.r;
    out[2] = p.g;
    out[3] = p.b;
    out[4] = p.a;
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
}
// packages/particles/src/billboards.ts
var SOUP_STRIDE = 9;
var VERTS_PER_PARTICLE = 6;
function fillBillboards(system, basis, out, options = {}) {
  const ramp = options.ramp ?? CONSTANT_RAMP;
  const spin = options.spin ?? 0;
  const f = system.fields;
  const count = system.count;
  const rx = basis.right[0], ry = basis.right[1], rz = basis.right[2];
  const ux = basis.up[0], uy = basis.up[1], uz = basis.up[2];
  const s = SCRATCH;
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
    let c1 = 1, s1 = 0, c2 = 0, s2 = 1;
    if (spin !== 0 || f.seed[i] !== 0) {
      const ang = f.seed[i] * 6.283185307179586 + age * spin;
      const cos = Math.cos(ang), sin = Math.sin(ang);
      c1 = cos;
      s1 = sin;
      c2 = -sin;
      s2 = cos;
    }
    const o0x = c1 * -half + c2 * -half, o0y = s1 * -half + s2 * -half;
    const o1x = c1 * half + c2 * -half, o1y = s1 * half + s2 * -half;
    const o2x = c1 * half + c2 * half, o2y = s1 * half + s2 * half;
    const o3x = c1 * -half + c2 * half, o3y = s1 * -half + s2 * half;
    at = vert(out, at, px + o0x * rx + o0y * ux, py + o0x * ry + o0y * uy, pz + o0x * rz + o0y * uz, 0, 0, cr, cg, cb, ca);
    at = vert(out, at, px + o1x * rx + o1y * ux, py + o1x * ry + o1y * uy, pz + o1x * rz + o1y * uz, 1, 0, cr, cg, cb, ca);
    at = vert(out, at, px + o2x * rx + o2y * ux, py + o2x * ry + o2y * uy, pz + o2x * rz + o2y * uz, 1, 1, cr, cg, cb, ca);
    at = vert(out, at, px + o0x * rx + o0y * ux, py + o0x * ry + o0y * uy, pz + o0x * rz + o0y * uz, 0, 0, cr, cg, cb, ca);
    at = vert(out, at, px + o2x * rx + o2y * ux, py + o2x * ry + o2y * uy, pz + o2x * rz + o2y * uz, 1, 1, cr, cg, cb, ca);
    at = vert(out, at, px + o3x * rx + o3y * ux, py + o3x * ry + o3y * uy, pz + o3x * rz + o3y * uz, 0, 1, cr, cg, cb, ca);
  }
  return at / SOUP_STRIDE;
}
var SCRATCH = new Float32Array(5);
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
// packages/particles/src/facade.ts
function createParticles(desc) {
  const capacity = desc.capacity;
  const system = createParticleSystem(capacity);
  const ramp = desc.ramp ?? CONSTANT_RAMP;
  const spin = desc.spin ?? 0;
  const forces = {
    gravity: desc.forces?.gravity ?? NO_FORCES.gravity,
    drag: desc.forces?.drag ?? NO_FORCES.drag,
    turbulence: desc.forces?.turbulence ?? NO_FORCES.turbulence
  };
  let spawner = createSpawner(desc.spawner ?? DEFAULT_SPAWNER);
  let ratePerSecond = desc.rate ?? 0;
  let carry = 0;
  const vertices = new Float32Array(capacity * VERTS_PER_PARTICLE * SOUP_STRIDE);
  const view = { vertices, vertexCount: 0 };
  const facade = {
    get count() {
      return system.count;
    },
    get capacity() {
      return capacity;
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
      return system.emit(n, spawner);
    },
    advance(dt) {
      if (ratePerSecond > 0 && dt > 0) {
        carry += ratePerSecond * dt;
        const whole = Math.floor(carry);
        if (whole > 0) {
          carry -= whole;
          system.emit(whole, spawner);
        }
      }
      system.advance(dt, forces);
      return facade;
    },
    billboards(basis) {
      view.vertexCount = fillBillboards(system, basis, vertices, { ramp, spin });
      return view;
    },
    stats() {
      const out = { count: system.count, capacity, spawned: system.spawned, retired: system.retired, dropped: system.dropped };
      return out;
    },
    clear() {
      system.clear();
      carry = 0;
      return facade;
    }
  };
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
export {
  sampleRamp,
  hash01,
  fillBillboards,
  createSpawner,
  createRamp,
  createParticles,
  createParticleSystem,
  VERTS_PER_PARTICLE,
  SOUP_STRIDE,
  NO_FORCES,
  CONSTANT_RAMP
};
