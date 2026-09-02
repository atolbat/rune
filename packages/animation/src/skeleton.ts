/**
 * skeleton.ts — skeleton types and the pose scratch space (flat SoA).
 *
 * A Skeleton is a FLAT list of joints in parents-first (topological)
 * order: the parent of joints[i] is always < i. The order is part of the
 * data contract, not an implementation detail — skin influences index
 * joints by position, so no runtime re-sorting is possible;
 * createSkeletonPose validates the order once and throws otherwise.
 *
 * FbxSkeleton from @rune/loaders IS a Skeleton structurally — feed the
 * loader's output directly, without adapters or copies.
 */

/** A single skeleton joint: rest pose + the inverse bind matrix. */
export interface Joint {
  /** Joint name — diagnostics and tooling; evaluation never reads it. */
  readonly name: string
  /** Parent joint index, −1 = root. Must be an index < the joint's own. */
  readonly parent: number
  /** Rest translation (3 floats, the asset's length units). */
  readonly restT: readonly number[]
  /** Rest rotation as a quaternion (x, y, z, w). */
  readonly restQ: readonly number[]
  /** Rest scale (3 floats). */
  readonly restS: readonly number[]
  /**
   * inv(bindGlobal) — 16 floats, column-major. Absent → identity:
   * the palette then equals the world transform (an unscribed joint).
   */
  readonly invBind?: ArrayLike<number> | null
}

/** A skeleton: joints in parents-first order (see the module contract). */
export interface Skeleton {
  readonly joints: readonly Joint[]
}

/**
 * The pose scratch: every buffer a skeletal evaluation touches, flat and
 * pre-allocated. This is the package's working memory — functions in
 * sampling.ts / pose.ts transform these buffers in place, nothing is ever
 * allocated per frame. The layout (per joint i):
 *
 *   localT  3 floats   sampled local translation
 *   localQ  4 floats   sampled local rotation (x, y, z, w)
 *   localS  3 floats   sampled local scale
 *   world   16 floats  world (model-space) transform
 *   palette 16 floats  skin palette: world × invBind — the upload-ready
 *                      uniform array (u_bones on both backends)
 *   parents 1 int32    the parent index (−1 = root), flattened once
 *   invBind 16 floats  flattened inverse binds (identity when absent)
 */
export interface SkeletonPose {
  readonly skeleton: Skeleton
  readonly jointCount: number
  /** Parent index per joint (−1 = root) — parents-first, guaranteed. */
  readonly parents: Int32Array
  /** 16 floats per joint, identity where the joint has no invBind. */
  readonly invBind: Float32Array
  /** Sampled local TRS — the input side of evaluateSkeleton. */
  readonly localT: Float32Array
  readonly localQ: Float32Array
  readonly localS: Float32Array
  /** World (model-space) transforms — evaluateSkeleton's first output. */
  readonly world: Float32Array
  /** The skin palette (world × invBind) — the frame's currency. */
  readonly palette: Float32Array
  /** Copies the rest pose into the local TRS buffers. */
  resetToRest(): SkeletonPose
}

/**
 * Validates the skeleton and allocates the pose scratch.
 *
 * @throws RangeError — actionable, with the joint's name — on a violated
 *   parents-first order, an out-of-range parent, or short rest/invBind
 *   arrays. All checks run ONCE here, never on the hot path.
 */
export function createSkeletonPose(skeleton: Skeleton): SkeletonPose {
  const joints = skeleton.joints
  const n = joints.length

  const localT = new Float32Array(n * 3)
  const localQ = new Float32Array(n * 4)
  const localS = new Float32Array(n * 3)
  const world = new Float32Array(n * 16)
  const palette = new Float32Array(n * 16)
  const parents = new Int32Array(n)
  const invBind = new Float32Array(n * 16)

  // Rest pose kept flat and private: resetToRest() bulk-copies it.
  const restT = new Float32Array(n * 3)
  const restQ = new Float32Array(n * 4)
  const restS = new Float32Array(n * 3)

  for (let i = 0; i < n; i++) {
    const j = joints[i]
    if (j === undefined) {
      throw new RangeError(`skeleton joint ${i} is undefined`)
    }
    const who = `joint "${j.name}" (${i})`
    const p = j.parent
    if (!Number.isInteger(p) || p < -1 || p >= i) {
      throw new RangeError(
        `${who}: parent ${p} violates the parents-first order (expected −1 or an index < ${i}). ` +
          'Skin influences index joints by position — re-sort the joints parents-first.',
      )
    }
    if (j.restT === undefined || j.restT.length < 3) {
      throw new RangeError(`${who}: restT must hold at least 3 floats`)
    }
    if (j.restQ === undefined || j.restQ.length < 4) {
      throw new RangeError(`${who}: restQ must hold at least 4 floats (x, y, z, w)`)
    }
    if (j.restS === undefined || j.restS.length < 3) {
      throw new RangeError(`${who}: restS must hold at least 3 floats`)
    }
    if (j.invBind !== undefined && j.invBind !== null && j.invBind.length < 16) {
      throw new RangeError(`${who}: invBind must hold 16 floats (column-major)`)
    }

    parents[i] = p
    // Bounded copies (a longer source array must not bleed into the next joint).
    for (let c = 0; c < 3; c++) restT[i * 3 + c] = j.restT[c]
    for (let c = 0; c < 4; c++) restQ[i * 4 + c] = j.restQ[c]
    for (let c = 0; c < 3; c++) restS[i * 3 + c] = j.restS[c]

    const o = i * 16
    if (j.invBind !== undefined && j.invBind !== null) {
      for (let c = 0; c < 16; c++) invBind[o + c] = j.invBind[c]
    } else {
      // identity: palette[i] = world[i] × I = world[i] (exact in IEEE-754)
      invBind[o] = 1
      invBind[o + 5] = 1
      invBind[o + 10] = 1
      invBind[o + 15] = 1
    }
  }

  const pose: SkeletonPose = {
    skeleton,
    jointCount: n,
    parents,
    invBind,
    localT,
    localQ,
    localS,
    world,
    palette,
    resetToRest(): SkeletonPose {
      localT.set(restT)
      localQ.set(restQ)
      localS.set(restS)
      return pose
    },
  }
  return pose
}
