import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { mat4Multiply, mat4FromQuatPosScale, quatSlerp } from '@rune/math'
import {
  createSkeletonPose,
  sampleClip,
  evaluateSkeleton,
  validateClip,
  createAnimator,
} from '../src/index.ts'
import type { Skeleton, SkeletonPose, TrackT, TrackR, TrackS, Clip, Joint } from '../src/index.ts'
import { parseFBX } from '../../loaders/src/fbx.ts'

// ─── helpers ────────────────────────────────────────────────────────────────

const QUARTER = Math.SQRT1_2 // sin/cos of 45°

function joint(
  name: string,
  parent: number,
  t: readonly number[],
  q: readonly number[],
  s: readonly number[],
  invBind?: Float32Array,
): Joint {
  return { name, parent, restT: t, restQ: q, restS: s, invBind }
}

function trackT(jointIndex: number, times: number[], values: number[]): TrackT {
  return { joint: jointIndex, times: new Float32Array(times), values: new Float32Array(values) }
}
function trackR(jointIndex: number, times: number[], quats: number[]): TrackR {
  return { joint: jointIndex, times: new Float32Array(times), quats: new Float32Array(quats) }
}
function trackS(jointIndex: number, times: number[], values: number[]): TrackS {
  return { joint: jointIndex, times: new Float32Array(times), values: new Float32Array(values) }
}

function clipOf(name: string, duration: number, tracks: { t?: TrackT[]; r?: TrackR[]; s?: TrackS[] }): Clip {
  return { name, duration, tracksT: tracks.t ?? [], tracksR: tracks.r ?? [], tracksS: tracks.s }
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

/** The @rune/math reference pipeline for the same local TRS. */
function referenceWorld(pose: SkeletonPose): Float32Array {
  const n = pose.jointCount
  const out = new Float32Array(n * 16)
  for (let i = 0; i < n; i++) {
    const local = new Float32Array(16)
    mat4FromQuatPosScale(
      local,
      pose.localQ[i * 4], pose.localQ[i * 4 + 1], pose.localQ[i * 4 + 2], pose.localQ[i * 4 + 3],
      pose.localT[i * 3], pose.localT[i * 3 + 1], pose.localT[i * 3 + 2],
      pose.localS[i * 3], pose.localS[i * 3 + 1], pose.localS[i * 3 + 2],
    )
    const p = pose.parents[i]
    if (p < 0) out.set(local, i * 16)
    else mat4Multiply(out.subarray(i * 16, i * 16 + 16), out.subarray(p * 16, p * 16 + 16), local)
  }
  return out
}

// A 3-joint chain: root → child → grandchild, with an invBind on the root.
const ROOT_INV = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1])
const CHAIN: Skeleton = {
  joints: [
    joint('root', -1, [1, 0, 0], [0, 0, 0, 1], [1, 1, 1], ROOT_INV),
    joint('child', 0, [0, 2, 0], [0, 0, QUARTER, QUARTER], [1, 1, 1]),
    joint('grand', 1, [0, 0, 3], [QUARTER, 0, 0, QUARTER], [2, 2, 2]),
  ],
}

// ─── skeleton: validation + the bind pose ──────────────────────────────────

test('createSkeletonPose: a parents-first violation throws with the joint name', () => {
  const bad: Skeleton = {
    joints: [
      joint('root', -1, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]),
      joint('late', 1, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), // parent 1 is not before joint 1
    ],
  }
  expect(() => createSkeletonPose(bad)).toThrow(/late.*parents-first/)
  expect(() => createSkeletonPose({ joints: [joint('self', 0, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])] }))
    .toThrow(/parents-first/)
})

test('createSkeletonPose: short rest/invBind arrays throw', () => {
  expect(() => createSkeletonPose({ joints: [joint('a', -1, [0, 0], [0, 0, 0, 1], [1, 1, 1])] }))
    .toThrow(/restT/)
  expect(() => createSkeletonPose({ joints: [joint('a', -1, [0, 0, 0], [0, 0, 0], [1, 1, 1])] }))
    .toThrow(/restQ/)
  expect(() => createSkeletonPose({ joints: [joint('a', -1, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1], new Float32Array(15))] }))
    .toThrow(/invBind/)
})

test('evaluateSkeleton: world = parent × local, exact @rune/math parity', () => {
  const pose = createSkeletonPose(CHAIN)
  pose.resetToRest()
  evaluateSkeleton(pose)
  expect(maxDiff(pose.world, referenceWorld(pose))).toBe(0)
})

test('evaluateSkeleton: palette = world × invBind (identity when absent)', () => {
  const pose = createSkeletonPose(CHAIN)
  pose.resetToRest()
  evaluateSkeleton(pose)
  const ref = referenceWorld(pose)
  // root: with the invBind
  const expectedRoot = mat4Multiply(new Float32Array(16), ref.subarray(0, 16), ROOT_INV)
  expect(maxDiff(pose.palette.subarray(0, 16), expectedRoot)).toBe(0)
  // child/grand: no invBind → palette = world exactly
  expect(maxDiff(pose.palette.subarray(16, 48), ref.subarray(16, 48))).toBe(0)
})

test('composeTRS: the kernel matches mat4FromQuatPosScale bit-for-bit', () => {
  // inputs go through Float32 storage first (as a parsed asset would);
  // the reference then sees exactly the same numbers as the kernel
  const q = new Float32Array([0.3, -0.4, 0.5, 0.7])
  const t = new Float32Array([1.5, -2, 0.25])
  const s = new Float32Array([2, 0.5, 3])
  const exotic: Skeleton = {
    joints: [joint('solo', -1, [1.5, -2, 0.25], [0.3, -0.4, 0.5, 0.7], [2, 0.5, 3])],
  }
  const pose = createSkeletonPose(exotic)
  pose.resetToRest()
  evaluateSkeleton(pose)
  const ref = new Float32Array(16)
  mat4FromQuatPosScale(ref, q[0], q[1], q[2], q[3], t[0], t[1], t[2], s[0], s[1], s[2])
  expect(maxDiff(pose.world, ref)).toBe(0)
})

// ─── sampling ───────────────────────────────────────────────────────────────

test('sampleClip: translation clamps at the ends and lerps inside', () => {
  const pose = createSkeletonPose({ joints: [joint('a', -1, [9, 9, 9], [0, 0, 0, 1], [1, 1, 1])] })
  const clip = clipOf('t', 2, { t: [trackT(0, [0, 1, 2], [10, 20, 30, 40, 50, 60, 70, 80, 90])] })
  sampleClip(clip, -1, pose)
  expect(Array.from(pose.localT)).toEqual([10, 20, 30])
  sampleClip(clip, 9, pose)
  expect(Array.from(pose.localT)).toEqual([70, 80, 90])
  sampleClip(clip, 0.5, pose)
  expect(Array.from(pose.localT)).toEqual([25, 35, 45])
  sampleClip(clip, 1.5, pose)
  expect(Array.from(pose.localT)).toEqual([55, 65, 75])
  // binary search picks the right segment of a 5-key track
  const pose2 = createSkeletonPose({ joints: [joint('a', -1, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])] })
  sampleClip(clipOf('t', 4, { t: [trackT(0, [0, 1, 2, 3, 4], [0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32, 40, 41, 42])] }), 2.3, pose2)
  expect(Array.from(pose2.localT)).toEqual([23, 24, 25])
})

test('sampleClip: slerp matches @rune/math quatSlerp (all three branches)', () => {
  const q0 = new Float32Array([0, 0, 0, 1])
  const q1 = new Float32Array([0, 0.6, 0, 0.8]) // unit, dot 0.8 — the real slerp branch
  const nearly = new Float32Array([0.01, 0, 0, Math.sqrt(1 - 0.0001)]) // dot > 0.9995 — nlerp
  const ref = new Float32Array(4)
  const check = (quats: number[], u: number) => {
    const pose = createSkeletonPose({ joints: [joint('a', -1, [0, 0, 0], [0, 0, 0, 1], [1, 1, 1])] })
    sampleClip(clipOf('r', 1, { r: [trackR(0, [0, 1], quats)] }), u, pose)
    return pose.localQ
  }
  // slerp + the sign-flip branch (−q1 walks the same rotation)
  quatSlerp(ref, q0, q1, 0.37)
  expect(maxDiff(check([0, 0, 0, 1, 0, 0.6, 0, 0.8], 0.37), ref)).toBeLessThan(1e-6)
  quatSlerp(ref, q0, new Float32Array([0, -0.6, 0, -0.8]), 0.37)
  expect(maxDiff(check([0, 0, 0, 1, 0, -0.6, 0, -0.8], 0.37), ref)).toBeLessThan(1e-6)
  // nlerp shortcut
  quatSlerp(ref, q0, nearly, 0.5)
  expect(maxDiff(check([0, 0, 0, 1, 0.01, 0, 0, Math.sqrt(1 - 0.0001)], 0.5), ref)).toBeLessThan(1e-6)
})

test('sampleClip: untracked joints hold the rest pose, scale tracks apply', () => {
  const pose = createSkeletonPose(CHAIN)
  // only joint 0 has tracks; joints 1-2 must keep their rest TRS
  const clip = clipOf('sparse', 1, {
    t: [trackT(0, [0, 1], [5, 5, 5, 6, 6, 6])],
    s: [trackS(2, [0, 1], [3, 3, 3, 4, 4, 4])],
  })
  sampleClip(clip, 1, pose)
  expect(Array.from(pose.localT.subarray(0, 3))).toEqual([6, 6, 6])
  expect(Array.from(pose.localT.subarray(3, 6))).toEqual([0, 2, 0]) // child rest
  const grandQ = Array.from(pose.localQ.subarray(8, 12)) // grand rest x,y,z,w
  expect(grandQ[1]).toBe(0)
  expect(grandQ[2]).toBe(0)
  expect(grandQ[0]).toBeCloseTo(QUARTER, 6)
  expect(grandQ[3]).toBeCloseTo(QUARTER, 6)
  expect(Array.from(pose.localS.subarray(6, 9))).toEqual([4, 4, 4]) // grand scale track won
})

// ─── clip validation ────────────────────────────────────────────────────────

test('validateClip: corruption throws, the FBX −1 joint is tolerated', () => {
  const ok = clipOf('ok', 1, { t: [trackT(0, [0], [1, 1, 1])] })
  expect(validateClip(ok, 3)).toBe(ok)
  // −1 = an unresolved FBX bone name — dead data, not corruption
  expect(() => validateClip(clipOf('neg', 1, { t: [trackT(-1, [0], [1, 1, 1])] }), 3)).not.toThrow()
  expect(() => validateClip(clipOf('oob', 1, { t: [trackT(3, [0], [1, 1, 1])] }), 3))
    .toThrow(/joint 3 but the skeleton has 3/)
  expect(() => validateClip(clipOf('empty', 1, { t: [trackT(0, [], [])] }), 3)).toThrow(/at least one key/)
  expect(() => validateClip(clipOf('short', 1, { r: [trackR(0, [0, 1], [0, 0, 0, 1, 0, 0, 0])] }), 3))
    .toThrow(/quats holds 7 floats/)
  expect(() => validateClip(clipOf('desc', 1, { t: [trackT(0, [1, 0], [1, 1, 1, 2, 2, 2])] }), 3))
    .toThrow(/non-decreasing/)
  expect(() => validateClip(clipOf('dur', Number.NaN, {}), 3)).toThrow(/duration/)
  expect(() => validateClip(clipOf('dur', -1, {}), 3)).toThrow(/duration/)
})

// ─── the animator facade ────────────────────────────────────────────────────

test('createAnimator: no clip → the bind pose, never a zero palette', () => {
  const animator = createAnimator(CHAIN)
  const pose = createSkeletonPose(CHAIN)
  pose.resetToRest()
  evaluateSkeleton(pose)
  expect(maxDiff(animator.palette, pose.palette)).toBe(0)
  expect(animator.clip).toBeNull()
  expect(animator.clipName).toBeNull()
  expect(animator.duration).toBe(0)
})

test('animator: play samples t = 0 immediately; advance and loop wrap', () => {
  const clip = clipOf('walk', 1, { t: [trackT(0, [0, 1], [10, 0, 0, 20, 0, 0])] })
  const animator = createAnimator({ joints: CHAIN.joints.slice(0, 2) }, clip)
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([10, 0, 0])
  animator.advance(0.5)
  expect(animator.time).toBe(0.5)
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([15, 0, 0])
  animator.advance(1) // past the duration → wraps
  expect(animator.time).toBeCloseTo(0.5, 10)
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([15, 0, 0])
  // speed scales dt; a whole period lands exactly on t = 0 (the loop point)
  animator.speed = 2
  animator.advance(0.25)
  expect(animator.time).toBe(0) // 0.5 + 0.25·2 = 1 = duration → wrapped
})

test('animator: seek via time, negative wraps, non-loop clamps and holds', () => {
  const clip = clipOf('hold', 2, { t: [trackT(0, [0, 2], [0, 0, 0, 4, 0, 0])] })
  const animator = createAnimator({ joints: [CHAIN.joints[0]] }, clip)
  animator.time = 1
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([2, 0, 0])
  animator.time = -0.5 // wraps to duration − 0.5 = 1.5
  expect(animator.time).toBeCloseTo(1.5, 10)
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([3, 0, 0])
  animator.looping = false
  animator.time = 99
  expect(animator.time).toBe(2)
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([4, 0, 0]) // final key held
  animator.advance(10)
  expect(animator.time).toBe(2)
})

test('animator: pause freezes, resume continues, stop → rest pose', () => {
  const clip = clipOf('p', 10, { t: [trackT(0, [0, 10], [0, 0, 0, 100, 0, 0])] })
  const animator = createAnimator({ joints: [CHAIN.joints[0]] }, clip)
  animator.advance(2)
  animator.pause()
  animator.advance(5) // frozen
  expect(animator.time).toBe(2)
  expect(animator.paused).toBe(true)
  animator.resume()
  animator.advance(1)
  expect(animator.time).toBe(3)
  animator.stop()
  expect(animator.clip).toBeNull()
  expect(animator.time).toBe(0)
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([1, 0, 0]) // root rest T
  // advance without a clip is a no-op, chaining works
  expect(animator.advance(1)).toBe(animator)
})

test('animator: play() swaps clips and validates them', () => {
  const animator = createAnimator(CHAIN)
  const a = clipOf('a', 1, { t: [trackT(0, [0, 1], [1, 0, 0, 2, 0, 0])] })
  const b = clipOf('b', 1, { t: [trackT(0, [0, 1], [3, 0, 0, 4, 0, 0])] })
  animator.play(a)
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([1, 0, 0])
  animator.advance(1)
  animator.play(b, { time: 0.5 })
  expect(animator.clipName).toBe('b')
  expect(Array.from(animator.pose.localT.subarray(0, 3))).toEqual([3.5, 0, 0])
  const broken = clipOf('bad', 1, { t: [trackT(9, [0], [1, 1, 1])] })
  expect(() => animator.play(broken)).toThrow(/joint 9/)
  // the previous clip stays bound after a failed play
  expect(animator.clip).toBe(b)
  animator.play(null)
  expect(animator.clip).toBeNull()
})

// ─── the Mixamo fixture (shared with the model-viewer demo) ─────────────────

// The heavy fixture is shared with the model-viewer demo: the tests are
// enabled automatically wherever the repo checkout is complete.
const SAMBA = new URL('../../../demo/model-viewer/assets/samba.fbx', import.meta.url)
const hasFixture = existsSync(SAMBA)
const it = test.skipIf(!hasFixture)

// Pinned against the previous in-demo implementation (itself verified
// key-for-key against three.js r170 on the same file): the palette of
// joint 0 (Hips) at t = 0 / 2.5 s and joint 2 at t = 2.5 s.
const PIN_HIPS_T0 = [0.822695, -0.020919, -0.568098, 0, -0.022473, 0.997345, -0.069269, 0, 0.568039, 0.069754, 0.82004, 0, 1.924065, -3.847727, 6.865995, 1]
const PIN_HIPS_T25 = [0.83307, 0.001819, -0.553165, 0, -0.090679, 0.986916, -0.133319, 0, 0.545685, 0.161225, 0.822335, 0, 8.659197, -4.784915, 23.381706, 1]
const PIN_JOINT2_T25 = [0.884159, -0.100063, -0.456345, 0, 0.142469, 0.988016, 0.059389, 0, 0.444933, -0.117525, 0.887819, 0, -17.386772, -5.151774, 2.304044, 1]

it('samba fixture: structural compatibility — loader output feeds the animator directly', async () => {
  const bytes = await readFile(SAMBA)
  const model = await parseFBX(bytes.buffer as ArrayBuffer)
  const animator = createAnimator(model.skeleton, model.clips[0] ?? null)
  expect(animator.jointCount).toBe(67)
  expect(animator.clipName).toBe('mixamo.com')
  expect(animator.duration).toBeCloseTo(18.2, 3)

  const hips = (t: number): number[] => Array.from(animator.palette.slice(0, 16))
  const pinCheck = (got: number[], pin: number[]) => {
    for (let i = 0; i < 16; i++) expect(got[i]).toBeCloseTo(pin[i], 4)
  }
  pinCheck(hips(0), PIN_HIPS_T0)

  animator.time = 2.5
  pinCheck(hips(2.5), PIN_HIPS_T25)
  pinCheck(Array.from(animator.palette.slice(32, 48)), PIN_JOINT2_T25)

  // a full loop: every palette entry finite, the wrap lands back at t = 0
  animator.time = 0
  for (let i = 0; i < 365; i++) animator.advance(0.05) // 18.25 s > duration
  expect(animator.time).toBeLessThan(0.05)
  for (const v of animator.palette) expect(Number.isFinite(v)).toBe(true)
  // skin matrices are affine: the w row stays (0, 0, 0, 1)
  for (let j = 0; j < animator.jointCount; j++) {
    expect(animator.palette[j * 16 + 3]).toBe(0)
    expect(animator.palette[j * 16 + 7]).toBe(0)
    expect(animator.palette[j * 16 + 11]).toBe(0)
    expect(animator.palette[j * 16 + 15]).toBe(1)
  }
})
