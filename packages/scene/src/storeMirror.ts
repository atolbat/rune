/**
 * storeMirror.ts — Task 214: @rune/scene's mirror/publish ON THE STORE.
 *
 * The Task-211 unified data surface (@rune/core's SoAStore) until now had
 * exactly one native consumer: the occlusion demo's own scene words
 * (adoptStore over its records region — zero copies, the GPU mirror eats
 * the coalesced dirty ranges through updateRecords). THIS module is the
 * same unification for the @rune/scene package proper: the scene's SAB
 * regions become ADOPTED STORES (zero copies — the views alias the very
 * bytes the worker reads and writes), and the bridge's mirror/publish
 * rhythm gains the store's dirty-range surface on BOTH directions:
 *
 *   THE PUBLISH SIDE (main → the frame):
 *     `locals` — the slot-space store over pos/quat/scale (what main
 *     writes through the Scene API; localStamp is the dirt). A GPU mirror
 *     of the statics re-uploads `staticRanges(watermark)` — the exact
 *     slots whose locals changed, coalesced, 4-aligned.
 *
 *   THE MIRROR SIDE (the frame → main → the GPU):
 *     `pool(epoch, camera)` — the store over ONE double-buffered instance
 *     pool row (the bridge snapshot's instance segments are prefix ranges
 *     of its single `matrix` column). `ranges(epoch, camera, watermark)`
 *     is Task 85's own dirt — the groupTouch/groupFlip stamps — expressed
 *     as the store's upload ranges: a group whose world content OR
 *     per-camera visibility flipped past the watermark re-uploads its
 *     whole segment; everything else stays. A pack (a rank reshuffle) is
 *     ALREADY conservative in the collect itself (it stamps every group
 *     of every camera — instances.ts's own law), so the pool side needs
 *     no extra layout watch.
 *     `worlds` — the RANK-space store over the world-matrix rows (the
 *     records are RANKS: valid until the next pack — the same contract
 *     worldMatrix(slot) carries). `worldRanges(watermark, layoutEpoch)`
 *     resolves worldStamp through order[]; a layout-epoch change (the
 *     consumer's second watermark) means the ranks were reshuffled — the
 *     mirror returns the FULL range set (touchAll), never a skipped one.
 *
 *   THE WATERMARK DISCIPLINE (one number for every side — all stamps are
 *   the scene's H_CLOCK domain):
 *     · hold watermark = 0 at boot (stamps start at 0 — nothing dirty);
 *     · after a FRESH take (the snapshot's epoch advanced) read
 *       `watermark()` — the H_CLOCK captured at the fresh-take moment.
 *       THE WINDOW IS SAFE BY THE BRIDGE'S OWN PROTOCOL: the worker sleeps
 *       until the next publish, so between outputEpoch = E and the next
 *       publish nothing writes stamps — the captured clock is exactly
 *       epoch E's final one;
 *     · on a STALE take (the epoch did not advance) HOLD the old
 *       watermark — the worker may already be mid-flight on the NEXT
 *       epoch, and its stamps must stay "unseen" for the next upload.
 *       Re-uploading a frozen row is always sound; skipping never is.
 *     · the bridge wrapper below (`take()`) applies this discipline
 *       itself — the raw `observe(epoch)` is the T0 spelling.
 *
 * ZERO STEADY-STATE ALLOCATIONS: the adopted stores (locals, spheres,
 * worlds, one per (row, camera) pool row) and their MarkSets are created
 * once and owned forever; `ranges`/`staticRanges`/`worldRanges` re-mark
 * the owned sets per call and hand out the store API's own small range
 * arrays (the same shape the occlusion demo feeds updateRecords). The
 * ranges are REGION-relative bytes (the pool row / the locals region /
 * the world region) — a GPU consumer registers the region's base when it
 * creates its mirror and adds nothing else.
 *
 * WHAT THIS IS NOT: not a renderer, not a bridge replacement. The Scene
 * API stays the writer (setLocalTR bumps localStamp, the pipeline bumps
 * worldStamp/groupTouch/groupFlip — the stamps ARE the store's dirt);
 * this module only ADOPTS and REPORTS. `spheres` is read-access (the
 * refit's product — its freshness is the scene's own domain).
 */
import { adoptStore, type SoAStore, type UploadRange } from '@rune/core'
import type { SceneWorkerBridge, SceneSnapshot } from './mirror.ts'
import type { Scene } from './scene.ts'
import { H_CLOCK, H_GROUP_COUNT, H_LAYOUT_EPOCH, H_NODE_COUNT, NF_ALIVE } from './layout.ts'

/** The publish-side + mirror-side store surface of one scene. */
export interface SceneStoreMirror {
  /** The slot-space store over the local TRS (pos 3 / quat 4 / scale 3).
   * Records = slots; the live set is the scene's own NF_ALIVE domain. */
  readonly locals: SoAStore
  /** The slot-space store over the bound spheres (sphereL 4 / sphereW 4).
   * Read-access (the refit's product — see the module header). */
  readonly spheres: SoAStore
  /** The RANK-space store over the world matrices (one 16-wide column).
   * Records = ranks — valid until the next pack (worldMatrix's own
   * contract); call worldRanges after the pipeline's updateWorld. */
  readonly worlds: SoAStore

  /** The store over one (epoch-row, camera) instance-pool row: a single
   * 16-wide `matrix` column; the snapshot's per-group segments are prefix
   * ranges of it. `epoch & 1` picks the double-buffered row. */
  pool(epoch: number, camera: number): SoAStore
  /** The dirty upload ranges of `pool(epoch, camera)` — the group stamps
   * (groupTouch = content, any camera; groupFlip = THIS camera's
   * visibility flips) past the watermark, marked on the owned set and
   * coalesced by the store's own rules. A pure query: same (epoch,
   * camera, watermark) → same ranges. */
  ranges(epoch: number, camera: number, watermark: number): UploadRange[]
  /** The publish-side dirt: the LIVE slots whose locals changed past the
   * watermark (localStamp), as the locals store's coalesced ranges.
   * Structural changes are the layoutEpoch channel's business (below). */
  staticRanges(watermark: number): UploadRange[]
  /** The world-side dirt: the ranks whose world matrix changed past the
   * watermark (worldStamp resolved through order[]). Pass the consumer's
   * layout epoch: when it differs from the scene's current one the ranks
   * were reshuffled and the FULL region returns (touchAll — conservative,
   * never a skip). Packs first when the layout is dirty (the bridge's own
   * publish discipline). */
  worldRanges(watermark: number, layoutEpoch?: number): UploadRange[]
  /** The scene's current layout epoch — the ranks' reshuffle signal. */
  layoutEpoch(): number

  /** Records a FRESH epoch and captures the watermark (the H_CLOCK at
   * this moment — safe by the worker's sleep-until-publish protocol).
   * Returns true when the epoch had not been observed (fresh); a stale
   * observation keeps the previous watermark (the discipline above). */
  observe(epoch: number): boolean
  /** The captured watermark — what the consumer holds after uploading
   * the last OBSERVED (fresh) snapshot. */
  watermark(): number

  /** The bridge wrapper: take() + observe() in one call (the fresh-take
   * watermark capture rides the snapshot's own rhythm). Requires the
   * factory's `bridge` option; on a stale take the snapshot returns
   * unchanged and the watermark holds. */
  take(): SceneSnapshot | null
}

/** Adopts the scene's SAB regions as stores + the stamp-driven dirty
 * surface. See the module header for the laws and the watermark
 * discipline. */
export function createSceneStoreMirror(scene: Scene, bridge?: SceneWorkerBridge): SceneStoreMirror {
  const views = scene.views

  // ── the adopted region stores (zero copies — the views alias the SAB;
  //  regionBytes bounds each SLICE — the scenes's regions live inside a
  //  larger buffer, and the capacity must be the REGION's, not the whole
  //  remainder's) ──
  const locals = adoptStore(
    views.buffer,
    [
      { name: 'pos', kind: 'f32', width: 3 },
      { name: 'quat', kind: 'f32', width: 4 },
      { name: 'scale', kind: 'f32', width: 3 },
    ],
    views.capacity,
    views.pos.byteOffset,
    views.capacity * 10 * 4,
  )
  const spheres = adoptStore(
    views.buffer,
    [
      { name: 'sphereL', kind: 'f32', width: 4 },
      { name: 'sphereW', kind: 'f32', width: 4 },
    ],
    views.capacity,
    views.sphereL.byteOffset,
    views.capacity * 8 * 4,
  )
  // RANK-space: the record count starts at the live node count and is
  // refreshed by worldRanges (resize is a plain count setter under the
  // adopted capacity — the honest bound for the marks below).
  const worlds = adoptStore(
    views.buffer,
    [{ name: 'world', kind: 'f32', width: 16 }],
    Math.max(1, views.headerI[H_NODE_COUNT]),
    views.world.byteOffset,
    views.capacity * 16 * 4,
  )

  // ── the pool-row stores: one per (double-buffer row, camera) ────────
  const rowBytes = Math.max(views.maxInstances, 1) * 16 * 4
  const pools: SoAStore[] = []
  for (let row = 0; row < 2 * views.cameraMax; row++) {
    pools.push(
      adoptStore(
        views.buffer,
        [{ name: 'matrix', kind: 'f32', width: 16 }],
        views.maxInstances,
        views.instPool.byteOffset + row * rowBytes,
        rowBytes,
      ),
    )
  }

  // ── the watermark discipline ─────────────────────────────────────────
  let lastEpoch = -1
  let clockHeld = 0
  const observe = (epoch: number): boolean => {
    if (epoch === lastEpoch) return false
    lastEpoch = epoch
    // SAFE WINDOW: a fresh epoch means the worker finished and sleeps
    // until the next publish — no stamp writes race this read.
    clockHeld = views.headerU[H_CLOCK]
    return true
  }
  const take = (): SceneSnapshot | null => {
    if (bridge === undefined) {
      throw new Error('scene storeMirror: take() needs the factory\'s bridge option (the T0 spelling is observe(epoch))')
    }
    const snap = bridge.take()
    if (snap !== null) observe(snap.epoch)
    return snap
  }

  const groupCount = (): number => Math.min(views.headerI[H_GROUP_COUNT], views.groupMax)

  return {
    locals,
    spheres,
    worlds,

    pool(epoch, camera) {
      if (camera < 0 || camera >= views.cameraMax) {
        throw new Error(`scene storeMirror: pool(epoch, camera=${camera}) — the scene holds ${views.cameraMax} cameras`)
      }
      return pools[(epoch & 1) * views.cameraMax + camera]
    },

    ranges(epoch, camera, watermark) {
      const row = (epoch & 1) * views.cameraMax + camera
      if (camera < 0 || camera >= views.cameraMax || row >= pools.length) {
        throw new Error(`scene storeMirror: ranges(epoch, camera=${camera}) — the scene holds ${views.cameraMax} cameras`)
      }
      const store = pools[row]
      const countsBase = (epoch & 1) * views.cameraMax + camera
      const countsBaseWords = countsBase * views.groupMax
      const flipBase = camera * views.groupMax
      store.clearDirty()
      const groups = groupCount()
      for (let g = 0; g < groups; g++) {
        // groupTouch = a content change (any camera's matrices); groupFlip
        // = THIS camera's visibility flip — either one re-writes the
        // segment's bytes; both must beat the watermark.
        if (views.groupTouch[g] <= watermark && views.groupFlip[flipBase + g] <= watermark) continue
        const off = views.instOffsets[countsBaseWords + g]
        const cnt = Math.max(0, views.instCounts[countsBaseWords + g])
        if (cnt > 0) store.markRecordsDirty(off, off + cnt)
      }
      const out = store.takeUploadRanges()
      store.clearDirty() // ranges() is a pure query — the marks retire here
      return out
    },

    staticRanges(watermark) {
      locals.clearDirty()
      const flags = views.nodeFlags
      const stamps = views.localStamp
      for (let slot = 0; slot < views.capacity; slot++) {
        if ((flags[slot] & NF_ALIVE) === 0) continue
        if (stamps[slot] > watermark) locals.markRecordDirty(slot)
      }
      const out = locals.takeUploadRanges()
      locals.clearDirty()
      return out
    },

    worldRanges(watermark, layoutEpoch) {
      // the ranks must be current — the bridge's own publish discipline
      if (scene.layoutDirty) scene.pack()
      const n = views.headerI[H_NODE_COUNT]
      worlds.resize(Math.max(1, n))
      worlds.clearDirty()
      if (layoutEpoch !== undefined && layoutEpoch !== views.headerI[H_LAYOUT_EPOCH]) {
        // the ranks were reshuffled since the consumer's last upload —
        // the whole region returns (conservative, never a skip)
        worlds.touchAll()
      } else {
        const order = views.order
        const stamps = views.worldStamp
        for (let rank = 0; rank < n; rank++) {
          if (stamps[order[rank]] > watermark) worlds.markRecordDirty(rank)
        }
      }
      const out = worlds.takeUploadRanges()
      worlds.clearDirty()
      return out
    },

    layoutEpoch() {
      return views.headerI[H_LAYOUT_EPOCH]
    },

    observe,
    watermark: () => clockHeld,
    take,
  }
}
