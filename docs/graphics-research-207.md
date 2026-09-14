# graphics-research-207 — the same-frame feedback round

Status: **SHIPPED (Task 207)** — the round the second field report drove:
«цветные боксы все ещё не окклюдят задние цветные боксы… за серыми
большими параллелепипедами они не рисуются» (the colored boxes still
don't occlude the rear colored boxes; behind the gray parallelepipeds
they already don't draw). The answer: the **current-frame two-pass HZB** —
after the first cull's verdicts, the fresh visible set re-renders
depth-only into the pyramid, the pyramid rebuilds, a second cull lands.
Declared as three new frame-graph passes, ON by default, both backends,
parity held. Plus the research round: two believed citations **verified
into oblivion** (both hallucinated — the honest negatives are below), and
the fresh harvest ranked against our profile.

The rule (inherited from 205/206): *a technique enters the engine only
with a number and a parity gate.* This round's corollary: *verify the
citation before it enters a comment.*

---

## 1. The field report and the design

The Task-206 numbers already told the story: at the guilty camera the
plain K-wall policy drew **2767** boxes while the brute «City occludes»
experiment (every record writes the fill) drew **428**. The gap *was* the
report: with the boot policy, the 16384 colored boxes never write depth —
they cannot occlude anything, least of all each other. Only the K=23 gray
occluders feed the pyramid («behind the gray parallelepipeds they don't
draw» — exactly).

The fix is the published two-pass HZB shape, moved into the current
frame:

```
z-fill (the K walls [+ the prev-visible set when history is on])
  → pyramid-reduce → cull #1 (the raw verdicts, flags ∈ {1,4} = V1)
  → feedback-fill (V1 re-renders DEPTH-ONLY into the tile)
  → pyramid-reduce-2 → cull #2 (the final verdicts)
  → hysteresis (ONE fold, on the final verdicts) → compact → color
```

**Why re-render instead of reproject** (devsh's polemic, verified this
round — see §3): reprojected depth can never be conservative (point
samples, gather cost, the chain-link-fence case), and programmatically
written depth kills the hardware Hi-Z on some drivers. Re-rendering the
survivors at the current camera is exact — the set is this frame's, the
geometry is this frame's.

**Soundness** (the same law the Task-199 city-occluders leg proved, one
cull deeper): a builder never self-culls — its own footprint max ≥ its
own front surface ≥ its nearest AABB corner — and a box the second cull
removes is behind a surface drawn *this* frame at *this* camera. The
cover-transfer induction carries any culled occluder's contribution to
the present surface in front of it (each step strictly decreases the
covering surface's minZ, the set is finite). V1 ⊇ V2 ⊇ … so nothing
already culled can resurrect.

**The price:** one depth-only draw of V1 (the survivors — 2767 instances
at the guilty camera, not the brute fill's 16407) + one pyramid rebuild +
one cull dispatch. On the WebGL2 leg the fill is the collapse draw over
the RAW verdict buffer (`from: 'rawFlags'` — the TF-output→attribute law
the no-hist configuration field-proved); on WebGPU the vertex shader
reads the storage flags directly. The temporal fold still runs exactly
once per frame, on the FINAL verdicts — the feedback reads raw flags,
never the smoothed hist.

**The frame-graph story (the version law's own showcase):** the feedback
fill is the graph's first *same-frame* consumer of a post-cull scene
version — the edge `cull-verdicts→feedback-fill scene@v1` — where the
z-fill binds the imported one (`import→z-fill scene@v0`). The fold reads
the second cull's write (`cull-verdicts-2→hysteresis`). Gated with the
culling/fresh/policy bits, the branch dies whole on the Hi-Z-off frame —
the shadows-off law, again.

## 2. The numbers (scripts/task207-closecam.mjs, both backends)

The report's cameras (dist 12 — the wheel's floor; pitch ≈ 0 = looking
along the city plane, near boxes huge on screen):

| camera | plain drawn | feedback drawn | brute city drawn | parity |
|---|---|---|---|---|
| yaw 0.00 pitch 0.10 (WG) | 2767 | **428** | 428 | IDENTICAL |
| yaw 0.00 pitch 0.10 (GL) | 2767 | **445** | 445 | IDENTICAL |
| yaw 0.00 pitch −0.05 (WG) | 2804 | **155** | 155 | IDENTICAL |
| yaw 0.40 pitch −0.15 (WG) | 3004 | **232** | 232 | IDENTICAL |
| yaw 3.14 pitch −0.15 (WG) | 2796 | **77** | 77 | IDENTICAL |
| yaw 1.57 pitch −0.15 (WG) | 813 | **114** | 114 | IDENTICAL |

The feedback legs land **exactly on the brute all-N fill's numbers** at
every camera on both backends (the ±17 cross-backend delta is the
documented attachment-precision borderline class) — the survivors' fill
carries the whole-scene fill's occlusion power, as the cover-transfer law
promises, at a sixth of the instance count. Pixel parity 6/6 IDENTICAL
per backend (the feedback never costs a pixel). The default orbit view:
drawn 2402 → **1697** (WG) / 2403 → 1699 (GL) — the boot policy now culls
~29% more of the default view too. The full smoke: validation PASS both
legs, zero errors.

## 3. The citation audit — two honest negatives

- **«Greedy Visibility: Using the Occlusion Lens», Wärmansson & Sintorn
  (~2024): DOES NOT EXIST.** Exact-phrase search: zero results; DBLP has
  no author record for «Wärmansson»; Crossref's Erik Sintorn index (a
  real Chalmers GPU-visibility researcher — almost certainly the
  hallucination anchor) contains no such paper. The *real* works with
  the claimed shape (batched near-to-far re-culling) are the ones we
  already cite: Aaltonen 2015, the CHC lineage, the HROC line. The
  phantom had leaked into a Task-207 code comment before this audit —
  removed in the same commit as this doc.
- **«Matt Pettineo's Incremental Hi-Z series 2024–2025»: DOES NOT EXIST.**
  His complete posts index for the window: *Shader Printf* (Jan 2024),
  *To Early-Z, or Not To Early-Z* (Apr 2025), *Ten Years of D3D12* (Sep
  2025). No Hi-Z series. The concept exists as MOC's masked
  hierarchical-depth updates (2016, already in the 205 harvest) and
  forum echoes. His real April 2025 post was harvested instead (§4).

## 4. The harvest (ranked, verdicts for our profile)

| # | source | idea | verdict |
|---|---|---|---|
| 1 | **bevy's GPU two-phase occlusion culling** — pcwalton PR bevy#17413 (Jan 2025) + JMS55 PR #18711 (Apr 2025) | The wgpu twin of our Task 207: early prepass from last frame's HZB+visibility, fresh HZB, late prepass re-culls the untested remainder, **late downsample after all rendering** seeds the next frame. Bistro 1591→585 meshes. | **IMPLEMENTED (the deltas, next round):** we shipped the 2-phase core; their three cheap deltas — the cross-frame HZB seed, the post-render late downsample, the non-pow2 pitfall class (we can't hit it at 480×270) — are the follow-up candidates. |
| 2 | **Kitware VTK WebGPU occlusion culling** — Clabault, Givord, Galland, Mazen (2024, VTK 9.4, BSD) | Two-pass HZB in WebGPU compute, publicly benched (Bistro, RTX A6000): 1.5–1.6× occlusion-only, 5–6× with frustum — but *loses to CPU culling below ~100M tris* (readback + mip chain + sync). | **VALIDATION.** Same algorithm, same API — their public numbers validate ours; their small-scene regression is the honest warning our design already answers (480×270 tile = ⅛ their texels, zero readback, indirect draws). |
| 3 | **«To Early-Z, or Not To Early-Z»** — Matt Pettineo (The Danger Zone, Apr 2025) | DX12 harness on early-Z hoisting: safe when no discard/PS-depth-export/UAV writes; front-to-back order + HW Hi-Z drive prepass efficiency; PS-invocation counters. | **SATISFIED-BY-CONSTRUCTION + BACKLOG.** Our fbfill/z shaders are trivially early-Z-safe (depth-only, no discard). The missing half — *front-to-back V1 ordering* — needs the depth sort (the radix-sort backlog item); expected win is second-pass raster time on real GPUs only (SwiftShader has no early-Z). |
| 4 | **«Don't even dream of reprojecting last frame depth»** — devsh (Nabla, gist Oct 2023) | The polemic with teeth: reprojection can't be conservative; programmatically written depth kills HW Hi-Z; the two sane forms = depth-test-only visibility writes, or compute HiZ 2×2 tests. | **REFERENCE.** The strongest practitioner validation of our no-reprojection re-render design; replaces the phantom citation in the code. |
| 5 | **Two-pass HZB in D3D12** — Luc Momber (Medium, Apr 2025) | Prev-frame-set prepass → max-mip chain → 4-tap 2×2 bias test; **Blelloch-scan compaction** for the indirect list. | **BACKLOG.** The scan compaction folds into the 205 decoupled-fallback/onesweep item (one kernel family). His prepass-geometry-reuse variant is REJECTED for us: our prepass is depth-only — no shaded geometry to reuse. |
| 6 | **Granite `hiz.comp`** — Hans-Kristian Arntzen (themaister.net, adopted by bevy #18711) | SPD-style single-pass Hi-Z pyramid: one 256-thread dispatch, subgroup quad shuffles, per-region atomic with last-block-continues (forward-progress-safe). | **BACKLOG (strong).** Trigger: the reduce dispatches showing in the frame timer / barrier count. Win: 9 dispatches → 1 at 480×270. Gate: WGSL `subgroups` (Chrome 134+) with a shuffle fallback for the GL/SwiftShader legs. |
| 7 | **GPUPrefixSums** — b0nes164 (2025) + **webgpu-radix-sort** (kishimisu, 2024) + **yamasaki's WGSL prefix-sum crossover study** (2026) | WGSL scan/sort libraries: TileScan/ChainScan families; 4-way radix with an *order-checking early exit* (frame-coherence exploitation); measured GPU/CPU scan crossovers. | **BACKLOG — the designated port sources.** The 205 scan/sort items get re-pointed here (WGSL in hand, no transliteration from Vello). The radix early-exit is the piece neither 205 note carried (slow orbits = near-sorted keys). |
| 8 | **CBT — Concurrent Binary Trees** — Benyoub & Dupuy, HPG 2024 | GPU-friendly bitfield-sum tree, amortized O(1) concurrent per-level updates; planetary-scale demo. | **BACKLOG.** The structure for a GPU-resident dynamic culling hierarchy. Trigger: a streamed/moving-occluder scene where per-frame BVH rebuilds show in the profile. |
| 9 | **Spatial hash with linear memory** — Zhyhallo & Woźna (ICAART 2024) + Anagnostou's WGSL layout recipe (2025) | Parallel 1D spatial-hash table, fixed-size vectors + pivots, rebuildable per frame. | **BACKLOG.** Trigger: dynamic-scene broadphase (particle collisions, swarm). |
| 10 | **NeuralPVS** — SIGGRAPH Asia 2025 (arXiv 2509.24677) | Learned from-region PVS, ~100 Hz, <1% missed. | **REJECT.** Training + on-device inference violates the runtime-pure contract (the same family as the 206 neural-visibility rejection). |
| 11 | **H-PLOC** — Benthin et al., HPG 2024 | Hierarchically batched PLOC BVH build. | **REJECT.** Same family as Fused Collapsing: our builds are one-shot; the hot build (model-viewer tri-BVH) is leaf-heavy where PLOC helps least. |
| 12 | **Steam Deck two-pass HZB economics** — Ferri de Lange (Breda U., Dec 2024) | Profiled on low-end hardware @8k draws: HZB chain 0.73–0.79 ms, geometry 3.44→2.17 ms; one scene *regressed* 0.25 ms. | **REJECT as a technique (we shipped the shape), KEEP as the cost model:** every extra phase ≈ a HZB rebuild + a draw-gen dispatch; our 480×270 pyramid is ~25× cheaper than his full-res chain, which is why our 2-phase survives. |

## 5. The open niche — where this can go next

- **N adaptive phases:** nobody accessible runs more than 2 phases + a
  cross-frame seed in one frame. If we go to N: order each wave
  front-to-back / largest-rect first (the CHC lineage), make each phase
  an **incremental delta-pyramid update** (re-max only the tiles the new
  wave's writers touched) instead of a full rebuild, and stop adaptively
  (newly-visible < threshold, or a read-tick budget). The delta-pyramid
  is the genuine unexplored piece — ferri's cost data says full rebuilds
  dominate multi-phase frames.
- **The bevy deltas** (§4 #1): the cross-frame HZB seed for phase 1 and
  the post-render late downsample are the two cheap follow-ups — both
  compose with our history brick without touching it.
- **The early-Z half** (§4 #3): front-to-back V1 ordering rides the
  radix-sort backlog.

The 205/206 backlog re-ranked: scan/sort items now point at WGSL port
sources (GPUPrefixSums, webgpu-radix-sort); the two-plane Hi-Z note stays
retired (the Task-206 fine descent covers its value); the delta-pyramid
enters as the highest-value *original* contribution candidate, gated on a
moving-occluder demo that would exercise it.
