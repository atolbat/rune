/**
 * clip.ts — animation clip types + bind-time validation.
 *
 * A Clip is sparse per-joint keyframe tracks over the LOCAL TRS channels:
 * a joint without a track holds its rest pose. Times are SECONDS and must
 * be non-decreasing within a track (the sampler's binary search relies on
 * it). FbxClip from @rune/loaders IS a Clip structurally.
 */

/** Translation track: xyz per key (values.length === times.length * 3). */
export interface TrackT {
  /** The driven joint index. */
  readonly joint: number
  /** Key times in seconds, non-decreasing. */
  readonly times: Float32Array
  readonly values: Float32Array
}

/** Rotation track: a quaternion (x, y, z, w) per key (quats.length === times.length * 4). */
export interface TrackR {
  readonly joint: number
  readonly times: Float32Array
  readonly quats: Float32Array
}

/** Scale track: xyz per key (values.length === times.length * 3). */
export interface TrackS {
  readonly joint: number
  readonly times: Float32Array
  readonly values: Float32Array
}

/** An animation clip: sparse per-joint tracks + duration in seconds. */
export interface Clip {
  readonly name: string
  /** Clip length in seconds (finite, ≥ 0). */
  readonly duration: number
  readonly tracksT: readonly TrackT[]
  readonly tracksR: readonly TrackR[]
  /** Optional scale tracks — FBX rigs rarely carry them, glTF does. */
  readonly tracksS?: readonly TrackS[]
}

/**
 * Checks a clip against a skeleton size. Runs ONCE at bind time (play()),
 * never per frame — the errors are actionable so a bad asset fails loudly
 * at load, not silently as a frozen model.
 *
 * Joint index −1 is TOLERATED (not an error): the FBX loader emits it for
 * tracks whose bone name resolved to nothing — dead data, skipped at
 * sample time. Indices ≥ jointCount are corruption (they would target
 * memory the skeleton does not have) and throw.
 *
 * @throws RangeError on a joint index ≥ jointCount, an empty track,
 *   a values/quats length mismatch, non-finite duration or a duration < 0.
 * @returns the same clip (chainable: `play(validateClip(clip, n))`).
 */
export function validateClip(clip: Clip, jointCount: number): Clip {
  if (typeof clip.name !== 'string') {
    throw new RangeError(`clip name must be a string (got ${typeof clip.name})`)
  }
  if (!Number.isFinite(clip.duration) || clip.duration < 0) {
    throw new RangeError(`clip "${clip.name}": duration must be finite and ≥ 0 (got ${clip.duration})`)
  }
  checkTracks(clip, jointCount, clip.tracksT, 'translation', 3)
  checkTracks(clip, jointCount, clip.tracksR, 'rotation', 4)
  if (clip.tracksS !== undefined) checkTracks(clip, jointCount, clip.tracksS, 'scale', 3)
  return clip
}

/** One validation pass over a track list: indices, key counts, ordering. */
function checkTracks(
  clip: Clip,
  jointCount: number,
  tracks: readonly { joint: number; times: Float32Array }[],
  kind: string,
  floatsPerKey: number,
): void {
  const floatsName = kind === 'rotation' ? 'quats' : 'values'
  for (let k = 0; k < tracks.length; k++) {
    const track = tracks[k]
    const who = `clip "${clip.name}" ${kind} track ${k}`
    if (track.joint >= jointCount) {
      throw new RangeError(
        `${who}: references joint ${track.joint} but the skeleton has ${jointCount} joints`,
      )
    }
    if (track.times === undefined || track.times.length === 0) {
      throw new RangeError(`${who}: a track needs at least one key`)
    }
    const values = kind === 'rotation' ? (track as TrackR).quats : (track as TrackT).values
    if (values === undefined || values.length < track.times.length * floatsPerKey) {
      throw new RangeError(
        `${who}: ${floatsName} holds ${values?.length ?? 0} floats, ` +
          `needs ${track.times.length * floatsPerKey} (${floatsPerKey} per key)`,
      )
    }
    for (let i = 1; i < track.times.length; i++) {
      if (track.times[i] < track.times[i - 1]) {
        throw new RangeError(
          `${who}: key times must be non-decreasing ` +
            `(${track.times[i]} at key ${i} follows ${track.times[i - 1]})`,
        )
      }
    }
  }
}
