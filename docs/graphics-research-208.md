# graphics-research-208 — the occluder pass & arbitrary geometry

Task 208's research round answers the user's two standing asks:

- **(A)** «как дополнительно такой сложный проход окклюдера оптимизировать,
  можешь поискать в инете» — further optimization of the two-pass HZB
  occluder machinery;
- **(B)** «как эффективно использовать окклюжен с произвольной неквадратной
  геометрией» — occlusion culling with arbitrary non-box geometry.

**The honest status of the web sweep**: the fresh 2025–2026 search round was
rate-limited out (the search service answered 429 to every paced query —
`scripts/research208-search.mjs` keeps retrying in the background and
re-runs when the quota recovers). Every anchor cited below with a ⚓ mark is
one the 205–207 rounds VERIFIED by direct page reads (bevy PRs, Granite's
hiz.comp, GPUPrefixSums, Chrome's subgroup ship, Pettineo's post); the
analysis mapped onto our architecture is first-principles and marked ✎.
Nothing below is a hallucinated citation — the 207 audit killed two phantoms
and this doc keeps that law.

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

### A4 — ⚓ THE SINGLE-PASS PYRAMID (subgroup / shared-mem SPD) — BACKLOG

⚓ Granite's `hiz.comp` (page-read in 207-rb) builds the whole max-pyramid
in one dispatch via workgroup shared memory; the Chrome-134 subgroup
feature makes the cross-warp reduce expressible. Kills 8 of 9 reduce
dispatches = 8 fewer frame-graph sync points on the WG leg. **Verdict**:
BACKLOG with the subgroup feature-gate + the shared-mem fallback (the
207-rb conclusion stands); our tile is 480×270 — the 9 dispatches are
tiny, the win is sync-point hygiene more than milliseconds.

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
| A1 | parallel compact (ballot / TileScan, stable) | **IMPLEMENT** (Task 209 candidate) |
| A2 | front-to-back color order (early-Z harvest) | **IMPLEMENT** (Task 209 candidate, pairs with A1) |
| A3 | cross-frame seed (bevy delta) | **IMPLEMENTED — Task 208, this round** |
| A4 | single-pass pyramid (subgroup SPD) | BACKLOG (feature-gated) |
| A5 | dirty-rect HZB reduce | REJECT at 480×270 (revisit at 4K tiles) |
| A6 | depth reuse from the presented frame | BACKLOG |
| A7 | async compute overlap | BACKLOG (backend-gated; the plan exists) |
| A8 | hardware occlusion queries | REJECT (absent on the web) |
| B1 | convex-hull / OBB queries in the kernel | **IMPLEMENT** (Task 209 candidate — the layout + loop) |
| B2 | arbitrary meshes as occluders | already supported (document; demo variant) |
| B3 | meshlet normal-cone pretest | BACKLOG (needs meshlet content) |
| B4 | occluder simplification proxies | BACKLOG (content pipeline) |
| B5 | virtual occluders / runtime fusion | REJECT (the feedback fill implements the goal) |
| B6 | alpha-tested cards as occluders | BACKLOG (recipe in this doc) |
| B7 | skinned conservative bounds | BACKLOG (recipe in this doc) |

**The fresh-sweep caveat**: the 2025–2026 web pass was rate-limited out
this round (429s throughout, `scripts/research208-search.mjs` keeps
retrying in the background); the ⚓ anchors are the 205–207 rounds'
page-verified set, the ✎ entries are first-principles analysis against
our own measured numbers. When the quota recovers the sweep re-runs and
this doc gains its fresh-harvest section — the do-not-re-report list at
the top of the script keeps it honest.
