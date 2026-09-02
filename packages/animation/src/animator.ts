/**
 * animator.ts — the playback facade: clock + clip + pose.
 *
 * The clock belongs to the CALLER: advance(dt) is driven from the render
 * loop (the demo's frameCallback), the animator owns the pose. The
 * palette is the frame's currency — a flat Float32Array handed to the
 * draw command's uniform array, never re-wrapped per frame.
 *
 * Chaining: play/advance/pause/resume/stop return the animator, so a
 * whole setup reads as one sentence:
 *   createAnimator(rig, idle).play({ speed: 1.25, loop: true }).advance(0)
 */
import type { Clip } from './clip.ts'
import { validateClip } from './clip.ts'
import type { Skeleton, SkeletonPose } from './skeleton.ts'
import { createSkeletonPose } from './skeleton.ts'
import { sampleClip } from './sampling.ts'
import { evaluateSkeleton } from './pose.ts'

/** Per-play overrides for Animator.play(). */
export interface PlaybackOptions {
  /** Start time in seconds (default 0). */
  readonly time?: number
  /** Playback rate (default 1; 0 freezes, negative plays in reverse). */
  readonly speed?: number
  /** Wrap around the duration (default true). */
  readonly loop?: boolean
  /** Start paused (default false). */
  readonly paused?: boolean
}

/** The playback facade over the composable core (sampleClip/evaluateSkeleton). */
export interface Animator {
  readonly skeleton: Skeleton
  readonly jointCount: number
  /** The pose scratch — the composable core's handle on this animator. */
  readonly pose: SkeletonPose
  /** The skin palette: 16 floats per joint, column-major — upload as-is. */
  readonly palette: Float32Array
  /** World (model-space) joint transforms — tooling, debug, attachments. */
  readonly world: Float32Array
  /** The bound clip (null after stop() or play(null)). */
  readonly clip: Clip | null
  readonly clipName: string | null
  /** The bound clip's duration in seconds (0 when no clip). */
  readonly duration: number
  readonly paused: boolean
  /** Clip time in seconds. Setting it seeks and re-samples immediately. */
  time: number
  /** Playback rate (advance multiplies dt by it). */
  speed: number
  /** Wrap around the duration when true; clamp at the ends when false. */
  looping: boolean
  /** Binds a clip (validating it once) and samples at options.time (default 0). */
  play(clip?: Clip | null, options?: PlaybackOptions): Animator
  /** Freezes the clock — advance() becomes a no-op until resume(). */
  pause(): Animator
  /** Resumes from the frozen time. */
  resume(): Animator
  /** Unbinds the clip and evaluates the rest (bind) pose into the palette. */
  stop(): Animator
  /** Advances the clock by dt·speed (wrap/clamp) and re-samples the palette. */
  advance(dt: number): Animator
  /** Re-samples at the current time without moving the clock. */
  sample(): Animator
}

/**
 * Creates an animator over a skeleton. When `clip` is given it is bound
 * (validated once) and sampled at t = 0; without a clip the palette holds
 * the rest (bind) pose — a skinned mesh is visible immediately, never a
 * zero palette.
 *
 * FbxSkeleton/FbxClip from @rune/loaders pass structurally:
 *   createAnimator(model.skeleton, model.clips[0] ?? null)
 */
export function createAnimator(skeleton: Skeleton, clip?: Clip | null): Animator {
  const pose = createSkeletonPose(skeleton)
  const n = pose.jointCount

  let current: Clip | null = null
  let clipName: string | null = null
  let duration = 0
  let time = 0
  let speed = 1
  let looping = true
  let paused = false

  /** Wrap (loop) or clamp (hold) a time into [0, duration]. */
  const wrap = (t: number): number => {
    if (duration <= 0) return 0
    if (looping) {
      // the fast path keeps t untouched — no float noise from re-modulo
      if (t >= 0 && t < duration) return t
      return ((t % duration) + duration) % duration
    }
    return t < 0 ? 0 : t > duration ? duration : t
  }

  /** Local TRS → world → palette at the current time. */
  const sample = (): void => {
    if (current !== null) sampleClip(current, time, pose)
    else pose.resetToRest()
    evaluateSkeleton(pose)
  }

  const animator: Animator = {
    skeleton,
    jointCount: n,
    pose,
    get palette(): Float32Array {
      return pose.palette
    },
    get world(): Float32Array {
      return pose.world
    },
    get clip(): Clip | null {
      return current
    },
    get clipName(): string | null {
      return clipName
    },
    get duration(): number {
      return duration
    },
    get paused(): boolean {
      return paused
    },
    get time(): number {
      return time
    },
    set time(t: number) {
      time = wrap(t)
      sample()
    },
    get speed(): number {
      return speed
    },
    set speed(v: number) {
      speed = v
    },
    get looping(): boolean {
      return looping
    },
    set looping(v: boolean) {
      looping = v
      time = wrap(time)
    },
    play(next?: Clip | null, options?: PlaybackOptions): Animator {
      const clipToBind = next === undefined ? current : next
      if (clipToBind !== null && clipToBind !== undefined) validateClip(clipToBind, n)
      current = clipToBind ?? null
      clipName = current?.name ?? null
      duration = current?.duration ?? 0
      if (options?.speed !== undefined) speed = options.speed
      if (options?.loop !== undefined) looping = options.loop
      if (options?.paused !== undefined) paused = options.paused
      time = wrap(options?.time ?? 0)
      sample()
      return animator
    },
    pause(): Animator {
      paused = true
      return animator
    },
    resume(): Animator {
      paused = false
      return animator
    },
    stop(): Animator {
      current = null
      clipName = null
      duration = 0
      time = 0
      sample()
      return animator
    },
    advance(dt: number): Animator {
      if (current === null || paused) return animator
      time = wrap(time + dt * speed)
      sample()
      return animator
    },
    sample(): Animator {
      sample()
      return animator
    },
  }

  if (clip !== undefined && clip !== null) animator.play(clip)
  else sample() // rest (bind) pose — a skinned mesh is visible at once
  return animator
}
