/**
 * @rune/animation — skeletal animation: clip sampling → joint hierarchy
 * → skin palette.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PACKAGE CONTRACT (the layer):
 *
 *   Pure CPU-side evaluation of skinned animation. The package knows
 *   NOTHING about the GPU, renderers, shaders or loaders:
 *     IN : a decoded skeleton + clips — flat typed arrays, seconds,
 *          xyzw quaternions, column-major matrices (@rune/math
 *          conventions)
 *     OUT: a skin palette — one Float32Array, 16 floats per joint —
 *          ready to upload as a uniform array on any backend
 *   The upload path belongs to the draw command (u_bones in the demo);
 *   this package never touches a GPU.
 *
 *   Structural compatibility with @rune/loaders: FbxSkeleton IS a
 *   Skeleton, FbxClip IS a Clip —
 *     createAnimator(model.skeleton, model.clips[0] ?? null)
 *   with no adapters and no copies. (Track joint −1 — unresolved FBX
 *   bone names — is tolerated and skipped.)
 *
 *   Two levels of API (the repo's facade + composable core split):
 *     facade : createAnimator — play/advance/pause/seek/stop + palette
 *     core   : createSkeletonPose → sampleClip / evaluateSkeleton /
 *              resetToRest — composable for blending, procedural
 *              overrides and tooling (a clip cross-fade is a future
 *              layer on the same pose buffers)
 *
 *   PERFORMANCE discipline (the core's mobile rules):
 *     - zero allocations per frame: the pose is flat SoA scratch,
 *       allocated once; the hot kernels are offset-based (no subarray
 *       views, no per-joint matrix objects)
 *     - one forward pass over the hierarchy (joints are parents-first —
 *       validated once at pose creation, never re-walked)
 *     - binary key search; lerp/slerp with an nlerp shortcut
 *     - the palette uploads as-is — no per-frame re-wrapping
 *     - the kernels mirror @rune/math's formulas and float operation
 *       order exactly; tests pin the parity
 *
 *   The clock belongs to the caller: advance(dt) is driven from the
 *   render loop. The animator owns the pose, not the frame.
 * ══════════════════════════════════════════════════════════════════════════
 */

export type { Joint, Skeleton, SkeletonPose } from './skeleton.ts'
export { createSkeletonPose } from './skeleton.ts'
export type { TrackT, TrackR, TrackS, Clip } from './clip.ts'
export { validateClip } from './clip.ts'
export { sampleClip } from './sampling.ts'
export { evaluateSkeleton } from './pose.ts'
export type { Animator, PlaybackOptions } from './animator.ts'
export { createAnimator } from './animator.ts'
