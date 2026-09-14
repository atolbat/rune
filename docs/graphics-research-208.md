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

### A4 — ⚓ THE SINGLE-PASS PYRAMID (subgroup / shared-mem SPD) — BACKLOG, strengthened

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

### A6 — ✎ DEPTH REUSE FROM THE PRESENTED FRAME — BACKLOG

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
