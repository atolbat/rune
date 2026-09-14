# graphics-research-206 — the close-camera round

Status: **SHIPPED (Task 206)** — the round the user's field report drove:
«камера вплотную к ярким боксам, они перекрывают почти весь экран, а
рисуются всё равно тысячи». The answer came in two moves — a **kernel
correctness fix** (the behind-the-eye population was being *drawn*, not
culled) and a **research-sourced strength win** (Greene's hierarchical-z
descent, budgeted, into the GPU cull kernel). Both backends, parity
held. Plus the fresh niche harvest (HPG 2025 + HPG 2026), every
candidate measured against our workload profile and honestly ranked.

The rule (inherited from 205): *a technique enters the engine only with
a number and a parity gate.* This round adds a corollary: *the best
research input is sometimes your own field report — reproduce it
headless first, then let the fix ride the literature.*

---

## 1. The reproduction (the probe that found the bug)

`scripts/task206-closecam.mjs` — the direct-drive probe (the new
`?bare=1` boot channel skips the multi-minute SwiftShader boot
validation; the rAF loop pauses; the probe owns the frame through
`window.__hizTier.renderTo`). Seven close cameras at dist 12 (the
wheel's floor), the policy matrix at the guilty one, the ON/OFF surface
hash per camera, and the canvas-coverage proxy (non-sky pixels).

The guilty camera (yaw 0, pitch 0.1, dist 12, coverage 95.6%):

| policy | drawn (before) | drawn (fix 1) | drawn (fix 1+2) |
|---|---|---|---|
| K = the 23 city occluders | 9477 | 2767 | 2767 |
| «City occludes» (N writers) | 8134 | 1425 | **428** |
| Hi-Z OFF (the frustum floor) | 7305 | 7305 | 7305 |

The straddle bucket: **6802 → 1**. The far validation camera (yaw 0.55,
dist 34) also cleaned up: drawn 5616 → 2302 — the behind-camera
population was inflating *every* view, the close camera just made it
obvious.

## 2. Fix 1 — the clip-space plane counts (the correctness bug)

**Source:** the field report + the standard clip-space culling form
(Ericson, *Real-Time Collision Detection* §5.3/GPGPU chapter; the same
half-space tests every hardware clipper runs).

**The bug:** the cull kernel's six frustum-plane counters (`outL..outF`)
lived *inside* the `w > 1e-4` guard, in NDC. A corner at/behind the eye
contributed nothing — so a box **fully behind the camera** never
gathered `outN == 8`, fell through to the straddle class (flag 4), and
was **drawn**: submitted, rasterizing nothing (the hardware clips it),
inflating the HUD's «drawn». At dist 12 that was 6802 of 16407 records.
The accounting invariant (frustum + occluded + drawn = N) held all
along — which is exactly why the far-camera gates never fired.

**The fix (both kernels, WGSL + GLSL):** count the plane outsides in
clip space — half-spaces of *eye space*, exact for every corner
whatever the sign of `w`:

- left `x + w < 0`, right `x − w > 0`, bottom `y + w < 0`, top `y − w > 0`
  (the four side planes pass through the eye);
- near: WG `z < 0` (the [0,1] NDC near plane — `z_clip = 0` *is*
  `z_eye = −near`, `w` never divides), GL `z + w < 0` (the [−1,1]
  spelling of the same matrix);
- far `z − w > 0` (both backends).

For `w > 0` corners these are algebraically the old NDC compares; for
`w ≤ 0` they finally *speak*: a fully-behind box has `z_clip < 0` at
every corner → `outN = 8` → frustum-culled, exactly what the CPU plane
model (`frustumVerdicts`) always answered. The kernel-model gate in the
demo's validation was re-pointed at the same clip-space form (it used
to *model the bug* — the old comment said so out loud).

**Soundness:** the reclassified boxes draw nothing either way (behind
the camera / outside a side plane) → pixels identical. The ON/OFF
surface hash: **7/7 IDENTICAL** across the close-camera scan, both
backends. The straddle class now carries only its honest population —
boxes genuinely crossing the eye plane (1–3 at these cameras).

## 3. Fix 2 — the budgeted Greene descent (the strength win)

**Source:** Greene, «Hierarchical Polygon Tiling with Coverage Masks» /
the hierarchical z-buffer lineage (Greene–Kass–Miller 1993; already in
the engine's CPU raster from Task 205 — this round it crossed to the
GPU kernel).

**The weakness:** the single-tap coarse test picks the mip where the
box's rect fits one texel (`2^L ≥ max(rw, rh)`). At level L the rect
rounds *out* to whole 2^L blocks — grid-rounding **slop** — and any
background gap inside that slop poisons the region max to 1.0. A far
box fully behind a dense cluster of small near boxes stayed drawn just
because the *neighborhood* of its footprint had holes. At the guilty
camera (city-occludes): 1425 boxes drawn at 95.6% coverage.

**The fix (both kernels):** after the coarse tap fails to prove hidden,
scan **only the rect's own texels** at the *finest* level whose read
count stays ≤ 64 (`stepsX·stepsY ≤ 64`, the level found by a pw-accumulator
loop — no shift-count typing traps in Tint), with the monotone
early-out: the first texel ≥ the box's nearest corner settles VISIBLE
(completing the scan = HIDDEN, every F-texel being the max of its
2^F×2^F mip-0 block). Sound by the coarse tap's own proof with a
tighter region; strictly stronger culling, never weaker; the visible
early-out keeps the common case at ~1 read.

**Numbers:** guilty camera city-occludes 1425 → **428**; the default
smoke view 4388 → **2391** (drawn/16407); the far validation camera
2548 → 2302. No measurable dispatch cost on the SwiftShader probe
(≈200 ms/config unchanged). Parity: the smoke boot validation PASS on
both backends; the close-camera ON/OFF hash 7/7 IDENTICAL both
backends; the accounting invariant holds.

## 4. The fresh harvest (2025–2026, niche sources only)

Sources: HPG 2025 (Copenhagen, CGF 44:8) + HPG 2026 (LA) paper lists,
EGSR 2025, JCGT 2024–2025, arXiv cs.GR. Engine-vendor blogs excluded
by the standing policy; corporate *research division* papers noted with
their affiliation. Raw search digests live with this doc's history; the
curated verdicts:

### The BVH session (HPG 2025 S1) — our exact territory

1. **DOBB-BVH** — *Efficient Ray Traversal by Transforming Wide BVHs
   into Oriented Bounding Box Trees using Discrete Rotations*
   (Kern, Galvan, Oldcorn, Skinner, Mehalwal, Reyes Lozano, Chajdas;
   HPG 2025; arXiv 2506.22849). OBB construction from a **fixed set of
   discrete quantized rotations**, all children of a node sharing one
   transform (so the ray transforms once per *node*, amortized over the
   fan-out); k-DOP extension for wide nodes; applied as a post-process.
   +18.5% primary / +32.4% secondary rays, max +65%, +12.6% build time.
   **Verdict: honest rejection this round.** Our ray workload is
   picking (one ray per click) and the validation sweeps — ray-light;
   the amortization needs wide BVHs our binary kit doesn't have, and
   JS has no SIMD to hide the 9-mult transform. **Backlog condition:**
   a ray-heavy feature (particle collision rays, a raytraced demo) —
   then a wide-BVH + DOBB prototype is the first candidate, benched
   against the current 1.52M rays/s.
2. **Fused Collapsing for Wide BVH Construction** (Barbier, Paulin;
   IRIT; HPG 2025). Bottom-up collapsing fused into the binary build —
   wide BVHs without the temporary binary pass, **1.4–1.6× lower build
   times**. **Verdict: rejection with numbers** — our city BVH builds
   once (16k boxes); the only hot build is model-viewer's lazy tri-BVH
   (2.4–27 ms/click), which is *leaf-heavy*, exactly where wide-node
   collapsing helps least. Backlog if tri-BVH builds move into the
   frame path.
3. **UBVH** — *Unified Bounding Volume and Scene Geometry
   Representation for Ray Tracing* (Káčerik, Bittner; CTU Prague; HPG
   2025). Merges bounds and geometry into one representation; their
   sphere-bounds variant (SOBB) hits 336 vs 293 Mrays/s on Mammoth.
   **Verdict: backlog note** — a representation change across the whole
   kit; the sphere-bound idea intersects our group-spheres (Task 191)
   and deserves a look when the ray path gets hot.

### HPG 2026 (the award paper)

4. **Memory-Efficient Bounding Volume Hierarchies with Merged Nodes**
   (Haydel, Kensler, Yuksel, Brunvand; 2nd place, Wolfgang Straßer
   Award). Sibling nodes with near-identical bounds merged — memory
   down, traversal flat-to-better. **Verdict: rejection with numbers** —
   our BVHs are typed arrays in the tens-of-KB range; memory is not a
   constraint the web demos feel. Revisit if a demo ships a mesh-heavy
   scene (the model-viewer tri-BVHs at 100k+ triangles).

### The rest of the harvest (logged, ranked)

5. **Fast Planetary Shadows using Fourier-Compressed Horizon Maps**
   (Fritsch, Schneegans, Friederichs, Flatken, Eisemann, Gerndt; DLR /
   Bremen / Braunschweig; HPG 2025). Quad-tree horizon tiles,
   Fourier-compressed, screen-size-driven LOD, in-frustum loading.
   Beautiful, very niche (CosmoScout VR). **Backlog:** needs the shadow
   pipeline we don't have; flagged for a future terrain/planet demo.
6. **LiPaC — Light Path Guided Culling for Hybrid Real-Time Path
   Tracing** (Kelling et al.; JCGT 2024). Culls *lighting relevance*,
   not visibility. **Rejection:** we have no RT path; the idea (cull by
   contribution, not just occlusion) is noted for a future LOD policy.
7. **Neural Visibility for Occlusion Culling in 3D Gaussian Splatting**
   (arXiv, Nov 2025). Trained visibility for 3DGS scenes. **Rejection:**
   training-based, 3DGS-specific — against the engine's runtime-pure
   contract.
8. **A GPU-friendly hybrid occlusion culling algorithm** (Li; 2023;
   iterative HiZ + object-level). **Rejection:** our two-pass HZB
   (history feedback) already covers the iterative-refinement shape,
   with the no-reprojection twist; no measured delta to gain.
9. HPG 2025 also shipped: *No More Shading Languages* (C++→SPIR-V;
   against our WGSL/GLSL dual-backend law), *Collaborative Texture
   Filtering* (Akenine-Möller, Ebelin, Pharr, Wronski — texture-path,
   we don't own a sampler framework), *Spherical Harmonic
   Exponentials* (glossy reflections — no reflections pipeline yet),
   *LidarScout* (out-of-core points — no point pipeline yet). All
   logged for the day their subsystem exists.

## 5. The updated backlog (absorbing 205's, re-ranked)

1. ~~Two-plane Hi-Z kernel~~ — **partially obsoleted by the budgeted
   descent**: the min-plane's win (early *visible* classification) is
   now largely covered by the fine pass's early-out. Remaining value:
   a max-plane-only tile skip in the *reduce* pass. Low priority.
2. **DOBB-style discrete-rotation OBBs** (HPG 2025) — gated on a
   ray-heavy feature landing.
3. **Decoupled Fallback / atomic-scan compaction** (HPG 2025 backlog
   item) — the compact kernel's scan path; measure before touching.
4. **Onesweep radix WGSL** — the compact's u32 sort-free ranking; same
   gate as 3.
5. **HROC group-then-refine** — the soft occluder's write side
   (cluster-conservative raster before per-box); pairs with the
   near-clip writeBox fix (the straddler-refusal hole the probe
   exposed on the CPU leg — documented, not yet fixed).
6. **MBOIT / STBN** — transparency and noise; untouched subsystems.

## 6. The honest holes this round left open

- **The soft leg's writeBox straddler refusal** — a CPU-side under-claim
  twin of the GPU bug (a box with a corner behind the eye writes
  *nothing* to the software depth buffer). Sound (never over-claims),
  but it guts the soft gate's catch at close cameras. The fix is
  Sutherland–Hodgman near-clipping of the face quads in clip space —
  designed, not implemented this round.
- **The GL/WG near-plane asymmetry** (the GL leg reads the WG matrix in
  [−1,1], putting its effective near at ≈near/2) — documented in the
  model gate's spelling; harmless at the demo's geometry scales, but a
  real cross-tier divergence class if a scene ever puts boxes inside
  (near/2, near).
- **The close cameras are still outside VAL_CAMERAS** — the probe
  covers them (7/7), but the *page's own* boot validation rides the far
  trio; folding a close camera into the validation set needs the
  cross-tier tolerance recalibrated for the near-plane asymmetry first.
