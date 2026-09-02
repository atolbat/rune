// packages/animation/src/skeleton.ts
function createSkeletonPose(skeleton) {
  const joints = skeleton.joints;
  const n = joints.length;
  const localT = new Float32Array(n * 3);
  const localQ = new Float32Array(n * 4);
  const localS = new Float32Array(n * 3);
  const world = new Float32Array(n * 16);
  const palette = new Float32Array(n * 16);
  const parents = new Int32Array(n);
  const invBind = new Float32Array(n * 16);
  const restT = new Float32Array(n * 3);
  const restQ = new Float32Array(n * 4);
  const restS = new Float32Array(n * 3);
  for (let i = 0;i < n; i++) {
    const j = joints[i];
    if (j === undefined) {
      throw new RangeError(`skeleton joint ${i} is undefined`);
    }
    const who = `joint "${j.name}" (${i})`;
    const p = j.parent;
    if (!Number.isInteger(p) || p < -1 || p >= i) {
      throw new RangeError(`${who}: parent ${p} violates the parents-first order (expected −1 or an index < ${i}). ` + "Skin influences index joints by position — re-sort the joints parents-first.");
    }
    if (j.restT === undefined || j.restT.length < 3) {
      throw new RangeError(`${who}: restT must hold at least 3 floats`);
    }
    if (j.restQ === undefined || j.restQ.length < 4) {
      throw new RangeError(`${who}: restQ must hold at least 4 floats (x, y, z, w)`);
    }
    if (j.restS === undefined || j.restS.length < 3) {
      throw new RangeError(`${who}: restS must hold at least 3 floats`);
    }
    if (j.invBind !== undefined && j.invBind !== null && j.invBind.length < 16) {
      throw new RangeError(`${who}: invBind must hold 16 floats (column-major)`);
    }
    parents[i] = p;
    for (let c = 0;c < 3; c++)
      restT[i * 3 + c] = j.restT[c];
    for (let c = 0;c < 4; c++)
      restQ[i * 4 + c] = j.restQ[c];
    for (let c = 0;c < 3; c++)
      restS[i * 3 + c] = j.restS[c];
    const o = i * 16;
    if (j.invBind !== undefined && j.invBind !== null) {
      for (let c = 0;c < 16; c++)
        invBind[o + c] = j.invBind[c];
    } else {
      invBind[o] = 1;
      invBind[o + 5] = 1;
      invBind[o + 10] = 1;
      invBind[o + 15] = 1;
    }
  }
  const pose = {
    skeleton,
    jointCount: n,
    parents,
    invBind,
    localT,
    localQ,
    localS,
    world,
    palette,
    resetToRest() {
      localT.set(restT);
      localQ.set(restQ);
      localS.set(restS);
      return pose;
    }
  };
  return pose;
}
// packages/animation/src/clip.ts
function validateClip(clip, jointCount) {
  if (typeof clip.name !== "string") {
    throw new RangeError(`clip name must be a string (got ${typeof clip.name})`);
  }
  if (!Number.isFinite(clip.duration) || clip.duration < 0) {
    throw new RangeError(`clip "${clip.name}": duration must be finite and ≥ 0 (got ${clip.duration})`);
  }
  checkTracks(clip, jointCount, clip.tracksT, "translation", 3);
  checkTracks(clip, jointCount, clip.tracksR, "rotation", 4);
  if (clip.tracksS !== undefined)
    checkTracks(clip, jointCount, clip.tracksS, "scale", 3);
  return clip;
}
function checkTracks(clip, jointCount, tracks, kind, floatsPerKey) {
  const floatsName = kind === "rotation" ? "quats" : "values";
  for (let k = 0;k < tracks.length; k++) {
    const track = tracks[k];
    const who = `clip "${clip.name}" ${kind} track ${k}`;
    if (track.joint >= jointCount) {
      throw new RangeError(`${who}: references joint ${track.joint} but the skeleton has ${jointCount} joints`);
    }
    if (track.times === undefined || track.times.length === 0) {
      throw new RangeError(`${who}: a track needs at least one key`);
    }
    const values = kind === "rotation" ? track.quats : track.values;
    if (values === undefined || values.length < track.times.length * floatsPerKey) {
      throw new RangeError(`${who}: ${floatsName} holds ${values?.length ?? 0} floats, ` + `needs ${track.times.length * floatsPerKey} (${floatsPerKey} per key)`);
    }
    for (let i = 1;i < track.times.length; i++) {
      if (track.times[i] < track.times[i - 1]) {
        throw new RangeError(`${who}: key times must be non-decreasing ` + `(${track.times[i]} at key ${i} follows ${track.times[i - 1]})`);
      }
    }
  }
}
// packages/animation/src/sampling.ts
function sampleClip(clip, time, pose) {
  pose.resetToRest();
  const n = pose.jointCount;
  const tracksT = clip.tracksT;
  for (let k = 0;k < tracksT.length; k++) {
    const track = tracksT[k];
    const joint = track.joint;
    if (joint >= 0 && joint < n) {
      sampleVec3Track(track.times, track.values, time, pose.localT, joint * 3);
    }
  }
  const tracksR = clip.tracksR;
  for (let k = 0;k < tracksR.length; k++) {
    const track = tracksR[k];
    const joint = track.joint;
    if (joint >= 0 && joint < n) {
      sampleQuatTrack(track.times, track.quats, time, pose.localQ, joint * 4);
    }
  }
  const tracksS = clip.tracksS;
  if (tracksS !== undefined) {
    for (let k = 0;k < tracksS.length; k++) {
      const track = tracksS[k];
      const joint = track.joint;
      if (joint >= 0 && joint < n) {
        sampleVec3Track(track.times, track.values, time, pose.localS, joint * 3);
      }
    }
  }
}
function sampleVec3Track(times, values, t, out, off) {
  if (t <= times[0]) {
    out[off] = values[0];
    out[off + 1] = values[1];
    out[off + 2] = values[2];
    return;
  }
  const last = times.length - 1;
  if (t >= times[last]) {
    out[off] = values[last * 3];
    out[off + 1] = values[last * 3 + 1];
    out[off + 2] = values[last * 3 + 2];
    return;
  }
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (times[mid] <= t)
      lo = mid;
    else
      hi = mid;
  }
  const span = times[hi] - times[lo];
  const u = span > 0.000000001 ? (t - times[lo]) / span : 0;
  for (let c = 0;c < 3; c++) {
    out[off + c] = values[lo * 3 + c] + (values[hi * 3 + c] - values[lo * 3 + c]) * u;
  }
}
function sampleQuatTrack(times, quats, t, out, off) {
  if (t <= times[0] || times.length === 1) {
    out[off] = quats[0];
    out[off + 1] = quats[1];
    out[off + 2] = quats[2];
    out[off + 3] = quats[3];
    return;
  }
  const last = times.length - 1;
  if (t >= times[last]) {
    out[off] = quats[last * 4];
    out[off + 1] = quats[last * 4 + 1];
    out[off + 2] = quats[last * 4 + 2];
    out[off + 3] = quats[last * 4 + 3];
    return;
  }
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = lo + hi >> 1;
    if (times[mid] <= t)
      lo = mid;
    else
      hi = mid;
  }
  const span = times[hi] - times[lo];
  const u = span > 0.000000001 ? (t - times[lo]) / span : 0;
  slerpOffset(quats, lo * 4, quats, hi * 4, u, out, off);
}
function slerpOffset(a, ao, b, bo, u, out, off) {
  let ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3];
  let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3];
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    let x2 = ax + (bx - ax) * u;
    let y2 = ay + (by - ay) * u;
    let z2 = az + (bz - az) * u;
    let w2 = aw + (bw - aw) * u;
    const len2 = Math.hypot(x2, y2, z2, w2) || 1;
    out[off] = x2 / len2;
    out[off + 1] = y2 / len2;
    out[off + 2] = z2 / len2;
    out[off + 3] = w2 / len2;
    return;
  }
  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - u) * theta) / sinTheta;
  const wb = Math.sin(u * theta) / sinTheta;
  const x = ax * wa + bx * wb;
  const y = ay * wa + by * wb;
  const z = az * wa + bz * wb;
  const w = aw * wa + bw * wb;
  const len = Math.hypot(x, y, z, w) || 1;
  out[off] = x / len;
  out[off + 1] = y / len;
  out[off + 2] = z / len;
  out[off + 3] = w / len;
}
// packages/animation/src/pose.ts
function evaluateSkeleton(pose) {
  const { localT, localQ, localS, world, palette, parents, invBind, jointCount: n } = pose;
  for (let i = 0;i < n; i++) {
    const w = i * 16;
    composeTRS(world, w, localT, i * 3, localQ, i * 4, localS, i * 3);
    const p = parents[i];
    if (p >= 0) {
      mul4(world, w, world, p * 16, world, w);
    }
    mul4(palette, w, world, w, invBind, w);
  }
}
function composeTRS(out, o, t, to, q, qo, s, so) {
  const x = q[qo];
  const y = q[qo + 1];
  const z = q[qo + 2];
  const w = q[qo + 3];
  const sx = s[so];
  const sy = s[so + 1];
  const sz = s[so + 2];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
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
  out[o + 12] = t[to];
  out[o + 13] = t[to + 1];
  out[o + 14] = t[to + 2];
  out[o + 15] = 1;
}
function mul4(out, o, a, ao, b, bo) {
  for (let col = 0;col < 4; col++) {
    const bc = bo + col * 4;
    const b0 = b[bc];
    const b1 = b[bc + 1];
    const b2 = b[bc + 2];
    const b3 = b[bc + 3];
    const oc = o + col * 4;
    out[oc] = a[ao] * b0 + a[ao + 4] * b1 + a[ao + 8] * b2 + a[ao + 12] * b3;
    out[oc + 1] = a[ao + 1] * b0 + a[ao + 5] * b1 + a[ao + 9] * b2 + a[ao + 13] * b3;
    out[oc + 2] = a[ao + 2] * b0 + a[ao + 6] * b1 + a[ao + 10] * b2 + a[ao + 14] * b3;
    out[oc + 3] = a[ao + 3] * b0 + a[ao + 7] * b1 + a[ao + 11] * b2 + a[ao + 15] * b3;
  }
}
// packages/animation/src/animator.ts
function createAnimator(skeleton, clip) {
  const pose = createSkeletonPose(skeleton);
  const n = pose.jointCount;
  let current = null;
  let clipName = null;
  let duration = 0;
  let time = 0;
  let speed = 1;
  let looping = true;
  let paused = false;
  const wrap = (t) => {
    if (duration <= 0)
      return 0;
    if (looping) {
      if (t >= 0 && t < duration)
        return t;
      return (t % duration + duration) % duration;
    }
    return t < 0 ? 0 : t > duration ? duration : t;
  };
  const sample = () => {
    if (current !== null)
      sampleClip(current, time, pose);
    else
      pose.resetToRest();
    evaluateSkeleton(pose);
  };
  const animator = {
    skeleton,
    jointCount: n,
    pose,
    get palette() {
      return pose.palette;
    },
    get world() {
      return pose.world;
    },
    get clip() {
      return current;
    },
    get clipName() {
      return clipName;
    },
    get duration() {
      return duration;
    },
    get paused() {
      return paused;
    },
    get time() {
      return time;
    },
    set time(t) {
      time = wrap(t);
      sample();
    },
    get speed() {
      return speed;
    },
    set speed(v) {
      speed = v;
    },
    get looping() {
      return looping;
    },
    set looping(v) {
      looping = v;
      time = wrap(time);
    },
    play(next, options) {
      const clipToBind = next === undefined ? current : next;
      if (clipToBind !== null && clipToBind !== undefined)
        validateClip(clipToBind, n);
      current = clipToBind ?? null;
      clipName = current?.name ?? null;
      duration = current?.duration ?? 0;
      if (options?.speed !== undefined)
        speed = options.speed;
      if (options?.loop !== undefined)
        looping = options.loop;
      if (options?.paused !== undefined)
        paused = options.paused;
      time = wrap(options?.time ?? 0);
      sample();
      return animator;
    },
    pause() {
      paused = true;
      return animator;
    },
    resume() {
      paused = false;
      return animator;
    },
    stop() {
      current = null;
      clipName = null;
      duration = 0;
      time = 0;
      sample();
      return animator;
    },
    advance(dt) {
      if (current === null || paused)
        return animator;
      time = wrap(time + dt * speed);
      sample();
      return animator;
    },
    sample() {
      sample();
      return animator;
    }
  };
  if (clip !== undefined && clip !== null)
    animator.play(clip);
  else
    sample();
  return animator;
}
export {
  validateClip,
  sampleClip,
  evaluateSkeleton,
  createSkeletonPose,
  createAnimator
};
