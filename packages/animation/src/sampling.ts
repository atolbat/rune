/**
 * sampling.ts — keyframe sampling: clip time → local TRS.
 *
 * The kernels are offset-based (they write straight into the pose's flat
 * SoA buffers, no subarray views) — that is the price of zero allocations
 * per frame. The interpolation math mirrors the previous in-demo
 * implementation exactly (verified key-for-key against three.js in the
 * FBX work): clamped ends, binary key search, lerp / slerp with an nlerp
 * shortcut for nearly-parallel quaternions.
 */
import type { Clip } from './clip.ts'
import type { SkeletonPose } from './skeleton.ts'

/**
 * Samples a clip at `time` into the pose's LOCAL TRS buffers.
 *
 * Deterministic and stateless: every call first seeds ALL joints from the
 * rest pose, then lets the tracks override their joints. Joints without a
 * track therefore hold the rest pose, whatever happened on previous
 * frames. Out-of-range times clamp to the first/last key (looping is the
 * caller's — the Animator's — business). Tracks whose joint is outside
 * the skeleton (the FBX loader emits −1 for unresolved bone names) are
 * skipped: dead data must not become a silent out-of-bounds write.
 */
export function sampleClip(clip: Clip, time: number, pose: SkeletonPose): void {
  pose.resetToRest()
  const n = pose.jointCount
  const tracksT = clip.tracksT
  for (let k = 0; k < tracksT.length; k++) {
    const track = tracksT[k]
    const joint = track.joint
    if (joint >= 0 && joint < n) {
      sampleVec3Track(track.times, track.values, time, pose.localT, joint * 3)
    }
  }
  const tracksR = clip.tracksR
  for (let k = 0; k < tracksR.length; k++) {
    const track = tracksR[k]
    const joint = track.joint
    if (joint >= 0 && joint < n) {
      sampleQuatTrack(track.times, track.quats, time, pose.localQ, joint * 4)
    }
  }
  const tracksS = clip.tracksS
  if (tracksS !== undefined) {
    for (let k = 0; k < tracksS.length; k++) {
      const track = tracksS[k]
      const joint = track.joint
      if (joint >= 0 && joint < n) {
        sampleVec3Track(track.times, track.values, time, pose.localS, joint * 3)
      }
    }
  }
}

/** Linear vec3 sampling: clamp at the ends, binary search inside. */
function sampleVec3Track(
  times: Float32Array,
  values: Float32Array,
  t: number,
  out: Float32Array,
  off: number,
): void {
  if (t <= times[0]) {
    out[off] = values[0]
    out[off + 1] = values[1]
    out[off + 2] = values[2]
    return
  }
  const last = times.length - 1
  if (t >= times[last]) {
    out[off] = values[last * 3]
    out[off + 1] = values[last * 3 + 1]
    out[off + 2] = values[last * 3 + 2]
    return
  }
  // binary search: times[lo] <= t < times[hi]
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) lo = mid
    else hi = mid
  }
  const span = times[hi] - times[lo]
  const u = span > 1e-9 ? (t - times[lo]) / span : 0
  for (let c = 0; c < 3; c++) {
    out[off + c] = values[lo * 3 + c] + (values[hi * 3 + c] - values[lo * 3 + c]) * u
  }
}

/** Rotation sampling: slerp between the two quats around t. */
function sampleQuatTrack(
  times: Float32Array,
  quats: Float32Array,
  t: number,
  out: Float32Array,
  off: number,
): void {
  if (t <= times[0] || times.length === 1) {
    out[off] = quats[0]
    out[off + 1] = quats[1]
    out[off + 2] = quats[2]
    out[off + 3] = quats[3]
    return
  }
  const last = times.length - 1
  if (t >= times[last]) {
    out[off] = quats[last * 4]
    out[off + 1] = quats[last * 4 + 1]
    out[off + 2] = quats[last * 4 + 2]
    out[off + 3] = quats[last * 4 + 3]
    return
  }
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= t) lo = mid
    else hi = mid
  }
  const span = times[hi] - times[lo]
  const u = span > 1e-9 ? (t - times[lo]) / span : 0
  slerpOffset(quats, lo * 4, quats, hi * 4, u, out, off)
}

/** slerp(a, b, u) → out[off..off+3], xyzw, normalized. */
function slerpOffset(
  a: Float32Array,
  ao: number,
  b: Float32Array,
  bo: number,
  u: number,
  out: Float32Array,
  off: number,
): void {
  const ax = a[ao], ay = a[ao + 1], az = a[ao + 2], aw = a[ao + 3]
  let bx = b[bo], by = b[bo + 1], bz = b[bo + 2], bw = b[bo + 3]
  let dot = ax * bx + ay * by + az * bz + aw * bw
  if (dot < 0) {
    // the two quats walk the long way round — flip the sign of b
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
    dot = -dot
  }
  if (dot > 0.9995) {
    // nlerp: the angle is tiny, linear interpolation + normalize is exact enough
    const x = ax + (bx - ax) * u
    const y = ay + (by - ay) * u
    const z = az + (bz - az) * u
    const w = aw + (bw - aw) * u
    const len = Math.hypot(x, y, z, w) || 1
    out[off] = x / len
    out[off + 1] = y / len
    out[off + 2] = z / len
    out[off + 3] = w / len
    return
  }
  const theta = Math.acos(dot)
  const sinTheta = Math.sin(theta)
  const wa = Math.sin((1 - u) * theta) / sinTheta
  const wb = Math.sin(u * theta) / sinTheta
  const x = ax * wa + bx * wb
  const y = ay * wa + by * wb
  const z = az * wa + bz * wb
  const w = aw * wa + bw * wb
  const len = Math.hypot(x, y, z, w) || 1
  out[off] = x / len
  out[off + 1] = y / len
  out[off + 2] = z / len
  out[off + 3] = w / len
}
