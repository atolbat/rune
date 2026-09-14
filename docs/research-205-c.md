# Research Digest 205-c — Spatial Data Structures + Math Micro-Optimizations + Demoscene/Tiny-Scene Tricks

Date of research: 2026 (session). Agent: RESEARCH (no production code touched).
Engine context: "rune" — TS monorepo, WebGPU + WebGL2, SoA frustum culling over strided Float32Array, octree + BVH (dynamic refit, two-level picking w/ lazy tri-BVHs), spatial hash, Morton codes, mat4 w/ f16 buffers, softwareOccluder (CPU box raster → depth pyramid), Hi-Z GPU path, frame graph. JS realities: typed arrays, no SIMD, monomorphic hot loops, GC-sensitive.

Search method: ~20 `web_search` queries (plane-mask culling, transformed vs conservative AABB, binned SAH, compressed/quantized BVH, refit vs rebuild, float16, DemoFox, ryg, sizecoding, SoA typed arrays, sphere-cone, dynamic AABB tree, arXiv GR, Morton interleave, radix sort JS, WASM BVH…), plus ~15 direct page fetches (WordPress REST API used for fgiesen/bartwronski since WordPress.com front-end is JS-walled; jacco.ompf2.com is bot-walled 403).

---

## A. Frustum culling micro-tests

### A1. Cesium — "Fast Hierarchical Culling" (Kai Ninomiya, Aug 4 2015)
URL: https://cesium.com/blog/2015/08/04/fast-hierarchical-culling/
- Implements **plane masking** (Sýkora & Jelínek, "Efficient View Frustum Culling", 2007 — https://old.cescg.org/... the CESC "Efficient View Frustum Culling" writeup) **in JavaScript** for a BVH.
- Algorithm: for each node not already rejected, a 6-bit (32-bit int) mask records per plane "inside (0) vs intersecting (1)". Child tests **skip every plane the parent was fully inside**; traversal also stops entirely when a parent is outside, and skips all tests when parent fully inside. Cesium reports "significant performance impact" (their JS 3D-tiles BVH).
- Tri-state per plane is exactly what a p/n-vertex (center/half-extent + |plane.n|) test already returns for free — so the mask is nearly free to populate in our SoA culler.
- Also references the classic: **Assarsson & Möller, "Optimized View Frustum Culling Algorithms" (Chalmers 1999/2000)** — 4 optimizations: plane-coherency test (retest the plane that rejected last sibling first), octant test, masking, **TR-coherency (temporal)**: store per-object the plane that rejected it last frame, test that plane first this frame (cheap cross-frame coherence for static scenes / slow cameras).

### A2. ryg blog — "View frustum culling" (Fabian Giesen, Oct 17 2010)
URL: https://fgiesen.wordpress.com/2010/10/17/view-frustum-culling/ (fetched via WordPress REST API)
- Catalog of methods with op counts. **Method 2b (CSE)**: when transforming 8 AABB corners, the 96 multiplies collapse to **24** by computing `mat[i][j]*min/max` per axis once and reusing across the 4 vertices that share it (4x mul reduction; fold `+mat[i][3]` into the z-axis products).
- **Method 3 (partial homogeneous transform)**: if model-view is affine and projection is standard, throw away the z row: view-space z rides in w, near/far tested explicitly vs w — 96 FMAs → 72. Clip-space z recoverable later with one FMA (`z = k1*w + k2`) below the rejection branch (useful if the survivor feeds occlusion culling).
- **Method 4/4b (p/n-vertex)**: max/min over `min.x*p.x vs max.x*p.x` per axis, i.e. implicit most-inside vertex; center/half-extent form: `d = dot(c,n) ± Σ e_i*|n_i|`, min/max pair → tri-state (outside / inside / intersecting) with no branch per vertex. This is what @rune/core already does; **methods 2b/3 are the headroom we do not yet exploit** (they trade register pressure for muls — in JS the win is fewer float ops in a monomorphic loop).
- Also links Zeux's 5-part series (zeux.io/2009/01/31/view-frustum-culling-optimization-introduction/) which ends in clip-space tests; ryg specifically debunks the claim that p/n-vertex can't win.

### A3. ryg blog — "Some more frustum culling notes" (Oct 20 2010)
URL: https://fgiesen.wordpress.com/2010/10/20/some-more-frustum-culling-notes/
- **Sphere-cone (frustum-as-cone) is usually NOT a win**: cone cross-section is ~64% larger than the frustum rect at 4:3 and **~84% larger at 16:9**; false positives swamp the saved cycles once you count per-draw submission cost (~1000 cycles) vs ~50 cycles saved. Useful counter-evidence to "cheap cone test" folklore.
- **Grouping advice**: flat hierarchy + **large fan-out** (8-16) beats binary trees on cache lines & mispredicts; build binary then merge nodes; at each subdivision just test 5-8 candidate splits and pick best (no exhaustive search).
- **Screen-space bbox as by-product**: if tests work in clip space, computing a 2D screen bbox is nearly free; use it for LOD/screen-size rejection and coarse occlusion; **then the far-plane test can be dropped entirely** from per-batch culling (screen-size < threshold replaces it).
- Endorses "get center along axis / radius along axis" primitives as the unifying trick (also core of SAT/GJK).

### A4. zeux.io — "View frustum culling optimization" series, esp. "Structures and arrays" (Feb 15 2009)
URL: https://zeux.io/2009/02/15/view-frustum-culling-structures-and-arrays/
- Switch intermediate layout **AoS → SoA** for the 8 corners: only 6 vectors needed, and **4 suffice** (x/y vectors shared across the two 4-point groups: `x X x X / y y Y Y / z z z z Z Z Z Z`).
- Dot product restructure: dot(plane, v) per 4 points becomes 3 multiplies + broadcast instead of gather; the series also has "Never let me branch" (branchless selection of min/max corners) and "Vectorize me" posts.
- For JS: same philosophy — keep boxes SoA in Float32Array, hoist plane broadcasts out of the inner loop, make the per-plane test branchless (`dMin>0 ? inside : dMax<0 ? outside : inter`) via arithmetic select or by two compares into a small int; JS has no SIMD but the fewer loads/branches still matter for monomorphic JIT code.

### A5. bruop (Bruno Opsenica) — "Frustum Culling" (Dec 24 2020) + "More (Robust) Frustum Culling" (Feb 17 2021)
URLs: https://bruop.github.io/frustum_culling/ , https://bruop.github.io/improved_frustum_culling/
- 2020 post: cheap test = project OBB corners (pick min/max corner **by sign of plane components**) — author later issued a correction: **this sign-pick trick has false negatives for OBBs** (edge-on cases → objects flicker out of view). Fix (2021): **SAT between frustum and OBB**: 26 candidate axes (3 OBB face normals, 5 frustum face normals [near/far anti-parallel → one], 18 edge×edge cross products: OBB axes × {up, right, 4 frustum edge dirs}).
- Lesson for us: the p-vertex test with `|n_i|` is **exact for AABBs vs plane** (our case — safe), but the moment we add any oriented/transformed volume (e.g., per-instance rotated OBB, or bounding "shear" cases), sign-selection near ±axis-aligned plane normals is numerically unstable and can cull visible objects → needs SAT or a conservative fallback. Great source of **parity-gate test vectors** (their edge-on diagrams).

### A6. Outerra — "View Frustum Culling of Sphere-mapped Terrain" (Nov 17 2012)
URL: https://outerra.blogspot.com/2012/11/view-frustum-culling-of-sphere-mapped.html
- p/n-vertex center/half-extent test (RTR-style) applied to **sheared quadtree tiles** on a sphere: transform the plane into tile space and account for the dominant **shear** by extending the extent projection — cheap "parallelogram" test, cheaper than full OBB. Niche trick; applicable only if we ever cull non-axis-aligned static tiles (e.g., heightfield patches, impostor cards). Low priority but a nice trick to keep in the notes.

### A7. Cesium — "Tighter Frustum Culling and Why You May Want to" (Feb 2 2017)
URL: https://cesium.com/blog/2017/02/02/tighter-frustum-culling-and-why-you-may-want-to/
- Introduces the **"culling volume"** metric (the volume you falsely keep vs the true object) and compares sphere vs AABB vs OBB; sphere culling volume is huge for elongated objects (aircraft), motivating mixed volumes per object type. Could not fully fetch the body (CDN), but the metric idea is directly usable for our bounding-volume choice policy (particles: spheres; city boxes: AABBs; long beams: OBB or split).

### A8. Bart Wronski — "Cull that cone!" (Apr 13 2017)
URL: https://bartwronski.com/2017/04/13/cull-that-cone/ (fetched via WP API)
- Exact **cone-vs-sphere** test (no sqrt of full vector, branch-free boolean combination):
  `V = s.c - origin; VlenSq = dot(V,V); V1 = dot(V, forward);`
  `closest = cos(a)*sqrt(VlenSq - V1*V1) - V1*sin(a);`
  `angleCull = closest > s.r; frontCull = V1 > s.r + len; backCull = V1 < -s.r;`
  visible = !(any). Trick is "flip the problem": test the *tile's/cluster's* bounding sphere against the cone instead of cone-vs-AABB/frustum — often better than plane tests for large primitives vs small frusta.
- Directly usable for spotlight/VFX emitter culling in our vfx carousel if/when it does tiled light culling. Companion niche posts: lxjk "Improve Tile-based Light Culling with Spherical-sliced Cone" (2018), Simon Coenen "Optimizing spotlight intersection in tiled/clustered culling" (2019).

### A9. cbloom — "View Culling" techdoc (Oct 31 2000)
URL: http://www.cbloom.com/3d/techdocs/culling.txt
- Old but little-cited gem set: **trinary return** propagation through the hierarchy; **bounding sphere stored as radius only** (world sphere = MTW translation, free — never invalidated by rotation; update spatial index only on translation); cone-of-spheres culling for groups; temporal-coherence retest. Pure-translation objects being "cull-stable" is a cheap invariant our culler could exploit for static-city instancing.

---

## B. BVH research

### B1. Prokopenko — "Revising Apetrei's BVH construction algorithm to allow stackless traversal" (arXiv:2402.00665, v2 Dec 21 2024)
URL: https://arxiv.org/abs/2402.00665
- **Stackless traversal** via left-child + **escape index (skip connection)**; normally needs an extra traversal during build. Shows how to get it **in a single bottom-up pass** for Karras 2012 LBVH, and — the novel part — **modifies Apetrei 2014 (extended-Morton / "a-triangle", 2 Morton codes per triangle → better-quality LBVH) to restore Karras's internal-node ordering** so the same single-pass trick works.
- Applicability: our Morton build could emit escape indices for free → **stackless (or small fixed "shortstack") ray/point/sphere queries & picking** in the two-level BVH; also a published route to Apetrei-quality Morton BVHs.

### B2. Karras 2012 / Apetrei 2014 / PBRT4 §4.3 (background)
- Karras "Maximizing Parallelism in the Construction of BVHs, Octrees, and k-d Trees" (2012): 30-bit Morton codes, radix sort, `clz`-based longest-common-prefix splitting, O(n) single pass. NVIDIA dev blog "Thinking Parallel, Part III" (2012) is the accessible writeup.
- Apetrei 2014: **two Morton codes per triangle** (from min/max corner) — internal nodes may own one triangle, SAH noticeably better at nearly the same cost.
- PBRT 4 §4.3 (pbr-book.org): binned SAH (Wald 2007) + LBVH + **HLBVH** (build Morton tree fast, then re-partition top levels with SAH — cheap quality fix worth copying: SAH-refit only the top ~32 nodes).

### B3. Jacco Bikker — "How to build a BVH" series (2022) + "BVH Quality: Beyond SBVH" (May 20 2025)
URLs: https://jacco.ompf2.com/2022/04/26/how-to-build-a-bvh-part-4-animation/ (403 to bots; indexed by search), https://jacco.ompf2.com/2025/05/20/bvh-quality-beyond-sbvh/
- Part 4 "Animation": the practical **refit-vs-rebuild cadence**: refit every frame, measure **SAH degradation**, rebuild (binned SAH) when quality drops below threshold; amortize by rebuilding subtrees ("selective rebuild"). Working C# code in the series.
- 2025 post: "Full-sweep SAH is ground truth. Binning is an approximation… full-sweep will always be better than binned" — quantifies the quality gap and argues about BVH quality metrics (also a rant on ray-tracing-specific quality measures). Useful when choosing our build: binned SAH (fast, approximate) + periodic top-level full sweep.

### B4. Grauer et al. — "Minimizing Ray Tracing Memory Traffic through Quantized/8-Wide BVH Ray Stream" (arXiv, May 30 2025; PDF at jo.dreggn.org — author is a demoscener)
URL: https://arxiv.org/... (via search), PDF: https://jo.dreggn.org/ (2025_rays.pdf path)
- **8-bit fixed-point quantization of geometry and BVH nodes in node-local coordinate systems**; 8-wide nodes; ray streams; memory traffic reduced to **18% of traditional** traversal. Related: Ylitie et al. 2017 "Efficient Incoherent Ray Traversal on GPUs through Compressed Wide BVHs" (Aalto; compressed 8-wide BVH + compressed traversal stacks); Embree QBVH8 (136-byte quantized 8-wide nodes); UC Davis "Accelerated Single Ray Tracing for Wide Vector Units" (AABBs packed to fit one vector op).
- JS applicability is limited (no 8-wide SIMD), but the **node-relative u8/u16 child bounds** idea directly shrinks BVH cache footprint — relevant for our model-viewer's lazy triangle BVHs (large meshes, cache-bound picking in JS). Dequant cost in JS may eat the win — must bench.

### B5. Dynamic AABB trees (writeups explicitly allowed)
- **Box2D "Balancing Dynamic Trees" (Erin Catto, Aug 7 2014)** https://box2d.org/posts/2014/08/balancing-dynamic-trees/ — without rotations a dynamic AABB tree degenerates (100 boxes along x → linked list; deep stacks for queries); Bullet-style random removal/reinsertion took "thousands of iterations" to rebalance; Box2D uses **AVL-like rotations without ordering constraints** — cheap and bounded. Direct fit for our BVH dynamic refit: add a rotation pass on the refit path.
- **slembcke.net "AABB Tree Shootout" (Jan 17 2023)** https://www.slembcke.net/blog/TreePerf — measured, modern take:
  - Box2D fat-AABB tuning is **scale- and velocity-sensitive**: baseline 45ms; 1/10 speed 42ms, 10x speed 120ms; 10x size 41ms, **1/10 size 280ms** (padding tuned for SI units).
  - Chipmunk cpBBTree: **collision-pair caching** (web of pair nodes, ~quadruply linked list updated during tree update instead of re-query) + **padding as percentage (10%)** → 12ms (3.75x faster), but high variance; 10x speed → 284ms.
  - **DriftRTree (R-tree, wide nodes)**: 14ms with **much lower variance, unaffected by scale and nearly unaffected by velocity**; threaded pair generation → 3ms. "In 202X binary trees are bad for cache: information density too low" — wide nodes put **all child bounds in one cache-friendly block**, tree is short, semi-self-balanced; splits have real spatial information to use.
  - Also: spatial hash wins when object sizes are uniform & tuned, degrades badly with mixed sizes (matches our spatial hash reality).
- **Sebastian Sylvan — "R-trees: adapting out-of-core techniques to modern memory hierarchies"** (blog + GDC talk, gdcvault "R-Trees — Adapting out-of-core techniques…") — R-tree blocks sized to cache lines; incremental restructuring ops. (Site 404s on deep fetch; accessible via GDC Vault page & slembcke's summary.)

### B6. arXiv / JCGT / HPG scan 2024-2026
- "Revising Apetrei…" (B1) — the standout for us.
- N-BVH "Neural ray queries with BVHs" (ACM 2024) — neural, skip.
- Nishimura 2021 "Grid-induced BVH" (Springer) — grid-induced hierarchy avoiding per-frame refit for dynamic scenes (deformables) — niche, later.
- zeux.io "Measuring acceleration structures" (Mar 31 2025) — methodology: how to actually measure AS build/trace tradeoffs (build quality vs traversal; relevant to designing our BVH benches honestly).
- Feldmann "Accelerated Ray Tracing using R-Trees" (Fraunhofer) — R-tree as ray AS, complements B5.

---

## C. Morton codes & sorting

### C1. forceflow.be — "Morton encoding/decoding through bit interleaving" (Oct 2013) (+ ryg "Decoding Morton Codes", Dec 2009)
- The standard **bit-spread magic-constant interleave** (5 mask steps for 32-bit 2D; more for 3D 96-bit), with "big-endian vs little-endian" Morton variants and C sources; ryg's post covers the *decoding* direction and the generalization: for a 1:3 interleave use shift distances **3*2^n**, plus the "compact"/companding variants. If our Morton codes are ever decoded back to coordinates (octree hashing, debug viz, bucketing), ryg's decode is the reference.
- Karras-style **common-prefix via clz** is the key build primitive (see B2).

### C2. Duvanenko — "Faster Sorting in JavaScript: LSD radix sort" (duvanenko.tech.blog, Jun 2017)
URL: https://duvanenko.tech.blog/2017/06/15/faster-sorting-in-javascript/
- LSD radix sort on numeric arrays: claims **5–34x faster than builtin sort up to 50M elements** (16x up to 30M ints). Benchmarks are contested (vs `.sort` with comparators), but the structural point stands: for **u32 Morton keys**, a 4-pass 8-bit histogram radix with preallocated Uint32Array buckets is zero-alloc and avoids comparator call overhead entirely. Also jasondavies/radixsort.js gist as a small reference.
- For our Morton sort (octree/BVH builds, "Morton order culling" sweeps over the city demo), this is the JS-native equivalent of the Karras radix sort.

---

## D. JS engine realities (SoA/typed arrays)

### D1. royalbhati — "Why Object of Arrays beat interleaved arrays: a JavaScript performance issue" (Dec 23 2025; HN Jan 2026, 46 pts)
URL: https://www.royalbhati.com/posts/js-array-vs-typedarray (JS-rendered; content corroborated via HN thread https://news.ycombinator.com/item?id=46574989)
- **Array-of-objects with double fields makes V8 allocate millions of out-of-line "HeapNumber" boxes** (Chrome-specific; SpiderMonkey NaN-boxes doubles in-place) → GBs of RAM and slow access. Fix: SoA with TypedArrays.
- The interesting subtlety for us: the article's point is **SoA (separate typed arrays per field) beat a single interleaved typed array** in the workload shown. HN reader numbers (Firefox): AoS 2951ms, **SoA 1624ms**, interleaved 1961ms. I.e., interleaved AoS-in-one-buffer sits in between — strided access costs vs separate streams; the exact ordering depends on access pattern (if you always touch all 6 floats per box, interleaved can win; if you touch subsets per pass, SoA wins).
- Caveat (from the article's own snippet): "the difference between a well optimized regular array and a TypedArray was negligible, sometimes within margin of error" — the TypedArray advantage shows under memory pressure / GC.
- Actionable: our culler reads all 6 floats per box per plane-batch → interleaved-in-block (e.g., 64-byte per-box blocks for cache lines) vs pure SoA should be A/B tested in a bun microbench; and **any array-of-object AABBs anywhere in the render path must go** (HeapNumber boxing + GC).

---

## E. Demoscene / tiny-scene / math gems

### E1. ryg — "Optimizing the basic rasterizer" (Feb 10 2013)
URL: https://fgiesen.wordpress.com/2013/02/10/optimizing-the-basic-rasterizer/ (WP API fetch)
- Edge-function (half-plane) rasterization vs scanline: embarrassingly parallel, orientation-independent, arbitrary sample positions — plus **incremental update of edge functions per pixel-step (2 adds, no multiplies)** after the per-edge setup (2 muls, 5 subs); earlier posts in the series handle **integer overflow, sub-pixel (fixed-point) precision and fill rules** (top-left rule) so the raster is deterministic and hole-free.
- Directly the reference for our **softwareOccluder** (CPU raster of box front-faces into the depth pyramid): box faces are 2 triangles → edge functions, incremental stepping, hierarchical Z write to the pyramid, and guard-band clipping conventions. Pair with the whole series' index post ("A trip through the graphics pipeline" adjacent).

### E2. lisyarus — "Implementing a tiny CPU rasterizer" parts 1–6 (Nov 2024–2025)
URL: https://lisyarus.github.io/blog/posts/implementing-a-tiny-cpu-rasterizer-part-4.html
- Modern, careful writeup of viewport/NDC conversions, **perspective divide and near-plane/w=0 handling**, clipping in homogeneous space, fixed-point sub-pixel precision. Tutorial-grade but very clean; useful as a correctness reference for the softwareOccluder's clip path (e.g., what to do when a box crosses the near plane: cheap version = reject, conservative version = clamp).

### E3. Sizecoding / demoscene sources
- **sizecoding.org wiki** — rasterizer + math pages; "Design Tips and Demoscene effects with pseudo code" (Jul 2025 update); Resources page links the Hugi diskmag articles (fixed-point perspective, texture-mapping gems of the 90s). Mostly x86/DOS-specific; the transferable ideas for us: **reciprocal-of-w via Newton-Raphson on a table seed** and **fixed-point (16.16) edge stepping** — the latter is exactly what ryg formalizes with sub-pixel precision.
- **coranac (Cearn) — "Another fast fixed-point sine approximation"** (Jul 2009, GBA/tonc): quadratic/cubic sine approximations good to ~1e-3 with 3-4 ops — cute, but we have no sine-bound hot loop; skip.
- DemoFox.org — surveyed: content is interpolation/Bezier/Distributions (e.g., (ab)using GPU lerp hardware to evaluate Bezier curves, 2018). Clever, but no current brick in our engine consumes it (vfx carousel uses curves? — if spline particle motion ever shows up, his "Bezier via linear interpolation" and Catmull-Rom↔Bezier conversion posts become relevant). Low.

### E4. FP16 / precision
- **MJP — "Half The Precision, Twice The Fun: Working With FP16 in HLSL" (The Danger Zone, Oct 2019)** https://therealmjp.github.io/posts/shader-fp16/ — the practical field guide: two paths (relaxed `min16float` vs true 16-bit), what drivers actually do, denormals, and **when fp16 is safe (short-range/local quantities) vs unsafe (world-space coordinates, accumulated sums)**. For our f16 buffers: keep transforms camera/local-relative, keep the world offset in f32; WebGPU needs `enable f16` (and WebGL2 fallback has no fp16 math at all — only storage). 
- **Nick Higham — "Half precision arithmetic: fp16 vs bfloat16" (Dec 2018)** https://nhigham.com/2018/12/03/half-precision-arithmetic-fp16-versus-bfloat16/ — the precision/range tables (fp16: 10-bit mantissa, max 65504, min normal 6.1e-5; catastrophic precision cliff beyond ~2048 for 1-unit resolution). Reference for writing the f16 range policy + a "precision gate" unit test.
- **Catastrophic cancellation in matrix inverse**: general numerics sources (Goldberg's "What Every Computer Scientist Should Know…" via Oracle docs; math.stackexchange examples) — the graphics-specific guidance is thin in this cluster; the applicable rule for our mat4 inverse: compute the determinant via the cofactor branch with the largest pivot (or pivot by row/column permutation), and if |det| < ε·scale², fall back to a pseudo-inverse/translation-only path rather than dividing by a denormal. I did not find a 2023-2026 niche post specifically on "cancellation in mat4 inverse" — the best available practical treatment remains Goldberg + Higham's Accuracy and Stability of Numerical Algorithms; flagging as a gap (opportunity for us to write the niche post after benchmarking).

---

## F. Cross-cutting / related (kept for the record)
- Zeux 2025 "Measuring acceleration structures" — bench methodology for BVH build-vs-traverse (use for our BVH bun benches: report queries/op AND build ms AND tree quality (SAH), not just one).
- GPUOpen "Subspace Culling for Ray-Box" — vendor research page, out of policy scope (excluded).
- Intel "Software Occlusion Culling" sample (SSE raster + depth pyramid) — classic ancestor of our softwareOccluder; the ryg rasterizer series (E1) is the better modern reference (kept Intel out per source policy preference for personal/research sources).
- "8-byte BVH" as literally-8-byte-nodes: no credible hit; nearest neighbors are the quantized-node works in B4 (96-136 byte 8-wide compressed nodes). The term-of-art is "compressed/quantized wide BVH".

---

## G. Ranked shortlist (see final message) — with measurement plans

1. **Plane-mask inheritance in octree/BVH cull traversal** (A1, + A2/A3's tri-state) — @rune/core culler. Measure: bun microbench (occlusion-city octree, 10k boxes, camera sweep); count plane-tests as metric; parity: identical visible-set bitset vs current impl.
2. **CSE / drop-z micro-opts in the homogeneous test path** (A2) — if/when we do clip-space culling for draw submission. Measure: bun microbench on the transform+cull kernel; parity gate on visible set.
3. **Wide-node (R-tree style) BVH blocks** (B5 slembcke + Sylvan) — dynamic BVH refit + picking. Measure: bun bench (update ms, query ms, variance p50/p99) on dynamic demo; parity: same query results.
4. **Stackless escape-index build from Prokopenko 2024** (B1) — Morton build + picking traversal. Measure: build ms (one pass emits skip indices), query stackless vs stack; parity: identical intersection lists.
5. **Refit cadence + SAH-degradation-triggered subtree rebuild** (B3) — dynamic refit. Measure: frame-time over animation loop + SAH value trace; parity gate.
6. **Tree rotations during refit** (B5 Box2D) — degeneration guard. Measure: max-depth / query-time variance under "row of boxes" insertion pattern stress test.
7. **LSD radix sort on Morton keys** (C2) — builds. Measure: bun microbench vs `sort` on (morton,idx) Uint32Array pairs at 10k/100k/1M.
8. **Edge-function incremental raster for softwareOccluder** (E1) — softwareOccluder brick. Measure: bun bench raster ms at 256²/512² pyramid; pixel-identical depth output (parity gate) vs current.
9. **SoA-vs-interleaved audit + per-box-block cache experiment** (D1) — @rune/core data layout. Measure: bun microbench of the cull inner loop in both layouts; also count allocations (should be 0).
10. **Temporal plane-coherency (TR test)** (A1 Assarsson-Möller, A9) — static scenes. Measure: cull ms on slow-camera bench; parity gate.
11. **SAT fallback for any oriented volume + edge-on test vectors** (A5) — correctness. Measure: unit tests (parity), no perf change for AABB path.
12. **Cone-vs-sphere exact test** (A8) — vfx/light culling. Measure: units + (if light culling exists) bench vs plane tests.
13. **u8/u16 node-relative quantized child bounds** (B4) — later. Measure: cache-miss proxy (bench on 1M-tri BVH picking), dequant overhead.
14. **f16 range policy + precision gate** (E4) — f16 buffers. Measure: tolerance-based parity gate on transformed positions at extreme camera offsets.
15. **Sphere-only rotation-invariance for translated instances** (A9) — later/nice-to-have.
