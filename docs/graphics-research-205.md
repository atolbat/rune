# graphics-research-205 — the niche-paper harvest

Status: **SHIPPED (Task 205)** — the collected sources, the four CPU-side
implementations, the measured wins, the honest rejections, and the
GPU-side backlog. The rule the whole file obeys: *a technique enters the
engine only with a bench number and a parity gate; a technique that
changes an answer is no win.*

`bun packages/core/bench/research205.bench.ts` (min of 12–40 passes, the
demo's own city corpus — 23 occluders + 16384 occludees, 480×270 Hi-Z
tile, the three validation cameras):

| section | the legacy twin | the shipped path | the win |
|---|---|---|---|
| **A. the occluder raster** (`softwareOccluder`, 23 `writeBox` + `reduce`) | 1.96 ms/camera | **1.03 ms/camera** | **1.91×** |
| **B. the query** (16k `hiddenView`) | 3.67 ms/camera | **2.80 ms/camera** | **1.31×** (CSE 1.28× + early-out) |
| **B. the whole soft-HiZ pass** (A+B combined) | 4.60 ms/camera | **2.80 ms/camera** | **1.64×** |
| **C. the octree frustum walk** | 14340 plane evals | **3357** | **4.3× fewer** (wall 1.09×) |
| **C. the BVH frustum walk** | 9422 plane evals | **2675** | **3.5× fewer, wall 1.22×** |
| **D. the picking ray** | tuple + object per slab | allocation-free | 1.52M rays/s (octree) |

Parity gates (all held, `packages/core/tests/task205.test.ts`, +2150/2150
suite): tiled ≡ legacy verdicts (fuzz, 0 drift), CSE ≡ legacy outputs
(≤1e-9) and verdicts (0 flips), early-out ≡ full scan, mask ≡ legacy
survivor sets, octree ≡ BVH ≡ brute raycast (the tie law).

---

## 1. The collected sources (the harvest)

Three research passes (rasterization/occlusion, GPU compute/particles/
sampling, spatial/math/demoscene), niche-only sources — journals, arXiv,
personal research blogs, CC0 repos; engine-vendor blogs excluded by
policy. The full raw digests: `docs/research-205-{a,b,c}.md (this repo)`.

### The implemented four (+the measurement discipline)

1. **Greene, «Hierarchical Polygon Tiling with Coverage Masks», SIGGRAPH
   1996** — the recursive tile subdivision driven by edge coverage; the
   «pyramid rasterization» lineage the 2025 MIT/NVIDIA paper extends.
   *In:* the 8×8 tile tiers of `softwareOccluder`'s `rasterTriTiled`.
2. **rawrunprotected, «Sponza in a Millisecond» + the software rasterizer
   update** (threadlocalmutex.com; repo CC0) — the quantized coarse edge
   test per tile (our exact linear-reach bound form), the clipless
   rasterization notes, and the N-frame jitter anti-over-cull. *In:* the
   REJECT/ACCEPT tier tests (the reach bound `(|A|+|B|)·7` is the exact
   linear swing — no LUT needed at our 480×270 scale).
3. **ryg (F. Giesen), «Optimizing the basic rasterizer», 2013 + «View
   frustum culling», 2010** — the incremental edge stepping (2 adds/pixel,
   zero multiplies), the depth-plane gradient, and the CSE corner
   transform (8 corners = the center's row dots + the per-axis half
   products: 96 mults → 24, signs unrolled to literal adds). *In:* the
   PARTIAL tier's inner loop, the z gradient, and `projectBox` CSE.
   Dyrkorn's JS rasterizer series (kristoffer-dyrkorn.github.io) is the
   JS-native confirmation of the same ladder.
4. **Sýkora & Jelínek, «Efficient View Frustum Culling», 2007 (the
   Cesium JS line, 2015)** — plane-mask inheritance: the 6-bit
   «planes the parent intersected» mask travels down the octree/BVH; a
   plane proven inside for the parent never returns. *In:*
   `maskedPlanes` in both `walkFrustum`s + the instrumented
   `planeTests` counter (the BVH's leaf items inherit it too — they
   live inside the node's tight bounds; the octree's straddlers keep
   the full six).

Plus two structural notes baked into the same pass:

- **the tz-pyramid lesson (Boulos et al., HPG 2010)** — the two-quantity
  Hi-Z read. The one-sided early-out in `hidden()` is the exact
  monotone-max form: the FALSE verdict settles on the first tile at/above
  the near corner; the TRUE verdict cannot early-exit (the unvisited
  tiles' max is unknown) — measured: the fp64 projection dominates the
  city queries, so the early-out is exact-but-invisible there, and the
  CSE projector is the lever that actually moved section B.
- **the allocation-free slab walk** — `clipRay`'s `[t0,t1]` tuple and the
  six-field `NodeBounds` literal per leaf item were GC garbage on the
  click path; `slabEnter` returns the entry t with the exit in a module
  scratch, the arithmetic order preserved bit-for-bit (the tie law
  survives — the model-viewer picking and the demo's octree ≡ BVH gate
  hold).

### The measured rejections (this round)

- **Escape-index stackless BVH traversal (Prokopenko, arXiv 2402.00665)**
  — the escape indices emit free in a Morton build, but our trees are
  ~14 deep and the visits per ray are ~hundreds: recursion overhead in
  JS is sub-µs against the slab math; the rewrite would pay complexity
  for noise. Revisit if picking grows 100×.
- **CHC++ randomized bounded persistence (Mattausch et al. 2008)** —
  decorrelates verdict flips, but our hysteresis already carries the
  streak encoding shared with the GPU leg; the policy change touches
  device.ts's contract for a variance win we cannot measure on the
  city (the flip bursts are already amortized). Documented for the
  WebGL2 TF fallback leg if its query cost ever shows in a profile.
- **Masked Occlusion Culling's layered tiles (Hasselgren et al., HPG
  2015)** — K depth layers + masks per tile beat a single zmax on
  partially-covered tiles; at 23 authored box occluders the layers
  would sit empty (the coverage is front-plane exact), and the merge
  machinery is SPU-shaped. The GPU-side variant (see the backlog) is
  the honest home for it.
- **SoA-vs-interleaved A/B (royalbhati, 2025)** — confirms our existing
  SoA `RecordView` (no change; the audit found no per-object boxing on
  the cull paths).

## 2. The GPU-side backlog (ranked, next rounds)

1. **Decoupled Fallback single-pass scan (T. Smith, HPG 2025)** — the
   WGSL-safe single-pass prefix sum (bounded spin + work stealing; no
   acquire/release needed). Transliterable from Vello's WGSL. Gate: the
   compaction kernel's GPU timer at 40k/256k/1M.
2. **Onesweep LSD radix sort in WGSL (Adelani et al. 2022 + Linebender's
   field notes: «warp» 16 beats 32; Lichtso's splatter is UB)** — 4–8
   dispatches vs bitonic's log²; the 40k-particle sort is the target.
   Reference: b0nes164/GPUSorting.
3. **Two-plane min-max Hi-Z in the WGSL kernel (the tz-pyramid's (a)
   form)** — the box z-interval vs the tile's plane pair: fewer
   false-visible verdicts on sloped ground + a fast-accept tier. Gate:
   the cull-rate delta + the pixel-parity hash (must not move).
4. **HROC's group-then-refine (Lee et al., EG 2021)** — the cluster
   (BVH-subtree) rect test first, per-object only for failing clusters
   (~20× fewer first-pass tests at 10k boxes); `clusterize` already
   builds the groups.
5. **MBOIT (JCGT 2018) / LWBOIT (GI 2021)** — the OIT pair for the
   particles/vfx blending tiers; browser-proven by three.js (2025).
6. **STBN (JCGT 2022)** — the spatiotemporal blue-noise volume behind a
   flag for stochastic/dither paths (opt-in: noise ≠ parity).
7. **Thread-group-ID L2 swizzle (NVIDIA GDC 2019)** — one dispatch-line
   change for the Hi-Z downsample and fullscreen passes on desktop
   GPUs; harmless on tiled ones.

## 3. The A/B surface (the permanent contracts)

The bricks keep their legacy twins as first-class options — the bench
and the fuzz gates ride them, and any future regression re-runs the
same table:

```js
softwareOccluder({ raster: 'tiled' | 'legacy',   // default 'tiled'
                   project: 'cse' | 'legacy',    // default 'cse'
                   earlyOut: true | false })     // default true
buildOctree(items, { planeMask: true | false })   // default true
buildBVH(items,   { planeMask: true | false })    // default true
```

`projectBoxLegacy` stays exported as the reassociation-noise oracle.
The `planeTests` getter on both indexes is the instrument (reset per
`queryFrustum`).
