# rune DESIGN — addendum to the v1.0 dossier (Mali-G57 MC2 bench calibration)

> Cross-checked against `upload/rune-design-dossier.docx` (dossier v1.0, 9 iterations, fully
> approved, August 2026). The previous draft "Round 5: adaptivity instead of
> hardcoding" is withdrawn: it turned out that most of the "new" ideas are already present
> in the dossier under canonical names (catalog §12, Contract 4 §11.3, mobile
> discipline §9.2). This document is an **addendum**, not a replacement for the dossier.

## 0. Context

The v1.0 dossier was lost during an environment reset (worklog Task 43) and was not restored.
Bench rounds 4–5 (the present-path bench on SwiftShader, the Mali-G57 MC2 phone bench,
heavy-×8 theory benches) were run without reference to the dossier. The result — several
"O–S theories" from Task 49 turned out to be renames of catalog §12 items. This
addendum records the cross-check and provides calibration formulas for Contract 4
(the adapter's tier ladder), based on bench data from a live Mali.

## 1. Cross-check of "O–S theories" ↔ catalog §12

A direct correspondence table. It confirms: what I presented as "new O–S
policies" is a renaming of already-approved dossier items.

| "theory" from Task 49 | № in catalog §12 | Name in the dossier | Layer |
|---|---|---|---|
| reactiveFrame | #17 | Signal frame-cap on input idle (battery) | Core |
| switchBackend | #19 | Hot adapter swap — journal replay | Core |
| atlas (UV remap) | — | (not in the catalog, but described in §6 as inferred passes) | Core |
| paging (virtual texture memory) | #9 | Network tiles via HTTP Range + textureArray (deep-zoom) | Kit |
| adaptive (dynamic resolution) | #44 | Mip-trim under memory pressure | Core |
| worker (moving compile/staging out) | #12 | Zero-main-thread asset path (fetch, decode, slicing — in workers) | Core |
| thermal heuristic | #47 | Thermal/battery fusion into the pressure signal | Core |
| present paths (direct/blit/bitmap/…) | #61 | Canvas compositing hygiene (premultiplied, opaque, desynchronized) | Kit |
| asyncbmp path | #62 | transferToImageBitmap export without readPixels (+ golden-CI) | Kit |
| feature-ladder (my "AdaptiveLimits") | #48 | Feature-ladder + requestTier (feature/limit negotiation) | Core |
| adaptive codegen by class | #43 | Adaptive codegen by device class | Core |

**Conclusion**: the "switchability of O–S policies" is already built into the dossier as a "catalog
of optimizations where every entry is toggleable with a safe default". Catalog №1–65 is
the canonical nomenclature; the "O–S theories" are withdrawn.

## 2. Adaptive limits — already in the dossier as Contract 4

§11.3, **Contract 4** — the adapter's tier ladder:
> `requestTier` — negotiation of `requiredFeatures` and `requiredLimits` with a step-down
> on refusal; feature-ladder is a first-class citizen (the mobile profile is a special
> case).

This is exactly what limit adaptivity looks like in canonical form:
- No hardcoding of `maxRenderSize=1024²`, `maxTextureMemory=480 MB`,
  `forbiddenPaths` — that would contradict Contract 4.
- `requestTier` negotiates `requiredLimits` with the adapter and steps down on
  refusal. On Mali-G57 MC2 it steps down to the mobile profile (§9.2: dpr≤2, ASTC,
  memoryBudget 256 MB), on desktop it stays at full.
- The profile is a **special case** of the feature-ladder, not a hardcode.

§9.2, the mobile profile — a profile for tile-based GPUs (99% of mobile devices):
> dpr up to 2, ASTC, memoryBudget 256 MB, an interpreter instead of codegen, idle
> frame-cap 30. Battery: a visibility signal, frame-cap on input idle,
> a thermal heuristic (frame-time EMA and charge level lower the resolution before
> throttling).

The Mali-G57 MC2 bench validates exactly this profile (rather than setting a "cap for everyone"):
- 9 contexts until eviction → the bench confirms that the mobile profile keeps
  `maxActiveContexts` low (but this is tier negotiation, not a hardcode)
- 128 × 1024² RGBA8 = 512 MB until the cap → the bench confirms that
  `memoryBudget 256 MB` (half of the cap) is a sensible profile
- heavy-2048 11 fps, p95 184 ms → the bench confirms that on Mali renderSize
  is limited to `MAX_TEXTURE_SIZE/4` adaptively

## 3. Real diffs code ↔ dossier (per the M0–M8 plan)

§14.3, implementation stages:

| Stage | Per plan | In code (per worklog Task 43–49) | Diff |
|---|---|---|---|
| M0 Skeleton | Monorepo, packages, CI | ✅ packages @rune/{core,math,prims,webgl2,webgpu,gl}, tsconfig | none |
| M1 Core-1 | Signals, epochs, tapes v1, journal | ✅ signal+derive, epoch, tape SoA, segments+live, transientPool, layoutGuard | **declarations journal** — DIFF (lost in Task 43, not restored) |
| M2 WebGL2 | DrawSpec, Uniform ABI, passes | ✅ glslReflect, compiler, executor (uniforms by name, state cache, BindTarget), realGL (FBO+depthMask), recordingGL | none |
| M3 WebGPU | Pipeline cache, arena, dynamic offsets | ✅ wgslReflect, 256 slice arena, compiler, executor, realGPU (writeTexture origin, lazy pipelines, dynamic offsets), recordingGPU | none |
| M4 Portability | Matrix, switchBackend, loss simulation | ✅ partial: showOn/showAny (backend cascade with try/catch), pause/resume, freshCanvas (re-probe) | **switchBackend as journal-replay** — DIFF (no declarations journal → no replay either); portability matrix §11.1 — DIFF (no caps module) |
| M5 Workers | Stub tapes, T0–T3, feed | ❌ **completely lost** (Task 43: "transport seqlock/SAB registry T0–T3, feed — not restored") | DIFF — no transports, no feed, no stub tapes in the worker |
| M6 Streaming | upload-jobs, AIMD, residency | ✅ uploadScheduler AIMD (2/16 MiB window, 4 MiB burst — theory N), streamTexture, chunker | none (theory N is closed) |
| M7 Sugar | scene, frag, image, prims, input | ✅ show, surface+pass (frag/image → ONE structure, Task 46), prims cube+quad | none |
| M8 Kit and debug | Recipes, capture, rewind, explain | ❌ partial: diag1–17 (the diagnostics arsenal), bench-present (the path bench) | **kit, capture, rewind, explain** — DIFF; golden-CI — DIFF |

**Main conclusion of the cross-check**: rounds 4–5 of bench engineering were run as "new design",
although in reality this is incremental work on M4/M8. The present-path bench is
preparation for #61 (compositing hygiene) and #62 (transferToImageBitmap), the phone bench is
calibration of Contract 4 (the tier ladder) and §9.2 (the mobile profile).

## 4. Calibration formulas — what the Mali bench adds to Contract 4

Bench data (Mali-G57 MC2 phone, round 4) does not set limits, it calibrates
the tier negotiation formulas:

| Mali measurement | Contract 4 / §9.2 formula | Its value on this hardware |
|---|---|---|
| `MAX_TEXTURE_SIZE=8192`, `limits.maxTextureDimension2D=16384` | `requestTier.requiredLimits.maxTextureDimension2D` | steps down from 16384 → 8192 on refusal |
| reference evicted after 9 contexts | probe `probeContextEviction()` (new for §9.2) | 9 → safetyMargin(1) = 8 (a measurement, not a hardcode) |
| 128 × 1024² RGBA8 = 512 MB until the cap | `memoryBudget` heuristic (§9.2: 256 MB profile) | profile=256 MB (half the cap; a profile, not a limit) |
| `blit2default` gl error 1282 | Contract 5: "an unavailable capability — an explicit matrix row" | matrix §11.1 notes: `blit→default` = no (format MISMATCH ANGLE BGRA) |
| `preserve`/`draw2d-half`/`scaled-half` p95 50–67 ms | jank contract (Contract 1, §11.3): "main thread ≤ maxMs" | these paths = "not dominant" in the portability matrix |
| heavy-2048 11 fps, p95 184 ms | `requestTier` steps down `maxTextureDimension` under pressure | Mali profile: renderSize ≤ 1024² for heavy, ≤2048² for light |

**New formula (not in the dossier, a proposal)**: an adaptive p95 degradation threshold
via a **ratio** rather than an absolute:
```
degradationRatio = p95_rolling / p50_rolling
pathHealthy = degradationRatio < thresholdRatio   // default 1.5
```
On Mali (p50≈16.8 vsync) ratio 1.5 → trigger 25.2 ms — catches preserve (3.0) and
draw2d-half (4.0). On desktop (p50≈4) ratio 1.5 → trigger 6 ms — it reacts to
relative degradation, not tied to the hardware. **This is an addition to Contract 1
(the jank contract), not a replacement**: instead of "maxMs = X" — "maxRatio = 1.5 × p50".

## 5. What REALLY needs to be added to the code (by M4–M8 priorities)

The diffs from §3, ranked by dependency:

### 5.1 Declarations journal (M1, lost) — the foundation for M4
Without it there is no `switchBackend` (#19), no `device-loss recovery` (#19), no migration
into a worker (#12). This is a **blocking diff** — M4 (Portability) cannot be
closed without it.

Per the dossier: "the declarations journal makes switchBackend = device-loss
recovery = worker migration a single replay mechanism". Restore it as
`packages/core/src/journal/` (a declarations registry with destroy-ops — audit 1,
§14.1).

### 5.2 caps module (M4, portability matrix)
§11.1, §11.4: `capabilities.has(FeatureId)`, `caps.format(f)` along 6 axes,
`caps.ext` escape hatch, `RendererStats` (cpuMs, gpuMs, memoryEstimate,
hit-rate). Without this there is no "gate honesty" (Contract 5) — an unavailable
capability must be either null, or a capability check, or a matrix
row. None of this is in the code today.

Artifact: `packages/core/src/caps.ts` + integration into realGL/realGPU.

### 5.3 requestTier (M4, Contract 4)
`adapter.requestDevice({ requiredFeatures, requiredLimits })` with a step-down on
refusal. Today `createRealGPU` (realGPU.ts:14–17) calls `requestDevice()` without
parameters — no negotiation. The "mobile" profile from §9.2 (dpr≤2, ASTC,
memoryBudget 256 MB) must be a **requested tier**, not hardcoded
by userAgent.

Artifact: `packages/webgpu/src/tiers.ts` — the RequestTier ladder (desktop / mobile /
fallback) + integration into `createRealGPU`.

### 5.4 T0–T3 transports + feed (M5, completely lost)
§7.2: T0 (single thread, synchronous), T1 (postMessage), T2 (SharedArrayBuffer + seqlock),
T3 (SAB registry + fallback). Measurements in the dossier: read 14 ns, write 18 ns —
four orders of magnitude cheaper than messages. Restore as
`packages/core/src/transport/`.

Artifact: T0–T3 transports + feed (dual-bind) — the base for #12 (zero-main-thread).

### 5.5 present paths (M8, #61 + #62)
The present-path bench (download/rune-bench.html) is preparation for #61 (compositing
hygiene) and #62 (transferToImageBitmap). The 12 frame-presenting paths + 2 WebGPU ones —
move them from the bench artifact into the runtime as `packages/gl/src/present.ts` with
a PathRegistry (my `PathState` from the withdrawn draft is the only thing that is
genuinely new; everything else is canon).

PathState must integrate with Contract 1 (the jank contract): the
`healthy → disabled` transition on `degradationRatio ≥ 1.5 × p50` (the §4 addendum formula).

### 5.6 Kit + capture + rewind + explain (M8)
§10.3, §11: `@rune/kit`, `@rune/debug`, `@rune/tape`. Two thirds of catalog §12
(#6, #8–11, #16, #21, #24–27, #30–32, #34, #39–42, #45, #49–65) live at the Kit layer.
Today the code only has `demo/diag*.ts` (diagnostic scripts, not a package).

## 6. What NOT to do (withdrawn from the previous draft)

- ❌ `maxRenderSize`, `maxActiveContexts`, `maxTextureMemory` as hardcode constants —
  contradicts Contract 4; the right way is `requestTier` negotiation.
- ❌ `forbiddenPaths: ['blit2default', 'preserve', 'draw2d-half', 'scaled-half']`
  as a hardcode list — contradicts Contract 5; the right way is the §11.1 matrix +
  degradationRatio.
- ❌ `disableGPUAcceleration` as a **new** option — it is a special case of the tier choice
  `requestTier=software` or the "Canvas2D fallback" profile (if added — as a
  `ShowOptions.backends` branch, not as a global toggle).
- ❌ `configure({ policies })` with reinvented names — the right way is
  `configure({ policies: { '#17': true, '#44': true, '#47': false } })` or
  human-readable aliases, but with a "= catalog #N" annotation.
- ❌ My "7 implementation stages" — withdrawn; the canonical M0–M8 from §14.3.

## 7. Refinements to the dossier (proposals for approval)

These items do not contradict the dossier; they refine its formulas based on bench data:

1. **Contract 1 refinement (jank)**: add an adaptive degradation threshold
   `degradationRatio = p95/p50` (default 1.5) — the absolute `maxMs` remains
   as a ceiling, but the ratio catches degradation relative to vsync saturation rather
   than from an absolute. See §4 addendum.

2. **§9.2 refinement (mobile profile)**: add the probe
   `probeContextEviction()` as part of `requestTier` — on Mali it yields 9, on
   desktop it may yield 16+. This is not the hardcode "8", it is a measurable profile.

3. **§11.1 matrix refinement**: add rows for the 12 present paths
   (direct/quadpass/bitmap/draw2d/multi4/draw2d-half/preserve/blit/
   quadcopy/uvremap/asyncbmp/multibmp4/scaled-half) and the 2 WebGPU paths
   (wgpu-direct/wgpu-copy) — with "renderable / not portable / degradation" annotations
   based on bench data.

4. **Catalog §12 refinement**: the real names of the "O–S theories" are already in
   the catalog; the bench data adds no new items, it calibrates #44
   (mip-trim under pressure), #47 (thermal/battery), #48 (feature-ladder),
   #61 (compositing hygiene), #62 (transferToImageBitmap).

## 8. Further work stages (the M4 → M8 canon, not mine)

| # | Task | Stage | Dependencies |
|---|---|---|---|
| 1 | Declarations journal + destroy-ops | M1 (restoration) | — |
| 2 | caps module + RendererStats | M4 | 1 |
| 3 | requestTier ladder (desktop/mobile/fallback) | M4 | 2 |
| 4 | T0–T3 transports + feed (dual-bind) | M5 | — |
| 5 | present.ts (PathRegistry + PathState + 12 paths) | M8 (#61, #62) | 2, 3 |
| 6 | degradationRatio as a Contract 1 refinement | M8 (dossier refinement) | 5 |
| 7 | Kit packages: @rune/kit, @rune/debug, @rune/tape | M8 | 1, 2 |
| 8 | switchBackend via journal-replay | M4 (#19) | 1 |

## 9. Infra-primitives for deploying the catalog

> Round 6 addendum. After the cross-check against the dossier (§1–§8) and catalog §12 as a whole —
> a decomposition of the 65 entries + 12/2 present paths into recurring patterns. The goal:
> make 80% of the catalog and the "similar with small changes" items
> deploy as compositions of 9 primitives + 1 meta, instead of a bespoke
> implementation of every single entry. It does not replace the dossier — it describes
> the infrastructural skeleton in which §12 items become ≤20-line
> compositions.

### 9.1 Method

Catalog §12 is 65 disjoint ideas. Without a common skeleton each one
is implemented in an isolated module, with its own API, its own tests, its own
degradation path. Bench rounds 4–5 showed the price: the "O–S theories" turned out
to be renames of catalog entries (§1 addendum), because every theory
had its own namespace, unconnected with the canonical names.

To keep this from repeating at the implementation level, the following method was applied:
1. Read all 65 catalog entries + 14 present paths.
2. For each one, write down "what it needs to measure / decide /
   degrade".
3. Group by the commonality of those three operations.
4. The group names are the primitives.

The result — 6 universal patterns (covering ~52 of the 65 entries) and
2 cross-cutting utilities (covering the rest except ~13 "specific" ones).
Not covered: raw browser APIs (HTTP Range, transferToImageBitmap,
VideoFrame, OffscreenCanvas), specific shader codegen (Nanite-lite,
TSR-lite, AgX, HiZ) and semantic invariants (premultiplied, opaque,
desynchronized, depthMode compare translation). Those remain manual
recipes.

### 9.2 The common part — six universal patterns

**P1. Probe → Gate → Degrade.** A triad: measure state → decide the
threshold → switch behavior. Found in: #17 (idle-input → cap),
#19 (device-loss → replay), #44 (memory → mip-bias), #47 (thermal →
resolution), #48 (features → tier), #43 (gpu-class → codegen), #14
(pressure → evict), #61 (p95/p50 → disable path), #62 (caps → asyncbmp),
#9 (range → paging), #57 (half-res). The pattern is one — implementations differ.

**P2. Pressure-bus fusion.** Several "decreasing" signals (idle-input,
thermal-EMA, battery, memory-pressure, network-downlink) merge into a single
scalar `Pressure ∈ [0, 1]` that degrade callbacks subscribe to.
Found in #17, #44, #47, #43, #48, #14, #61. Dossier §9.2 describes it
by hand ("visibility signal, frame-cap on input idle, thermal
heuristic (frame-time EMA and charge level lower the resolution)") — that is precisely a
pressure-bus, just not named as a primitive.

**P3. Journal-replay.** One mechanism for three scenarios (per §5.1 addendum):
#19 switchBackend = device-loss recovery = worker migration. The declarations
journal with destroy-ops is the "mount point" of P3. It also
serves: #13 (heap compaction = replay + drop), #14 (lazy
re-declaration = evict + redeclare), #41 (resume-snapshot = journal +
tape ring), #42 (cold-start prewarm = replay tape during the splash).

**P4. Transferable stream (Tape + dual-head).** A tape = an SoA ArrayBuffer,
the recorder writes, the executor plays back, and between threads — transfer.
Found in #4 (triple buffer), #5 (parallel encoders), #7 (Tape JIT
vs interpreter), #12 (worker path), #15 (orchestrator batches), #30
(GPU-less authoring = stub recorder), #41 (resume), #64 (scoped
determinism = the tape as a pure function of the log). Already in the code as
`recordingGL/realGL` and `recordingGPU/realGPU` — an invariant, not new
development.

**P5. AIMD pump.** A window with AIMD dynamics + an idle slot + a burst. Already in the code
as `uploadScheduler` (theory N closed by Task 45). Generalizes into `Pump<T>`
and covers: #8 (scan-progressive decode), #9 (HTTP Range tiles), #10
(OPFS L2 cache), #11 (codec plugins), #12 (upload-jobs), #46 (staging
pool), #42 (cold-start prewarm).

**P6. Capability matrix + path registry.** Honest gates (Contract 5):
`caps.has(FeatureId)`, `caps.format(f, axis)`, `caps.path(id)`. A path registry
with Probe/Caps/Decay gates. Covers: #39 (pickFormat family),
#48 (tier), #49 (subgroups), #50 (work graphs), #60 (WebCodecs), #61
(present paths), #62 (asyncbmp), #45 (zero-copy ladder audit). Dossier
§11.4 already has Caps — extend it with `path()` for present paths.

**U1. Decay (EMA + ratio + hysteresis).** A cross-cutting utility.
Found in #17 (EMA frame-cap), #44 (memory decay), #47 (thermal-EMA),
#61 (degradationRatio p95/p50 — the §4 addendum formula), #21 (history ring).
Needs no separate "module" — a utility function.

**U2. Telemetry hook.** A cross-cutting contract: every primitive
exports `state(): {id, enabled, lastValue, verdict}`. Found
everywhere (§11.3 Contract 5, §11.4 RendererStats, #27 signal devtools, #45
explain-audit, #65 pixel-diff). Present in the code as diag1–17 — generalize into
a single interface.

### 9.3 The specific part — what does NOT reduce to primitives

Four classes remain manual; primitives wrap them but do not
replace their content:

**S1. Raw browser APIs (escape hatches).** HTTP Range (#9), OPFS (#10),
transferToImageBitmap (#62), OffscreenCanvas + transferControlToOffscreen
(#12, asynchronous present paths), createImageBitmap (asyncbmp/multibmp4/
scaled-half), VideoFrame (#60), WebCodecs, scheduler.postTask (#63),
SAB + seqlock (T2), GPUQuerySet (#34), WebGPU render bundles (#5),
shared memory (#49), navigator.connection (bandwidth/RTT). Each one is a
`caps.path(id) → 'ok'|'unavailable'|'degraded'` plus step-by-step logic in
`run(ctx)`. The primitive provides the shield; the content is manual.

**S2. Specific shader codegen (recipes).** Mip-bias injection (#44),
UV remap (uvremap present path, theory P), dynamic-resize shader
(scaled-half), AgX + Oklab (#55), TSR-lite (#56), checkerboard
(#57), blue-noise Owen-Sobol (#58), meshlet-LOD-DAG (#51), visibility-
buffer deferred (#53), GPU culling chain (#54), HiZ pyramid (#31),
Meshoptimizer pipeline (#52). These are recipes at the `@rune/kit` level —
shader + Tape ops + a Caps gate. They do not generalize into a primitive, but the plug-in
template describes the structure.

**S3. Semantic invariants (not optimizations).** Premultiplied alpha,
opaque canvas, desynchronized canvas (#61), depthMode semantic compare
→ physical translation (#33), NDC harmonization (§5.2 of the dossier),
premultiplied copy (#62), damage-clears for UI canvases (#32), MSAA
resolve (#38), reversed-Z convention (#32). This is discipline, not
optimization — implemented in the Tape executor as an invariant, not a plug-in.

**S4. Specific debug artifacts.** Snapshot fuzzing (#23), perf bisect
(#24), borrow-check (#26), pixel-diff (#65), capture (#25), explain-audit
(#45), signal devtools (#27), GPU-less authoring (#30). They consume the Tape
as a data source, but each is its own analytics. They do not generalize,
because the analysis algorithm differs.

### 9.4 Principle: boilerplate must not grow

The customer's main requirement: **the external API = minimal**. The internal
complexity of the primitives is invisible and unimportant. This formalizes the principle:

> The user writes **only what is specific to their feature** — the caps gate,
the measure function, the run function, the shader. The entire skeleton (cache, invalidation,
EMA, fusion, subscription, telemetry, healthy-path selection, degradation) is
library-side, with sensible defaults. `FeaturePlug` is an **internal**
library record (for telemetry / rewind / determinism); the user does not
build it and never sees it.

Two API rules follow from this principle:

1. **No required fields beyond the feature specifics.** `id` is auto-generated
   from the name string. `requires` accepts a string shorthand. `telemetry`,
   `degrade`, `depends` — library defaults.
2. **`depends` is removed from the user API.** The library infers
   dependencies from what `apply()`/`run()` calls (pressureBus.on →
   pressure-dep, paths.add → path-dep, pump.create → pump-dep).

### 9.5 Primitives (9 + 1 meta) — the external and internal layers

Nine primitives + one meta. Some already exist in the code/dossier (marked),
some are new (per §5 addendum). They do not duplicate the dossier — they generalize what the
dossier describes point by point.

**External API (user-facing, low boilerplate)** — functional
one-liners with optional fields and defaults:

```typescript
// A present path — 2 required fields (requires + run), the rest by default
paths.add('transferControl', {
  requires: 'OffscreenCanvas.transferControl',  // string shorthand for caps.path === 'ok'
  run: ctx => ctx.canvas.transferControlToOffscreen()
  // probe:        default — auto-benchmark on first run, cached
  // degrade:      default — switch to the next healthy path
  // telemetry:    default — the standard {id, enabled, state}
});

// Probe — 2 required (id, measure)
probe.add('hasSAB', () => typeof SharedArrayBuffer !== 'undefined');
// cached:    computed-once, refresh on invalidate (device-loss / backend-swap)
// subscribe: a library signal

// Pressure-source — 2-3 required (id, measure, ema option)
pressureBus.add('network', () => computeNetworkPressure(), { ema: 0.1 });
// range: default [0, 1]; fuse/decay/subscribers — library-side

// Subscribing to pressure — one line
pressureBus.on('idle-input', level => {
  if (level > 0.7) tape.frameSkip();
});

// Pump — 2 required (min, max), maxBurst option
const tilePump = pump.create<Tile>({ min: 256*1024, max: 16*1024*1024 });
tilePump.push(tile);
// burst/drain/stats/AIMD dynamics — library-side

// Tier profile — registration in the ladder
tiers.register('mobile-v2', {
  features: ['astc'], limits: { maxTextureDimension2D: 8192 }
});

// Global options — env-driven, optional
configure({ log: 'verbose' });
// or: RUNE_LOG=verbose (env-variable fallback)
```

**Boilerplate comparison**: the plug-in object described earlier — 6 required
fields (`id`/`requires`/`depends`/`apply`/`degrade`/`telemetry`) + 2
optional ones, ~24 lines for a typical feature. Now — 2–3 required
arguments in a functional call, ~4–6 lines. **A 4–5× reduction.**
The "boilerplate must not grow" condition — met.

**A low-level escape hatch** (for <5% of features — composite plug-ins like
the "mobile profile", which register several sources/paths with a single
declaration):

```typescript
registerRawPlug({
  id: 'mobile-profile',
  requires: caps => caps.has('astc'),
  apply(ctx) {
    ctx.pressureBus.add('thermal', measureThermal, { ema: 0.05 });
    ctx.pressureBus.add('battery', measureBattery, { ema: 0.1 });
    ctx.paths.add('preserve', { requires: 'preserveDrawingBuffer', run: ... });
    // ...
  }
});
```

Full control, a manual declaration. **Not for typical features**.

**Internal representation (library-side, not user-facing)** —
`FeaturePlug` as a record that is built automatically from the
`paths.add()` / `probe.add()` / `pressureBus.add()` / etc. calls:

```typescript
// INTERNAL interface — NOT user-facing
interface FeaturePlug {
  readonly id: string;
  requires: (caps: Caps) => boolean;
  apply: (ctx: PlugCtx) => void;
  // depends — INFERRED from the calls inside apply() (pressureBus.on, paths.add, etc.)
  degrade?: (level: number) => void;     // default: switch to next-best path / no-op
  telemetry: () => PlugState;             // default: {id, enabled, state}
}
```

The full primitive interfaces (for a library-maintainer audience, not users):

```typescript
// 1. PressureBus — NEW (dossier §9.2 describes it by hand)
interface PressureBus {
  add(id: string, measure: () => number, opts?: { ema?: number; range?: [number, number] }): PressureSource;
  on(source: string | PressureSource, fn: (level: number) => void): Unsub;
  fuse(...sources: PressureSource[]): Pressure;     // weighted max; on() accepts a fused pressure
}

// 2. Probe<T> — NEW (a §9.2 refinement, addendum §4: probeContextEviction as a special case)
interface Probe<T> {
  readonly id: string;
  readonly cached: T;                                  // refresh-on-invalidate
  measure(): T;                                        // explicit refresh
  invalidate(): void;                                  // triggered automatically by device-loss / backend-swap
  subscribe(fn: (v: T) => void): Unsub;
}
function probe.add<T>(id: string, measure: () => T): Probe<T>;

// 3. Caps — dossier §11.4, EXTEND with path() and the zeroCopy ladder
interface Caps {
  has(f: FeatureId): boolean;
  format(f: GPUFormat, axis: FormatAxis): FormatSupport;
  path(name: PresentPathId | 'range' | 'asyncbmp' | 'video-external' | 'zero-copy' | 'offscreen-canvas'): PathSupport;
  ext(name: string): unknown | null;
  stats(): RendererStats;
  invalidate(): void;                                  // = invalidate all Probes
}

// 4. TierLadder — dossier §11.3 Contract 4, DO NOT TOUCH (canonical)
interface TierLadder {
  request(features: FeatureId[], limits: Record<string, number>): TierResult;
  register(profile: TierProfile): void;               // desktop / mobile / fallback / custom
}

// 5. Journal — dossier §14.1 audit 1, restore as a primitive (§5.1 addendum)
interface Journal {
  record(op: DeclOp): void;
  replay(backend: BackendId): void;                    // = switchBackend = device-loss recovery = worker migration
  compact(): void;                                     // #13 heap compaction
  snapshot(): Snapshot;                                // #41 resume-snapshot
  evict(predicate: (op: DeclOp) => boolean): void;     // #14 lazy re-declaration
}

// 6. Tape + Recorder/Executor — in the code, an INVARIANT (not a new primitive, but enforced)
interface Tape {
  push(op: OpCode, ...args: number[]): void;
  transfer(): ArrayBuffer;                             // transferable across workers
  replayOn(executor: Executor): void;
  analyze(): TapeStats;                                // borrow-check #26, usage #37, post-link prune #36
  optimize(): void;                                    // #6 tape.optimize
  ring(depth: number): Tape[];                         // #4 triple buffer, #41 resume
}

// 7. Pump<T> — a generalization of uploadScheduler (in the code as uploadScheduler, to be generalized)
interface Pump<T> {
  push(job: T): void;
  drain(slot: IdleSlot): number;                        // bytes / tiles / chunks processed
  burst(bytes: number): void;                           // #theory N — instant on idle, ≤ cap
  setWindow(min: number, max: number): void;            // AIMD bounds
  stats(): PumpStats;
}
function pump.create<T>(opts: { min: number; max: number; maxBurst?: number }): Pump<T>;

// 8. Decay — a NEW utility (formulas in §4 addendum and §9.2 of the dossier)
interface Decay {
  ema(value: number, prev: number, alpha: number): number;
  ratio(p95: number, p50: number): number;              // §4 addendum, degradationRatio
  hysteresis(value: number, lower: number, upper: number, state: boolean): boolean;
  ring<T>(values: T[], n: number): T[];                 // #21 history
}

// 9. PathRegistry — NEW (DESIGN.md §5.5 addendum, to be generalized to any plug-in)
interface PathRegistry {
  add(name: PresentPathId, def: {
    requires: string | ((c: Caps) => PathSupport);   // a string shorthand OR a full function
    run: (ctx: PresentCtx) => void;
    probe?: () => PathCost | Promise<PathCost>;         // default: auto-benchmark
    degrade?: (level: number) => void;                  // default: switch to next-best
  }): void;
  select(caps: Caps, pressure: Pressure): PresentPathId;     // auto-select best healthy
  state(id: PresentPathId): PathState;                       // healthy | degraded | disabled via Decay.ratio
  all(): { id: PresentPathId; state: PathState; cost: PathCost }[];
}
```

### 9.6 Decomposition of catalog §12 → compositions of primitives

Every catalog entry is a composition of primitives. "S1/S2/S3/S4" in the "specific"
column — what remains manual (see §9.3).

| # | Name | Primitives | Specific |
|---|----|-----------|---------|
| 1 | every(n) | Tape.optimize | — |
| 2 | Transient pool | Pool<Target> (epoch-recycle, already in the code) | — |
| 3 | Frequency-split arenas | Tape.partition (frame vs draw) | — |
| 4 | Triple-buffered arena | Tape.ring(depth) | — |
| 5 | Parallel encoders | Tape.split + Caps.has('render-bundles') | S1 (WebGPU bundles) |
| 6 | tape.optimize | Tape.optimize pass | — |
| 7 | Tape JIT/interpreter | Tape dispatch (codegen toggle, dual-head) | — |
| 8 | Scan-progressive decode | Pump<DecodeChunk> | S1 (ImageDecoder) |
| 9 | Network tiles | Pump<Tile>.aimd + Caps.path('range') + Tape.texSubImage | S1 (HTTP Range) |
| 10 | OPFS L2 cache | Pump<Tile> tier extension + Caps.path('opfs') | S1 (OPFS) |
| 11 | Codec plugins | CodecRegistry (pluggable; S1 per codec) | S1 (meshoptimizer, Basis, Draco) |
| 12 | Zero-main-thread | Pump<Job> + Tape.transfer + Journal.replay(worker) | S1 (OffscreenCanvas, postMessage, SAB) |
| 13 | Journal compaction | Journal.compact | — |
| 14 | Lazy re-declaration | Journal.evict(pressure predicate) | — |
| 15 | Global frame orchestrator | FrameOrchestrator (one rAF, BC-delta batching) | — |
| 16 | rVFC frame pacing | FrameOrchestrator extension | S1 (vsync API) |
| 17 | reactiveFrame | PressureBus.source('idle-input') + Decay.EMA + Tape.frameSkip | — |
| 18 | Late input sampling | Tape.snapshot at submit | S1 (input events) |
| 19 | switchBackend | Journal.replay(newBackend) | — |
| 20 | sinkSignal | Arena direct writer (signal → typed slot) | — |
| 21 | history(sig, n) | Decay.ring | — |
| 22 | Fixed-point sim-time | Time source (u64 µs) | S3 (invariant) |
| 23 | Snapshot fuzzing | Tape.fuzz (mutations of epoch snapshots) | S4 (fuzzer logic) |
| 24 | Perf bisect | Tape.bisect (binary search regression) | S4 (search algorithm) |
| 25 | Session capture | Capture (video + Journal.snapshot) | S4 (capture format) |
| 26 | Borrow-check | Tape.analyze (use-after-destroy check) | S4 (analyzer rules) |
| 27 | Signal devtools overlay | Telemetry hook + Tape.epoch timeline | S4 (overlay UI) |
| 28 | Fix-suggestions in errors | Diagnostic messages | S4 (suggestion engine) |
| 29 | Renderer fan-out | Renderer.multiplex (one device, many canvases) | — |
| 30 | GPU-less authoring | Stub backend + Tape authoring | S4 (stub completeness) |
| 31 | Depth pyramid (HiZ) | Recipe (Caps.gate + Tape ops) | S2 (shader recipe) |
| 32 | Reversed-Z + damage-clears | Convention in math + Tape.clear(damage rect) | S3 (convention) |
| 33 | depthMode | Uniform ABI translator (semantic → physical) | S3 (semantic map) |
| 34 | Occlusion-feedback | Probe<Visibility> + Tape.feedback | S1 (GPUQuerySet) |
| 35 | Bind-group-aware ordering | Tape.sortKey extension | — |
| 36 | Active-uniform pruning | Tape.analyze (post-link) | — |
| 37 | Memoryless depth | Tape.analyze (usage analysis) | S3 (usage semantics) |
| 38 | MSAA storeOp discard + resolve | Tape.storeOp select | S3 (resolve invariant) |
| 39 | caps.pickFormat | Caps.format(family) negotiation | — |
| 40 | GLSL precision profiles | Codegen profile (mediump gate) | S2 (GLSL precision hints) |
| 41 | Resume-snapshot | Journal.snapshot + Tape.ring | — |
| 42 | Cold-start replay prewarm | Pump<Prewarm> + Tape.replay(splash) | — |
| 43 | Adaptive codegen | Probe<GPUClass> + Codegen.select(profile) | S2 (profile table) |
| 44 | Mip-trim under pressure | PressureBus.source('memory') + Tape.mipBias | S2 (mip-bias shader) |
| 45 | Zero-copy ladder | Caps.path('zero-copy') + Explain-audit | S4 (audit logic) |
| 46 | Staging pool for small buffers | Pool<Buffer> (ring recycle) | — |
| 47 | Thermal/battery fusion | PressureBus.fuse('thermal-EMA', 'battery') | — |
| 48 | Feature-ladder + requestTier | TierLadder.request | — |
| 49 | Subgroups | Caps.gate + shared-mem emulation | S1 (shared memory) + S2 (emulation) |
| 50 | Work graphs | Tape.reserve(indirect) (watchlist) | S1 (indirect API) |
| 51 | Nanite-lite | Caps.gate + Tape ops | S2 (meshlet-LOD-DAG, soft rasterizer) |
| 52 | Meshoptimizer pipeline | CodecRegistry (prims extension) | S2 (meshlet builder) |
| 53 | Visibility-buffer deferred | Recipe (material resolve by primitive-ID) | S2 (visibility shader) |
| 54 | Full GPU culling chain | Compute pipeline recipe | S2 (instance→meshlet→cluster→occ) |
| 55 | AgX + Oklab | Color recipe | S2 (AgX/Oklab shader) |
| 56 | TSR-lite | Temporal upscale recipe | S2 (reprojection + clip history) |
| 57 | Checkerboard transparency | Recipe (half-res particles) | S2 (quincunx shader) |
| 58 | Blue noise without a LUT | Recipe | S2 (Owen-scrambled Sobol) |
| 59 | WASM-SIMD math | Math backend | — |
| 60 | WebCodecs zero-copy | Caps.path('video-external') + VideoFrame | S1 (WebCodecs) |
| 61 | Compositing hygiene | PathRegistry + PathState (Decay.ratio) | S3 (premultiplied, opaque, desync) |
| 62 | transferToImageBitmap | PathRegistry.register('asyncbmp') + Caps.path | S1 (transferToImageBitmap) |
| 63 | scheduler.postTask/yield | Scheduler integration | S1 (postTask API) |
| 64 | Scoped determinism | Determinism contract (cross-cutting) | S3 (semantic) |
| 65 | Pixel-diff in rewind | Tape.diff (visual bisect) | S4 (diff algorithm) |

**Summary**: 65 entries → 52 reduce fully to a composition of primitives
(specific = "—"), 13 carry an S1/S2/S3/S4 tail that remains manual. That is
an 80/20 ratio — exactly what the customer wanted: "similar with small
changes" = new entries with the same composition template.

### 9.7 Decomposition of the 14 present paths → PathRegistry

All 12 GL + 2 WebGPU present paths (bench round 4, DESIGN.md §5.5 addendum)
are expressed as registrations in the PathRegistry. Every path = { probe, caps,
run }, state managed by `PathState` via `Decay.ratio(p95, p50)`.
This is precisely "compositing hygiene" (#61) + "transferToImageBitmap" (#62) in
canonical form.

| Path | Probe/Caps | Specific (S1/S2/S3) |
|------|-----------|---------------------|
| direct | Caps.has('webgl2') — always 'ok' | S3 (premultiplied) |
| quadpass | Caps.has('webgl2') — always 'ok' | S2 (pass vert shader) |
| bitmap | Caps.path('OffscreenCanvas') + Caps.path('ImageBitmap') | S1 (transferToImageBitmap) |
| draw2d | Caps.path('Canvas2D') — fallback branch | S1 (Canvas2D), S3 (alpha) |
| multi4 | Caps.has('webgl2') + N viewers | S1 (4 contexts) |
| draw2d-half | like draw2d + Decay degradation | S1 (Canvas2D half-res) |
| preserve | Caps.has('preserveDrawingBuffer') | S3 (premultiplied tax) |
| blit | Caps.has('blitFramebuffer FBO→default') | S1 (ANGLE BGRA mismatch) |
| quadcopy | Caps.has('webgl2') | S2 (copy shader) |
| uvremap | Caps.has('webgl2') (atlas view) | S2 (UV-remap shader) |
| asyncbmp | Caps.path('transferToImageBitmap') | S1 (OffscreenCanvas.transferToImageBitmap) |
| multibmp4 | like asyncbmp × 4 viewers | S1 (4 ImageBitmaps) |
| scaled-half | Caps.path('createImageBitmap resize') | S1 (createImageBitmap + resize) |
| wgpu-direct | Caps.path('WebGPU') + Caps.has('render-bundles') | S1 (WebGPU canvas) |
| wgpu-copy | Caps.path('WebGPU.copyExternalImage') | S1 (copyExternalImageToTexture) |

`PathRegistry.select(caps, pressure)` automatically picks the best
healthy path on the given hardware under the current pressure. On Mali (preserve
p95/p50 ratio = 3.0 ≫ 1.5) preserve → disabled, the choice moves to quadpass
or direct. On desktop (ratio < 1.5) — the cheapest per the
Probe is chosen (direct or quadcopy). On an adapter without WebGPU wgpu-* → 'unavailable',
path-state = 'unavailable', an asynchronous GL path is selected.

### 9.8 Deploying "similar with small changes" — one-liners

The main value of the skeleton: **a new feature = ≤6 lines of user code**.
Not a plug-in object with 8 fields — a functional call with 2–3 required
arguments and defaults for the rest.

```typescript
// Template: paths.add / probe.add / pressureBus.add / pump.create / tiers.register
// Every function builds a FeaturePlug internally; the user never sees it.
```

Three examples of "similar with small changes":

**A. A new present path "OffscreenCanvas.transferControl"**
(similar to #62 asyncbmp, but without a transfer into an ImageBitmap — the frame stays in the
OffscreenCanvas, presented via `transferControlToOffscreen`):

```typescript
paths.add('transferControl', {
  requires: 'OffscreenCanvas.transferControl',
  run: ctx => ctx.canvas.transferControlToOffscreen()
});
```

**4 lines**. Versus ~14 lines in the old plug-in object (id/requires/depends/
apply/ctx.paths.register/probe/caps/run/telemetry). The delta against the asyncbmp
registration (also 4 lines) — only the `requires` line and the `run` body. Probe,
telemetry, PathState gating, decay, the degrade switch — library
defaults.

**B. A new probe "probeSharedArrayBuffer"**
(similar to probeContextEviction, but checks SAB availability for the T2/T3
transports — needed for #12 worker migration):

```typescript
probe.add('hasSAB', () => typeof SharedArrayBuffer !== 'undefined');

// Usage in TierLadder — in a profile request:
tiers.register('transport-sab', {
  features: [],
  limits: {},
  // if probe.cached === false → the ladder steps down to T1 (postMessage)
});
```

**1 line** to register a probe. Versus ~8 lines in the old Probe object
(id/cached/measure/invalidate/subscribe). The delta against probeContextEviction
— only the measure body. Cache, invalidate on device-loss, subscribe —
library-side.

**C. A new pressure-source "network bandwidth"**
(similar to #47 thermal-EMA, but the signal is network bandwidth from
navigator.connection.downlink + RTT — needed by #9 paging, #10 OPFS, #8
scan-progressive for tile quality degradation):

```typescript
pressureBus.add('network', () => {
  const c = navigator.connection;
  if (!c) return 0;
  return c.rtt > 200 || c.downlink < 1 ? 0.8 : 0;
}, { ema: 0.1 });

// Subscribers — one line each:
pressureBus.on('network', level => {
  if (level > 0.5) tilePump.setWindow(64*1024, 4*1024*1024);
});
```

**3 lines** per source + 2 lines per subscriber. The delta against
the thermal source — only the measure body and the ema coefficient. PressureBus, EMA,
fusion, subscription — library-side.

**A "small change" summary**:

| What changes | API call | Required fields | Delta against the nearest neighbor |
|---|---|---|---|
| New present path | `paths.add(name, {requires, run})` | 2 | requires + run |
| New probe | `probe.add(name, measure)` | 2 | the measure body |
| New pressure-source | `pressureBus.add(name, measure, {ema})` | 2–3 | measure + ema |
| New AIMD stream | `pump.create({min, max})` | 2 | the min/max bounds |
| New tier profile | `tiers.register(name, {features, limits})` | 3 | features/limits |
| New kit recipe | `recipe.add(name, {caps, setup, shader})` | 3 | shader + Tape ops |

**Kit recipes (S2)** — a separate escape hatch, since they require a shader:

```typescript
recipe.add('agx-grading', {
  caps: c => c.has('render-target-float'),
  shader: { frag: AGX_FRAG_SRC, vert: PASS_VERT_GLSL },  // dual-source
  setup: ctx => ctx.tape.bindTarget(ctx.target)
});
```

3 required fields instead of an 8-field plug-in — still below the old
variant. recipe.add — for the S2 class of features (AgX, TSR-lite, HiZ, etc.); other
primitives (paths/probe/pressureBus/pump/tiers) need no shader.

**Principle**: every new feature — **only its specifics**. No
boilerplate fields (id/requires/depends/apply/degrade/telemetry) — those are
library defaults. The customer's "boilerplate must not grow" condition is
met: 2–3 required fields for a typical feature, versus 6–8 in the plug-in
object. A 4–5× reduction.

### 9.9 What this gives for M4–M8

The primitives mapped to the implementation stages (§14.3 of the dossier):

| Primitive | Stage | Dependencies | Note |
|----------|------|-------------|------------|
| Journal | M1 (restoration) | — | Blocker for M4 (#19), M5 (#12) |
| Caps (extend path()) | M4 | Journal | The basis for #39/#48/#61/#62 |
| TierLadder | M4 | Caps | Canonical, do not touch |
| PressureBus + Decay | M8 (as part of #47/#44/#17) | Probe | Named from §9.2 of the dossier |
| Probe | M4 (probeContextEviction, probeTextureMemory) | Caps | A §9.2 refinement, addendum §4 |
| Pump<T> (generalization) | M6 (uploadScheduler → Pump) | — | Already in the code, to be generalized |
| PathRegistry | M8 (#61, #62) | Caps, Probe, Decay | DESIGN.md §5.5 addendum |
| FeaturePlug | M8 (meta) | all of the above | Catalog §12 becomes declarative |

The order — the canonical M4→M8 (as in the §8 addendum), without overlap.
Every primitive is an independent step with dependencies, easy to test.

### 9.10 What the primitives do NOT cover (remains manual)

Listed explicitly, so there are no illusions:

1. **Shader codegen of the S2 recipes** — AgX, TSR-lite, meshlet-LOD-DAG,
   HiZ-pyramid, the GPU culling chain. Each one is a separate WGSL/GLSL shader +
   Tape ops + a Caps gate. The plug-in provides the structure, not the content.

2. **The state cache of specific GL/GPU commands** — `depthMask(true)` before
   a depth clear (the Task 46 lesson), `bindTarget` with feedback-loop
   prevention, viewport restoration on the canvas. These are invariants
   of the Tape executor, not plug-ins.

3. **Bug hunting on specific combinations** — like diag17's frame-by-frame proof
   that "frame 2+ is empty" turned out to be `depthMask` masking glClear (Task 46).
   Such incidents do not reduce to primitives — diagnostic
   scripts (diag1–17) are needed, which remain manual.

4. **The discipline of contracts 1–5** — jank/maxMs, scoped determinism,
   transport invariance, the tier ladder, gate honesty. These are
   audit rules, not code. The primitives implement them, but do not replace them.

5. **Bench calibration for new hardware** — like round 4 (Mali-G57 MC2).
   A physical device or an emulator is needed, the bench-present /
   bench-phone scripts, manual analysis. The primitives provide observation
   points (`telemetry()`), but the interpretation is human.

### 9.11 Demonstration: the current pipeline vs the §9.5 primitives

**The purpose of this section** — to fix the boundary between "works today" and
"proposed in §9.5". The cross-check showed that the `triangle-primitives-demo.ts`
example reads as if `scene.mount(...)` already exists. It does not: the file is
a reference for a future API, explicitly marked in the header "primitives are NOT implemented".
The current code is **regl-like**, without a scene graph.

#### 9.11.1 The current API — what `@rune/gl` exports today

```typescript
// packages/gl/src/index.ts — the real set
export { createRenderer } from './renderer.ts'
export { createWebGpuRenderer } from './webgpuRenderer.ts'
export { show } from './scene.ts'           // sugar — "a cube in one line"
export { showAny, showOn, probeWebGpu } from './show*.ts'
```

`scene.ts` — the name is historical; inside there is only `show(target, options)`
for a cube. **There is no scene graph**: no `scene.add(node)`, no
`scene.traverse()`, no `scene.root`. The file name is an artifact of the MVP-2 round,
when the cube was called a "scene".

The current regl-like user loop:

```typescript
const r = createRenderer({ canvas: '#c' })
const tex = r.texture(1024, 1024)
void tex.upload(rgba).done
const draw = r.command({
  shader: { glsl: { vertex: VERT, fragment: FRAG } },
  attributes: { position: { data: POS, size: 2 }, uv: { data: UV, size: 2 } },
  textures: { u_tex: tex },
  uniforms: { u_mvp: (p) => p.mvp },
  pipeline: { depth: { test: 'always', write: false }, raster: { cull: 'none' } },
  count: 3,
})
r.frame((ctx, record) => record(draw, { mvp: rotation2d(ctx.time * 0.5) }))
r.start()
```

**8 lines** of user code (without the shader/geometry — that is feature
specifics, not boilerplate). Underneath them — all seven inference layers (see §9.11.3).

#### 9.11.2 The frame-by-frame pipeline beat (real)

```
rAF tick → step(nowMs)
  ├─ updateFrameContext(nowMs)     time/dt/aspect/size → FrameContext
  ├─ transients.beginFrame()      the previous frame's scratch ages
  ├─ epoch.frame(() => {          safeguard: the rollback point on error
  │    ├─ time.value = ctx.time   push into a signal → reactive derives
  │    ├─ writer.reset()         tape reset
  │    ├─ writer.emit(BeginPass) the opening bracket
  │    ├─ buildFrame(lives, w)    live commands emit opcodes,
  │    │                          only if their deps changed
  │    ├─ emitFrameCallbacks()    user callbacks:
  │    │    └─ record(cmd, props) → cmd.record(props, ctx, w)
  │    │        ├─ resolve uniforms  (props, ctx) → arena.write
  │    │        ├─ value-compare     dirty flag on the slot
  │    │        └─ w.emit(Draw, id, 0, count, 1)
  │    ├─ writer.emit(EndPass)    the closing bracket
  │    ├─ executor.run(view)      opcode interpretation:
  │    │    ├─ BeginPass:  bindTarget(0) + clear(color, depth)
  │    │    ├─ Draw:      ensureProgram (lazy GL program+buffer)
  │    │    │                useProgram (cache lastProgram)
  │    │    │                applyState (depth/cull cache)
  │    │    │                uploadUniforms (only dirty slots)
  │    │    │                bind samplers (auto-unit from reflection)
  │    │    │                bind vertex buffers
  │    │    │                gl.drawArrays(...)
  │    │    └─ BindTarget: switch render target
  │    └─ uploads.drain()        the idle slot: texture streaming
  └─ scheduleNext()              the next rAF
```

#### 9.11.3 Zero-declaration inference — what is inferred TODAY

"Inference" in the current code is seven layers of automatic derivation from
`DrawSpec`, without a single manual location/binding/state declaration:

| # | Layer | What is inferred | Where in the code |
|---|------|-------------------|------------|
| 1 | GLSL reflection | the uniform slot in the arena by name | `glslReflect.ts` → `command.ts:toField` |
| 2 | Attribute binding | `location` from the shader | `glslReflect.ts` → `command.ts:attributes` |
| 3 | Sampler binding | texture unit auto-increment | `command.ts:bindSamplers` |
| 4 | Pass builtins | `u_time`/`u_resolution`/`u_texel` | `surface.ts:scanBuiltins/applyBuiltins` |
| 5 | State cache | depth/cull/program skip no-op | `executor.ts:applyState` |
| 6 | Arena diff | value-compare → only dirty uploads | `arena.ts:write` + `executor.ts:uploadUniforms` |
| 7 | Lazy resources | program/buffer on the first draw | `executor.ts:ensureProgram` |

This is precisely the "extended regl spirit" of the current version: the user
writes **only the feature specifics** (shader, geometry, uniforms), everything
else is derived by the runtime. No plug-in object, no 8 fields, no
manual `gl.getUniformLocation`/`bindAttribLocation`.

#### 9.11.4 What is NOT inferred today — the §9.5 zone

| Boundary | Today | What §9.5 will add |
|---------|---------|------------------|
| Backend choice | explicit `createRenderer` / `createWebGpuRenderer` | `recipe.caps` → auto-selection |
| Texture | `renderer.texture().upload()` — streams, does not publish pressure | `texture.create({pressureSource})` — is itself the source |
| Present path | the frame always lands in the canvas | `PathRegistry.select(caps, pressure)` |
| Device loss | manual reboot | `Journal.replay(auto)` |
| Reactive uniforms | `renderer.live()` — manual registration | `recipe.uniforms: () => ({u_x: signal})` |
| Post-processing | `surface.pass()`/`capture()` (exists, but within one framework) | `scene.mount([recipe.into(s), fx])` |
| Telemetry | `diag*.ts` scripts | `state()` on every object |

#### 9.11.5 The boundary in one table

| Layer | Today (regl-like) | After §9.5 (recipe/mount) |
|------|---------------------|---------------------------|
| init | `createRenderer({canvas})` | `scene.mount(target, recipe, props)` |
| spec | `renderer.command(DrawSpec)` | `recipe.add(name, {caps, shader, geometry, uniforms})` |
| uniforms | `function (props, ctx) => value` | `signal.derive([deps], fn)` |
| texture | `renderer.texture(w,h).upload(bytes)` | `texture.create({source, pressureSource})` |
| present | canvas (hardcoded) | `PathRegistry.select` (quad/asyncbmp/...) |
| device loss | manual reboot | `Journal.replay` (auto) |
| post-processing | `surface.capture()` + `surface.pass()` in a chain | `scene.mount([recipe.into(s), fxBlur])` |
| idle/thermal | none (a hard rAF) | `pressureBus.on('idle-input', ...)` |

#### 9.11.6 The "brilliant" angle — inference growth vs code reduction

Today's 8 lines of user code generate 7 inference layers (§9.11.3).
After §9.5 — 5 lines will generate 12 layers (the current 7 + caps/pressure/paths/
journal/reactive/textures-as-sources/telemetry). Inference growth: **+5 layers**;
code reduction: **−3 lines**. That is exactly the customer's
"boilerplate must not grow" condition being met (§9.4): every new feature = only its specifics,
and the library takes on more for inference than for boilerplate.

`triangle-primitives-demo.ts` remains the reference for §9.5; it cannot be
inserted into the current code — `scene.mount` does not exist. For it to
work, the primitives from §9.9 are needed (the M4→M8 implementation order):
Journal → Caps extension → Probe → PressureBus → Pump → PathRegistry →
FeaturePlug. Until they are implemented, the current regl-like loop (§9.11.1–9.11.3) is
the only working path.

### 9.12 Backend auto-selection — a single `createRenderer`

The customer: "WebGPU by default, WebGL if absent; if at least one
shader is WGSL-only and not in an optional case like pass(), then WebGL;
give a reason; possibly — a shader pre-check before the first render, if
auto". The design went through four critique iterations; the final version is fixed.

#### 9.12.1 The final API

```typescript
type BackendId = 'webgpu' | 'webgl2'

interface RendererOptions {
  canvas: HTMLCanvasElement | string
  backend?: BackendId | readonly BackendId[]  // default ['webgpu', 'webgl2']
  // ...other options (uniforms arena size, tape capacity, etc.)
}

interface Renderer {
  command(spec: DrawSpec): CompiledCommand
  frame(cb: (ctx, record) => void): void
  start(): Promise<void>                  // ALWAYS async (a unified contract)
  whyBackend(): BackendDecision | null    // null until .start()
  // ...the rest unchanged
}

// A single entry point + two explicit ones for strict mode
function createRenderer(opts: RendererOptions): Renderer
function createWebGL2Renderer(opts: RendererOptions): Renderer    // the former createRenderer
function createWebGpuRenderer(canvas: HTMLCanvasElement | string): Promise<Renderer>
```

`backend` is optional. A string — strict mode (a length-1 order, no
fallback); an array — an ordered list with fallback. By default
`['webgpu', 'webgl2']`: try WebGPU, on unavailability or
uncovered shaders — WebGL2. The old WebGL2-only `createRenderer`
is renamed to `createWebGL2Renderer` (migration below, §9.12.6).
The new `createRenderer` — a wrapper over both; inside it is the same
`Renderer` class, with webgpu/webgl2 as swappable adapters.

#### 9.12.2 DrawSpec — dual-source shader

```typescript
interface DrawSpec {
  shader: {
    glsl?: { vertex: string; fragment: string }
    wgsl?: string
  }
  attributes: ...
  uniforms: ...
  pipeline: ...
  count: number
}
```

At least one of `glsl`/`wgsl` is required. Both — the spec works
everywhere (portable code). Only `glsl` → WebGL2 only. Only
`wgsl` → WebGPU only. `pass()` instances are excluded from the pre-flight
(§9.12.4): their shaders are the built-in dual-source quad and cannot "fail
to suit" any backend. The same applies to `surface.capture()` and
other built-in quad passes.

#### 9.12.3 `resolveBackend` — a pure function + `BackendDecision`

```typescript
interface HardwareAvailability {
  webgpu: boolean
  webgl2: boolean
}

function resolveBackend(
  order: readonly BackendId[],
  specs: readonly DrawSpec[],
  hardware: HardwareAvailability,
): BackendDecision
```

The algorithm — two lines:

```typescript
const candidates = order.filter(b =>
  hardware[b] && specs.every(s => covers(s, b)))
const chosen = candidates[0] ?? null
```

`covers(spec, backend)` is trivial: `webgpu` needs
`spec.shader.wgsl`, `webgl2` — `spec.shader.glsl`. A pure
function, tested without a GPU — in `packages/gl/tests/autoBackend.test.ts`
10+ cases are already green (Task 52).

`BackendDecision` — a structured report, no reason enums:

```typescript
interface BackendDecision {
  chosen: BackendId | null
  message: string                   // generated from verdicts, always actionable
  verdicts: {
    webgpu: { available: boolean; covers: boolean; rejected?: string }
    webgl2: { available: boolean; covers: boolean; rejected?: string }
  }
  coverage: Array<{ id?: string; hasGlsl: boolean; hasWgsl: boolean }>
}
```

Round 1 dropped the `prefer: 'auto'|'webgpu'|'webgl2'` enum as
self-contradictory: "prefer = a priority, not a fixation; throwing on
absence — crude". Only facts in `verdicts`; `message`
is assembled by a template. If `chosen === null` — throw a
`BackendResolutionError` with the full `decision` in a field; the user sees
which backend dropped out and why ("webgpu: unavailable", "webgl2:
covers=false, 2 specs are WGSL-only").

#### 9.12.4 Lazy spec discovery — via `.command()`

Round 2 required `specs: DrawSpec[]` in the options for the pre-flight.
The customer: "brutal boilerplate" — the user would list the specs twice (for
the resolver, then in `command(spec)`). Removed. The specs are collected
automatically from what the user actually calls in `command()`.
The decision is made on `.start()` — that is the "pre-check before the first
render".

The flow:

1. `createRenderer(opts)` is **synchronous** — a wrapper, no GPU work.
   `inner: Renderer | null = null`, `pendingSpecs: DrawSpec[] = []`,
   `pendingFrames: FrameCb[] = []`.
2. `command(spec)` before start: `pendingSpecs.push(spec)`, returns a
   proxy `CompiledCommand` (the real one is attached after `.start()`).
3. `frame(cb)` before start: `pendingFrames.push(cb)`.
4. `start()` is **asynchronous**:
   - probe hardware (`navigator.gpu !== undefined` + try
     `requestAdapter()` for webgpu; `typeof WebGL2RenderingContext`
     for webgl2; the canvas is untouched, no context is created);
   - `decision = resolveBackend(order, pendingSpecs, hardware)`;
   - if `chosen === null` → throw `BackendResolutionError(decision)`;
   - `inner = chosen === 'webgpu'
       ? await createWebGpuRenderer(canvas)
       : createWebGL2Renderer(canvas)`;
   - proxy `pendingSpecs` through `inner.command()` (the proxy commands
     receive their real `CompiledCommand`);
   - proxy `pendingFrames` through `inner.frame()`;
   - `await inner.start()`.
5. `command(spec)` after start: `assertCovers(spec, decision)` —
   if the spec does not fit the chosen backend, throw with an actionable
   message ("you are on webgl2, the spec requires wgsl — add glsl
   to the spec or restart with `backend: 'webgpu'`"). Otherwise
   `inner.command(spec)`. This is the late-reject for specs
   added dynamically after the start.

The constructor is synchronous, `.start()` is asynchronous — a contract break for
old WebGL2 users (previously `.start()` was sync), but the price of a
single entry point. The WebGL2 path resolves instantly, its `.start()`
completes within the same tick.

#### 9.12.5 User code

```typescript
// 1. Default — webgpu with a fallback to webgl2
const r = createRenderer({ canvas })
const tri = r.command({
  shader: { glsl: { vertex, fragment }, wgsl },
  attributes: { position: [...] },
  count: 3,
})
r.frame((ctx, rec) => rec(tri, { u_time: ctx.time }))
await r.start()
console.log(r.whyBackend())
// { chosen: 'webgpu', verdicts: { webgpu: {...}, webgl2: {...} }, ... }

// 2. Strict webgpu (runs into BackendResolutionError if unavailable)
const r = createRenderer({ canvas, backend: 'webgpu' })

// 3. Legacy mode — webgl2 only (equivalent to the former createRenderer)
const r = createRenderer({ canvas, backend: 'webgl2' })
// or explicitly: const r = createWebGL2Renderer({ canvas })

// 4. Reverse order (webgl2 preferred, webgpu as the fallback)
const r = createRenderer({ canvas, backend: ['webgl2', 'webgpu'] })
```

#### 9.12.6 Iterations and migration of existing code

Design iterations (a memory for future rounds):

| Round | Proposal | Customer's rejection |
|---|---|---|
| 1 | `prefer: 'auto'\|'webgpu'\|'webgl2'` enum + throw on unavailability | "Prefer = a priority, not a fixation. Throwing on absence is a contradiction. The system is crude" |
| 2 | `createAutoRenderer({ specs: DrawSpec[] })` with a pre-declaration | "Brutal boilerplate — the specs get listed twice" |
| 3 | A separate `createAutoRenderer` as a new entry point | "Why \"auto\"? Just add `backend` to `createRenderer`, and rename the old one to `createWebGL2Renderer`" |
| 4 (final) | `createRenderer({ backend?: BackendId \| BackendId[] })` + lazy discovery via `.command()` + `.start()` as the decision point | Accepted |

Every rejection → a simplification. The final API: one entry point
(`createRenderer`), one option (`backend` — a string or an array),
one asynchronous point (`.start()`), one resolver function
(`resolveBackend` — pure, tested without a GPU).

Current state (Task 52 is already implemented in `autoBackend.ts` +
`autoRenderer.ts`, but under the old name `createAutoRenderer` —
a rename refactoring is required):

- `packages/gl/src/autoBackend.ts` — `resolveBackend`,
  `shaderCoverage`, the `BackendDecision`/`BackendVerdict`/
  `SpecCoverage` types — stay unchanged (they already match the result).
- `packages/gl/src/autoRenderer.ts` — `createAutoRenderer` → rename to
  `createRenderer`; either rename the file to `renderer.ts`
  (then the old `renderer.ts` → `webgl2Renderer.ts`), or
  move the wrapper into `renderer.ts` and rename the old one.
- `packages/gl/src/renderer.ts` — the current WebGL2 renderer → rename the
  export to `createWebGL2Renderer`, the file → `webgl2Renderer.ts`
  (or `webgl2.ts`).
- `packages/gl/src/webgpuRenderer.ts` — unchanged.
- `packages/gl/src/index.ts` — export: `createRenderer`
  (new), `createWebGL2Renderer` (renamed),
  `createWebGpuRenderer`, `resolveBackend`, `BackendResolutionError`,
  the `BackendId`/`BackendDecision`/`RendererOptions` types.
- `packages/gl/tests/autoBackend.test.ts` — unchanged (the pure
  function is already final).
- `packages/gl/tests/autoRenderer.test.ts` → rename to
  `renderer.test.ts` (or leave as is — it tests the same class).
- `demo/auto-backend-demo.ts` — update the user API in the
  final example (rename the calls).

The work — a pure rename + move, without changing the `resolveBackend` algorithm
(it has been final since Task 52). One contract break: `.start()` became
`Promise<void>` instead of `void` for the WebGL2 path.

### 9.13 External canvases + alternative texture sources

Two concrete features that do not require all of §9.5 — concrete improvements
to the existing API. A light groundwork base: once `PathRegistry` and
`textures-as-sources` are implemented, these APIs become declarative
wrappers over them.

#### 9.13.1 External canvases — `OffscreenCanvas` as a render target

```typescript
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

interface RendererOptions {
  canvas: AnyCanvas | string
  // ...
}
```

The size semantics differ fundamentally (`canvasHelpers.ts`):
- `HTMLCanvasElement`: `clientWidth`/`clientHeight` (CSS), `width`/`height`
  (buffer). The renderer multiplies CSS by DPR → buffer. `ResizeObserver` works.
- `OffscreenCanvas`: `width`/`height` are BOTH the CSS size AND the buffer (no DOM, no
  CSS sizes). DPR = 1 always. `ResizeObserver` is NOT supported —
  the user calls `renderer.resize(w, h)` themselves.

```typescript
function isOffscreenCanvas(canvas: AnyCanvas): canvas is OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) return true
  // Duck-typing fallback for Node/headless (HTMLCanvasElement has
  // clientWidth via HTMLElement.prototype, OffscreenCanvas does not)
  return !('clientWidth' in canvas)
}

function getCanvasCssSize(canvas: AnyCanvas): readonly [number, number] {
  if (isOffscreenCanvas(canvas)) return [canvas.width, canvas.height]
  const css = canvas.clientWidth, cssH = canvas.clientHeight
  if (css > 0 && cssH > 0) return [css, cssH]  // the DOM is laid out
  return [canvas.width || 1, canvas.height || 1]  // fallback for early initialization
}

function canvasDpr(canvas: AnyCanvas, override?: number): number {
  if (override !== undefined) return override
  if (isOffscreenCanvas(canvas)) return 1  // no CSS → no DPR
  return typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1
}
```

`transferControlToOffscreen()` workflow support: the user calls
`canvas.transferControlToOffscreen()` themselves and passes the resulting
`OffscreenCanvas` into `createRenderer({ canvas })`. The renderer does not know
the difference — it works with the `OffscreenCanvas` as usual. This is the basis for
zero-main-thread rendering (see §9.5 #12 "Zero-main-thread" in the future).

`acquireWebGL2` and `createRealGPU` now accept `AnyCanvas`.
`canvas.getContext('webgl2' | 'webgpu', ...)` works on both types.
`observeSize` early-returns and skips `OffscreenCanvas` (no
`ResizeObserver`).

Tests (`canvasHelpers.test.ts`, 6 cases): `isOffscreenCanvas` distinguishes
the types; `getCanvasCssSize` for HTML vs Offscreen; `canvasDpr` HTML vs
Offscreen; `createWebGL2Renderer` accepts `OffscreenCanvas` + createGL
injection (size = `canvas.width/height`, not `clientWidth`); `step` does
not throw on `OffscreenCanvas`; HTML with `clientWidth=0` falls back to
`width/height`.

#### 9.13.2 Alternative texture sources — `texture.uploadImage(source)`

Streaming (chunked bytes) and atomic upload (bitmap/canvas/video) are
different semantics — two APIs:

```typescript
interface Texture extends TextureHandle {
  width: number
  height: number
  /** Streaming RGBA bytes: preview → chunks; progress and cancellation. */
  upload(source: Uint8Array, options?: { priority?: number; onProgress?: (fraction: number) => void }): TextureUpload
  /** Atomic upload from bitmap/canvas/video — a single call, no chunks. */
  uploadImage(source: GLImageSource | GPUImageSource): void
}

type GLImageSource = ImageBitmap | HTMLCanvasElement | HTMLImageElement |
                     HTMLVideoElement | OffscreenCanvas | VideoFrame
type GPUImageSource = ImageBitmap | HTMLCanvasElement | HTMLVideoElement |
                      OffscreenCanvas | VideoFrame
```

Implementation:
- WebGL2: `gl.texImage2D(target, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)`
  — the overload with `TexImageSource` (overwrites mip 0; the size is taken from the source).
- WebGPU: `device.queue.copyExternalImageToTexture({ source }, { texture, mipLevel: 0, origin: [0,0,0] }, [w, h, 1])`
  — `ExternalImageCopy` accepts ImageBitmap | HTMLCanvasElement | HTMLVideoElement | VideoFrame | OffscreenCanvas.

Facade contract:
```typescript
interface GLFacade {
  // ...
  texImage2DFromSource(textureId: number, source: GLImageSource): void
}
interface GPUFacade {
  // ...
  copyExternalImageToTexture(textureId: number, source: GPUImageSource, w: number, h: number): void
}
```

Tests (`textureUploadImage.test.ts`, 5 cases): `uploadImage` calls
`texImage2DFromSource` with the same `textureId`; an `HTMLCanvasElement` source
→ the correct type name in the record; does NOT call `texSubImage2D` (streaming is
not engaged); `upload(bytes)` and `uploadImage(source)` can be interleaved;
an `OffscreenCanvas` source → the correct name. `describeSource` in
recordingGL.ts and recordingGPU.ts uses duck-typing for headless
environments (without a global `ImageBitmap`/`OffscreenCanvas`).

Why a separate `uploadImage` instead of extending `upload`:
1. Streaming returns a `TextureUpload` with `.done: Promise<void>` and progress
   — meaningless for atomic sources (a one-shot upload).
2. The source types `GLImageSource`/`GPUImageSource` are wide unions;
   stuffing them into `upload(bytes: Uint8Array | GLImageSource)` breaks type inference.
3. The semantics differ — the user chooses explicitly: "I have a ready bitmap"
   vs "I have bytes, stream them in chunks".

Relation to §9.5 "textures-as-sources" (future): once `PressureBus` is
implemented, textures become pressure sources (`texture.create({source,
pressureSource})`). The current `uploadImage` is a concrete improvement: the same
function, but without the reactive `pressureSource` flag. The migration path —
`texture.uploadImage(source)` → `texture.create({source, pressureSource:
'memory'})` (a decorator on top).

#### 9.13.3 Migration and what remains

File changes:
- `packages/gl/src/canvasHelpers.ts` (NEW, ~70 lines) — `AnyCanvas`,
  `isOffscreenCanvas`, `getCanvasCssSize`, `canvasDpr`, `resolveCanvasAny`.
- `packages/gl/src/webgl2Renderer.ts` — the `WebGL2RendererOptions.canvas`
  type `AnyCanvas | string`; `acquireWebGL2(canvas: AnyCanvas)`; init size
  via `getCanvasCssSize`; `observeSize` skip for Offscreen; the `Texture`
  interface extended with `uploadImage`; the `texture.uploadImage` implementation via
  `gl.texImage2DFromSource`. Removed `resolveCanvas` (HTML-only) and
  `devicePixelRatioOrOne` (replaced by `canvasHelpers`).
- `packages/gl/src/webgpuRenderer.ts` — the same for WebGPU; the `createGPU`
  injection accepts `AnyCanvas`.
- `packages/gl/src/renderer.ts` (unified) — the `RendererOptions.canvas` type
  `AnyCanvas | string`; the WebGPU branch of `texture()` returns an object with
  `uploadImage` via `gpu.copyExternalImageToTexture`.
- `packages/webgl2/src/facade.ts` + `realGL.ts` + `recordingGL.ts` —
  the `GLImageSource` type, the `texImage2DFromSource` method.
- `packages/webgpu/src/facade.ts` + `realGPU.ts` + `recordingGPU.ts` —
  the `GPUImageSource` type, the `copyExternalImageToTexture` method.
- `packages/webgpu/src/realGPU.ts` — `createRealGPU(canvas: AnyCanvas)`
  instead of `HTMLCanvasElement`.
- `packages/gl/src/scene.ts`, `showAny.ts`, `showOn.ts`, `showWebgpu.ts` —
  unchanged (they use the existing renderers through the sugar).

What is NOT done in this round (the full §9.5 vision):
- `PressureBus` — textures do not yet publish pressure (no
  `pressureSource` flag). The current `uploadImage` is an atomic one-shot.
- `PathRegistry` — no automatic choice between `OffscreenCanvas` +
  `transferControlToOffscreen` vs the direct canvas path. The user
  chooses manually.
- `VideoFrame` — the type is included in `GLImageSource`/`GPUImageSource`, but
  real verification requires WebCodecs (absent in SwiftShader).
- Streaming `Uint8Array` on the WebGPU path — absent (the gpu facade would need
  to be extended for `writeTexture` tiles). Workaround: `createImageBitmap(bytes)` →
  `uploadImage(bitmap)`.

## 10. Status

The design dossier v1.0 is the primary document. This addendum — rounds 4–8:
- **Round 4** — the Mali-G57 MC2 bench calibration (§4) + the code ↔ dossier cross-check (§3, §5);
- **Round 5** — withdrawn (a renaming of catalog §12);
- **Round 6** — the infra-primitives for deploying catalog §12 (§9): 6
  universal patterns, 9 primitives + 1 meta (FeaturePlug), the decomposition
  table of all 65 entries + 14 present paths, the template for "similar with
  small changes", a demonstration of the current vs future API boundary (§9.11).
- **Round 7** — backend auto-selection (§9.12): four design iterations
  (the `prefer` enum → `createAutoRenderer+specs` → a separate `createAutoRenderer`
  → the final `createRenderer({ backend?: BackendId | BackendId[] })` with lazy
  discovery via `.command()`). The final API is fixed; the existing
  Task 52 code (`autoBackend.ts` + `autoRenderer.ts`) awaits a rename refactoring
  to the final names (`createRenderer`/`createWebGL2Renderer`).
- **Round 8** — concrete improvements to the existing API (§9.13): external
  canvases (`OffscreenCanvas` as a render target + duck-typing helpers) +
  alternative texture sources (`texture.uploadImage(source)` via the
  `texImage2D` overload / `copyExternalImageToTexture`). Without the full §9.5 —
  groundwork for the future `PathRegistry` + `textures-as-sources`.

All the "new" proposals (§7 formula refinements, §9 primitives, §9.12 backend
auto-selection) are not new architectural decisions but a generalization of what
the dossier describes point by point. Any implementation goes through the canonical M0–M8
(§14.3 of the dossier); §9.9 provides the mapping of primitives to stages.

The packages' code is still untouched since the previous round (except the Task 52
`autoBackend.ts`/`autoRenderer.ts`); the decisions on §5 (journal restoration,
caps, requestTier, the T0–T3 transports, present.ts, the Kit packages), §9 (the primitives
as the skeleton for their composition) and §9.12 (the backend auto-selection
rename refactoring) await the customer's approval.
