# Research Digest 205-a — Rasterization + Occlusion Culling + Visibility (rare/niche sources)

**Agent:** research (no production code touched)
**Date:** session 2026 (queries via `z-ai function -n web_search`, ~36 queries; page fetches via `curl`; PDFs via `pdftotext`)
**Target engine:** rune — TS monorepo, WebGPU + WebGL2 dual backend; CPU `softwareOccluder` (256×256 depth + 2×2 MAX-reduce pyramid + conservative nearest-corner test); GPU z-prepass → Hi-Z (integer log2 mips) → WGSL compute cull → compaction → multidraw; two-pass HZB history feedback (no reprojection); hysteresis (verdict + streak/32 in one float word, K frames); amortized culling for still cameras; octree/BVH; clusterize; bitonic sorts; frame graph.
**Constraints honored:** JS typed arrays (no SIMD), GC-sensitive monomorphic hot loops; WebGL2 TF fallback must keep working; pixel-parity culture (ON/OFF pixel-hash gates).

**Source policy applied:** journals (CGF/EG, HPG/PACMCGIT, TOG/SIGGRAPH, arXiv), personal research blogs, GitHub repos/gists, university reports/theses, community articles. **Excluded engine-vendor sources:** Unreal/Epic, Unity, Frostbite/EA (incl. the EA "Coverage Bitmasks" SIGGRAPH talk — excluded per policy), Godot, Crytek, Guerrilla/Killzone, NVIDIA GTC/GPU Gems chapters used only as historical context where cited by non-vendor papers. Intel GameTechDev repo included (hardware vendor, not engine vendor; canonical research artifact).

---

## 0. The requested "MIT 2025 Pyramid Rasterization" paper — status: NOT LOCATED

Searched via ~8 phrasings ("Pyramid Rasterization: Faster Line and Triangle Rasterization", "pyramid rasterization 2025 coverage masks", "faster line and triangle rasterization", "pyramid rasterizer github", MIT/CSAIL-scoped variants). The search backend does not index it; arXiv API was persistently rate-limited (HTTP 429 from sandbox IP); DDG/Scholar blocked. **Recommendation: check ACM DL (HPG 2025 / PACMCGIT) and arxiv.org/list/cs.GR/2025 manually** — if it exists it is too new / poorly indexed. The *technique family* ("hierarchical coverage-mask / pyramid rasterization") is fully covered below by real, verifiable sources: Greene's coverage-mask tiling (§1.1), threadlocalmutex's quantized edge→64-bit mask tables (§1.2), TU Wien bin/tile mask hierarchy (§1.4), CuRast 3-stage (§1.5), and HOM / tz-pyramid image-space pyramids (§2.4, §2.5).

---

## 1. RASTERIZATION

### 1.1 Greene — "Hierarchical Polygon Tiling with Coverage Masks" (SIGGRAPH 1996)
- **Author/venue:** Ned Greene, SIGGRAPH '96 (ACM TOG). Landing: cs.princeton.edu course archive. ~12 pages.
- **Core idea:** Image space is a pyramid of 2×2 blocks (4×4, 16×16, … tiles). Each convex polygon is classified at each pyramid level as *trivially accepted*, *trivially rejected*, or *indeterminate* by testing its edges against the block; coverage of a block is a bitmask obtained by AND-ing the per-edge bitmasks of covered children. Recursion descends only into indeterminate blocks. Trivial-reject uses the AND of edge-mask complements; trivial-accept ORs. This is the original "pyramid rasterization": O(area actually covered) instead of O(bounding box), with a mask-pyramid data structure identical in spirit to a mip chain of coverage.
- **Applicability:** HIGH for `softwareOccluder`. A 2-level version (8×8 blocks → 64-bit mask as two Uint32; level-1 "coarse masks" as a 32×32 Uint8Array at 256×256) skips empty blocks entirely; boxes are convex and axis-aligned in screen space → per-edge masks are monotone along rows (cheap row-interval tests).
- **Measure:** bun micro-bench ms/frame for 10k occluder boxes @256×256; % blocks skipped; parity gate must stay green (masks are exact, no precision change).
- **Verdict:** implement-now (cheap, exact, JS-friendly).

### 1.2 rawrunprotected / threadlocalmutex.com — "Sponza in a Millisecond" + "Software Rasterizer Update" (+ GitHub `rawrunprotected/rasterizer`)
- **Author/venue:** anonymous handle `rawrunprotected`, blog threadlocalmutex.com (posts ?p=144, ?p=163; repo CC0). ~2019–2021. Sponza raster in ~1 ms.
- **Core idea:** (a) **Edge-mask precomputation**: for each triangle edge, quantize (slope, offset-at-block-center) and look up a precomputed **64-bit coverage mask for an 8×8 block** from a 32 KB table; AND 3 edge masks → block coverage. Quantization "bristle" artifacts are ≤1 px and never cross block boundaries → safe for occlusion use (no over-occlusion beyond 1 px). (b) **Clipless (homogeneous) rasterization**: skip clipping/near-plane by clamping w away from zero, doing perspective division late, sign-inverting edge equations for w<0 vertices. (c) FMA/AVX tuning (~20%). (d) In the update post: **temporal jitter filtering to kill over-occlusion** — sub-pixel camera jitter over N=4 frames using MSAA sample patterns; an object is culled only if occluded for all N frames (per-object counter); for stereo, alternate eyes per frame. Saved ~1 ms CPU + 1 ms GPU in a shipped VR product. 2–3× faster than Intel's OcclusionCulling sample single-threaded.
- **Applicability:** HIGH — the edge-mask table is the practical realization of Greene masks and needs **no SIMD**: a `Uint32Array(2)`-per-block mask + `Float32Array` edge quantization ports directly to TS. The N-frame jitter-streak filter is a strict generalization of our hysteresis pass (verdict + streak/32): add a deterministic 4-frame sub-pixel jitter sequence to the occlusion-camera when the main camera is still; keep streak counter semantics (occlude only at streak==N).
- **Measure:** bun micro-bench (raster inner loop ms); parity gates across the 4 city cameras; over-cull incident counter (should drop to ~0 with jitter).
- **Verdict:** implement-now (two independent wins: mask table for raster speed; jitter for verdict robustness).

### 1.3 ryg blog — "Optimizing the basic rasterizer" + "Triangle rasterization in practice" + "Optimizing Software Occlusion Culling" series (Feb 2013)
- **Author/venue:** Fabian Giesen (ryg), fgiesen.wordpress.com. (Bot-gated to curl; content summarized from indexed snippets + the well-known series.)
- **Core idea:** Integer edge functions with incremental evaluation (add edge-function step per pixel/column instead of re-evaluating), sub-pixel fixed-point precision, block-based 4×4 output, scanline vs edge-walk trade-off analysis ("scan-line rasterization works great one scanline at a time, but gets hairy quickly"), and for the occlusion series: struct-of-arrays vertex/buffer layout, depth-buffer rasterizer with per-row incremental updates, occluder batching, and the full optimization ladder of Intel's sample. This is *the* canonical CPU depth-raster optimization reference.
- **Applicability:** HIGH as the JS-port checklist: SoA `Float32Array`/`Int32Array` planes (we already do RecordView SoA), monomorphic inner loops, integer edge stepping, per-block unrolls. Giesen's later work also covers the "no clip, clamp w" family used by 1.2.
- **Measure:** bun micro-bench before/after each checklist item (the series is literally a sequence of measured micro-opts — replicate that discipline).
- **Verdict:** implement-now (reading list + micro-bench ladder).

### 1.4 Liopas Evangelos Ioannis — "Software Rasterization of Large Triangles" (TU Wien, "Project in Visual Computing 1", 2026)
- **URL:** https://www.cg.tuwien.ac.at/research/publications/2026/ioannis-2026-sro/ (+ report PDF; fetched & parsed).
- **Core idea:** GPU raster pipeline specialized for **large primitives**: screen split into **64×64-px bins** → each bin into **8×8-px tiles**; coarse bbox/bin test → per-bin **64-bit tile coverage mask** built by testing edge half-spaces per tile row (edges conservatively extended by half a tile width to avoid striping) → mask==0 culls bins that passed the bbox test → per-tile scanline fragment test by a single thread. Threshold: triangles > ~4000 fragments go down the hierarchical path; small triangles use the direct path (this fixes block-level work imbalance).
- **Applicability:** MED-HIGH — our `softwareOccluder` rasterizes **box front-faces** (2 large quads-ish per box) into 256×256; boxes near camera cover huge screen areas → bbox loops dominate. A bin/tile mask pass (2 levels: 16×16 bins of 16×16 px, or the report's ratios scaled to 256) cuts per-pixel work massively; the "extend edge by half tile" trick is exactly the conservative-coverage rule our parity gates want (over-cover ≤ half-tile, and for occlusion depth we take min-z per tile so coverage slack = *under*-occlusion, never over-cull… careful: for occluders you want INNER-conservative; see §2.8).
- **Measure:** bun micro-bench ms/frame; % tiles skipped; parity gate.
- **Verdict:** implement-now (second priority after 1.2; composable with edge-mask tables).

### 1.5 Schütz, Lipp, Kristmann, Wimmer — "CuRast: Cuda-Based Software Rasterization for Billions of Triangles" (EGSR 2026, CGF 45(4):e70538; arXiv Apr 2026; repo `m-schuetz/CuRast`)
- **Core idea:** CUDA software rasterizer: 1B unique / 4B instanced triangles at 60 fps (RTX 5090), beating the fixed pipeline on dense opaque meshes by 2–5× (unique) / 12× (instanced). **3-stage pipeline**: stage 1 = small/pixel-sized triangles via atomic depth writes (no binning), stage 2/3 = binned/tiled traversal for increasingly larger primitives. No precomputed LOD/acceleration; targets dense opaque geometry.
- **Applicability:** MED — not CUDA, but the **dispatch-by-size taxonomy** applies to our WGSL compute occluder rasterizer (if we move `softwareOccluder` to GPU as an alternative backend): tiny occluder quads → atomic-write path; big quads → per-bin workgroups. Also a design argument for "software raster on GPU beats fixed-function for special workloads" — relevant if we ever raster occluders via compute instead of the z-prepass.
- **Measure:** GPU timer (timestamp-query) of an experimental compute-occluder-raster pass vs z-prepass Hi-Z path; parity gate on city demo.
- **Verdict:** later (R&D; current CPU occluder + z-prepass suffice at 10k boxes).

### 1.6 Dyrkorn — "A fast and precise triangle rasterizer" + "Rasterizing triangles using scanline conversion" (kristoffer-dyrkorn.github.io, 2022–2023)
- **Core idea:** JS-specific(!) tutorial series: fixed-point subpixel coordinates, exact inside tests, **incremental edge evaluation** giving ~10× speedup, then a scanline-coverage variant. All sample code in JS with browser demos. Emphasis on *precision* (matching GPU fill rules) before speed — matches our pixel-parity culture.
- **Applicability:** HIGH for `softwareOccluder` JS internals: use fixed-point edge deltas over the quad's rows, hoist to `Int32Array`, monomorphic inner loop; the series is the most directly portable reference found (literally JS).
- **Measure:** bun micro-bench of the inner loop vs current float edge evaluation; exactness check vs reference fill (parity).
- **Verdict:** implement-now (port the incremental/fixed-point inner loop).

### 1.7 Minor / adjacent rasterization sources
- **Scali's OpenBlog "span buffer" (2015)** + **GP2X "Software S-buffering" (pyra-handheld.com, 2007)** + **flipcode "Harmless Algorithms" column (90s)**: span/C-buffer line — occlusion raster via 1-D spans per row instead of per-pixel depth. LOW-MED for us (256×256 + mask pyramids beat span lists in JS; spans = pointer-chasing/GC risk), but the *c-buffer-as-span-simplification* framing (also in Pesce §2.7) is good historical context.
- **lisyarus "Implementing a tiny CPU rasterizer" (2024, series)** — clean modern walkthrough; LOW (educational).
- **alain galvan gitbook "(Triangle) Rasterization and Setup" (2021)** — summary with pointers to Greene/clipless; LOW.
- **Lipp & Bode — "High-Performance Real-Time Implicit Strand-Based Hair Rendering via Software Rasterization" (PACMCGIT 9(4), July 2026, TU Wien)** — SW raster of millions of thin primitives with binned scheduling; LOW for us (workload mismatch).
- **graphdeco-inria/hierarchy-rasterizer** — hierarchical (tile-pyramid) 3D-Gaussian rasterizer from "A Hierarchical 3D Gaussian Representation for Real-Time Rendering of Very Large Datasets"; LOW-MED (particles demo is 40k, not the bottleneck).
- **Schütz et al. — "Software Rasterization of 2 Billion Points in Real Time" (HPG 2022, repositum.tuwien.at / arXiv 2204.xxxxx)** — GPU point SW-raster; MED only if the particle demo grows 100×.

---

## 2. OCCLUSION CULLING & VISIBILITY

### 2.1 Hasselgren, Andersson, Akenine-Möller — "Masked Software Occlusion Culling" (HPG 2015) + `GameTechDev/MaskedOcclusionCulling` repo (+ companion TOG 2015 paper)
- **Venue/URL:** HPG 2015 (diglib.eg.org, dl.acm.org/10.5555/2977336.2977340); repo (fetched README); companion: "Masked Depth Culling for Graphics Hardware", ACM TOG 34(6) 2015 (PDF fetched from fileadmin.cs.lth.se).
- **Core idea:** Replace the classic hierarchical Z-buffer (per-8×8-tile zmax) with a **masked hierarchical depth buffer**: each tile stores a small set of *layers* (e.g. 2) of depth values plus a **1-bit mask per sample** saying which layer the sample belongs to. Coverage is decoupled from depth: fragment coverage is computed in parallel, and hierarchy updates only touch tiles whose mask changes. This culls much better in partially-covered tiles (the case where zmax-only fails) and parallelizes without a serial final pass. The software variant adds: occluder rendering via a scanline rasterizer with tile-level masks, "B-resolutions" (multi-scale test), `TestRect()` fast conservative rect query in NDC (≈ our nearest-corner test), and (May 2018 repo update) **merging two depth buffers** — which both parallelizes buffer creation and reduces silhouette bleed when occluders can't be sorted front-to-back.
- **Applicability:** HIGH for `softwareOccluder` *and* the GPU Hi-Z. Concretely: (a) store per 2×2 or 8×8 tile a near/far plane pair + coverage count instead of max-only (see also §2.5 two-plane) — verdicts flip less on sloped/silhouette tiles; (b) depth = 1/w (their exact choice) avoids perspective interpolation cost — we already do perspective-correct, verify 1/w substitution; (c) buffer **merge** lets us rasterize occluders in parallel (multiple typed-array buffers, merge = componentwise max/min) — no global sort, GC-free; (d) their `TestRect` = our conservative nearest-corner test; their NDC-rect formulation is a known-good spec.
- **Measure:** bun bench (raster + query µs); verdict-flip statistics per tile type; parity gates (masked layers only *reduce* over-culling → parity should improve).
- **Verdict:** implement-now (mask/layer tile representation + merge; biggest single algorithmic lever found for the CPU brick).

### 2.2 Lee, Jeong, Seok, Lee — "Hierarchical Raster Occlusion Culling" (EG 2021, CGF 40(2):489–495, SKKU)
- **URL:** http://cg.skku.edu/pub/papers/2021-lee-eg-hroc-crc.pdf (fetched & parsed).
- **Core idea:** ROC (raster occlusion culling, per-object bounds + early-Z/query) doesn't scale to huge object counts. HROC: (1) with occluders from temporal coherence, **rasterize coarse bounds of *occludee groups*** (BVH subtrees) instead of individual objects; (2) within rasterized group bounds, **cast per-pixel rays** for fine-grained per-object tests (hybrid raster + ray); (3) **occluder filtering (OF)** via an item buffer to remove false-positive occluders (objects rendered before their blocker get classified visible by early-Z); (4) **counter read-back (CR)** to pack multidraws tightly (maxdrawcount). Speedups vs CHC++/ROC/WOC/IOC: 1.4–24.8× on 17.9M–807M-tri scenes; OC-only overhead 0.23–2.0 ms.
- **Applicability:** HIGH — the **group-then-refine** structure maps 1:1 onto our `clusterize` + WGSL cull kernel: first run Hi-Z test on *cluster bounds* (few thousand), then only clusters that fail get per-object tests — cuts kernel work by the cluster-to-object ratio (10k boxes / ~500 clusters ≈ 20× fewer first-pass tests). OF's item-buffer idea = tag each occluder pixel with object id; cheap version: reuse our z-prepass object-id (or draw-index) attachment to filter stale occluders in the history set. Their CR is the one thing we should *avoid* (CPU-GPU sync); our compaction already handles draw counts on-GPU — but their measured benefit says a *approximate* maxdrawcount with margin is the right compromise.
- **Measure:** GPU timer on the cull kernel (group-test-only vs per-object); # tests/frame counter; parity unchanged (same final verdict semantics, just batched).
- **Verdict:** implement-now (two-level cull inside the existing kernel; no new resources).

### 2.3 Lee & Lee — "Iterative GPU Occlusion Culling with BVH" (HPG 2022 poster, cg.skku.edu)
- **Core idea:** Iterative version of raster occlusion culling working on a *select number of BVH levels* (rasterize bounds at multiple levels, refine only where needed) — poster-scale result, scales to massive scenes.
- **Applicability:** MED — same family as 2.2; the multi-level schedule (iterate levels until convergence) could replace our single-pass verdict when cameras move fast. Later.
- **Verdict:** later ( folded into 2.2 experiments).

### 2.4 Boulos, Luong, Fatahalian, Hanrahan, Moreton — "Space-Time Hierarchical Occlusion Culling for Micropolygon Rendering with Motion Blur" (HPG 2010, Stanford; tz-pyramid)
- **URL:** http://graphics.stanford.edu/papers/tzpyramid/tzpyramid.pdf (fetched).
- **Core idea:** The **tz-pyramid** extends the z-pyramid with per-texel **time intervals [tmin,tmax]** of when the depth sample is valid (motion-blurred geometry). Culling adapts: tight when motion is small, relaxed under large motion. Shades 1.2× vs 4.1× as many vertices as visible vs a plain z-pyramid (3.5× better). It is the canonical "two quantities per texel" Hi-Z.
- **Applicability:** MED-HIGH — two independent takeaways: (a) **min/max (two-plane) Hi-Z** instead of max-only: our integer-log2 MAX pyramid can store (min,max) pairs; occlusion test becomes "box z-interval fully behind tile's [zmin,zmax] plane pair" → fewer false 'visible' verdicts on grazing/sloped surfaces (classic two-plane HZB); (b) **time-interval bounds**: for our *amortized culling for still cameras*, a "motion budget" per tile (like tz) is the principled way to decide when cached verdicts expire as the camera starts moving — better than a global K-frame constant.
- **Measure:** verdict-flip rate on the city demo's ground-plane-heavy views (two-plane should cut false-positives); GPU timer for the extra plane (Hi-Z build + cull pass); hysteresis stability metric for (b).
- **Verdict:** (a) implement-now (small change to Hi-Z mips + kernel test); (b) later.

### 2.5 Min-max / two-plane Hi-Z practical sources
- rastergrid.com (Daniel Rákos) "Hierarchical-Z map based occlusion culling" (2010) and Nick Darnell (2010): the classic non-vendor write-ups of Hi-Z map construction + object test (bbox → select mip by projected size → compare). (Both bot-gated to curl; snippets confirm content.) MED — good spec references for our GPU brick; we already implement the integer-log2 mip selection.
- miketuritzin.com "Hierarchical Depth Buffers" (2020): Hi-Z construction details + reverse-Z unprojection of HiZ texels (used for ray marching start); MED (relevant if we ever ray-trace against HiZ or unproject corners instead of testing nearest-corner in view space).
- **Verdict:** reading list; no immediate code change.

### 2.6 Kitware — "WebGPU Occlusion Culling in VTK" (blog, Aug 29 2024; T. Clabault, L. Givord, T. Galland, F. Mazen)
- **URL:** https://www.kitware.com/webgpu-occlusion-culling-in-vtk/ (fetched).
- **Core idea:** Two-pass **history feedback** occlusion culling in WebGPU compute: render previous frame's visible objects into a depth prepass; build mip chain; per-object test = project bbox → pick mip where the screen rect is **2×2 texels** → 4 fetches; depth of the object approximated by its **front-most point**. Benchmarked in Bistro vs OpenGL CPU frustum culling; implemented as a `vtkWebGPUComputeOcclusionCuller` (compute classes from their earlier post). No reprojection.
- **Applicability:** HIGH — this is an *independent, non-game-engine* implementation of exactly our @rune/gl design (two-pass HZB, compute cull, 2×2 mip selection, no reprojection). Use as: (a) external validation/reference numbers; (b) the "front-most point" vs our "nearest-corner" conservative choice — front-most point is *less* conservative (tighter), which trades parity-safety for cull rate; our nearest-corner stays the right choice for pixel-hash parity, but we should measure the gap.
- **Measure:** GPU timer + cull-rate; run both corner rules behind a flag and count verdict differences in the parity harness (expected: nearest-corner never over-culls).
- **Verdict:** implement-now (as reference + one A/B flag experiment).

### 2.7 CHC++ (Mattausch, Wimmer, Bittner — EG/CGF 2008) + temporal-coherence line
- **URL:** cg.tuwien.ac.at page (+ 10-page PDF).
- **Core idea:** Hardware occlusion queries made useful: BVH front-to-back traversal with a **priority queue** of nodes; query only when a node's *estimated* screen coverage exceeds a threshold; **bounded random persistence** — a node found visible is kept visible for a random bounded number of frames (this is the "mailboxing"/lazy re-query trick), flattening query bursts; occluders are the previously-visible set. CHC+RT extends to ray tracing (out-of-core scheduling).
- **Applicability:** MED-HIGH — this is the *theoretical basis* of our hysteresis pass (streak/32 + K frames) and of the amortized still-camera culling. Directly stealable: (a) **jittered (randomized) re-query intervals** instead of fixed K — decorrelates verdict flips across objects, smoothing the compaction's variance (our bitonic sort loves stable counts); (b) coverage-threshold query scheduling for the **WebGL2 TF fallback** path where "queries" are expensive (CPU verdicts): only re-test objects whose projected area exceeds a threshold — others ride the hysteresis verdict.
- **Measure:** frame-time variance + verdict-flip counts across a scripted camera orbit; query-count/frame.
- **Verdict:** implement-now (scheduling change only, no data structures).

### 2.8 Svensson — "Occlusion Culling on the GPU: Inner Conservative Occluder Rasterization" (MSc thesis, DiVA portal, 2016; also an HPG-style short)
- **Core idea:** For occluder rasterization, *inner* conservative rasterization (only pixels certainly inside the occluder) guarantees **no over-occlusion** — the complement of the usual "outer" conservative rasterization used for e.g. collision. i.e., **"conservative occlusion rasterization is not the same as conservative triangle rasterization"** (echoed by Pesce §2.7). Shaves occluders inward so any query verdict of "occluded" is provably correct even with coarse resolution/quantization.
- **Applicability:** MED-HIGH — directly de-risks our parity gates: our 256×256 occluder raster + 2×2 MAX-reduce + nearest-corner test is already approximately inner-conservative (nearest corner = farthest? careful: nearest corner is the *most-visible* point, so culling requires even the nearest corner behind → conservative-safe). The thesis formalizes the *raster side*: our box raster should snap edge coverage inward (only certainly-covered pixels written) — then pixel-hash parity ON/OFF becomes provable rather than empirical. Also pairs with threadlocalmutex's jitter filtering (§1.2) for the residual quantization risk.
- **Measure:** adversarial parity test set (thin/tilted occluders, sub-pixel geometry); count over-cull incidents = 0 with inner-conservative snap.
- **Verdict:** implement-now (1-day hardening change; great fit with our parity culture).

### 2.9 Pesce (c0de517e) — "Half baked: Dynamic Occlusion Culling" (blog, Mar 15 2023) + gist "Don't even dream of reprojecting last frame depth" (Oct 23 2023)
- **URL:** http://c0de517e.blogspot.com/2023/03/half-baked-dynamic-occlusion-culling.html (fetched); gist on gist.github.com (Oct 23 2023; URL not resolvable from search results — search title).
- **Core idea:** A design-space walk for dynamic worlds (Roblox constraints: no authored occluders, everything can move, low-end targets): real-time (CPU raster / GPU query / GPU-driven) vs incremental (PVS caching and its *validity* problem — raster sampling can't prove a PVS is right). Then a prototype: **generate world-space occluders from the previous frame's depth** — downsample, build a heightfield quad-mesh, **cut it at depth discontinuities** (edge detection: neighbor 3D-distance test, then point-to-plane distance to keep glancing-angle connected geometry) so each tile is a single valid plane occluder for the set of views it was generated from. On reprojection: Crytek's "coverage buffer" (Aaltonen/Kaplanyan lineage — vendor, excluded) point-splats depth to the next camera, creating holes (disocclusion, frame edges, gaps) filled by dilation — accepting false-positives-but-correct frames; the gist's point: only **gather**-based reprojection (SSR-style) is sound, splat is not.
- **Applicability:** MED — (a) validates our **no-reprojection, history-feedback** choice (holes/validity argument); (b) the depth-discontinuity-cut occluder tiles are a future "auto-occluders" path: reuse our z-prepass → make per-tile plane occluders for the *CPU* `softwareOccluder` in scenes with no authored occluder boxes; (c) his framing of "conservative occlusion raster ≠ conservative triangle raster" matches §2.8.
- **Measure:** prototype offline: measure CPU-occluder efficacy (cull rate) from generated occluders vs authored boxes on the city demo; parity gate ON/OFF.
- **Verdict:** later (R&D experiment; low risk, gated behind a flag).

### 2.10 Lee, Kim, Eisemann — "Iterative Depth Warping" (ACM TOG 37(5), 2018)
- **Core idea:** WOC: reproject/warp last frame's depth to the current camera *iteratively* (multiple refinement iterations) for occlusion culling of dynamic scenes with large camera motion; axis-aligned bound tests against the warped depth. State-of-the-art in the "reprojection" branch per HROC's comparison.
- **Applicability:** MED — if we ever outgrow two-pass HZB under fast camera motion (our HZB history feedback lags one frame by design), iterative warping is the non-vendor, peer-reviewed upgrade. Cost: warp pass + iterations; complexity risk for parity (holes).
- **Verdict:** later (only if motion-heavy demos show HZB lag costing cull rate).

### 2.11 Classic gems (pre-2010, little-known-but-applicable)
- **Zhang, Manocha, Hudson, et al. — "Occlusion Culling Using Hierarchical Occlusion Maps" (SIGGRAPH 1997, UNC):** HOM = opacity pyramid + depth estimates; the original *coverage pyramid* occlusion test. MED: our 2×2 MAX pyramid is the depth analog; the opacity/coverage pyramid (fraction of covered pixels per tile) is a cheap *additive* confidence signal for hysteresis (area-weighted verdicts) — could refine streak thresholds.
- **Bittner & Havran — "Exploiting Coherence in Hierarchical Visibility Algorithms" (JVCA 2001):** coherence cache of visibility queries on hierarchy nodes (the intellectual root of verdict caching + lazy re-query). LOW-MED.
- **Bartz, Klosowski, Stanek — "Tighter Bounding Volumes for Better Occlusion Culling Performance" (WSI TR 2005):** k-DOP-style tighter volumes → better cull rates per query. MED: our BVH refit could optionally produce screen-space-tight bounds (OBB) for the occlusion test only; measure verdict flips.
- **Hey & Tobler — "Real-Time Occlusion Culling with a Lazy Occlusion Grid" (2001):** lazy grid; LOW.
- **Coorg & Szeliski (1997):** large-occluder fusion + temporal caching of occlusion *relations*; LOW-MED (we do spatial occluder selection instead).
- **Egbert et al. — Horizon Occlusion Culling (2002, BYU):** horizon-based culling for terrains; LOW for box city, MED if a terrain demo lands.
- **Staffans — "Online Occlusion Culling" (MSc thesis, Åbo Akademi 2006, jstaffans.github.io/thesis.pdf; fetched):** survey + implementation of query-based online OC (incl. NOHC); good single-document background for the WebGL2 fallback path. LOW-MED.
- **Grundhöfer et al. — "LOD-Based Occlusion Culling for Dynamic Scenes" (Weimar, ~2010; non-conservative OC):** accepts small errors for speed; LOW (conflicts with parity culture).
- **"Patch-Based Occlusion Culling for Hardware Tessellation" (2014):** patch-level Hi-Z + temporal coherence; LOW-MED (meshlet analog, gated behind academia.edu).
- **"Towards Adaptive Occlusion Culling in Real-Time Rendering" (2021):** adaptive query intervals; MED — same family as CHC++ scheduling; fold into 2.7.

### 2.12 Modern/adjacent (2022–2026)
- **Unterguggenberger, Kerbl, Pernsteiner, Wimmer — "Conservative Meshlet Bounds for Robust Culling of Skinned Meshes" (PG 2021, CGF 40(7); PDF fetched):** exact conservative spatio-temporal bounds (positions + normal cones) for meshlet frustum/backface culling under LBS animation. MED — methods transfer to our `clusterize` bounds + any skinned demo; "robust conservative bounds" discipline matches parity culture.
- **Neural Visibility for Occlusion Culling in 3D Gaussian Splatting (CVPR 2026):** learned visibility for GS raster; LOW (workload mismatch).
- **gamedev.net "Coverage Buffer as main occlusion culling technique" + Khronos forums thread (2017):** community implementations of C-buffer (prev-frame depth + bbox raster test); bot-gated; LOW-MED as non-vendor documentation of the vendor technique we already emulate.
- **GDC Vault "Why Render Hidden Objects? Cull Them With a Software Depth Buffer" (Intel, 2014-ish):** vendor-adjacent talk; historical context for Intel's sample only.

### 2.13 Excluded per source policy (noted for completeness)
- EA/Frostbite "Coverage Bitmasks for efficient Rendering Algorithms" (SIGGRAPH 2023 talk) — coverage-bitmask algorithm patterns; excluded (Frostbite/EA). The non-vendor equivalents (Greene §1.1, threadlocalmutex §1.2, MOC §2.1) cover the same ground.
- Crytek "Secrets of CryENGINE 3" (Sousa/Kasyan/Schulz 2011 — the C-buffer/HZB lineage our engine already cites as Aaltonen-style), Guerrilla "Practical Occlusion Culling in Killzone 3" (2011), NVIDIA GTC "GPU Driven Large Scene Rendering" (Boudier & Kubisch 2015 — the "ROC" baseline HROC improves), ARM compute Hi-Z sample, Unreal/Unity docs. Also bazhenovc.github.io "GPU Driven Occlusion Culling in Life is Feudal" (2017) — personal dev blog, but the site currently 404s (use Wayback); same pipeline shape as @rune/gl (SW raster of occluders to downscaled depth on GPU + HiZ + compute cull); MED; use as external reference once reachable.

---

## 3. Cross-cutting synthesis for rune

**CPU `softwareOccluder` (TypeScript):**
1. Inner loop: Dyrkorn/ryg incremental fixed-point edge stepping (§1.6, §1.3).
2. Block skip: Greene 2-level masks or threadlocalmutex quantized edge→64-bit mask table (§1.1, §1.2); bin/tile conservative traversal for large quads (§1.4).
3. Buffer representation: MOC masked/layered tiles + buffer merge (§2.1); depth = 1/w.
4. Correctness: inner-conservative snapping (§2.8) + N-frame sub-pixel jitter streak filter (§1.2 §post 163) — makes pixel-parity provable and kills quantization over-cull.
5. Query: keep nearest-corner (conservative); A/B front-most point per Kitware (§2.6).

**GPU @rune/gl pipeline:**
6. Two-plane (min/max) Hi-Z mips (§2.4/§2.5) — fewer false-visible verdicts; small kernel change.
7. Group-then-refine culling with clusters (§2.2) + occluder filtering via item/id buffer (§2.2) — big kernel-work reduction at 10k+ objects; keep draw counts approximate (no readback).
8. Hysteresis: randomized bounded persistence + area-threshold scheduling (§2.7, §2.11-HOM area signal) — smoother compaction, fewer bursts; WebGL2 fallback gets the same scheduling.
9. Time-interval/motion-budget verdict expiry for the amortized still-camera path (§2.4 tz-pyramid concept).

**Measurement harness (consistent across all):**
- `bun` micro-bench: ms/frame raster+query at 10k occluders, 256×256; allocation counts (GC).
- Demo parity gate: occlusion-city ON/OFF pixel hash across 4 cameras (already exists) + adversarial thin-occluder scenes (new).
- GPU: timestamp-query durations for Hi-Z build, cull kernel, compaction; verdict-flip & over-cull counters (should be zero with §2.8).

---

## 4. Query log (z-ai web_search, saved as q*.json in this dir)
q01 pyramid-rasterization, q02 coverage-mask, q03 edge-block, q04b/c/d pyramid paper, q05 hiz-minmax, q06 recent-papers, q07 sw-occlusion-github, q08 chcpp, q09 coverage-buffer, q10 hroc, q11 iterative, q12 cuda-sw-rast, q13 mailboxing, q14 frozen, q18 pyramid retry, q19 tuwien, q20 exact SRO, q21 faster line/tri, q22 two-plane, q23 masked depth, q24 MOC pdf, q25 MOC repo, q26 MIT, q27 webgpu, q28 pyramid line, q29 pyramid repos, q30 hysteresis, q31 bazhenovc, q32 diva, q33 svensson pdf, q34 csail, q35 tz, q36 reprojection, q37 gist, q38 recent sweep, q39 span buffer, q40 js occlusion.

Fetched & parsed documents: HROC PDF (full), Masked Depth Culling PDF, tz-pyramid PDF, SRO report PDF, meshlet-bounds PDF, Staffans thesis PDF, Kitware post, threadlocalmutex ×2, Dyrkorn index+post, CuRast pub page, MOC repo README, TU Wien pub index (2010–2026), c0de517e post.

**Bottom line:** No single "pyramid rasterization 2025" paper surfaced, but the composite of (Greene masks + threadlocalmutex mask tables + TU Wien bin/tile masks + MOC masked tiles + HROC group-raster + two-plane HiZ) gives rune a concrete, low-risk upgrade path for both the CPU and GPU occlusion stacks, with parity-preserving by construction (inner-conservative + jitter + exact masks).
