# graphics-research-208 — the occluder pass & arbitrary geometry

Task 208's research round answers the user's two standing asks:

- **(A)** «как дополнительно такой сложный проход окклюдера оптимизировать,
  можешь поискать в инете» — further optimization of the two-pass HZB
  occluder machinery;
- **(B)** «как эффективно использовать окклюжен с произвольной неквадратной
  геометрией» — occlusion culling with arbitrary non-box geometry.

**The fresh sweep re-ran on 2026-09-14 — and landed, by a second road.**
The z-ai function quota is still exhausted (web_search 429'd all 13 paced
queries — the limit is quota-based, not pace-based; page_reader shares the
same pool), so the harvest went **direct-HTTP against the known URLs of the
verified corpus**: the bevy PR/issue pages themselves, the occlusion-PR
search listing, Pettineo's RSS. Every claim in the fresh-harvest section
below was read from its own page TODAY (raw HTML archived locally under
`scripts/out/research208/`, gitignored — the doc records the dates, states
and titles the pages carried); the 205–207 anchors keep their ⚓ marks, the
first-principles analysis keeps ✎, and `scripts/research208-search.mjs`
stays in the tree for the day the search quota recovers and blind discovery
of non-GitHub material becomes possible again. Nothing below is a
hallucinated citation — the 207 audit killed two phantoms and this doc
keeps that law.

---

## the fresh harvest (2026-09-14): the bevy line moved

Our Task-207/208 architecture's upstream twin evolved past where the 207
round left it — the full page-verified timeline:

| when | # | what | state |
|------|---|------|-------|
| 2025-01-27 | PR #17413 | pcwalton's experimental GPU two-phase occlusion culling | **MERGED** (by alice-i-cecile, 32 commits) |
| 2025-02-21 | PR #17951 | occlusion culling for directional light shadow maps | MERGED |
| 2025-04-04 | Issue #18711 | «Swap to a hi-Z buffer approach … make it non-experimental» (alice-i-cecile): the merged form is experimental «because of known precision issues with the downsampling approach when applied to non-power-of-two framebuffer sizes»; the stated follow-up is «the SPD-based hi-Z buffer shader from the Granite engine» | CLOSED as duplicate of #14062 |
| 2025-12-31 | PR #22286 | a mechanism for applications to invoke the single-pass downsampler (the Granite SPD, landed) | MERGED |
| 2026-01-20 | PR #22603 | make hierarchical Z buffer generation properly conservative | MERGED |
| 2026-01-21 | PR #22631 | **move occlusion culling out of the `experimental` namespace** | MERGED |
| 2026-01-25 | PR #22699 | fix occlusion culling | MERGED |
| 2026-03-23 | PR #23483 | storage-buffer limit check for gpu occlusion | MERGED |
| 2026-03-29 | PR #23555 | fix stale occlusion culling components | MERGED |
| — | Issue #14062 | «Occlusion culling is bugged at non-power-of-2 window sizes» | **OPEN** |

Four consequences for us:

1. **The graduation (#22631, 2026-01-21) is the strongest external
   validation our direction could get**: the two-phase HZB architecture
   Task 207 built and Task 208 seeded is now non-experimental bevy
   mainline, surviving the conservative-pyramid fix (#22603) and the
   stale-hygiene fix (#23555) that graduation demanded.
2. **#22603 names a bug class we were born without**: our reduce takes
   the max at every level unconditionally and sizes every level by
   ceil-div (no power-of-two assumption anywhere) — upstream needed a PR
   to become «properly conservative»; our pyramid never had another
   spelling.
3. **The open bug #14062 lives on OUR home turf**: non-power-of-two
   buffers are the upstream failure surface, and our HZB tile is
   480×270 — non-Po2 in both dimensions, the daily operating point since
   Task 205. #18711's body names small meshes + non-Po2 as the precision
   trap; our verdict-4 near-straddle guard and the fp32 reduce chain have
   held pixel-parity on exactly that geometry.
4. **#23555 (stale components) is the upstream twin of our seed
   staleness metering**: they fixed stale per-entity culling state
   crossing frames; our frame graph's staleness channel + the `seedActive`
   gate are the same hygiene, expressed as scheduling policy instead of
   component cleanup — convergent design under the same problem.

---

## (A) optimizing the occluder pass

Where the frame's time actually goes on our 16407-box city (the probe's own
accounting): the z-prepass fill, ~9 reduce dispatches/quads (×2 on the
feedback frame), the cull kernels (two), and — the quiet one — the
**single-thread serial compaction** on the WG leg. Ranked candidates:

### A1 — ⚓+✎ THE PARALLEL COMPACT (ballot / TileScan) — IMPLEMENT candidate #1

⚓ *Verified in 207-rb*: WGSL `subgroups` shipped in Chrome 134 (Feb 2025) —
`subgroupBallot`/`subgroupBroadcast` are expressible; b0nes164's
**GPUPrefixSums** (2025) ships WGSL/wgpu implementations of ChainScan and
TileScan that are Decoupled-Fallback-compatible; kishimisu's
webgpu-radix-sort (npm, Aug 2024) demonstrates the same compaction shape.

✎ Our WG compact is **one thread looping all 16407 records** every frame —
the stable-ascending-order law (the pixel-parity gates demand a
deterministic draw order) forced the serial spelling in Task 199, but an
**exclusive prefix scan is order-stable by construction**: a ballot-based
workgroup compaction (per-64 ballot → popc offsets → workgroup-base
atomics, or a TileScan two-phase with block offsets) produces the identical
ascending list in one dispatch. The GL leg already parallelizes (the TF
pass writes per-record verdicts; the collapse is draw-side). This is the
last serial N-loop in the frame.

**Adaptation sketch**: the compact brick in `packages/gl/src/device.ts`
(WG closure) grows a second kernel — `compactParallel` — gated on
`gpu.features.subgroups` when the facade exposes it, falling back to the
serial spelling (the honest ladder). The frame graph's pass shape doesn't
change (still one compute pass); only the kernel body does.

### A2 — ⚓+✎ FRONT-TO-BACK ORDER FOR THE COLOR PASS (early-Z harvest) — IMPLEMENT candidate #2

⚓ *Verified in 207-ra*: Pettineo's real 2025 post is **«To Early-Z or Not
To Early-Z»** (Apr 2025) — the early-Z-safe depth-only shader plus a
front-to-back submission order lets the fixed-function Hi-Z kill overdraw
in the MAIN pass; the 207 round marked it IMPLEMENT-small and it never
landed.

✎ Our cull already computes each record's `minZ` (the nearest corner) — the
compact can carry a 16-bit depth key per visible record and emit the list
**near-first** (a stable radix over the key, or even a coarse 256-bucket
bucket-sort inside the same scan kernel — buckets are already
order-stable). The color pass then rides early-Z rejection for everything
behind the front layer. On the seed frame the front layer IS the pass set
(428 records), so the win is bounded but free; on wide views (1700+) it is
the classic overdraw halver. **Pixel-parity caution**: equal-depth
collision order must stay deterministic — the stable sort preserves the
Task-199 law if the tie-break is the record index (the sort key is
(minZ-bucket, index), both stable).

**Adaptation sketch**: `compactParallel` (A1) writes `(index, key)` pairs;
one more pass sorts 256 buckets by atomic base + stable insert, OR the
radix-sort npm shape is borrowed wholesale. The color pass's list
indirection already draws whatever order the list carries — zero shader
changes.

### A3 — ✎ THE CROSS-FRAME SEED — IMPLEMENTED THIS ROUND (Task 208)

⚓ *The bevy two-phase delta* (PR #17413's cross-frame HZB seed + PR
#18711's late downsample after the depth writers — both page-read in
207-rb), adapted to our no-reprojection law: the pyramid carries as the
persistent `hiz-seed` frame-graph resource; the seeded frame drops the
K-wall z-fill and the first reduce chain entirely (two fewer passes), and
the feedback fill's pass set collapses 2767 → 428 (×6.5, up to ×36.3 at
yaw π) while the final buckets land bit-identical (the fixed-point law:
the tile only depends on its front layer). The probe's numbers on BOTH
backends: `scripts/task208-closecam.mjs` PASS.

This IS the round's answer to «как оптимизировать сложный проход» — the
warm-up died, and the machinery that remains is the survivors' depth and
the re-cull.

### A4 — ⚓ THE SINGLE-PASS PYRAMID (subgroup / shared-mem SPD) — IMPLEMENTED THIS ROUND (Task 214)

⚓ Granite's `hiz.comp` (page-read in 207-rb) builds the whole max-pyramid
in one dispatch via workgroup shared memory; the Chrome-134 subgroup
feature makes the cross-warp reduce expressible. **⚓ FRESH (2026-09-14):
bevy shipped this exact thing** — PR #22286 (merged 2025-12-31) lands the
invokable single-pass downsampler, and issue #18711's body names the
motivation outright («switch to the SPD-based hi-Z buffer shader from the
Granite engine» over the non-Po2 precision issues). The port now has a
**WGSL/wgpu reference implementation in the bevy tree** — no GLSL→WGSL
translation guesswork left. Kills 8 of 9 reduce dispatches = 8 fewer
frame-graph sync points on the WG leg. **Verdict**: BACKLOG with the
subgroup feature-gate + the shared-mem fallback (the 207-rb conclusion
stands, now with a stronger port source); our tile is 480×270 — the 9
dispatches are tiny, the win is sync-point hygiene more than milliseconds.

### A5 — ✎ DIRTY-REGION HZB REDUCE — REJECT (at this tile size)

Only reduce the regions the fill actually wrote (the fill's screen-space
bounds). Honest math: the feedback fill covers most of the screen at the
report's cameras (the survivors ARE the front layer), so the dirty rect ≈
the whole tile; the bookkeeping (per-level dirty rects + guarded reduces)
costs more than 9 tiny dispatches on a 480×270 tile. **Revisit at 4K-class
tiles** where the reduce chain is 12+ levels over 2M texels.

### A6 — ✎ DEPTH REUSE FROM THE PRESENTED FRAME — IMPLEMENTED THIS ROUND (Task 215)

Build the seed from the color pass's own depth buffer (render depth into a
samplable depth texture on the main pass, late-downsample it) — saves the
feedback fill when the camera is still. Web-portability catch: the canvas
depth attachment is not resolvable/samplable portably; it needs a dedicated
depth texture bound as the color pass's depth target. A real option when
the surface grows; today the feedback fill (428 instances, depth-only) is
already cheap.

### A7 — ⚓ ASYNC COMPUTE OVERLAP — BACKLOG (backend-gated)

The frame graph's 3-lane overlap plan already models cull-on-compute beside
render-on-graphics; a single WebGPU queue executes in submission order and
WebGL2 is one lane by definition. The plan is the submission script for the
day a backend gives queues — no action available now.

### A8 — ✎ HARDWARE OCCLUSION QUERIES — REJECT

Absent from both WebGPU and WebGL2 core. The HZB software form is the
portable answer (and the reason this demo exists).

### A9 — ⚓ PER-VIEW CULLING (the light's frustum) — BACKLOG (new this harvest)

⚓ FRESH (2026-09-14): bevy PR #17951 (pcwalton, merged 2025-02-21)
implements occlusion culling **for directional light shadow maps** — the
same two-phase machinery run against the light's view-projection, culling
the shadow pass itself.

✎ Our demo's «shadows-off law» currently inverts the problem: when the
shadow pass runs, culling is gated out of it entirely. The frame graph
already runs verdict passes per phase-set and already owns the pyramid
bricks — a second `cull-verdicts` against a light-frustum pyramid is the
same brick with a different view-projection, and the frame graph would
carry it as a parallel branch (the version-law showcase extends, not
changes). The catch is honest: the light's «screen» is the shadow map,
so the HZB tile, the near-straddle guard, and the feedback fill all need
per-view instances — a real round, not a patch. **Verdict**: BACKLOG with
a named trigger (a shadow-mapping demo whose shadow pass shows up in the
frame budget).

---

## (B) occlusion with arbitrary non-square geometry

The load-bearing analysis first (✎, first-principles, and it lands better
than any single paper):

### B1 — ✎ THE KERNEL IS ALREADY A CONVEX-HULL TEST IN DISGUISE — IMPLEMENT

The cull kernel projects 8 corners and takes (rect, minZ). Two facts make
this the general test for ANY convex bound, not just AABBs:

1. **View-space depth is a linear function of the world position** — over a
   convex polyhedron a linear function's extremum sits at a vertex.
2. **NDC z is a monotone (Möbius) function of view depth** on the valid
   range — the pole sits behind the eye, and the near-straddle escape
   (verdict 4) already handles corners there.

Together: the minimum NDC z over a convex hull is attained AT A HULL
VERTEX, and the projected footprint of a convex polyhedron is the convex
hull of its projected vertices — so «project every vertex, take the
bounding rect + the min z» is the EXACT conservative footprint/depth test
for any convex query bound. Non-convex meshes: their convex hull is the
conservative superset (sound, looser). **The generalization is a record
layout + a corner loop, not new math**: records grow a vertex region (or an
OBB rotation field — 8 rotated corners feed the same loop), the kernel
loops `k < vertexCount` instead of `k < 8`, and both backends' shader
columns change shape-identically. Spheres: their world AABB (trivial, no
shader change).

**Adaptation sketch (the natural Task 209)**: `scene.js` records grow
`[cx,cy,cz, vertexCount, verts…]` or an OBB quaternion; `shaders.js`'s
CORE_WGSL/GLSL corner loop becomes data-driven over the count (a uniform
cap — 8 for boxes, 16–24 for hulls); the frustum plane counters and the
near-straddle guard already work per-corner. The pixel-parity gates
re-prove soundness on the mixed scene (boxes + a few rotated boxes +
hull-bound objects). Expected tightening: an OBB test on a diagonally
rotated long object shrinks the rect ~sin/cos of the rotation — the
classic «the AABB of a rotated beam is 2× too big» fix.

### B2 — ✎ ARBITRARY MESHES AS OCCLUDERS — ALREADY SUPPORTED (document it)

The depthPass brick draws whatever mesh the geometry handle carries —
nothing in the prepass is box-specific. The soundness law is «the query
bound must ⊇ the rendered occluder geometry»: a convex query (any hull,
per B1) over an arbitrary rendered mesh is sound because the min over a
superset under-estimates the nearest depth — the test never over-claims.
Mixed scenes (box queries + arbitrary occluder meshes, or arbitrary-mesh
queries over arbitrary occluders) work with ZERO kernel changes today; the
demo just never showed it. A follow-up demo variant (a rotated-box city +
a triangulated statue as the occluder) would prove it live.

### B3 — ⚓ MESHLET NORMAL-CONE PRETEST — BACKLOG

The GPU-mesh-pipeline lineage (vendor-free compute forms; the 205 round
already carries the cone idea in the CPU kit): per-meshlet backface-cone
rejection BEFORE the HZB test cuts pyramid traffic on dense triangle
meshes. Expressible as a plain compute kernel (no mesh shaders needed for
the TEST — only for the draw, which the web lacks anyway). **Verdict**:
BACKLOG — needs meshlet content to matter; our boxes are their own cones.

### B4 — ⚓ OCCLUDER SIMPLIFICATION / LOD PROXIES (Bartz et al., the classic) — BACKLOG

The classic line (Bartz–Klosowski–Staneker, 1998–2001; Durand's
visibility taxonomy): replace dense occluder meshes with simplified convex
proxies in the depth-only pass. Sound by the same superset law (B2). On
the web the practical form is a content-pipeline concern (an occluder LOD
mesh authored or auto-simplified), not a runtime one. **Verdict**: BACKLOG
— our K walls ARE the simplified proxies.

### B5 — ⚓ KOLTUN'S VIRTUAL OCCLUDERS + ESSAFI'S FUSION — REJECT (for this profile)

⚓ The classics: precomputed fused occluders at portals (Koltun 2000/01),
runtime occluder merging (Essafi 2001). ✎ Our profile is an open city, not
a portal graph — and the two-pass HZB's feedback fill IS runtime screen-
space fusion (the Task-207/208 evidence: the survivors' fill carries the
brute whole-scene fill's exact power). The goal is implemented; the
mechanism is different and cheaper. Indoor/portal scenes would reopen
Koltun — noted, not pursued.

### B6 — ✎ ALPHA-TESTED VEGETATION CARDS — BACKLOG (recipe documented)

Two-pass depth for foliage: a depth-only prepass variant sampling the alpha
mask (`discard` on fail, depth-write on pass) — the card quad is the
conservative bound and the test is sound; the classic pattern. The LAYER
policy already fixes participation (glass never writes depth, ghosts stay
outside the cull). Needs textured content; the brick change is a
`depthPass` shader variant with the mask texture bound.

### B7 — ✎ SKINNED / MOVING GEOMETRY — BACKLOG (recipe documented)

Per-frame conservative bounds: a compute kernel over the posed vertices
(atomic-free axis min/max by reduction) rewrites the record's bound before
the cull — the scene record layout already supports per-frame records
(`recordsF32`). The sound law: the bound must be conservative for the
CURRENT pose — recompute every frame, never cache across poses. The
history/feedback bricks' no-reprojection law already forbids the stale-
geometry trap on the occluder side.

---

## the round's verdict table

| # | candidate | verdict |
|---|-----------|---------|
| A1 | parallel compact (ballot / TileScan, stable) | **IMPLEMENTED — Task 209** (the Hillis-Steele single-workgroup spelling, not ballot: no feature gate needed) |
| A2 | front-to-back color order (early-Z harvest) | **IMPLEMENTED — Task 209** (the depth-bucket bitonic; GL keeps index order — no list) |
| A3 | cross-frame seed (bevy delta) | **IMPLEMENTED — Task 208, this round** |
| A4 | single-pass pyramid (subgroup SPD) | BACKLOG, strengthened (bevy #22286 shipped it; WGSL port source now exists) |
| A5 | dirty-rect HZB reduce | REJECT at 480×270 (revisit at 4K tiles) |
| A6 | depth reuse from the presented frame | BACKLOG |
| A7 | async compute overlap | BACKLOG (backend-gated; the plan exists) |
| A8 | hardware occlusion queries | REJECT (absent on the web) |
| A9 | per-view culling (the light's frustum) | BACKLOG (⚓ bevy #17951; trigger: a shadow pass in the frame budget) |
| B1 | convex-hull / OBB queries in the kernel | **IMPLEMENT** (Task 209 candidate — the layout + loop) |
| B2 | arbitrary meshes as occluders | already supported (document; demo variant) |
| B3 | meshlet normal-cone pretest | BACKLOG (needs meshlet content) |
| B4 | occluder simplification proxies | BACKLOG (content pipeline) |
| B5 | virtual occluders / runtime fusion | REJECT (the feedback fill implements the goal) |
| B6 | alpha-tested cards as occluders | BACKLOG (recipe in this doc) |
| B7 | skinned conservative bounds | BACKLOG (recipe in this doc) |

**The fresh-sweep postscript**: the harvest landed on 2026-09-14 by the
direct-HTTP road (the section above tells the how); the ⚓ anchors are
page-verified — 205–207 for the old set, TODAY for the bevy timeline — and
the ✎ entries are first-principles analysis against our own measured
numbers. One attribution correction the harvest surfaced:
`demo/occlusion/tier.js` calls #18711 a «PR» in two comment lines — it is
an ISSUE (the hi-Z/SPD graduation tracker, closed as a duplicate of
#14062); the late-downsample position itself is #17413's implementation,
which #18711's thread tracks for the downsampler swap. The two comment
lines ride the next code-touching round's version bump (a comment-only
edit would leave `?v=208`-cached copies stale for nothing).

**Pettineo check (RSS, 2026-09-14)**: the newest post remains «Ten Years
of D3D12» (Sep 7, 2025); «To Early-Z, or Not To Early-Z» (Apr 2025) is
still his latest occlusion-relevant word — A2's anchor is current.

## Task 210 — the array round (2026-09-14): the measured CPU laws

The user's ask: array speed during scene manipulation and occlusion —
reading, writing, copying, resizing — at the JS, V8 and wasm level. The
instrument: `scripts/task210-core.js` (a plain classic script so the exact
same source runs everywhere), **105 variants across 13 groups**, every one
checksum-gated against its group's truth variant, a **hand-emitted wasm
binary** (no toolchain: memcpy/memfill bulk ops, u32/u64 loops, the masked
extract, the compact, a 2×2 f32/f64 pyramid reduce, a 64-byte record copy)
racing the JS lanes on the SAME shapes, driven by
`scripts/task210-arrays.mjs` over **three runtimes**: node 24 (V8), bun
1.3 (JSC), headless Chromium 151 (the browser V8). Discipline: 3 warmups,
measure-many calibration, 3 rounds × 4 samples, min + median reported.
The full table: `scripts/out/task210/results.json` (gitignored — the
scripts regenerate it); the headline laws:

**The engine-relevant winners (integrated)**

- **G — the pyramid reduce**: the flat `t`-loop paid `t % wo.w` and
  `(t / wo.w) | 0` per texel — two integer divisions the JIT cannot hoist.
  Nested y/x with hoisted row pointers and lifted clamp bounds:
  **1.37× (node) / 1.5× (bun) / 1.26× (Chromium)** over the real
  480×270 chain, bit-identical mips (proven by `task210-parity.mjs` on
  five chains incl. odd tails). LANDED in `softwareOccluder.reduce()`.
- **writeBox's face quads are constants**: the per-box `faceAlong` closure
  allocated a fresh `ids[]` and walked 8 corners × 3 faces on EVERY box —
  replaced by a 6-entry `FACE_QUADS` table computed at module load. The
  no-allocations-in-hot-loops law, applied. LANDED.

**The confirmed laws (the engine already lives by them — now measured)**

- **E — sparse compaction**: a **pre-packed bitset word-walk (the
  `instances.ts` shape) beats the plain-array push 15–22×** (0.80µs vs
  12.3µs @ 16407, ~0.4% survivors) and beats the typed-counter sweep 12×.
  The two-pass count-then-scatter loses (the count buys an exact-size
  alloc, not speed). The demo's JS oracle keeps plain_push by contract —
  it is validation-only, and the E numbers say the ENGINE's bitset
  walk is the right production shape.
- **H — SoA vs objects**: reading `{cx,cy,cz}` off an object array is
  **2× (Chromium) / 2.8× (bun) / 8× (node)** slower than SoA Float32
  lanes; AoS f64 is the runner-up. The kit's `recordView` (SoA over the
  scene's own buffer) is the right front door; `spatialBoxes` (objects)
  stays a one-time build input.
- **J — elements kinds**: `Int32Array` reads beat even PACKED_SMI plain
  arrays (1.6× node), HOLEY costs 3.4× (and `new Array(n)` + writes =
  HOLEY). Typed arrays are not just for buffers — they are the fastest
  integer lane V8 has.
- **A/B — copies and fills**: `set()` / `copyWithin()` / wasm
  `memory.copy` / `memory.fill` all saturate at memcpy/memset class
  (48 GB/s @ 64KB, ~20–27 GB/s @ 1MB); JS element loops are 3–5× off;
  plain-array copies 10–50× off; `Array.from(typed)` ~100× off;
  **BigInt64Array is 64× poison under JSC** (5.4ms vs 85µs node for 1MB).
  `alloc_zeroed` at 1MB runs at **328 GB/s** — zero pages are mmap-free;
  never fill-zero what a fresh allocation gives you.
- **F — sorting**: typed `.sort()` WITHOUT a comparator keeps its crown;
  any comparator costs 4.4×; LSD radix wins at scale (**1.8× over sort()
  @ 16407**, the 2×16-bit pass beats 4×8 there, flips at 2048).
- **K — views**: `subarray` is 31ns, `new Uint32Array(ab, off, n)` 17–45ns
  — view creation is FREE; `slice()` pays the copy (9.5µs @ 16407 words).

**The cross-engine splits (the honest footnotes)**

- **C2 — the growth ladder**: a resizable ArrayBuffer's `resize()` ladder
  (4KB→1MB) is **43× faster than new+set on V8** (6µs vs 258µs — the
  in-place VA remap) and ~100× on Chromium — but **LOSES on JSC** (390µs
  vs 265µs: JavaScriptCore copies on resize). A V8-targeting hot path may
  grow in place; a portable one keeps new+set.
- **C — growth with traffic**: when the writes dominate (the real growth
  pattern), the policy is noise — new+set ×2, ×1.5, transfer, RAB and
  wasm-Memory.grow all land within ±15%; `exact_realloc_every_append` is
  the 1000× strawman the textbooks promise it to be.
- **D — the masked extract (readVerdicts' shape)**: the plain `& 255` loop
  is within noise of wasm at N=16407 (7.5µs vs 7.0µs) — the incumbent
  SURVIVES the challenge; wasm's unroll4 wins only at 4×N (1.5×).
  DataView is 18× poison under JSC. Manual unrolls LOSE on V8 here
  (the mixed u32-load/u8-store lane defeats BCE) — the engines grew
  opinions, measure before unrolling.
- **I — the 16-float record copy**: the segment `set()` fast path is the
  floor (5µs); the wasm 64-byte record copy beats the JS bitset-walk +
  unroll16 **9.4× on node** but only 1.4× on bun — and the REAL
  `instances.ts` walk (the `lb = word & -word` + clz32 shape, not the
  naive per-bit test the bench also ran) is already the E-group winner.

**The meta-law (paid for in debugging hours, twice)**: a browser tab
coarsens `performance.now()` to 100µs without cross-origin isolation —
timing ONE fast call reads exactly zero, and a naive `target/dt`
calibration explodes to its iteration cap (our "3ms" samples became
15–75 SECONDS of wall time). Measure-MANY calibration (run the op until
the clock moves, then divide) is the only robust shape — the Task-193
clock lesson, one level deeper.

---

## Task 211 — THE UNIFIED DATA SURFACE (the array laws, applied as a system)

Task 210 measured the laws; 211 is «применяй» — the laws as ONE reusable
system, not one-off patches. `packages/core/src/store.ts`:

- **The SoA store** — schema-driven columns over ONE backing buffer
  (`createStore`), or the ADOPTION of an existing buffer
  (`adoptStore` — `buildSceneViews` generalized: the occlusion demo's
  `[list|flags|hist|records]` scene words become a store over the
  records region without moving a byte; fixed-capacity by contract,
  the buffer's layout belongs to its owner).
- **The measured growth ladder** — RAB's in-place VA remap where the
  runtime wins, the copy twin elsewhere; `'auto'` MEASURES once per
  process (a 4KB→4MB ×2 ladder, both lanes, measure-many timed —
  RAB needs a 1.5× margin or the copy lane keeps the crown). The
  Task-210 split (V8 remaps, JSC copies) became a runtime probe, not
  an assumption. Shared stores grow in place (growable SAB) or refuse
  — a reallocated SAB strands every other thread's views.
- **MarkSet** — the bitset companion with BOTH iteration lanes public
  (the ctz word-walk and the dense rank scan) and the density-picked
  `forEach` at the 12.5% crossover: the lane changes, the ANSWER never
  does (the equivalence gate runs at eight densities).
- **Packed u32 keys** — `packKey(hi, lo, loBits)`: Task-209's verdict
  words and 210's group-F sort keys generalized; `keys.sort()` with no
  comparator is the crown (a comparator costs 4.4×).
- **The dirty-range surface** — record bits → coalesced, 4-aligned,
  buffer-relative byte ranges (`takeUploadRanges`, MERGE_GAP=8): the
  GPU contract both backends eat directly — WG
  `queue.writeBuffer(dst, start, buffer, start, size)` (the 5-arg
  ArrayBuffer form), GL `gl.bufferSubData(target, start, view)`. The
  dirty bits SURVIVE growth (the pending upload is never lost).

**The device brick** — `SceneHandle.updateRecords(ranges)` on BOTH
backends (packages/gl device.ts): WG one `writeExternalBuffer` per
range over the words' own bytes; GL one `bufferSubData` per range into
the records buffer (translated from words-coords; a contents-only
upload leaves the vertex-bind memo valid by its own contract). Plus
`readRecords` — the record mirror's readback (the edit-mode gate's
channel: the GPU's own copy, compared against the store's bytes).

**The demo, live** — the Scene edit mode: 48 drones rewrite their
centers through the adopted store's column view every frame; the
octree/BVH update on the same ids (the pick ray hits a MOVED box); the
tier pushes ONLY the dirty ranges — **2304 B over 48 ranges against
the 961 KB whole-buffer write, a 427× cut** (the HUD's upload line).

**The store's own bench** (`packages/core/bench/store211.bench.ts`,
bun + node, checksum-gated):

| lane | bun (JSC) | node (V8) |
|---|---|---|
| read sweep: store view vs object array | 1.02–1.14× | **2.74×** |
| edit sweep: write+markDirty vs object write | 1.1× (wins) | 1.33× |
| takeUploadRanges (64 scattered) | 3.1 µs | 3.8 µs |
| growth ladder: rab vs copy | 1.4× | 1.66× |
| sparse walk: MarkSet vs filter+push (2%) | **18.9×** | 1.3–3.3× |
| dense delete: swapRemove vs splice | **11.4×** | **15.3×** |
| bulk copy: copyRecords vs element loop | **8.7×** | **33.5×** |

The honest footnotes: the object-array read gap is a V8 law (JSC
optimizes monomorphic shapes to parity — the 210 H-group split,
reproduced on the store's own surface); the store's column view rides
the raw-flat control lane exactly (the adoption costs nothing); the
sparse-walk ratio follows the baseline's speed (the walk itself is
2–10 µs everywhere — the array-filter twin is what the runtime decides
to cost).

**The gate's own lessons (the debugging hours, paid again)**:

- **The rAF wall-clock law**: a headless SwiftShader stack runs the
  loop at 2.6–9.7 fps — a frame-index animation phase crawls ~23×
  slower than wall-clock and the drones never visibly move. The tick
  takes the rAF timestamp (`t/1000`): the drones fly REAL seconds on
  ANY frame rate.
- **The readback pause discipline (one layer past Task-209's)**: every
  GPU readback — records, verdicts, stats, the surface — races the
  live submits and kills the SwiftShader renderer. Pause → read →
  resume, on every probe.
- **The GL live canvas vs the surface FBO**: the GL leg's color pass
  draws the CANVAS; the surface's FBO is the validation target —
  nothing live writes it. A "pixels move" probe must read the canvas
  (screenshot) on GL, the surface on WG (snapshot mode) — and the WG
  snapshot's 2D-canvas stretch is raster-nondeterministic between
  screenshots, so WG hashes the SURFACE (the parity gates' own probe).
- **The verdict flip is the decisive proof**: the record-mirror compare
  says the bytes landed; the TELEPORT probe (a visible record moved
  through the store, behind the frustum, verdict 1 → 2) proves the
  CULL reads them — end to end, on both backends.

## Task 212 — THE OVERRIDE LANE (the dynamic-index leak, the third field report)

The report: «Scene edit сразу взвинчивает мс на кадр, увеличивая лаги в
разы. Со временем мс увеличивается.» The store's upload path was already
KBs (Task 211); the leak sat in the DYNAMIC INDEXES the edit mode feeds.

**The diagnosis** (measured, `scripts/task212-leak.mjs` — the report
reproduced headless against the real scene and the real indexes):
`update()` was `remove(id) + insert(newBounds)`, and:

- the octree's `remove` only TOMBSTONES — the tree shape is never torn
  down mid-query — so every intermediate object stayed in the leaves
  FOREVER: 48 drones at 60 fps grew the tree **55 828 → 3.3M nodes in
  one second**, and every walk pays for all of it;
- the BVH's `insert` appends to the linear overflow (the
  amortized-rebuild pattern), so the overflow grew **48 objects a
  frame**, and `rebuild()` — every 180 frames — folded `items + the
  whole overflow` into the layout, BAKING every stale intermediate in:
  the layout grew +8 640 entries per fold cycle, forever, and each fold
  cost more than the last (~25 ms and climbing);
- `bvh.live` lied upward through the old arithmetic
  (`buildCount + overflow − removed` counted the intermediates).

Two compounding symptoms, exactly the report's two sentences: the
~25 ms fold spike on a ~16.7 ms frame is «лаги в разы» at once, and the
never-shrinking structures + growing fold + GC pressure are «со временем
увеличивается».

**The fix — THE OVERRIDE LANE** (`packages/core/src/spatial.ts`):

- `byId`, a small id→box Map, is the LIVE-SET AUTHORITY (the freshest
  bounds per live id); `moved`, the ids the LANE owns. `update()` on a
  live id is O(1): `byId.set` + `moved.set`, nothing else. The tree's
  own stale copy is skipped by id (`indexed()`), and every walk reads
  the lane AFTER the tree with the same per-item predicate (the stamp
  mask dedups the id exactly like a straddler's several leaves).
- The lane is BOUNDED by the distinct-mover count, not the update
  count: 48 drones ride a 48-entry lane forever. `stats.lane` exposes
  it; `live` rides `byId.size` (both structures — the octree's manual
  counter also lied on the remove→re-insert round-trip).
- THE FOLD (`rebuild()`, now on BOTH structures) rebuilds over byId's
  freshest objects: the lane empties into the tree, the tombstone Set
  clears (the fresh tree holds only byId ids — the Set can never grow
  unbounded across a long edit session), the loose bounds re-tighten.
  The DEMO folds on a LANE BUDGET (256), never a blind cadence —
  the lane's linear per-query scan is the only cost driver, and at 48
  the fold buys nothing (the old 180-frame timer billed ~25 ms every
  3 s for nothing).
- **A latent BVH bug killed by the same lane**: a re-insert of a
  tombstoned id used to push a SECOND copy into the overflow while the
  tombstone's clearing revived the stale layout copy — DUPLICATE
  answers (the BVH has no stamp mask). ANY re-insert of a known id
  (tombstoned or live) now rides the lane: the stale copy is skipped
  by id, exactly one answer, from the freshest bounds.
- **The live-set law, measured** (the 60 s leak run): octree nodes
  55 828 → 55 828 (1.00×), the lane 48/48 flat, both live counts
  honest (Δ0), zero duplicate answers, zero stale-geometry ghosts,
  octree ≡ BVH ≡ brute force at every mark, tick 25.2 → 8.1 µs
  (0.32× — it falls as JIT warms, it no longer climbs), zero folds
  fired; the explicit fold probe: answers IDENTICAL, lanes empty,
  re-arm clean, a moved box found at its NEW position and rejected at
  the stale one.

**The regression tests** (`packages/core/tests/spatial.test.ts`, 5 new):
the leak law (48 movers × 1 200 updates grow NOTHING — nodes, lane,
live), the freshest-bounds law (every query family tracks a teleported
box OUTSIDE the boot root bounds), the remove→re-insert round-trip (one
answer per id, honest live, the live-re-insert twin), the fold
(identical answers, empty lane, re-arm), and the drone cadence against
the brute truth (every 40th frame, boot node count at the end).

**The local gates** (`scripts/task212-local.mjs`, both backends — the
living page, a 20-second wall-clock flight): the lane pinned at 48/48,
node counts NEVER move, live counts honest, msAvg flat (WG 0.91, GL
1.06 — BEFORE the fix this climbed without bound), the upload math
alive throughout, the fold probe through the page's own channel
(`__hizEdits.fold()` — lanes 0/0, re-armed 48/48, the re-split tree
stable), zero errors. Gate lessons riding the round: the fold and the
lane read must share ONE JS task (a rAF interleaves otherwise and
re-arms the lane before the read), and msAvg's EMA EXCLUDES frames
slower than 250 ms — on a slow boot it converges FROM BELOW, so the
flatness law compares the end against the MAX of the first two samples
(a from-below climb is convergence, never a leak).

## Task 213 — THE KIT'S OWN SoA ROUND (the records front door, bit-identical)

The Task-211 promise was «the store feeds everything»; the spatial kit
was the last consumer still eating OBJECTS — `buildOctree(SpatialBox[])`
boxed the demo's 16 407 records into 16 407 heap objects before the
first query, and every drone edit allocated a fresh box per drone per
frame on top of the store's dirty bookkeeping. The Task-210 H-group had
already measured the shape's tax: an object-array walk of the six AABB
fields runs 2.5–8× behind the flat record words on V8 (JSC holds
1.0–1.2× on monomorphic reads — the honest split). This round moved the
kit's STORAGE onto the flat lane and made the store's own shape the
kit's front door.

**The storage** (`packages/core/src/spatial.ts`, both structures): ONE
interleaved `Float64Array` of `[cx, cy, cz, hx, hy, hz]` rows (48 B —
one cache line per box; the Task-210 column measured `aos_f64` winning
JSC outright and within 13% of the parallel split on V8 — the
cross-engine compromise) + ONE `Int32Array` of ids. Every leaf, layout
cell, overflow slot and override-lane entry holds a ROW INDEX; every
predicate reads the six doubles at `row * 6`. The byId authority of
Task 212 became rowOf (id → row); the GEOMETRY is always the freshest
write (`updateBox` overwrites the row in place — the lane exists for
the tree's stale PLACEMENT, never for stale data: there is exactly one
copy of every box's numbers in the kit). The fold compacts the columns
to the live rows in place (the strictly-increasing first-touch row
order makes the sweep safe — no row is clobbered before it is read)
and the fresh tree builds over the identity.

**The front doors**: `buildOctreeRecords(view)` / `buildBVHRecords(view)`
take the strided `RecordView` every other kit brick already speaks —
zero boxing, zero copies, f32 words landing in the f64 columns exactly
(every f32 is an f64; the trees read the GPU kernel's own numbers).
The object door stays open as a compat shim (it writes one row); the
SCALAR twins `insertBox`/`updateBox` take six numbers — the store-
driven edit loop now touches zero objects per frame. The id contract
fails loud at the door (fractional/negative/≥2³¹ ids throw — the stamp
array is indexed by id and used to corrupt silently).

**The allocation kills riding the rewrite**: `octantsOf`'s fresh
`boolean[8]` per item per split became a bit mask; the sphere walks'
six-field `NodeBounds` literal per item became the inlined arithmetic
on the row (the last per-item allocation in the walks); the octree's
`queryRay` moved onto Task-205's numeric slab lane (the `[t0, t1]`
tuple per node is gone — the BVH had ridden it since 205); the BVH's
median split sorts ROW INDICES reading the center column (the
comparator values are `centerAlong`'s own, the stable sort keeps the
equal-key order — the permutation is the object path's exactly).

**The proof** (`packages/core/tests/task213.test.ts`, 8 tests): the
records-built trees must answer with the EXACT arrays of their object-
built twins — order included (the storage permutation may never
permute a walk), plus the stats and the instrumented `planeTests`
counters; the strided read is surgical (a POISONED NaN-padded record
region — a builder reading one word off answers NaN geometry and every
gate fails loudly); the scalar twins stay interchangeable with the
object twins across a 400-step mixed churn; the leak law holds through
the SCALAR lane (48 movers × 1 200 `updateBox` grow nothing, the fold
empties, the freshest-geometry verdicts match brute); the fold compacts
(removes shrink the tree, the post-fold structure answers identically
to a fresh object build over the same live set); the id guard throws.

**The measured A/B** (`packages/core/bench/spatial213.bench.ts`, the
public API only — the same file runs against the pre-rewrite kit, the
records legs skipping themselves; the demo's own city at N=16 407, both
runtimes, checksum-gated):

| lane | bun (JSC) | node (V8) |
|---|---|---|
| octree battery (48f+96p+48s+48r+48c) | 320.9 → 195–229 ms | 271.3 → 252–287 ms |
| **bvh battery** | **30.3 → 17.6–18.9 ms** | **45.8 → 28.5–28.7 ms** |
| octree boot | 34.2 → 22.3–22.8 ms | 42.5 → 20.8 ms |
| bvh boot | 26.7 → 28.6–29.5 ms (+9%) | 34.8 → 32.1 ms |
| the fold (octree) | 28.5 → 19.1–19.8 ms | 38.3 → 20.5 ms |
| the fold (bvh) | 25.0 → 26.6–27.2 ms | 32.3 → 29.5 ms |
| churn updateBox vs update(box) | 5.0 → 4.4 ms | 4.3 → 3.7 ms |

The BVH battery is the headline: **−37% (JSC) / −41% (V8)** — the
tight leaf ranges now walk a contiguous f64 column instead of pointer-
chasing object fields. The octree battery improves 14–29% on JSC and
7% on V8 (the straddler duplication keeps its leaf lists jumpier).
The honest costs, kept: the BVH BOOT pays +9% on JSC (the index sort's
comparator reads the column through an indirection the object sort did
not pay; V8 lands −7% anyway), and the octree boot on V8 sits within
noise on the worst runs. The oracle walk (the validation gate's own
sweep) reads the flat words 1.1× (JSC) to 2.6× (V8) faster than the
object array it replaced.

**The demo**: the trees are built by `buildOctreeRecords(view)` /
`buildBVHRecords(view)` over the SAME `recordView` the kit bricks read
(the `spatialBoxes` array of 16 407 objects is GONE — the boot stops
boxing the city), the drone squad edits through `updateBox` (zero
objects per frame), and the validation gate's brute oracle walks the
flat record words (an oracle must not lean on a second copy of the
city). The Task-212 laws ride through unchanged — the leak gate re-run
on the new kit: nodes 55 828 → 55 828 (1.00×), lane 48/48 flat, zero
duplicates, zero ghosts, octree ≡ BVH ≡ brute at every mark, the fold
probe clean; task209-order PASS on BOTH legs (the numbers bit-equal
209); task211-local PASS on BOTH legs (the record mirror, the teleport
probe, the 427× upload math — the SoA kit changes the kit's storage,
never the frame's policy).

## Task 214 — THE TWO-DISPATCH DOWNSAMPLER + THE SCENE STORE MIRROR (2026-09-15)

**Leg 1 — the single-pass pyramid** (`packages/gl/src/device.ts`, WG
path): the Task-196 chain spent TEN dispatches per frame on the Hi-Z
build — `zToMip0` + nine sequential `reduceL`s, each one a frame-graph
sync point between the z-pass and the cull. The A4 harvest (FidelityFX
SPD v2.1, the shape bevy landed as #22286's `downsample_depth.wesl`)
collapses them to TWO: the **region pass** — one 256-thread workgroup
per 64×64 mip0 tile; each thread computes 4 clamped 2×2 maxes (and
stores its region's own mip0 words), building mip1's 32×32; a
16×16 shared-memory cascade then folds mip2..mip5 plus the region's
1×1 top at level 6; and the **top pass** — ONE workgroup (64 threads)
reducing the region-top grid into the last levels (read | barrier |
write | barrier per level — the counts strictly descend, the in-place
prefix overwrite is race-free). bevy's own TODO says «True single
pass»; the two-dispatch form IS the landed upstream shape, and ours
keeps the #22603 law (no Po2 assumption — the ceil-halved dims, every
store bounds-checked, the clamps resolve inside the region).

**The bit-identity proof, executable.** Nested ceilings collapse
(`dims[6]` IS the region grid ⌈w/64⌉×⌈h/64⌉); every cascade value is a
max over a sub-rectangle of the workgroup's region; the stored texels'
sub-rectangles union to exactly the sequential chain's clamped windows;
and the phantom (never-stored) values are maxes of sub-rectangles —
≤ the true value wherever they fold in at the L6 top. The gate is not
an argument, it is a dispatch: `PyramidHandle` grew `buildLegacy()`
(the old chain, lazy pipelines — free until dispatched) and
`readWords()` (the whole storage, flat), and the demo's `spdParity()`
dispatches BOTH spellings over the same z tile and compares every
storage word: **0 diffs of 172 902 words, 2 vs 10 dispatches** (the
local gate, WG leg; the GL leg's FBO pyramid is that backend's own
mechanism, untouched — `spdParity()` returns null by contract).

**Two gate traps this round taught** (both now part of the parity
channel's discipline): (a) a STATIC camera lets under-budgeted phases
inherit the previous complete build's values — the holes hide from a
naive compare; the cure is poison (pre-fill the storage with NaN
through `writeExternalBuffer`, so any unwritten word answers NaN
loudly); (b) the readback raced the queue — `readExternalBuffer`
submits only its own copy-encoder while the build dispatches stayed in
the merged compute pass, so the read landed BEFORE the writes; the cure
is a `device.submit()` before the readback. The parity channel in the
shipped demo carries both.

**Leg 2 — @rune/scene's mirror/publish ON THE STORE**
(`packages/scene/src/storeMirror.ts`): the Task-211 unified data
surface had exactly one native consumer — the occlusion demo's own
records region. This leg generalizes it into the scene package proper:
the scene's SAB regions become **adopted SoAStores — zero copies** (the
views alias the very bytes the worker reads and writes; `adoptStore`
grew the `regionBytes` bound so a slice adoption of a region inside a
larger buffer does not derive its capacity from the neighbor's bytes).
The dirty-range surface now speaks BOTH directions: **publish**
(`staticRanges(watermark)` — the exact slots whose locals changed,
coalesced, 4-aligned; fresh sees nothing, the dead stay silent) and
**mirror** (`ranges(epoch, camera, watermark)` — Task-85's own
groupTouch/groupFlip stamps expressed as upload ranges over the
double-buffered instance-pool rows; `worldRanges(watermark,
layoutEpoch)` resolves worldStamp through `order[]` in RANK space —
valid until the next pack, the same contract `worldMatrix(slot)`
carries — and a layout-epoch change means the FULL region, never a
skipped one). ONE watermark domain (H_CLOCK) serves every side: hold 0
at boot, capture at the fresh take (the worker sleeps until the next
publish — the window is safe by the bridge's own protocol), HOLD the
old watermark on a stale take (re-uploading a frozen row is always
sound; skipping never is). The bridge wrapper `take()` applies the
discipline itself. Zero steady-state allocations: the stores and their
MarkSets are created once and owned forever.

The five contract tests (`packages/scene/tests/task214.test.ts`):
adoption aliasing (the store IS the Scene API's bytes), the pool
store's segment views + the stamp law, staticRanges' three-way verdict
(changed / fresh / dead), worldRanges' rank-space dirt + the
layout-epoch conservatism, and the bridge wrapper's watermark
discipline (fresh captures, stale holds).

**Gates**: 2188/2188 tests, tsc 0, lint 0 errors (368 warnings — the
baseline), task214-local ALL PASS (WG: parity 0/172 902, dispatches
2 vs 10, the loop alive after the gate's readbacks, zero errors; GL:
the null contract, the loop alive, zero errors), and every standing
gate re-run green on the new code: task209-order PASS both legs (the
numbers bit-equal 209), task212-leak PASS (nodes 55 828 → 55 828,
lane 48/48, fold clean), task211-local PASS both legs, demo-smoke full
PASS (WG drawn 4353 / GL drawn 1694 — the same verdicts as the
object-built kit).

## Task 215 — THE DEPTH-REUSE HARVEST + THE SCENE-MIRROR DEMO (2026-09-15)

**Leg 1 — research A6, the presented frame's own depth as the pyramid's
author** (the occlusion demo, both backends). The recipe's portability
catch was the whole job: the color pass must render with a DEDICATED
samplable depth texture as its attachment (WG: a depth32float texture
with TEXTURE_BINDING — the facade's `createTarget` grew `depthTextureId`,
the caller's own texture replacing the internal depth24plus; GL: a
DEPTH_COMPONENT32F texture attached where the renderbuffer was — the
format catalog grew `'depth32f'`). On it ride three structural pieces:

- **The parity anchor**: the z tile's own depth attachment moved to
  depth32float too (the WG side — the GL tile already ran
  DEPTH_COMPONENT32F by its ladder). Both paths now pick their winning
  fragments at EXACT f32, and the tile's r32f color write IS the winner's
  `position.z` — so the feedback path's tile and the harvest path's
  surface depth carry the SAME values for the same set. The WG render
  pipelines gained the DEPTH FORMAT as the FOURTH variant axis
  (sampleType × depth-presence × color format × sample count × **depth
  format**) — Dawn's own first-boot message caught the need: a pipeline's
  `depthStencil.format` must equal the pass's attachment format.
- **The harvest**: `PyramidHandle.harvestDepth(depthTextureId)` — WG: the
  SAME two-dispatch SPD pair with `zAt` reading `texture_depth_2d` (the
  facade's `'depth'` compute binding — present since Task 196, first
  consumed here; the family lazy + memoized per source texture, the
  storage written directly, the tile never touched); GL: one texelFetch
  harvest quad into the r32f tile + the FBO reduce ladder (the program
  lazy).
- **The still-frame policy**: `renderTo` gained a still-camera detector
  (the mvp bit-identical to the previous call) + the `reuse` flag. A
  still frame gates the feedback branch out (cull#2 falls back to the
  carried pyramid — the Task-208 staleness law, and the K=3 hysteresis
  fold absorbs the transition), and the new `depth-harvest` pass —
  declared after the color pass, `keep: true` (its consumers live in the
  NEXT frame; without the keep the branch-culling law — a reader-less
  write is a dead branch — would drop it) — becomes the pyramid's author.
  hi-z turned PERSISTENT in the graph (it always physically was; the seed
  twin's own law).

**The gate is the fixed-point law, executable**: at a still converged
camera the harvested pyramid ≡ the feedback-built one, word for word —
172 902 words, 0 diffs, drawn/occluded equal, pixels identical, the frame
shapes honest (feedback-fill gated out, depth-harvest live). The win the
recipe promised: a still camera + live edits (the drone squads) used to
pay the depth-only re-render of the survivor crowd every frame — now two
dispatches (WG) / one quad + the ladder (GL), and the seed refreshes
THROUGH the color pass's own depth (the edits land in the pyramid with
the presented frame, one cull of staleness — the seed law's own class).
The honest limit, kept in the doc's own words: the LIVE-CANVAS path (a
real GPU presenting straight to the canvas) carries no samplable depth —
the reuse idles off there (the GL live loop; every WG snapshot/probe/
validation leg renders to the surface, and the software WG tier IS
snapshot mode — the gates' whole world). The live-canvas redirect is the
documented follow-up.

**Leg 2 — the store mirror's first LIVE consumer**
(`demo/scene-mirror/`): the Task-214 library surface — @rune/scene's SAB
regions as adopted SoAStores + the stamp-driven dirty ranges both
directions — was library-and-tests only; this page is the integration
ask answered. A 4176-node city (3600 buildings, 480 props, two drone
squads) runs in a real Web Worker over the SAB (`runSceneWorker`'s
Atomics.wait rhythm — publish wakes it, `take()` reads its epoch, the
bridge in zero-copy snapshotViews mode); the main thread writes the 96
movers through the Scene API; every frame the mirror resolves EXACTLY
the re-uploaded bytes (staticRanges + pool ranges per camera +
worldRanges in rank space) and the HUD carries the honest math (~85×
under the full locals region). The canvas draws the city FROM THE
STORE'S OWN BYTES — the worlds column + the visibility bitsets, zero
copies end to end. The boot gates prove the laws on the page: the
aliasing law, the exact-dirt law (one moved slot = exactly its bytes in
every SoA column — the pos/quat/scale fan-out), the pool ≡ snapshot law,
the stale-take watermark discipline, the upload math. The honest
degrade: without cross-origin isolation (GitHub Pages serves no
COOP/COEP) the SAB cannot cross the worker boundary — the T0 lane
(`runScenePipeline` on the main thread, the mirror's `observe(epoch)`
spelling) runs the same pipeline and SAYS SO in the HUD; the local gate
serves COOP/COEP headers, so the WORKER lane is gated locally and the
T0 lane on production — both lanes, each in its own environment. The
demo ships its own bundle (`dist/rune-scene.esm.js`, the @rune/scene
index with @rune/core inlined — the worker imports it as a module).

**Gate lessons this round taught**: (a) the WG pipeline DEPTH-FORMAT
variant axis (above — Dawn's attachment-compatibility message on the
very first boot); (b) the frame graph's branch-culling law cuts a
cross-frame writer without an in-frame reader — `keep: true` is the
designed mechanism for the seed's authors; (c) the graph's transient
law refused cull#2's read of a hi-z nobody wrote THIS frame — the fix
was making hi-z honest (persistent, which it always physically was);
(d) a gate's own camera math must multiply in the project's order
(proj × view, not view × proj — drawn=1 was the tell); (e) the SoA
dirty-range reader must map each column through ITS OWN base and width
(the pos/quat/scale fan-out — an interleaved assumption answers garbage
slots).

**Gates**: 2188/2188 tests (+2 device contracts: the WG depth-source
compute family lazy+memoized, the GL harvest quad + ladder; the Task-198
recording expectations updated for the depth32float z-tile attachment),
tsc 0, lint 0 errors (368 warnings — baseline), task215-local ALL PASS
(WG: the A6 parity 0 diffs of 172 902 words, drawn 722 = 722, pixels
identical, the shapes honest, the loop alive; GL: the parity
drawn/occluded/pixels equal, the still-canvas honest classic shape; the
scene-mirror worker lane 6/6 + the T0 lane 5/5, the dirt live, the culls
honest), task211-local PASS both backends on the new code, and the
standing gates re-run green with the 209 gate's legs isolated to its own
subject (its drive now passes `reuse: false` explicitly — the gate pins
the Task-208/209 frame shape; the A6 shape is the 215 gate's own law).

## Task 216 — THE FIRST-PERSON WALKER: THE CHARACTER BRICK, THE TERRAIN PASSES, THE ADAPTIVE SCALE (2026-09-15)

The ask: «Создай новое демо, где от первого лица ходишь по террэйну и
прыгаешь по объектам, втч сложным. Мобайл Фёрст. Создавай и применяй
новые технологии.» Three new engine bricks, one new demo, the whole
recent stack applied in a single game loop — and the occlusion tier
grew optional TERRAIN passes without moving a bit of its classic frame
(every standing gate re-ran green).

### The exact-mesh sampler (packages/prims/terrain.ts)

The terrain's height GRID (terrainGrid — pass 1 of terrain(), now
exported) builds BOTH the render soup and the collision oracle: one
source of truth for the pixels and the feet. gridHeightSampler
reproduces the soup's own TRIANGLE interpolation — not bilinear: the
mesh splits every cell along the (i,j)→(i+1,j+1) diagonal, the sampler
picks the same triangle by the diagonal test and interpolates in the
same barycentric forms. The laws (terrainSampler.test.ts, 7): the
VERTEX law (bit-exact at every grid vertex — the walker's world uses a
power-of-two step so the (x+half)/step round trip lands on integer grid
coordinates exactly); the SOUP law (an independent barycentric oracle
walks the soup's triangles — tolerance 1e-4, the oracle's own f32-corner
noise floor, the sampler itself being the MORE accurate of the two: it
reads the grid's f32 heights at exact f64 cell coordinates); the
diagonal, continuity, clamp (a bounded world — the border plane answers,
no NaN, no falling off), determinism, and the anchor (terrain() and
terrainGrid() are the same bytes — the mesh/sampler contract).

### The kinematic character (packages/core/character.ts)

A ground-oracle controller: the controller never knows what a terrain or
a box IS — the world answers three questions (the highest walkable
surface below a point with the surface's own velocity; the boxes
overlapping an AABB; a box's six numbers by id), and the demo's oracle
mounts the Task-213 octree (records-built) under the terrain sampler.
THE LAWS: the RAY law (the ground probe is an infinite-down ray — any
platform, however thin, catches any fall speed in one substep; no swept
volume, no tunneling); THE FEEL LAWS — coyote time (a jump fired within
0.12 s after walking off an edge still launches), jump buffer (a press
within 0.15 s before landing fires on touchdown — a held jump
auto-bunnyhops), STEP-UP (a grounded body meeting only ledges ≤ 0.62 m
mounts the highest instead of stopping — staircases, the «сложные
объекты», are walkable), GROUND GLUE (a grounded body within a step of
its ground stays glued walking down slopes AND stair-descents — no
air-frame stutter); THE MOVER CARRY (a platform is a frame of reference:
its displacement rides the body BEFORE the input moves, and the contact
is RE-PROBED fresh every substep — a mover whose velocity changed, or
which rose INTO the body between substeps, carries with its CURRENT
numbers and rides its top; the round's own caught bug: a stale carry
fell one substep behind and the walker dropped off a platform it stood
on); AXIS-SEPARATED PUSHOUT (X and Z resolve independently — sliding
along a wall IS two 1-D clamps; the exit side is the NEARER side by the
body's position vs the box's center, never the travel direction's face —
the second caught bug: a body grazing a box's far edge while falling
teleported to the far face); fixed-substep determinism (the accumulator
runs whole 1/120 s substeps, the same script → the same trajectory
bits); zero steady-state allocations (the contact, the id scratch and
the box scratch are boot-owned out-params). 13 test laws: the parabola
(apex ≈ v₀²/2g, flight ≈ 2v₀/g), land, tunnel (a 200 m/s fall onto a
0.1 m platform), the running gap jump, coyote (0.08 s fires, 0.25 s
does not), buffer, step-up, the 10-step staircase (never one air frame),
the wall (stops at face − radius, the other axis slides), the ceiling,
the carry (a rising elevator + a horizontal ferry), glue (slopes and
stair-descents stay grounded, a real ledge falls), determinism
(bit-identical trajectories).

### The adaptive render-scale governor (packages/core/scale.ts)

Mobile-first's honest answer to the unknown GPU: the frame time decides
the resolution. THE LAWS (8 tests): EMA first (one slow frame is a
hitch, not a signal — the average absorbs it); THE STREAK LAW (the
counter reads the RAW frame, the gate reads the EMA — counting the EMA
alone let a single hitch's DECAY TAIL read as 7 frames of sustained
overload and step the ladder down on one GC pause, the exact jitter the
governor exists to kill; requiring both keeps the hitch law and the
sustained law); hysteresis (8 over-budget frames step down, 30
under-budget climb back — climbing is deliberately harder); the cooldown
(a step arms 2 s — a surface recreation must not run every frame); the
floor and ceiling; the manual pick (setLevel resets the streaks — a
user's choice must not be fought at once); the oscillation law
(alternating slow/fast frames around the target NEVER move — the
margins' whole purpose); junk samples refused. The engine side: both
renderers grew setDpr (the mutable override channel — the backing store
re-derived through the same resize path a css change rides; the GL
twin's live-DPR poll stands down while an override is pinned), and the
tier exposes setRenderScale(scale) (live legs re-derive at bootDpr ×
scale; the snapshot/probe legs answer null — the documented no-op).

### The terrain passes (the tier + the device's drawMesh)

The device's new drawMesh brick: a plain parallel-attribute soup
(@rune/prims Geometry — positions/normals/uvs, no index) as ONE
non-instanced draw on both backends (WG: the program's attr slots bind
the arrays in order through the facade's keyed cache; GL: the
from:'mesh' decls with their mesh slots over a per-array buffer cache —
3 contract tests on the recording facades). The walker's frame gains
three declared passes: terrain-z / terrain-z-2 (the hills' depth into
the pyramid tile — the tile's BASE layer: the crowd's history/feedback
bricks stop clearing (noClear) and merge on top through the depth test,
so the HILLS OCCLUDE the crowd) and terrain-color (the lit soup — the
height palette the terrain prim bakes into uv.y, the central-difference
normals' lambert, the distance fog). TWO CAUGHT BUGS of the round live
in these passes' wiring: THE OVERLAY LAW (the crowd's color pass must
READ the target — a pure second write left terrain-color's version
reader-less and the graph's branch-culling law rendered the terrain
INVISIBLE while its collision worked); and THE TAPE CONTRACT (a drawMesh
leaves the WG render pass open; the next brick's compute — the compact
in drawVisible, the pyramid's reduce — refuses to run under an open
render pass; every terrain draw ENDS its pass, the pyramid's own
build()'s pattern). The A6 fixed point survives the terrain: the harvest
path reads the surface's depth (terrain + crowd), the classic path
builds the same set (terrain-z-2 + the feedback fill) — the walker's
still-frame gate proves the shape swap on both backends.

### The demo (demo/walker)

A seeded parkour course over a 512 m hills heightfield (a deterministic
xorshift world — the same bytes on every boot, every backend): the
plaza, a 6-hop platform run (each hop engineered against the character's
tuned arc — takeoff 1.8..4.2 m, rises ≤ 1.2 m), the 10-step staircase,
the elevator (the carry law's stage), the ferry gap (the platform slides
the exact 11 m pad-to-pad), the tower with the express elevator and the
ledge ladder, the arch's beam, the finish pad — and a 7 000-box crowd
scattered over the hills (the corridor kept clean), culled by the full
tier (the seed carries phase 1, the same-frame feedback, the near-first
order, the hysteresis fold — drawn ~150-500 of 7k at the course's
checkpoints). THE COURSE'S ANCHORING POLICY (a caught lesson): every
structural piece anchors to the LOCAL terrain with small offsets — each
station reachable from the ground beneath it (a missed hop lands on the
terrain and the course continues); the first staircase draft anchored to
a global height ladder and the walker stood before an unreachable wall.
The movers (the elevator, the ferry, the express) ride the FULL
Task-211/213 path every frame: column writes → markRecordDirty →
coalesced 4-aligned dirty ranges → the tier's partial upload (144 B/frame
against the full 72 KB region — a 500× cut) with the octree's override
lane keeping the collision tree honest (the node counts never move).
MOBILE-FIRST input: the left half of the stage is a virtual joystick,
the right half the look drag, a 84px thumb-range JUMP button (touch
only — the controls module reveals it on the first touch); desktop gets
pointer lock + WASD + Space. The HUD carries the honest numbers (fps,
drawn/occluded/total, the ground contact + its top, the movers' upload
math, the scale level + the EMA, the validation verdict).

### The validation (the page's own, deterministic)

A scripted autopilot walks the course — GEOMETRY-DRIVEN (steer to the
next platform; ONE arc per approach — a jump lock, the round's third
caught lesson: a held jump bunnyhop-chained past every platform; a
progress watchdog backs away from any block), stepped at a FIXED 1/60
(the trajectory a pure function of the seeded world + the script — the
same bits on every backend). 12 laws, asserted live on the page: the
settle (spawns grounded on the plaza), the hop chain (the landing's
ground id IS the progress), the 10-step staircase (y ≡ stairTop), the
elevator ride (the carry law measured live — 18 grounded samples, max
error 4 cm), the feet law (grounded ⇒ feet ≡ the oracle's own top, 81
samples over the run), the culling law (drawn < total behind the hills),
the upload law (the dirty ranges against the full region), the A6 shape
law (a still camera swaps the fill for the depth-harvest), the terrain
passes live, the scale law (the governor steps under injected load), the
pixels law (the drawn count moved with the camera), zero errors. THE
READBACK DISCIPLINE (the round's fourth lesson, the 211 class): the
finish's own readbacks hung the SwiftShader queue even on a paused loop
— the laws now read the LOOP-fed channel (the counts refresh every 12
frames in the page's own safe lane), and the finish's async work parks
the loop until it lands.

Gates: 2221/2221 tests (+31: the sampler 7, the character 13, the
governor 8, the drawMesh contracts 3), tsc 0, lint 0 errors (386
warnings — the new baseline, +18 from the new bricks' honest `!`
assertions), task216-local ALL PASS on both backends (WG: 12/12 laws,
the snapshot leg's honest setRenderScale null; GL: 12/12 laws, the LIVE
leg's setRenderScale re-derives the backing store 672×378 → 420×237 →
restored), the demo-smoke's new walker section green (its own WG-capable
browser — the main smoke browser's light args carry no adapter), and
every standing gate re-run green on the tier surgery: task209-order
BOTH legs (the numbers bit-equal 209), task211-local, task212-leak
(nodes 55828 → 55828, the lane frozen), task214-local (the SPD parity),
task215-local (the A6 parity + both mirror lanes).


## Task 217 — THE FIELD REPORT ROUND: THE SCREEN, THE STICK, THE SKY, THE STAIRS (2026-09-16)

The walker demo's first field report came back with four findings — «управление неудобное на телефоне», «канвас на весь экран», «террейн не виден, там всё чёрное», «физика с боксами несовершенна, особенно у лестниц» — and each one traced to a real cause. The round's method: reproduce FIRST (screenshots through an emulated phone, brightness decoded in numbers), fix at the RIGHT layer (the engine brick where the law belongs, the page where the chrome belongs), then pin every fix with a law and a mobile leg in the gate.

**THE SCREEN.** The Task-216 stage was a letterboxed 16:9 aspect box inside a documentation page — a video player, not a game. The shell's own FULLSCREEN layout (model-viewer's, particles', vfx's) was one mount flag away: the stage now fixes over the whole viewport, the page never scrolls, the controls hide behind the FAB menu (the walker's Culling/Pyramid/Quality buttons ride the sheet), and a real-Fullscreen button rides the sheet where the platform's Fullscreen API exists (iOS Safari hides it — the fixed stage already covers the viewport there). The HUD compacted to four lines under the FAB.

**THE STICK.** The Task-216 virtual joystick was invisible — the thumb flew blind across the unit disc, and any resting-touch creep became a walk. The joystick now SHOWS itself: a base ring + a knob fade in at the touch-down anchor and track the thumb (pure visuals — pointer-events: none, the canvas owns the input), and a 14% dead zone rescales to the full range (a resting thumb is neutral). The synthetic-pointer trap (setPointerCapture refuses a pointer the browser never tracked) is caught — the gates dispatch PointerEvents directly.

**THE SKY.** The occlusion demo's near-black navy clear ([0.045, 0.055, 0.09]) was the walker's sky: 85–96% of the canvas read BLACK in portrait, and the fog line faded the terrain into that black. The tier's clear color became the CALLER'S (deps.sky — the occlusion demo keeps its own, bit-identical classic frame), and the walker passes the fog's own daytime blue: the horizon blends seamless, the fog IS the aerial perspective. The terrain shader's ambient floor lifted 0.38 → 0.46, the fog range pushed out (320/700). The sky law in the gate decodes the page's own screenshot in-page: the top quarter's mean 15/255 → 137/255.

**THE STAIRS — THE MOUNT LADDER.** The one-shot step-up read the obstacles ONCE at the moved position: a diagonal approach (the analog stick's natural drift) put the body's AABB across TWO consecutive steps, the upper one (rise 2×0.55 > stepHeight) was a WALL, and the pushout shoved the body sideways — off the staircase, the report's own complaint. The ladder raises rung by rung and RE-QUERIES after each raise (≤ 4 rungs; the body's span straddles at most two adjacent steps): the next step's nose becomes mountable at the raised feet. 7 new laws (task217.test.ts): the diagonal drift climbs to the pad with ZERO air frames, the steep diagonal climbs with monotone forward progress (the old shove read as backward jumps), the flank brush slides (never mounts a 2 m wall mid-height, never stops), the step+wall composition, determinism bit-identical.

**THE STAIRS — THE LEDGE SAVE.** The trace caught a second bug the report never named precisely: the stair→landing seam held a 0.15 m gap (the pad's near edge vs the last step's far edge) — the body crossed it, the point ray saw nothing under the CENTER for one substep, the body went AIR, and the pad's face became a wall the pushout resolved SIDEWAYS: +1.3 m in two substeps, ejected off the platform it should have mounted (the autopilot's own rescues=2, the same hole). THREE cures: the world closes the seam (the pad sits flush — the geometry fix), the character gains airStepUp (THE LEDGE SAVE: an airborne body within 0.35 m below a ledge's top mounts it — the parkour near-miss law, a jump clipping a platform's face pops onto the top), and the pushout learned the ENTRY SIDE (a wall this move walked into resolves back where the body came from — the nearer-side rule now only governs pre-existing penetrations). The seam law replays the exact crossing: zero air frames, no sideways teleport.

**THE STAIRS — THE FOOTPRINT ORACLE.** The Task-216 ground probe was a POINT: the body left the ground the moment its CENTER left a surface — icy platform edges, the seam, every corner. The oracle now answers FIVE columns (the center + the four toe corners at 0.7·radius) as ONE ground — the highest walkable top under ANY toe — the platformer edge law: the toes hold to the last 30% of the foot. The fromY ceiling stays the caller's (the toes never snap the body onto higher boxes — the carry probe's own discipline). The edge law teleports onto the pad: +0.5·r past the edge = GROUNDED, +1.5·r = falling. The stairs themselves widened 3.2 → 4.4 m — the drift deserves room.

**THE GATE'S OWN LESSON — the frame-count laws.** The mobile legs run under SwiftShader at a 3× DPR fullscreen canvas: the GL leg can hold as little as ONE sim frame in a 700 ms wall window (the caught trap: the release check read 6.6 m/s = 7.5 − 55/60, exactly one frame of decel). The bare loop advances FIXED 1/60 per rAF frame — sim time is frame-count-bound, never wall-bound — so the touch laws WAIT for their predicates (the move, the stop, the fade), generous frame budgets, never fixed sleeps. The mobile legs assert: the fullscreen canvas cover, the sky's and terrain's decoded brightness, the joystick trio (the visuals appear, the drag walks, the release stops), the look drag's yaw, the JUMP button's launch — both backends, portrait 390×780, emulated touch. The validation legs grew to 14 laws (+ the diagonal stairs, + the edge forgiveness).

Gates: 2228/2228 tests (+7 ladder/ledge laws), tsc 0, lint 0 errors (386 warnings — the baseline), task217-local ALL PASS (validation legs 14/14 laws both backends, mobile legs 9/9 both backends), the standing gates re-run green, and the ?v=217 cache-busts across the demo tree.

## Task 218 — THE SECOND FIELD REPORT: THE WG LIVE DEATH, THE FLICKER (2026-09-16)

The report: «Серьезно, не работает небо и террэйн на вебгпу. На вкбгл норм. Еще в вебгл боксы мерцают то исчезая то появляясь и по всей видимости окклюжн с террэйном не дружит норм». Two separate diseases, both real.

**THE DIAGNOSIS HOLE the report exposed first.** The Task-217 gates ran WG in SNAPSHOT mode — `tier.js` routes a SOFTWARE WG adapter away from the canvas-present path (`SNAPSHOT = backend === 'webgpu' && (FORCE_SNAPSHOT || device.software)`), and the headless container's adapter IS software. A real GPU walks the LIVE path (real presents) — a path NO gate had ever exercised with the terrain passes. The forced-live autopsy (`?live=1`, the round's own hatch): the frame graph executes all nine passes, the HUD says `webgpu live`, there are ZERO console errors — and the canvas is 100% TRANSPARENT (an in-page 16×16 mirror reads alpha 0 everywhere; the "sky" was the page background). The readbacks die with `mapAsync: A valid external Instance reference no longer exists` — the DEVICE is dead. This is the container's documented present-death class (Task 175's own tracing: software stacks let devices die unwatched right after their first present), and the SAME SYMPTOM CLASS walks on any field device whose WG present path dies — an adapter misdetection, a driver variant: an empty canvas over a dark page background reads as «всё чёрное», the HUD lies, no error ever surfaces.

**THE LIVE-PRESENT WATCHDOG.** The demo now polices its own canvas: at staged frames (90, then +90 after each fallback boot) a 16×16 2D mirror probe reads the tier's canvas — ALL-transparent alpha means the presents never landed, whatever the cause. The fallback chain: webgpu/live → webgpu/SNAPSHOT (the surface + the 2D blit — WebGPU KEPT where the device itself is alive; the container's second device lives, so this is where it lands) → webgl2 (the device is dead). A device-lost storm (the Task-175 wire, real hardware) short-circuits straight to GL. The engineering laws the chain taught: a fallback boot runs its SYNCHRONOUS prefix (cancel rAF, dispose, tier=null) INSIDE the loop callback that triggered it — the rest of that frame must be forfeited (`if (tier === null) return`), or `tier.aspect()` throws uncaught; and a validation finish hung on a dead device leaves the loop PARKED (`paused=true`) — every boot resets the loop state, and a watchdog boot re-arms the validation on the healthy backend. The gate's fallback leg turns the container's present-death into the LAW: `?mode=webgpu&live=1` dies at the first present, the watchdog catches it at frame 90, the snapshot tier resurrects the canvas — 100% of the mirror lit, the sky 170/255, drawn 194/549, the loop running, zero uncaught debris, the evidence in the log. The user's black-screen class, reproduced and answered.

**THE FLICKER — measured before touched.** The verdict oscilloscope (per-record verdict time series via the tier's `readVerdicts`, both backends): the RAW occlusion verdicts oscillate at hill silhouettes — a crowd box flipping occluded↔visible 28–30 times in 15 s, a COURSE box 20 times, 50 records flipping ≥4 times; occluded bursts run up to ~23 frames. The Frostbite-classic hysteresis K=3 (and the kernel's hard streak cap of 15!) masks none of that — the boxes BLINK, exactly the report's words. The bisect matrix (hysteresis/feedback/seed/terrain each toggled off via a patched serve) moved nothing — the correct null result: the RAW churn is honest borderline geometry (boxes at silhouette edges under a walking camera), and the damper that matters is the temporal one. The cure: the kernel's streak cap rose 15 → 31 (the byte field's own encoding limit — the WGSL word packs the streak in bits 8..15; the GL twin's 1/32 fraction encoding carries 31 losslessly), and the walker runs K=24 — a cull must persist 24 consecutive occluded frames before it lands. 78% of the measured occluded runs (215 of 277) are now masked; the delay is CHEAP for opaque geometry (the depth test rejects the extra draws — the cost is a handful of extra instances in the indirect draw). The occlusion demo keeps the classic K=3 — its frames stay bit-identical, every standing gate green untouched (the K is a tier parameter now, `deps.hystFrames`).

**THE WIRING.** `?live=1` — the field-debug hatch (force the canvas-present path open; the gates and the field can both walk it). The HUD carries the error count. The hysteresis K rides the tier's return (`hystFrames`) — the gate's wiring law asserts 24 on both backends.

Gates: 2228/2228 tests, tsc 0, lint 0 errors (386 warnings — the baseline), task218-local ALL PASS (validation 14 laws + the K wiring both backends, mobile 9/9 both backends, the fallback leg 6/6, the oscilloscope evidence), the standing gates re-run green (209-order, 211, 212-leak, 214, 215, 216, demo-smoke), and the ?v=218 cache-busts across the demo tree (28 marks).

## Task 219 — THE ROOT-CURE ROUND: THE SINGLE-PASS PRESENT, THE OCCLUSION-RESOLUTION LAW (2026-09-16)

The field pushed back on Task 218's answers, and the field was right: «То есть ты его лечишь за 2 сек. Ты решил подорожник приложить вместо нормального решения проблемы? Изолируй поведение и исследуй. Решай задачу» — and of the flicker: «Замаскировано? Почему ты опять не проблему решаешь корневую, а заплатки ставишь». Task 218's own commit said it out loud («78% of the measured occluded runs masked») — a mask is not a cure. This round takes both diseases to the root.

**THE ISOLATION (the demanded step).** The WG-canvas isolation matrix (scratch-219a: 1x-one-pass / 1x-two-pass / MSAA-one-resolve / MSAA-two-resolve-discard-load — the tier's exact live shape) ran in the container: ALL FOUR die identically at the first present (device lost 'destroyed', the readback's «external Instance no longer exists», the probe alpha 0). The container kills ANY canvas present — the documented software-stack class — so the container can tell us nothing about WHICH construct kills a real GPU; it can only prove the fallback chain. The phone's killer had to be eliminated BY CONSTRUCTION. The construct audit of the live path found the suspects the gates never exercised: the live frame rendered TWO passes directly into the canvas (terrain-color with clear, then the crowd's color with load), both through the 4x MSAA resolve — the first pass ends `storeOp:'discard'`, the second opens `loadOp:'load'` on the SAME MSAA texture and resolves a SECOND `getCurrentTexture()` into the same frame. Spec-legal, contents UNDEFINED: a desktop's memory happens to survive the discard, a mobile tiler (Adreno/Mali) reads garbage — the second resolve then overwrites the first pass's pixels with it. Black sky, black terrain, a canvas that never visibly presents while the HUD says «webgpu live». Every gate ran the snapshot leg (the surface, 1x, zero presents) — the diagnosis hole Task 218 named but did not close.

**THE CURE — THE SINGLE-PASS PRESENT.** The whole frame now renders into the offscreen SURFACE on every backend and every mode; the live canvas is a PRESENTATION target reached by exactly ONE fullscreen blit pass per frame (the canonical WebGPU present shape — the one every shipping WG app uses). The new `device.blitToCanvas` brick (WG: a hasTextures quad, one getCurrentTexture inside bindTarget; GL: the textured-strip twin) rides inside the frame graph's present pass. The WG boot retires canvas MSAA (antialias is the GL context's own). And the engine keeps the class from returning: **THE CANVAS-PASS LAW** in the WG facade — a SECOND render pass on the canvas within one submit cycle under antialias throws a named error (the load-after-discard + double-resolve construct is now impossible to reintroduce silently). The watchdog stays as an honest safety net, tightened: the cadence 90 → 30 frames (a dead canvas heals in ~0.5 s, not 2), with **THE SNAPSHOT PREDICATE** — the snapshot leg's present is an ASYNC readback+putImageData, and an empty canvas before the FIRST LANDING is latency, not death (the frame-217 predicate law, learned again: the first tightened-cadence run false-positived a healthy SwiftShader snapshot at frame 30 and the tier now carries `snapshotHealth()` — landed/refused — as the watchdog's predicate).

**THE FLICKER'S ROOT — THE OCCLUSION-RESOLUTION LAW.** The 218 oscilloscope measured 530 raw verdict flips / 219 blinking occluded runs in 12 s; the bisect (hysteresis/feedback/seed/terrain off) moved nothing, and the round called it «borderline geometry» — true but not the root. The root: **the pyramid was 480×270 against a 960×540 render (and a 720×1326 canvas on the phone)** — the cull proves occlusion at a resolution 2–5× coarser than the display, so a sliver that pokes out by 1–3 display pixels is sub-texel to the proof: falsely culled, then revealed a hair of camera motion later — the blink. The fix is the law, not a threshold: **the pyramid EQUALS the render surface** (the tier builds `device.pyramid(SURF_W, SURF_H)`; the cull kernels' baked dims parametrized through `buildShaders(scene, dims)`). At equal resolutions a visible sliver is a full texel — the false-cull class cannot exist by construction. The proof pair: **THE STILL-CAMERA ZERO-FLIP LAW** (a frozen camera, 39 frames, the raw verdicts bit-stable — ZERO flips; no feedback loop exists — the 218 bisect never tested this), and the jitter floor (a ±0.0003 rad jitter flips only the far sub-pixel tail: 2 of 549 boxes, the nearest at 197 m — honest aliasing, invisible at distance). The K=24 masking blanket retires for the honest K=4 damper (the twinkle's streaks run 1–3 frames; the occlusion demo keeps its classic K=3, bit-identical).

**THE SURFACE LADDER.** The game's surface follows the STAGE's own shape × the boot dpr under honest caps: live real-GPU ≤ 1,048,576 texels (native-class on phones), the snapshot degrade ≤ 552,960 (the phone's «норм»-class fallback picture), software ≤ 155,520 (the classic 480×270-class budget — the gates' SwiftShader legs stay fast). A new **GL SOFTWARE PROBE** feeds the ladder: the WebGL2 renderer reads its unmasked RENDERER string at boot (ANGLE names SwiftShader honestly), the device carries `software: true` — the GL legs were the only ones rendering at full canvas res in the container. Side effects that are upgrades: the crowd's drawn counts now match BIT-FOR-BIT across the backends on the same viewport (the same surface ⇒ the same pyramid ⇒ the same verdicts — the walker gate reads drawn=278 on both legs), and the A6 depth-reuse rides the LIVE legs too (the live frame's target IS the surface with its sampleable depth — Task 215's documented limitation «the canvas present path carries no samplable depth» dissolves; the 215 gate's canvas-shape law flipped with it, and the 211 gate's still-frame hash moved to the surface — a screenshot of a CSS-stretched canvas is raster-nondeterministic on both legs now).

Gates: 2228/2228 tests (the task-200 mocks grew the surface's `texture` field — the new `textureId` contract), tsc 0, lint 0 errors (386 warnings — the baseline), task219-local ALL PASS (the pyramid-equality wiring, the ladder caps, the WG-MSAA retirement, the single-present shape, the orientation law on both live legs, THE STILL-CAMERA ZERO-FLIP LAW, the jitter floor, the occlusion-demo control — the fixed 480×270 surface untouched), the standing battery green on the surgery (209-order both legs, 211, 212-leak, 214-local, 215-local, 216-local, 217-local, 218-local all legs, demo-smoke), ?v=219 across the demo tree (28 marks).

## Task 220 — THE HONEST AA + THE QUIET WATCHDOG (2026-09-16)

The field answered Task 219's root cure with the best possible news and two follow-ups: «Сейчас вебгпу сразу показывает норм, но потом на мгновение черный экран и потом снова начинает норм» — the root cure WORKED (the live canvas presented from frame 1), but the watchdog STILL fired at frame 30 (the field log: «the live canvas never presented (frame 30) — the WG snapshot path takes over»), the swap's boot was the black flash, and the phone limped on the snapshot path (readback per frame) ever after; and «если ты говоришь, что там мсаа есть, то надо сказать, что сглаживания я там не вижу, одни лесенки» — correct again.

**THE SPURIOUS SWAP — THE ISOLATION.** The probe mirrored the live canvas into a 16×16 2D canvas and checked the ALPHA channel only, once, at frame 30 — and a verdict on the FIRST blank sample. But a `canvas.width` write CLEARS the bitmap to transparent (spec: setting width/height resets the canvas) until the next present — and the adaptive-scale governor's level drop (`setRenderScale → renderer.setDpr → resize → canvas.width = …`) lands exactly in a phone's boot window: the first frames are slow (WG pipeline compilation), the frame-time EMA sags, `downNeed: 8` trips, the level drops right around frame 30. The probe read the resize gap — a healthy canvas mid-resize — as a dead one, and the swap was the flash. The cascade: the re-armed validation on the snapshot tier then failed its own «zero errors» law (every one of the 14 laws held; the count carried the chain's pre-run notes — the field log's absurd «validation FAIL — zero errors during the validation»).

**THE QUIET WATCHDOG — THE LAW.** A blank probe is a **SUSPECT**, never a verdict: the confirm probe lands 6 frames later (past every resize-clear gap; the governor's 2 s cooldown makes two drops inside the window impossible), and only TWO consecutive blanks walk the chain — the error message carries both frames («suspect frame 30, confirmed frame 36»). The probe reads **ANY channel** now (the sky's RGB is 143/168/199 — the alpha-only check's blind spot was the straight-alpha class: a browser handing the mirror RGB with A=0 reads blank while the canvas looks fine). And the swap itself stopped flashing: **THE OVERLAY SWAP** — a rescue boot does NOT dispose the old tier first; the new canvas lands ON TOP (absolute stacking) and stays `visibility: hidden` until its first landed present (an empty alpha:false GL canvas composites BLACK from creation — visible-but-blank would cover the frozen frame the overlay exists to keep); the old canvas freezes on its last presented frame underneath and retires the moment the new tier's **PRESENT LEDGER** (`tier.presentHealth()` — live: submitted blits; snapshot: landed readbacks) says the rescue is on screen. A failed rescue boot resumes the old tier's loop; a chained rescue (snapshot refused → GL) parks only canvases that ever landed a frame. The end-state is exactly ONE canvas — the gate's law. The «zero errors» law re-bases per run (`validationErrorsAtStart`): the chain's own notes are the chain's evidence, not the fallback tier's failure.

**THE DEAD AA — THE ISOLATION.** Task 219's single-pass present moved the whole scene into the offscreen surface — and quietly retired every antialiasing path in the codebase: the WG canvas MSAA was the field death's construct (retired, honestly), and the GL context cascade only ever covered the DEFAULT framebuffer — which now receives nothing but the presentation blit quad (MSAA on a fullscreen textured quad is a no-op). Both backends rendered a 1x surface and blitted it up: «одни лесенки» was true BY CONSTRUCTION.

**THE HONEST AA — THE MSAA SURFACE.** The AA's new home is the surface itself: `SurfaceOptions.samples` (4 on every real-GPU leg; probe legs stay 1x — the validation's exact-pixel laws; software adapters stay 1x — the 4x fill on SwiftShader is the caps' whole point). The surface's EXPOSED texture stays the RESOLVED 1x image — every reader (the presentation blit, `read()`, a later pass's sampler) keeps its contract unchanged. WG: `createTarget(..., samples)` builds internal 4x color+depth twins and the pass renders into them with `resolveTarget` = the caller's own texture — the resolve rides the pass descriptor (one pass, one resolve — the healthy single-resolve shape of the Task-219 matrix, now pointed at a surface; the pipeline variant axis of Task 198 keys the 4x twins lazily). GL: `renderbufferStorageMultisample` twins (RGBA8 + DEPTH_COMPONENT24) on a render FBO, the target's own FBO becomes the RESOLVE side, and `blitFramebuffer` carries the samples across at every pass boundary LEAVING the target (and before any readback) — NEAREST, the only legal filter for a depth-carrying resolve. **THE DEPTH ASYMMETRY, documented at the door:** the WG spec has NO depth resolve (depth24plus is not a valid resolveTarget) — `samples > 1 + depthTexture` is REFUSED loudly on the WG leg (a silently unresolvable attachment would render undefined depth), so the WG MSAA legs drop the A6 sampleable-depth harvest and the still-camera reuse declines honestly to the feedback fill (the pre-A6 shape, ~1 extra depth-only draw of the visible set); GL's blit resolves DEPTH too (DEPTH_BUFFER_BIT), so the harvest rides the GL MSAA leg free. The validation's A6 law became **CAPABILITY-SPLIT**: a harvest-capable surface MUST swap the fill for the harvest, a WG MSAA surface MUST honestly keep the fill. The proof is pixels, not wiring: **THE MSAA LAW PAGE** (scripts/scratch-220-msaa.html) renders a clip-space triangle's diagonal over a contrasting clear at 1x and at 4x and reads both back — the 1x boundary cuts (0 blended texels), the 4x resolve blends 128 (the boundary column's 25/50/75% coverages) — on BOTH backends, in the container (surfaces resolve fine on SwiftShader; only presents die there).

Gates: 2235/2235 tests (+7 — the MSAA surface's recording-facade laws: the samples= mark both backends, the WG combo refusal at both the renderer and the facade door, the GL combo riding, the 1x legacy shape), tsc 0, lint 0 errors (386 warnings — the baseline), task220-local ALL PASS (the MSAA law page both backends, the source laws, the validation 14 laws both backends — the container's software legs stay 1x, the fallback chain at the two-stage cadence «suspect frame 30, confirmed frame 36» with the overlay end-state exactly ONE canvas and the recovered canvas visible at 100% mirror), the standing battery green (219-local, 217-local, 216-local, 215-local, demo-smoke — 218-live's version-pinned checks are superseded by 219-live, updated to the two-stage law), ?v=220 across the demo tree (28 marks).

## Task 221 — THE TILER LAWS: THE SURFACE-PASS STORE, THE DEPTH-FORMAT PARITY, THE RESOLVE PROBE (2026-09-16)

The third field report: «Там опять темный экран на вебгпу, а на вебгл ничего не рендерится вообще» — the log (webgl2, Android 10 / Chrome 152) carrying both diseases at once: the WG chain's «the live canvas never presented (suspect frame 30, confirmed frame 36) — the WG snapshot path takes over» and the GL leg's «GL error: INVALID_OPERATION (0x502) — an error accumulated in the last frame», twice, ~1.7 s after the takeover — the user switching to WebGL2 by hand and meeting the second disease there.

**THE TIMELINE RECONSTRUCTION.** The boot was webgpu (the default): the WG live canvas read blank at frames 30 AND 36 — a TRUE verdict this time (the content was genuinely black), the watchdog took over to the WG snapshot — which renders through the SAME broken surface — then the user switched the radio to webgl2 (~2 s in): the fresh GL tier's frame-8 error drain logged the INVALID_OPERATION pair at 07:32:59.770, the hunting-mode re-drain logged the single flag 18 ms later, the spam guard silenced the rest. Every timestamp in the field log accounted for.

**WG — THE LOAD-AFTER-DISCARD, RE-GROWN ON THE SURFACE.** The walker's frame opens the SAME 4x MSAA surface TWICE: the terrain-color `drawMesh` ends its pass (the tape contract — the compute bricks refuse to run under an open render pass), and the crowd's color pass re-binds the SAME target with `loadOp:'load'` to merge over it (the overlay law — the frame-graph's own read-modify-write). Task 220's surface-MSAA pass ended with `storeOp:'discard'` — the 4x samples died at every pass end, and every re-open read DISCARDED contents: spec-legal, UNDEFINED, «black screens on mobile tilers, garbage on desktops» — the canvas-pass law's own words, the exact class that law was written against, re-grown one layer down. The depth twin had `depthStoreOp:'store'` all along (the 220 code got depth right and color wrong). SwiftShader is an immediate-mode emulator — the discarded memory physically survives — which is why every container gate stayed green while the phone went dark; and BOTH legs died (the snapshot rescue renders through the same surface), so the rescue showed the same black screen it was rescuing.

**THE STORE LAW.** `storeOp:'store'` on the surface-MSAA color attachment: a surface target is re-opened BY DESIGN (any caller may end and re-open a pass), so the 4x samples must survive every pass end; the resolve still lands at each pass end (the later whole-surface resolve overwrites the earlier — idempotent). `discard` remains legal in exactly ONE place: the canvas pass, under the canvas-pass law's proven one-pass-per-submit contract. The cost is one 4x store per pass end — the standard price of multi-pass MSAA, and precisely what a tiler does at its tile flush anyway.

**GL — THE DEPTH-FORMAT MISMATCH.** The GL MSAA surface's boundary resolve blitted DEPTH from a hardcoded `DEPTH_COMPONENT24` 4x renderbuffer into the caller's `DEPTH_COMPONENT32F` 1x harvest texture (the walker's GL leg always runs depthTexture — the A6 harvest rides it). `blitFramebuffer` REQUIRES identical depth formats: every resolve raised INVALID_OPERATION and no-op'd the WHOLE blit — COLOR included. Both FBOs reported COMPLETE (`checkFramebufferStatus` judges each framebuffer ALONE — the mismatch lives only in the blit between them), the caller's color texture never received a pixel, the presentation blit showed an empty surface — «ничего не рендерится вообще», with the error surfacing only at the frame-8 drain cadence seconds later.

**THE PARITY LAW + THE PROBE.** One depth format per target: the 4x twin rides the 1x side's own format (the 32f harvest texture → a 32f multisampled twin; the depthBits pick 16/24/32 → the same pick on both sides) — the resolve blit is format-identical by construction. And the capability ladder's missing rung: a CREATION-TIME 1×1 dry-run of the exact resolve blit (the same mask, NEAREST) with a pre-drained sticky-error state — a driver that accepts both storages but refuses the resolve between them fails the boot LOUDLY (the tier's ladder catches it, the surface re-boots at 1x with the note) instead of rendering blank frames forever. The dry-run's one garbage pixel lands in the just-created (uninitialized) caller textures — the first frame's clear + full resolve overwrite it.

**THE CONTENT DISCRIMINATOR.** The watchdog's stage-two verdict gained judgment: a blank canvas with ZERO submitted presents is the present-lane death (the takeover, as designed); a blank canvas with presents > 0 splits in two, and the SURFACE's own readback (the copy lane — not the present lane) discriminates: LIT content = the present lane drops frames while the render is fine — the snapshot rescue saves exactly this class (the takeover, with the evidence in the message); BLANK content = the render itself is black — the snapshot path renders the SAME bytes through its readback, the rescue would show the same black while burning the fast path — the honest note + retirement. A rejected (or 1.5 s stalled) read = the device died mid-run — the chain walks. The content probe judges RGB only: a driver's discarded-memory resolve can read (0,0,0,255) — opaque BLACK — and an alpha-inclusive check would call that "alive" while the screen shows darkness.

**THE LAWS THAT PIN IT.** Six mock-GL unit laws (the format parity at 32f and the depthBits picks, the dry-run's exact shape — 1×1, COLOR|DEPTH, NEAREST — the loud refusal, the stale-flag drain, the 1x no-probe legacy shape); the MSAA law page grew THE RE-OPEN LAW (quad A → a REAL pass boundary via the tape contract's own `endPass` → quad B with `loadOp:'load'`: the readback must carry BOTH layers — B-left=128, A-right=128, clear-right=0 on both backends, 1x and 4x — the container's honest proof the resolve/load/re-resolve mechanism loses no pixel, the source law carrying the storeOp assertion the container cannot catch); the fallback leg proves the discriminator did NOT eat the rescue (the container's present death — 35 blits submitted, the surface read dead — walks to the snapshot tier, one canvas, 100% lit).

Gates: 2241/2241 tests (+6), tsc 0, lint 0 errors (386 warnings — the baseline), task221-local ALL PASS (the law page: the resolve law + THE RE-OPEN LAW both backends + the doors; the source laws: the store law, the parity law, the probe, the discriminator; the validation 14 laws both backends; the fallback chain — the rescue walks, the content-black retirement does not fire in the present-death class), task220-local ALL PASS (the pins follow the current deploy state — v=221 marks), 219/217/216/215/214/212/211-local ALL PASS, 209-order PASS, demo-smoke full PASS.

## Task 222 — THE BLIND PROBE, THE GAME PRESERVATION, THE TOUCH LOOK (2026-09-16)

The fourth field report: «Норм, осталась фигня, что на вебгпу в начале начинает работать, а потом скидывается в начало снова спустя мгновение» + «Еще поменяй вверх вниз когда камеру пальцем вращаешь» + «Можешь сделать больше логов, если что». The log's own evidence was complete: «the canvas never presents but the content is alive (suspect frame 30, confirmed frame 38, 35 blits submitted, 100% of the surface lit) — the present lane drops the frames — the WG snapshot path takes over» — the Task-221 content discriminator had CORRECTLY established that the render was alive (100% lit, 35 blits) — and then made the wrong call.

**THE ISOLATION.** The screen was WORKING (the user watched it — «в начале начинает работать»); the 2D mirror probe read blank at frames 30 AND 38; the surface readback read 100% lit. The phone's own history across all four reports: every real-device blank-probe verdict was either content-black (218, 221 — real bugs) or the resize-gap false positive (220) — never once a true present-lane death. The mechanism: Android Chrome promotes an accelerated canvas to a HARDWARE OVERLAY (direct scanout), and the 2D `drawImage` snapshot of an overlay-promoted canvas reads BLANK on a healthy screen — the probe is BLIND on this device class. The takeover then did double damage: `bootTier` teleported the player to spawn (the «сбрасывается в начало») AND re-armed the validation autopilot (the input steal — the game walks away on its own), and the snapshot tier permanently burned the fast path.

**THE BLIND-PROBE LAW.** A lit surface + submitted blits NEVER takes over: no programmatic signal can split a blind probe from a dead present lane, and the takeover's cost on a blind probe (a working game broken: reset + stolen input + the slow readback path forever) outweighs the miss on a genuinely dead one — the user's eyes are the present-proof, the WARN note names the escape (the mode radio). The verdict is a WARN, not an ERROR: a healthy phone's validation must not fail over its own diagnostics (the zero-new-errors law counts ERRORs). The takeover survives only for the classes it can actually save: zero submitted blits (the present lane never ran) and a dead/rejected surface read (the device died mid-run — the container's class).

**THE GAME PRESERVATION LAW.** A rendering rescue must never restart the game it rescues: every boot after the first keeps the walker's transform, the camera, and the FRAME CLOCK — `frameIndex` feeds `simT = frameIndex/60`, the movers' phase; the old unconditional rewind teleported the elevator out from under the rider mid-carry. A COMPLETED validation stays completed (the old unconditional `validationDone = false` re-ran the autopilot — the input steal); the re-arm fires only when the previous run never finished, and the autopilot's module state (phase, target, checks) survives the boot — the course CONTINUES, mid-run. The settle law fires exactly once (`settleLawDone`): a resumed validation mid-course never re-judges the spawn. A user-driven mode switch mid-game gets the same preservation — the grace window for the re-armed watchdog chain is 30 frames FROM NOW (the preserved clock: the old fixed 30 would probe a fresh canvas before its first present).

**THE TOUCH LOOK LAW.** «Поменяй вверх вниз когда камеру пальцем вращаешь» — the vertical drag is the STANDARD mobile convention now: drag DOWN looks DOWN (the horizon glued to the finger); the old sign was the inverted flight-yoke feel (drag down = look up). The desktop pointer-lock axis (movementY) keeps its own convention — the ask was the finger alone. The 217 gate grew the pitch-direction law (drag down ⇒ pitch falls, both backends, emulated touch).

**THE FIELD VISIBILITY** (the report's own ask: «больше логов»): the probe's own evidence rides every verdict note — the max channel over the 16×16 mirror + the canvas dims (a blind probe reads max 0/255 over a healthy-sized canvas; a resize-gap reads the same but heals in frames; a dead canvas reads it forever — the notes now carry the numbers that tell them apart); every render-scale governor step is a log line (the scale math + the resize-clear warning — the correlation between a governor level drop and a blank probe is now readable straight from the field log).

Gates: 2241/2241 tests (no engine bits moved — the round is demo-level), tsc 0, lint 0 errors (386 warnings — the baseline), task221-local ALL PASS (the gate grew the round's source laws: the blind-probe retirement + the WARN verdict + the preservation law + the settle-once law + the probe evidence + the touch look; the fallback chain still walks in the container's read-dead class — the rescue the blind-probe law kept), task220-local ALL PASS (v=222 marks), 217-local ALL PASS (+the pitch-direction law, both backends), 216/215/214/212/211-local, 209-order, demo-smoke ALL PASS. Deployed (4784db1 → CI success → Pages): task222-live ALL PASS on production (the seven source laws on the deployed bytes; THE DEPLOYED TOUCH LOOK LAW both backends, both directions — drag down ⇒ pitch −0.06→−0.67, drag up ⇒ back — zero page errors), 219-live ALL PASS (the v=222 marks, the gallery card 216–222, both validation legs 14 laws — WG drawn 359/1537, GL 277/1537 — and the deployed fallback chain: the read-dead verdict walks to the snapshot tier, 100% of the mirror lit), 221-live ALL PASS (the tiler laws on the deployed dist + the law page).

## Task 223 — THE DENSE FOREST: one tree, instanced (2026-09-16)

The ask: «Используй ссылку и загрузи 3д модель дерева. Твоя задача сделать демо, наполненное этим деревом одним в густой лес. Учитывай, что дерево весьма большое и с полигонами, так что тебе надо всячески оптимизировать и придумать как хорошо окклюдить все.»

**THE SUBJECT.** free3d's «Podokarp tree N051218» — a 58 MB zip (a 25.7 MB .3ds + two JPEG textures + a 173 MB Archicad .gsm the demo never touches). The 3ds parsed from chunks (the file is ONE mesh sliced into 16 × 64k-vertex objects by the exporter's 16-bit index limit — the slices share one matrix, welded back at the seams). The file contains TWO complete trees (the GSM's 3D model + a second copy mirrored below the ground plane — the sub01..07/sub08..16 split); the VLM compared both renders and the LOWER copy is the real tree (trunk from ground, canopy above — the matrix's translation was built for it). 310,729 faces: 302,561 foliage + 8,168 bark. THE FOLIAGE IS AN UNSHARED TRIANGLE CLOUD — 2.3 vertices per triangle, no edge sharing, MIXED winding (a soup of independent needles; the bark alone is a consistent closed-tube surface). The textures: the foliage map is SOLID noise (no alpha keying — the foliage is opaque 3D geometry, no alpha-test anywhere) and the bark is a vertical tiling pattern (the UVs wrap ±3 — REPEAT wrap, a new facade option).

**THE ASSET PIPELINE** (scripts/task223-convert-tree.py, the artifacts committed): clean (floaters above the canopy line, soil below, degenerates) → normalize (the trunk base = the lowest bark segment cluster; 12 m) → THE NESTED LOD LADDER — one seeded hash per face, keep(f, p) = hash(f) < p, so every coarser LOD is a strict SUBSET of the finer (45% / 18% / 5% / 1.5% of the leaves; the bark 100/100/60/stem-chain) — the SUBSET LAW: a z-fill drawn at any coarser LOD can only UNDER-occlude, never falsely cull, by construction → smooth normals → Morton order → THE QUANTIZED FEED (i16×4 snorm positions decoded over each mesh's own bbox + i8×4 normals + i16×2 uvs = 16 B/vertex against fp32's 32; the soup makes the vertex bytes the whole asset: 11.2 MB raw / 7.1 MB gz) → THE OCCLUDER PROXY (below). The .gz ships because GitHub Pages never gzips application/octet-stream — the loader fetches tree.bin.gz and DecompressionStream inflates it.

**THE ENGINE LAWS (Task 223's own bricks, both facades + the device).**
· THE QUANTIZED FEED: GpuAttrSlot grows `format` ('snorm16x4'/'snorm8x4'/'snorm16x2' — the pipeline's vertex layout + stride follow), bindVertexBuffer accepts Int16Array/Int8Array (the WG cache + the write path widened), the GL bindVertexBuffer grows a `type` param (SHORT/BYTE + normalized — the memo carries it), createBuffer accepts the typed arrays, the journal carries quantized buffers verbatim (a toFloat32 copy would lie on replay).
· drawMeshInstanced: one mesh × one RECORD RUN × one indexed instanced draw — WG (the mesh arrays at their slots + the scene storage at group 2 + one texture at group 1 + drawIndexed; the shader fetches its own record by u_base + instance_index) / GL (the mesh attrs typed by the array's constructor + the records/flags feeds BYTE-SHIFTED by baseInstance — the run is contiguous, the divisor-1 attributes walk it) — THE VERDICT COLLAPSE rides the shader (a hidden tree outputs z=2, zero pixels, zero readbacks, no CPU list).
· texture(bitmaps[], {wrap}): the mip chain uploaded level by level (WG copyExternalImageToTextureMip / GL texImage2DLevel — the facade's own progressive contract), REPEAT when asked.
· runCullCompact(scene): the compact WITHOUT a draw — the verdict counters into the args buffer (WG; a documented GL no-op — its flag sweep needs none).

**THE OCCLUSION STORY (the hard-won half).** The first honest smoke: every tree read «straddle», frustum 0, occluded 0 — THREE roots, each its own lesson. (1) THE MAT4 CALL: scene.js's math RETURNS new arrays (a (out, a, b) call left the MVP zeroed — every clip.w was 0, every box straddled the eye plane, the screen was empty). (2) THE TIGHT AABB: the record's box is the yaw-EXACT rotated footprint (the 4 corners rotated, the extents taken) — the podocarp's 24×27 m crown inflated to a 42×42 disc at 15 m forest spacing SWALLOWS the camera, and a box containing the eye can never be occluded. (3) THE SIEVE: even with tight boxes and real depth in the pyramid, occluded stayed 0 at every camera — the foliage is a cloud of 2-3 px triangles with sub-pixel gaps, and the max-reduced Hi-Z (the SOUND form — a box culls only behind the FARTHEST surface in its footprint) reads one sky texel through the gaps as zmax=1.0: NO cull. THE ANSWER IS THE INDUSTRY'S OWN: the OCCLUDER PROXY — the canopy's dense core voxelized offline (12×8×12 grid over the leaf cloud, cells above the density threshold, greedy-merged rectangles per Y-layer: 69 solid boxes, 828 tris), drawn DEPTH-ONLY in both z phases. The far trees finally cull behind the wall (occluded > 0 at the canopy-level camera — honestly still 0 from above, where nothing is behind anything).

**THE SOFTWARE LADDER + THE COUNTS CHANNEL.** The container's legs taught three more laws. The WG snapshot present reads the surface EVERY frame — an endless mapAsync chain that starves every other readback (present throttled to every 3rd frame). The stats copy lane on WG first read the SCENE STORAGE mid-loop — the 211-class poison sharpened: one hung mapAsync (the scene is bound in the frame's unsubmitted passes) kills every later readback on the device, even paused ones — THE COUNTS CHANNEL is the cure (the compact's counters into the args buffer, an UNBOUND buffer whose readback is the safe class; the field's drawn=106 stable at 60 fps where every scene read hung). The software LOD0 CAP: a 139k-tri showcase tree would kill the container's renderer — the soft legs keep six band-0 trees, clamped bands, a light validation branch (10 sweep steps + one wall probe); the real GPUs run the full showcase.

Gates: 2241/2241 tests (no engine test moved — the new bricks are law-checked by the demo gates; the recording facades' shapes follow), tsc 0, lint 0 errors (386 warnings — the baseline), task223-local ALL PASS (the source laws + the 7-law validation BOTH backends in the container: drawn 36..45 of 118, occluded 6 at the wall, frustum 77, zero flips, LOD0 runs live, the 11-pass frame declared, zero page errors). Deployed (cb62e13 + b6d1b44 → CI success → Pages): task223-live ALL PASS on production — the deployed bytes carry the round (the quantized feed + the new bricks in the deployed dist, the proxy + the tight AABB + the counts channel in the demo sources, the 7.06 MB packed asset) and THE DEPLOYED VALIDATION walked on BOTH backends (7/7 laws, zero page errors).

