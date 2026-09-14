# Research Digest 205-b — GPU compute / particles / sampling / transparency

**Agent:** RESEARCH (no production code changes)
**Scope:** prefix-scan advances, stream compaction, GPU sorting 2022–2026, particle techniques from niche sources, OIT research 2021–2026, blue-noise sampling, depth precision, WGSL-specific optimization.
**Method:** 26 web searches (z-ai web_search) + direct fetches (Linebender wiki, GPUPrefixSums README, raphlinus blog, GPUOpen article, Contini thesis page, evanvoodoo particle post). Source JSONs saved as `s1.json`–`s32.json` in this directory.
**Engine context (applicability judged against):** rune — TS monorepo, WebGPU + WebGL2 dual backend, bun tests/benches; @rune/core (bitonic+Stockham sorts, gpgpu helpers, noise, frame graph); @rune/gl (Hi-Z occlusion culling w/ WGSL compute, compaction, multidraw, particles: compute or TF ping-pong, 40k demo, depth soft particles, atomics emit/spawn, CPU fallback); pixel-parity culture; JS realities (typed arrays, no SIMD, monomorphic hot loops).

---

## A. Prefix scan & compaction

### A1. Decoupled Fallback: A Portable Single-Pass GPU Scan
- **Authors/Venue/URL:** Turner Smith (b0nes164), HPG 2025 (dl.acm.org, cited by 2); code: github.com/b0nes164/GPUPrefixSums (CUDA, D3D12-HLSL, Unity, **WGPU/WGSL** per repo description); live WGSL development in **Vello** (github.com/linebender/vello). Year: 2025 (paper), repo 2023–2025.
- **Core idea:** Chained Scan with Decoupled Lookback is single-pass (each workgroup publishes its tile reduction via an atomic flag, then lookbacks spin-wait on predecessors), but it formally requires (a) forward-progress guarantee (FPG) across workgroups and (b) acquire/release atomics — both absent in WGSL. Decoupled Fallback adds: each spinning workgroup counts spin cycles; on exceeding a budget it **recomputes the missing prefix itself** (work stealing), races other blocks via **atomic compare-and-swap**, and only one winner broadcasts the reduction. Redundant work bounds latency; no deadlock on no-FPG hardware (Apple Silicon, tiled GPUs); performance close to plain Decoupled Lookback. This is *the* portability trick for single-pass scans in WebGPU.
- **Applicability: HIGH.** Brick: `@rune/gl` gpgpu helpers + `@rune/core` sorts. Today we use multi-pass reduce-then-scan inside bitonic/Stockham and compaction; a single-pass chained scan with Decoupled Fallback removes 1–2 full-buffer re-reads (Raph Levien measures decoupled lookback ~1.5× faster than tree-reduction scan end-to-end, ~50% faster scan, ~16% end-to-end pipeline). WGSL reference exists (Vello) to transliterate; the flag word + payload packing fits our u32-atomics constraint.
- **Measure:** GPU timestamp-query around scan dispatches at N ∈ {40k, 256k, 1M} vs current multi-pass scan (bun-driven headless bench harness, per-backend); correctness parity: scan output is deterministic → exact-match gate (typed array compare in bun test).
- **Verdict: IMPLEMENT-NOW candidate.** Single biggest compute primitive upgrade; WGSL-ready reference; WebGPU-only, WebGL2 keeps multi-pass scan.

### A2. ScanBox: A Tunable and Portable GPU Prefix Scan (Vulkan + WebGPU)
- **Authors/Venue/URL:** James V. Contini, UCSC honors thesis (advisor Tyler Sorensen), June 2025; jamescontini.com (PDF) + github repo (WGSL + Vulkan). 99 pp.
- **Core idea:** Systematic study of scan tunables (workgroup size, items/thread, chained-tile length, scan kernel family: Hillis–Steele vs Blelloch vs chained) **benchmarked in-browser in WGSL**. Vulkan version reaches within 1% of CUB DeviceScan on RTX 4070, 1.5% on RX 7900 XT, and up to +43% vs CUB on small inputs (small-N matters for our 40k particles!). Also documents a real **subgroupBarrier bug in NVIDIA's Vulkan driver** he found and got patched — a caution for cross-vendor correctness testing.
- **Applicability: HIGH.** Brick: `@rune/gl` scan kernels; adopt its parameter-sweep bench methodology (bun + in-page GPU timer harness) as our standard for kernel tuning; his WGSL kernels are a known-good baseline to diff against.
- **Measure:** direct: replicate his throughput table on our hardware matrix (M-series, Adreno, desktop NV/AMD) with timestamp queries; target ≥ CUB-relative numbers from thesis.
- **Verdict: IMPLEMENT-NOW candidate** (methodology + reference kernels), paper as tuning playbook.

### A3. Raph Levien — "Prefix sum on portable compute shaders" (+ gpuweb#2229 "Atomic concerns", "coherent buffers" thread)
- **Authors/Venue/URL:** Raph Levien, personal research blog, Nov 17 2021, raphlinus.github.io/gpu/2021/11/17/prefix-sum-portable.html; github.com/gpuweb/gpuweb/issues/2229.
- **Core idea:** Decoded why decoupled lookback is hard portably: it needs a device-scope acquire/release (message-passing idiom) that Metal lacked, and WebGPU spec'd weaker barriers as a consequence; WGSL today has **relaxed-only atomics** (follows Vulkan memory model subset) — cross-workgroup publication without acquire/release is formally a data race, though real backends mostly behave. Also documents uniformity-analysis pain: the lookback loop must be uniform control flow (FXC rejected it; WGSL uniformity analysis is the successor).
- **Applicability: HIGH (as constraint knowledge).** Brick: design rules for ALL our atomics kernels (emit/spawn, grid build, compaction): keep cross-workgroup communication to monotonic atomicAdd counters; if using message-passing, use Vello's Decoupled-Fallback pattern and treat races as tolerable-bounded, document per-backend testing; keep WGSL uniformity analysis happy (loop on atomics with uniform trip structure).
- **Measure:** stress test: run scan/emit kernels 10k iterations across backends in bun+WGPU headless, assert output invariants each run (sums match, no hang — add watchdog timeout).
- **Verdict: IMPLEMENT-NOW as engineering rules** (fold into A1's implementation).

### A4. Stream compaction using wave intrinsics
- **Authors/Venue/URL:** N. Dion, Interplay of Light (personal blog), Dec 25 2022.
- **Core idea:** Compaction as: wave-level ballot (mask of valid lanes) + wave prefix-sum-of-mask gives per-lane output index in one shot, then only active lanes scatter. Without wave intrinsics (WGSL pre-subgroups), emulate with workgroup shared memory ballot — Linebender measured a **fake ballot where "warp"=16 beat 32** (ballot cost is O(warp) linear scan in shared memory).
- **Applicability: MED.** Brick: `@rune/gl` compaction (culling + dead-particle compaction). Upgrade path: (1) now — shared-memory ballot compaction, single dispatch per workgroup + small device scan; (2) when WebGPU subgroups ship — real ballot, drop to wave-level.
- **Measure:** GPU timer on culling-compaction pass (occlusion city demo), frame-time delta at 10k→200k draw items; parity: compaction is order-preserving in our usage → exact-match gate possible (use stable variant).
- **Verdict: later** (nice, small win) — implement when touching the culling kernel next.

### A5. Efficient Algorithms for Stream Compaction on GPUs
- **Authors/Venue/URL:** D. Bakunas-Milanowski et al., International Journal of Networking and Computing (IJNC), 2017.
- **Core idea:** Two compact algorithms; notably an **order-preserving** stream compaction variant and one optimized to reduce memory traffic vs classic Billelloch chain. Mostly superseded by wave-intrinsic approaches but useful for the order-preserving formulation.
- **Applicability: LOW-MED.** Reference for stable compaction invariants (needed to keep pixel parity for sorted-blend order after compaction).
- **Verdict: skip** (keep as citation only).

### A6. Red Hat developers blog — "Your first GPU algorithm: scan/prefix sum"
- **URL:** developers.redhat.com, Aug 15 2024. Vulkan compute tutorial with solid diagrams; decent onboarding doc, no new algorithm. **Verdict: skip** (docs value only).

---

## B. GPU sorting

### B1. Onesweep: A Faster LSD Radix Sort for GPUs
- **Authors/Venue/URL:** Mark Adelani, Martin Burtscher et al., arXiv:2206.01784 (2022); authoritative impl in NVIDIA CUB (agent_radix_sort_onesweep).
- **Core idea:** LSD radix with **single-pass digit-histogram scan** (decoupled-lookback based): ~2n global memory ops per 8-bit-digit pass; 4 passes for 32-bit keys. Uses warp-level multi-split for ranking. This is the algorithm our bitonic/Stockham comparison sorts should graduate to for large N.
- **Applicability: HIGH (large-N only).** Brick: `@rune/core`/`@rune/gl` sorts. At 40k particles bitonic is fine; at ≥256k (Hi-Z compaction batches, 1M particle stress) LSD radix wins big. Needs the A1 scan as its engine. Multi-split requires subgroups → use Linebender's fake-ballot (shared memory, "warp" 16) until subgroups ship.
- **Measure:** GPU timestamp: sort total time vs bitonic & Stockham at N ∈ {40k, 256k, 1M}; JS-side dispatch count (bun bench — radix = 4–8 dispatches vs bitonic's ~log² dispatches which also matters for dispatch overhead, see G5).
- **Verdict: implement-now candidate** (WebGPU path; keep bitonic for WebGL2 TF/small-N).

### B2. Linebender wiki "Sorting" (Raph Levien's WebGPU radix experiment + cautions)
- **Authors/Venue/URL:** Linebender community wiki (Raph Levien et al.), linebender.org/wiki/gpu/sorting — living page, 2023–2025.
- **Core idea:** Field notes for sorting **in WGSL specifically**: hybrid FidelityFX-style 4-bit-digit radix ≈ **1 G elem/s on M1 Max in pure WebGPU**; with real Metal subgroups ≈3 G elem/s. Because WebGPU lacks subgroups, warp multi-split is faked with shared memory; **"warp" 16 outperforms 32** (fake ballot is O(warp)); 8-bit digits gave no sustained gain pre-subgroups. Critical cautions: (a) **Lichtso's one-pass sort (splatter, gaussian splatting) is only approximate — it relies on atomics returning in subgroup order (UB) and can deadlock on no-FPG GPUs (Apple)**; (b) subgroups proposal lacks subgroup_barrier needed for correct multi-split (threadgroup barrier only costs ~2% on M1, so workaround OK); (c) segmented sorts (Modern GPU library) for per-tile/per-bucket sorting.
- **Applicability: HIGH.** This is literally a WGSL sorting playbook for our exact stack; the caution list maps 1:1 to our atomics-emit and any future one-pass kernels.
- **Measure:** adopt his elem/s benchmark format; replicate M1/Android numbers.
- **Verdict: implement-now (as design doc + benchmarks).**

### B3. Boosting GPU Radix Sort: memory-efficient Onesweep extension with circular buffers
- **Authors/Venue/URL:** Chih-Chen Kao, Atsushi Yoshimura (AMD), GPUOpen technical article, May 6 2025 (hardware-vendor tech article, not engine vendor).
- **Core idea:** Extends Onesweep with **circular buffers** to keep per-digit-pass histogram offsets resident and reduce global memory traffic between passes; improvements to reduce-then-scan structure. Reported throughput gains at large N on RDNA.
- **Applicability: MED.** Fold the circular-buffer idea into our B1 port once the base works (it's an optimization of memory layout, not new algorithm).
- **Measure:** GPU timer + memory-traffic estimate (bytes/dispatch model) in the sort bench.
- **Verdict: later** (phase 2 of B1).

### B4. Sorting networks for particles (bitonic / even-odd merge)
- **Authors/Venue/URL:** Khronos community thread (2018); Wiley "Fast in-place, comparison-based sorting with CUDA" (2011); Kipfer GPUGems2 ch.46.
- **Core idea:** For small-to-medium fixed N, data-oblivious networks (bitonic) are cache-friendly, dispatch-count predictable, and **key trick: for particles you only need to sort 32-bit packed (depth, index) keys** and fetch payload after — network cost is on 4-byte elements.
- **Applicability: MED** — we already have bitonic+Stockham. The niche nugget to keep: **pack sort keys as u32 (quantized depth<<bits | id)** and never sort the full particle struct; also Stockham (we have) avoids in-place swap hazards.
- **Verdict: skip (already covered), keep key-packing trick.**

### B5. GPUSorting (b0nes164)
- **URL:** github.com/b0nes164/GPUSorting — OneSweep in CUDA, D3D12, Unity HLSL, wave-size agnostic [4..128]. **Verdict: implement-now reference** for B1 port (sister repo to A1; HLSL→WGSL translation is direct since both are compute-shader shaped).

---

## C. Particles

### C1. evanvoodoo — "Creating a GPU-based Particle System" (freelist + indirect draw)
- **Authors/Venue/URL:** Evan Lohento (BUas student, personal blog), Jan 24 2025, evanvoodoo.github.io.
- **Core idea:** Textbook-clean student write-up of the full GPU particle pipeline: **freelist buffer of dead particle indices**; spawn kernel pops from freelist, update kernel moves dead→freelist; drawlist + **indirectDrawBuffer** written by compute so the CPU never touches particle state. Min/max attribute ranges sampled at spawn. OpenGL GLSL compute (so it maps to our WebGL2 TF fallback mindset).
- **Applicability: MED-HIGH.** We already do atomics-based emit/spawn; the value is (a) validation that our structure matches a known-good design, (b) the freelist→indirect-draw glue in one readable place, (c) good doc reference for our CPU fallback parity tests.
- **Measure:** n/a (reference). If adopting indirect-draw in WebGL2 path: CPU frame-time drop in bun bench + frame capture count.
- **Verdict: implement-now as reference/doc**; no new algorithm.

### C2. wgpu issue #5329 — "Mysterious data race with atomicAdd on a WGSL compute shader"
- **URL:** github.com/gfx-rs/wgpu/issues/5329 (Mar 2024).
- **Core idea:** Real-world debugging saga of an atomics-based spatial grid build in WGSL; documents how subtle WGSL memory-model misuses (assuming ordering around relaxed atomics / missing barriers) produce flaky wrong counts on some backends.
- **Applicability: HIGH (cautionary, engineering rules).** Brick: our atomics emit/spawn + grid kernels. Rules: every cross-workgroup aggregate must be plain atomicAdd on u32 (no read-modify-write races); zero counters with a dedicated clear dispatch (or workload); validate with invariant asserts.
- **Measure:** stress harness (see A3) with randomized particle spawn storms; assert alive+dead == pool each frame.
- **Verdict: implement-now (test harness), not an algorithm.**

### C3. Tiled Depth-of-Field Splatting (binning particles into tiles, per-tile sort)
- **Authors/Venue/URL:** Stamminger group (K. Schäfer?/Stamminger), Eurographics 2022 short, diglib.eg.org ("Tiled Depth of Field Splatting").
- **Core idea:** Particles are **binned into screen-space tiles (compute)**, then **sorted within each tile** (small N → sorting networks shine), then traversed and blended. Confirms the tiled-particle-rendering pattern from research (not engine-vendor) literature: the global sort is replaced by many tiny local sorts; overdraw and blending order are both improved.
- **Applicability: MED-HIGH.** Brick: `@rune/gl` particles renderer + sorts. For the 40k blended demo: bin into 64×64 or 128×128 tiles (compute, atomics for counters + prefix), per-tile bitonic on 256-element buckets (dispatched as one fused pass or few), then per-tile draw/blend. Cuts sort from O(n log²n) global to O(n log² t), t≈tile capacity.
- **Measure:** GPU timers: binning pass + tile sorts + blend vs current global sort + draw; demo parity gate **with tolerance** (blend order changes slightly per tile).
- **Verdict: implement-now candidate** (big perf win for the flagship particles demo; needs tolerance-based parity gate).

### C4. GPU-Native Compressed Neighbor Lists with Space-Filling Curves
- **Authors/Venue/URL:** arXiv 2602.19873 (2026, MD/molecular focus).
- **Core idea:** Particle→cell neighbor lists stored in a **space-filling-curve order** compressed layout to maximize cache locality for short-range particle-particle interactions.
- **Applicability: LOW-MED.** If we ever add collision/attraction forces to GPU sim: sort particle indices along a Morton/SFC curve per frame (we have radix sort!) to get locality; cite this for the layout.
- **Verdict: later.**

### C5. Sparse GPU particle updates (dead/alive list pattern)
- **Sources:** Particle-in-cell GPU literature (e.g., "Fast parallel particle-to-grid interpolation", U. Maryland 2008) + stackoverflow lore.
- **Core idea:** Sparse updates = run update kernel only over the **alive list** (compacted) rather than the whole pool; dead particles sit in a free list. Keeps sim cost ∝ alive count.
- **Applicability: MED.** We already have atomics emit; adding alive-list compaction (A4) each frame makes sim sparse. For 40k pool with 30% dead this is ~1.4× sim savings, more at low occupancy.
- **Measure:** GPU sim-pass timer at fixed visual output (seeded RNG for parity).
- **Verdict: later** (cheap add once compaction upgrade lands).

### C6. Pause/resume GPU sim
- **Finding:** No niche paper found (searched). Standard practice = double-buffer full state + fence; "pause" = stop dispatching, "resume" = continue; snapshot = copy state buffers.
- **Applicability: LOW.** Our ping-pong buffers already make this trivial; document as pattern. **Verdict: skip** (nothing to import; absence-of-evidence result recorded).

---

## D. Order-independent transparency

### D1. Moment-Based Order-Independent Transparency (MBOIT)
- **Authors/Venue/URL:** Münstermann, Zirr et al., JCGT 2018 (momentsingraphics.de; cg.ivd.kit.edu); survey/impl experience: Interplay of Light "OIT: Endgame" (2022).
- **Core idea:** Store 4–8 **power moments** of per-pixel fragment depths in one fp32 MRT; reconstruct the transmittance function with a small polynomial solve (householder), then blend in a fullscreen resolve. No sorting, no per-fragment linked lists. 4 moments ≈ very good quality (Interplay measured 8.1 ms @ 1440p for 7M fragments in 2022 hardware). Works in **WebGL2** with float render targets and in WebGPU trivially — **proven in-browser: three.js MBOIT+WBOIT showcase (discourse.threejs.org, "OI, you got a license for that T?", Aug 2025)**.
- **Applicability: MED-HIGH.** Brick: vfx carousel new sub-demo + optional particles mode. For depth-soft blended particles it kills the depth-sort dependency entirely (or complements C3). WGSL/GLSL fragment-only — fits both backends.
- **Measure:** GPU timer for MRT write + resolve vs current sort+blend; PSNR vs depth-peeled ground truth (three.js has a depth-peeling demo Nov 2025 to borrow reference from).
- **Verdict: implement-now candidate for the vfx carousel** (research-backed, browser-proven, dual-backend).

### D2. Layered Weighted Blended OIT (LWBOIT)
- **Authors/Venue/URL:** Friederichs, Eisemann & Eisemann, Graphics Interface 2021 (research.tudelft.nl).
- **Core idea:** Extends WBOIT (McGuire & Bavoil, JCGT 2013) with a **small fixed number of weighted layers** (k≈4) instead of one aggregate: each fragment picks a layer by depth bucket; per-layer weighted sums; resolve combines layers back-to-front. An **order of magnitude accuracy gain over WBOIT** (openreview summary) at trivial cost — no sorting, no atomics, fragment-shader only.
- **Applicability: MED-HIGH.** Cheapest "good" OIT for the WebGL2 fallback path (no compute needed!) — pairs with D1 for the dual-backend story.
- **Measure:** same harness as D1; compare L2 error vs peeled reference at equal ms budget.
- **Verdict: implement-now candidate (WebGL2 path), D1 for WebGPU.**

### D3. StochasticSplats: Stochastic Rasterization for Sorting-Free 3D Gaussian Splatting
- **Authors/Venue/URL:** Kheradmand et al., arXiv Mar 31 2025 (ubc-vision.github.io; openreview).
- **Core idea:** Replaces sorted alpha blending with an **unbiased Monte Carlo estimator** of the volume rendering equation: each gaussian's opacity is stochastically thresholded by a per-pixel random value (stochastic transparency à la Enderton 2010), blended with plain over; 1 SPP + temporal accumulation converges to the exact result. **Removes the sort entirely.** Nearest published relative: "Stochastic Layered Alpha Blending" (Wyman & McGuire, JCGT 2013 — quality >32 spp stochastic transparency at ~8 layers).
- **Applicability: MED.** Tempting for particles: kill the 40k sort for blended demo — but output changes every frame (noise) → **cannot pass our pixel-parity gate**; requires TAA/temporal accumulation we don't have as standard. Best fit: optional "stochastic blend" mode behind a flag in the particles demo for perf headroom studies.
- **Measure:** frame time w/o sort; 100-frame accumulated RMSE vs sorted reference (new metric, documented as intentionally non-parity).
- **Verdict: later** (research experiment; document, don't ship in parity path).

### D4. OIT: A Survey for Real-Time Rendering Practitioners
- **Authors/Venue/URL:** P. Kakkar, 2025 (SSRN; ResearchGate "Advancements in Order Independent Transparency"). Broad 2025 snapshot: A-buffer, depth peeling, WBOIT/LWBOIT, MBOIT, weighted/hybrid.
- **Applicability: LOW (reference map)** for picking D1/D2/D3. **Verdict: keep as citation.**

### D5. Improving OIT 3DGS via ... (W. Yang, arXiv 2026)
- URL: arxiv (2026). OIT methods to remove/modify depth sorting in 3DGS rendering. **MED-LOW for us** (splatting-specific); watch item. **Verdict: skip/watch.**

### D6. endavid — "New weight function for Weighted-Blended OIT"
- **URL:** endavid.com (Aug 2017, personal blog, niche). Analytic weight function w(z,α) that fixes WBOIT artifacts for smooth particles. **LOW-MED** — one-function change if we ship WBOIT anywhere. **Verdict: later; keep link.**

### D7. Intel — Adaptive Transparency (Salvi & Vaidyanathan)
- **Venue/URL:** Intel tech report/SIGGRAPH 2012. Linked-list-lite: k-bucketed depth thresholds, fragment-count adaptive. **LOW** for our use (needs atomics in fragment; WebGL2 has no image atomics) — WebGPU could do it, but D1/D2 dominate on cost. **Verdict: skip.**

---

## E. Blue-noise sampling & dithering

### E1. Scalar Spatiotemporal Blue Noise Masks (STBN)
- **Authors/Venue/URL:** Wolfe, Zirr, Heitz, McGuire, et al., JCGT 2022 + arXiv 2112.09629; generator code: github.com/NVIDIA-RTX/STBN.
- **Core idea:** Precomputed 3D masks (x,y,frame) with blue-noise spectra in space AND time; scalar variants pack multiple channels (RGB) with per-channel blue noise + low cross-channel correlation. One texture lookup replaces hash RNG for dithering/stochastic sampling: **error becomes animated blue noise = perceptually optimal + TAA-friendly**, no mask regeneration.
- **Applicability: HIGH for our noise brick.** @rune/core noise: ship 64×64×64 (or 128×128×64) STBN u8 volume as embedded asset; use for particle dithering (soft-particles fade), OIT stochastic thresholds (D3 mode), opacity dither of LOD pop, and depth-quantization dither. Zero shader cost change (texture read vs hash — similar; hash freed for sim only).
- **Measure:** convergence test: fixed scene with 1 spp stochastic effect, compute temporal RMSE with STBN vs PCG hash over 64 frames (bun + readPixels harness); perceptual screenshot diff.
- **Verdict: implement-now candidate** (asset + sampling swap; pixel-parity: affects only opt-in stochastic paths).

### E2. FAST: Filter-Adapted Spatio-Temporal Sampling for Real-Time Rendering
- **Authors/Venue/URL:** Wolfe, Donnelly, Halén et al., I3D 2024 (Proc. PACMGRAPHIT 7(1)); arXiv 2023.
- **Core idea:** Instead of blue-noise-shaped noise, **generate the sample volume so the residual noise spectrum is shaped like (adapted to) the TAA/reprojection filter's frequency response** — noise is placed where the filter attenuates. Noticeably less residual flicker than STBN under a given temporal filter; offline generator (style: STBN) produces a 3D sample volume matched to *your* filter kernel.
- **Applicability: MED-HIGH.** We control the whole pipeline (frame graph knows the exact TAA/bloom chains): regenerate a FAST-style volume offline in bun (their generator is open source) matched to our temporal filter; drop-in replacement for E1's masks.
- **Measure:** same RMSE/perceptual harness as E1; expect lower residual noise at equal frame budget.
- **Verdict: implement-now (phase 2 after E1).**

### E3. Importance-Sampled Filter-Adapted Spatio-Temporal Sampling
- **Authors/Venue/URL:** Wolfe, Donnelly, Halén, **JCGT, May 9 2025** (jcgt.org/published/00…); open-source generator: github.com/electronicarts/fastnoise.
- **Core idea:** Extends FAST with **importance sampling**: the sample volume stores multiple dimensions and the sampling is importance-adapted (e.g., 2D spatial + 1D temporal + dimension index), improving convergence of stochastic effects that sample non-uniform distributions (soft shadows, DoF, translucent particle densities).
- **Applicability: MED.** Same brick as E2; matters once we do stochastic transparency/soft shadows. Newest (2025) JCGT in this space — exactly the "hash-based blue noise 2023-2026" target of the task.
- **Measure:** as E2 + stratified-vs-uniform variance ratio on a particle-density test.
- **Verdict: later** (adopt with E2 if we add stochastic effects).

### E4. Screen-space blue noise without precomputed masks (hash approaches)
- **Findings:** demofox blog ("Summing Blue Noise Octaves Like Perlin" Sep 2024; "Making Blue Noise Point Sets With Sliced Optimal Transport" Dec 2023 — **sliced-optimal-transport blue noise generation in a few iterations**, could even run in-shader cheaply for small masks); reedbeta "Quick And Easy GPU Random Numbers" (PCG port classic, 2013 gem); @typegpu/noise (TypeScript/WebGPU PRNG package — TS-native, maps to our CPU fallback parity).
- **Core idea:** Hash-based blue noise without masks: either (a) generate small blue-noise tiles on the fly via sliced optimal transport (each iteration is a sort toward the target distribution), or (b) accept hash white noise but filter temporally. (a) is genuinely new-ish (2023) and mask-free.
- **Applicability: MED.** @rune/core noise: add PCG/hash (we have) + optional on-the-fly tile generator for dynamic resolutions where a fixed mask tiles poorly.
- **Measure:** bun micro-bench of generator (iterations × N) + spectral Fourier check (radially-averaged power spectrum) — cheap validation test.
- **Verdict: later**; E1 masks cover 90% of value for 10% of work.

### E5. Interleaved Gradient Noise (IGN) & dithering
- **Findings:** demofox IGN explainer; Bart Wronski "Dithering part three" (2016, still best practical writeup); **Meta "Tech Note: Shader Snippets for Efficient 2D Dithering"** (developers.meta.com, mobile tiled-GPU oriented); docs.rs `dithereens` (Rust dithering crate with IGN).
- **Core idea:** IGN (Jimenez 2014) = analytic per-pixel noise `52.9829189f*frac(0.06711056f*x+0.00583715f*y)` with low-discrepancy in 2D neighborhoods — the cheapest "good" dither; Meta's note adds mobile-cheap variants and quantization advice for tiled GPUs (mediump-safe constants).
- **Applicability: MED.** We likely already use Bayer/IGN somewhere; formalize in @rune/core noise with the *threshold-matrix* formulation and f16-safe constants for mobile.
- **Measure:** screenshot diff on banded gradient test before/after dither; GPU timer (negligible).
- **Verdict: implement-now (tiny), part of noise brick cleanup.**

### E6. Demofox blue-noise series
- **URL:** blog.demofox.org (2023–2024 posts listed above). Practical recipes (void-and-cluster, sliced OT). **Verdict: keep as reference for E4.**

---

## F. Depth precision

### F1. Quantitative Analysis of Z-Buffer Precision
- **Authors/Venue/URL:** zero-radiance.github.io (Tarek Sherif? personal research blog), Aug 24 2020.
- **Core idea:** Formal treatment: reversed floating-point Z is an **approximation of a logarithmic depth buffer** — keeps the curve shape but not continuity; gives error-rate formulas per format; concludes fp32 reversed-Z ≈ log-depth for practical ranges.
- **Applicability: HIGH (informs Hi-Z + soft particles).** We should flip to reversed-Z (WebGPU: depth24plus, GREATER compare, flipped projection; WebGL2: nlguillemot's recipe — reversed projection + glDepthFunc(GREATER), no clip-control needed) — improves our **Hi-Z occlusion culling** far-plane precision directly (city demo!).
- **Measure:** z-fighting regression test (two coplanar quads at varying distance); Hi-Z false-negative rate on city demo camera path; culling statistics comparison.
- **Verdict: implement-now candidate.** Parity note: Hi-Z mips change → culling decisions change → needs tolerance-parity gate (same visible set, ±epsilon on cull counts), plus screenshot gate.

### F2. Visualizing Depth Precision
- **Authors/Venue/URL:** NVIDIA dev blog, Oct 21 2021 (hardware-vendor blog, allowed; classic). Visual intuition for fixed-vs-float, reversed-Z zero-error result; directly cited by three.js's reverse-depth-buffer docs (threejs.org — browser-engine, proof it works in WebGL).
- **Applicability: MED** (companion to F1; three.js confirms WebGL2 viability). **Verdict: implement-now as F1's reading.**

### F3. Reversed-Z in OpenGL
- **Authors/Venue/URL:** nlguillemot.wordpress.com (Nicolas Guillemot, personal), Dec 2016. Exact WebGL-safe recipe (no glClipControl): multiply projection z by -1, swap depth func, adjust clear value. **Verdict: implement-now recipe for the WebGL2 backend of F1.**

### F4. gpuweb #497 "The case for Reversed Depth Range"
- **URL:** github.com/gpuweb/gpuweb/issues/497 (2019). WebGPU NDC z∈[0,1] fixed; reversed-Z is done at projection level (as F3). Confirms no API-level gotcha. **Verdict: noted; part of F1.**

---

## G. WGSL-specific optimization & dispatch

### G1. ARM developer guidance — Workgroup sizes (Mali)
- **URL:** developer.arm.com (mobile tiled GPU). **Baseline 64**, multiple of 4, prefer **smaller before larger when barriers/sync used** (each barrier costs the whole workgroup; smaller groups hide it and raise occupancy on Mali's short threads).
- **Applicability: HIGH, trivial.** Audit our WGSL kernels (@rune/gl Hi-Z, compaction, sort, particles sim): barrier-heavy (sort inner loops, scans) → 64; bandwidth kernels (sim update) → 128/256 on desktop.
- **Measure:** GPU timer per kernel on Android tile GPU + desktop; sensitivity sweep table (this is A2's methodology).
- **Verdict: implement-now (audit + sweep).**

### G2. Qualcomm Adreno Best Practices
- **URL:** docs.qualcomm.com. Workgroup ≥64 to avoid dispatch stalls; notes on command-buffer flush behavior with small groups. Same conclusion as G1 from the other vendor. **Verdict: implement-now (same sweep).**

### G3. Vulkan TBR Best Practices (Khronos docs)
- **URL:** docs.vulkan.org. **mediump/16-bit types improve occupancy and bandwidth on mobile**, some desktop too.
- **Applicability: MED-HIGH.** WGSL f16 (shader-f16 feature) for particle state (pos/vel as f16 where range allows), Hi-Z mip data f32→ keep, but sim scratch in f16. TS side: store as f16-packed typed arrays (Uint16Array half floats) halves our particle pool bytes 40k×… — also less CPU↔GPU copy for the CPU fallback path.
- **Measure:** GPU sim timer + bandwidth model on mobile; CPU fallback bench (bun) with half-float decode in monomorphic loop (validate the JS cost claim!).
- **Verdict: implement-now candidate for particle state.**

### G4. NVIDIA — Optimizing Compute Shaders for L2 Locality using Thread-Group-ID Tiling
- **URL:** developer.nvidia.com blog (Jul 2020; GDC 2019 talk). **Swizzle workgroup IDs (tile the dispatch order, N=16)** so concurrently-running workgroups touch a compact L2 window: 47% gain on a fullscreen denoise kernel.
- **Applicability: MED-HIGH.** WGSL one-liner: remap `wg_id` inside shader for fullscreen passes (Hi-Z build, downsamples, particle soft-depth fetch, bloom). Works on all GPUs to varying degree (L2 locality universal).
- **Measure:** GPU timer on Hi-Z downsample + particle resolve before/after swizzle; expect 5–45%.
- **Verdict: implement-now candidate (cheap, isolated).**

### G5. Characterizing WebGPU Dispatch Overhead for LLM Inference
- **Authors/Venue/URL:** arXiv, Feb 9 2026. Measures per-dispatch overhead in Dawn: JS submission + scheduling costs dominate small kernels; application-level batching of dispatches matters.
- **Applicability: MED-HIGH.** Our bitonic sort issues ~log²(N) dispatches (for 40k, ~10–12 dispatches — measurable overhead); frame graph splits many small passes. Actions: (a) prefer Stockham/radix with fewer, fatter dispatches on small N; (b) frame graph: fuse passes that share barriers (we have auto barriers — add a "dispatch-count" cost term to pass fusion heuristics); (c) measure with timestamp queries per pass.
- **Measure:** bun bench: submit-time of a frame's command buffer (JS) + GPU gap analysis via timestamps.
- **Verdict: implement-now (measurement + heuristic term).**

### G6. Chrome "What's New in WebGPU" posts (subgroups, immediates)
- **URL:** developer.chrome.com (Chrome 151-152 post, Aug 2026, references WGSL subgroup ops for compute optimization; earlier posts track subgroups/subgroup ops landing + "WebGPU immediates" and transient attachment validation). Browser-team posts — explicitly allowed source class.
- **Core idea:** Subgroup operations are (now) shipping in WGSL for compute on specific platforms; Chrome posts give per-feature timing notes. Once available: real ballot for A4/B1 multi-split (3× sort speed per Linebender's Metal data), subgroup scans for compaction.
- **Applicability: HIGH (forward-looking).** Add feature-detect (`subgroups` feature) + dual shader paths where the win is big (sort multi-split only). Keep shared-memory fallback (it's our WebGL-compat mindset anyway).
- **Measure:** A/B sort throughput with/without subgroups on a platform that has them.
- **Verdict: implement later, design hooks now.**

### G7. toji.dev — WebGPU best practices: compute with vertex data
- **URL:** toji.dev (Brandon Jones, Chrome WebGPU team), Feb 2024. Patterns for compute→vertex feed (storage buffers as vertex attributes, indirect draw) — exactly our particle draw path and multidraw; browser-team sanctioned idioms. **Verdict: implement-now reading; align our multidraw with it.**

### G8. webgpufundamentals.org — Compute shader basics / histogram
- **URL:** webgpufundamentals.org (2023-2025). Workgroup size 64 default advice; atomics histogram tutorial (u32 atomics only, i32/u32 — matches our constraint). **LOW-MED; onboarding docs. Verdict: skip (team knows), keep for onboarding.**

---

## H. Extras (marginal, recorded for completeness)
- **Bloom methods on mobile TBDR (JT Tarigan, etasr.com 2026):** benchmark of 5 bloom variants on tile GPU — LOW (post-FX not in cluster), skip.
- **three.js depth peeling demo (discourse, Nov 2025):** browser OIT reference implementation for our PSNR gates. Keep.
- **ea/SEED presentation links (I3D 2024 FAST paper PDF):** used as paper source; not engine-blog content.
- **Excluded per policy:** Unreal/Unity/Frostbite/Godot blogs (Unity forum thread on b0nes164's GPUSorting was used only to locate the GitHub repo, which is the source actually cited).

---

## Ranked top 15 (applicability to rune)

| # | Finding | Brick | Verdict |
|---|---------|-------|---------|
| 1 | A1 Decoupled Fallback single-pass scan (HPG'25, b0nes164/Vello WGSL) | @rune/gl gpgpu scan | implement-now |
| 2 | B1+B2+B5 Onesweep radix sort in WGSL + Linebender cautions (fake ballot, warp=16, no-FPG) | @rune/core sorts (WebGPU path) | implement-now |
| 3 | A2 ScanBox WGSL scan benchmarks/tuning methodology (Contini 2025) | bench harness + kernels | implement-now |
| 4 | F1–F3 Reversed-Z for WebGPU+WebGL2 (zero-radiance, nlguillemot) | Hi-Z culling + depth | implement-now |
| 5 | D1+D2 MBOIT (WebGPU) + LWBOIT (WebGL2) — browser-proven by three.js showcase | vfx carousel / particles OIT | implement-now |
| 6 | E1 STBN masks (+ E2 FAST) spatiotemporal blue noise | @rune/core noise | implement-now |
| 7 | G1+G2+G3 workgroup-size audit + f16 particle state (ARM/Adreno/TBR docs) | all WGSL kernels | implement-now |
| 8 | G4 thread-group-ID tiling for L2 locality (NVIDIA) | fullscreen compute passes | implement-now |
| 9 | C3 tiled/binning particle rendering (EG 2022 + AMD-style pipeline) | particles renderer + sorts | implement-now (tolerance gate) |
| 10 | G5 WebGPU dispatch-overhead characterization (arXiv 2026) | frame graph pass fusion | implement-now (measurement) |
| 11 | A3+C2 WGSL relaxed-atomics rules + stress harness (raphlinus, gpuweb#2229, wgpu#5329) | atomics emit/spawn | implement-now (tests) |
| 12 | C5 sparse GPU particle updates via alive-list compaction | particle sim | later |
| 13 | B3 circular-buffer radix histogram optimization (GPUOpen 2025) | sort phase 2 | later |
| 14 | D3 StochasticSplats sorting-free stochastic transparency (arXiv 2025) | opt-in particles mode | later (breaks parity by design) |
| 15 | E3+E4 importance-sampled FAST (JCGT 5/2025) + sliced-OT hashless blue noise | noise brick phase 2 | later |

**Deliberate skips:** adaptive voxel OIT (Activision — engine vendor), FidelityFX blog content (engine-vendor-adjacent; only the *algorithm* facts from Linebender's neutral analysis were used), stochastic layered alpha blending standalone (subsumed by D3), Intel adaptive transparency (needs image atomics), SFC neighbor lists (MD-focused), stream compaction papers pre-2020 (superseded).

## Search log (26 successful queries)
decoupled look-back prefix scan; chained scan fallback counters; stream compaction GPU 2024; GPU radix sort 2024-2025; sorting networks GPU particles; tiled particle rendering binning; sparse GPU particle update dead/alive lists; moment-based OIT 2024-2025; weighted blended OIT improvements; spatiotemporal/hash blue noise; reversed-Z depth precision; WGSL workgroup size Chrome; stochastic transparency 2023-2024; WebGPU forward progress decoupled lookback; OIT survey 2025; interleaved gradient noise; sorting-free gaussian stochastic; Chrome WebGPU subgroups; Vello decoupled fallback WGSL; MBOIT power moments; ScanBox Contini; raphlinus prefix sum URL; WGSL relaxed atomics memory model; Layered WBOIT Friederichs; FAST I3D 2024; WebGPU PCG hash blue noise; workgroup size 64 vs 128; three.js OIT discourse; b0nes164 GPUSorting; importance-sampled FAST JCGT 2025. (Raw JSON: s1–s32 in this folder.)

**Direct fetches performed:** linebender.org/wiki/gpu/sorting (full text captured above); b0nes164/GPUPrefixSums README (full); raphlinus 2021/11/17 prefix-sum-portable (full); gpuopen.com boosting_gpu_radix_sort (metadata+author); jamescontini.com (thesis/scanbox info); evanvoodoo 2025-01-24-gpu-particles (structure captured).
