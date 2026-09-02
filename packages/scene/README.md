# @rune/scene

A maximally flat data-oriented scene graph for rune: cameras,
frustum culling, instance packs, RENDERABLES (Task 86: an abstract
"what to draw" entity — a mesh recipe + material + pass + policy,
reduced to a mesh by the resolver) and moving the per-frame pipeline into
a worker — on top of ONE memory layout shared by main and the worker.

## Design in one paragraph

Not a single JS object per node in hot paths: everything is flat typed
arrays by slot (SoA). The traversal order is preorder (`order[]`), so
a parent always comes before its child (one transform pass without recursion),
and a subtree is a contiguous rank range (`subtreeEnd[]`) — hierarchical
culling rejects/accepts subtrees by filling bitset words. Dirt is u32 stamps
of a monotonic clock: a resting frame recomputes nothing. The scene lives
either in ArrayBuffer (T0) or in SharedArrayBuffer (T1/T2 — worker) — the
hot loops are one and the same (a core transport invariant, §7.2).

## Quick start

```ts
import { createScene, createCamera, recommendSceneStrategy } from '@rune/scene'

const scene = createScene({ capacity: 100_000, groupMax: 4, maxInstances: 50_000 })

// Build the instance field: a cluster → 9 leaves of group 0.
for (let c = 0; c < 10_000; c++) {
  const root = scene.create({ position: [c % 100 * 60, 0, Math.floor(c / 100) * 60], sphere: [0, 0, 0, 26] })
  for (let k = 0; k < 9; k++) {
    scene.create({ parent: root, position: [/* … */], sphere: [0, 0, 0, 0.8], group: 0 })
  }
}

const cam = createCamera()
cam.setPerspective(Math.PI / 3, aspect, 0.1, 1000)
cam.setViewLookAt(eyeX, eyeY, eyeZ, 0, 0, 0, 0, 1, 0)

// A frame (T0, the whole pipeline in main):
scene.updateWorld()            // dirt stamps — rest is free
scene.refitGroupBounds()       // auto bounds of internal nodes
scene.cull([cam])              // visibility bitset (hierarchical)
scene.collectInstances(0)      // matrices of the visible instances of group 0
const { matrices, count } = scene.instances(0)
// matrices: Float32Array(count*16) — a ready instance attribute
// (4 vec4 columns, stride 64 bytes, divisor 1 — rendererFeed/batchCommand).

scene.forEachVisible(0, (slot) => {
  const myObject = myTable[scene.views.payload[slot]]
  // draw myObject with scene.worldMatrix(slot)
})
```

## Worker (T1/T2)

```ts
// main.ts
const scene = createScene({ capacity: 100_000, shared: true })
const worker = new Worker(new URL('./scene.worker.ts', import.meta.url))
const bridge = createSceneWorkerBridge({ scene, worker: myPortAdapter(worker) })
await bridge.ready

// Frame: publish the input → main is free → take the consistent snapshot.
bridge.publish([cam])          // ~microseconds
// …render the previous snapshot, GPU submits…
const snap = bridge.take()     // bits + instances (copies, no tearing)
```

```ts
// scene.worker.ts (worker)
import { runSceneWorker } from '@rune/scene'
self.onmessage = (e) => { if (e.data.type === 'scene-init') {
  postMessage({ type: 'scene-ready' })
  runSceneWorker(e.data.sab)   // a blocking loop on Atomics.wait
} }
```

Frame fairness protocol: main writes only up to `inputEpoch++`; the worker
reads only after waking; main reads the bitsets/pools only after `outputEpoch`.
The bitsets and instance pools are double-buffered (`epoch & 1`) — tearing is
excluded; `take()` never blocks (a stale frame → the previous epoch's
snapshot, +1 frame of latency).

## Measured numbers (bench.ts, bun 1.3.14, a 4-core container)

| What | Result |
|---|---|
| updateWorld, rest (0% animation) | 0.5 ms per 100k nodes (5 ns/node) |
| updateWorld, full animation | 16.4 ms per 100k (160 ns/animated node) |
| hierarchical cull vs brute | 2× at 100k, 4.5× at 1M nodes |
| cull of 1M nodes | 2.0–2.6 ms (hierarchical) |
| instance compaction | 0.8 ms / 10k visible, 1.3 ms / 100k |
| pack (a structural edit) | 0.07 ms / 10k, 0.77 ms / 100k |
| publish+take bridge | ≈1 µs (median) |
| worker: publish→fresh latency | 1.3–2 ms (≤100k), ~12 ms (1M) |
| worker: overlap over 3 ms of main work | 90% fresh frames (≤100k), 0% (1M) |

**Honest conclusion:** the worker is not about latency (the in-thread pipeline
is ≈2.5× slower + wakeup), it is about freeing main time. The threshold is
`recommendSceneStrategy()`: a pipeline ≥1 ms AND the worker fits the frame
budget. On resting scenes up to ~200k nodes the local pipeline is cheaper
than synchronization.

## Boundary contract

* A node's local sphere (`setSphereLocal`) must enclose the node's geometry;
  for an INTERNAL node the sphere must enclose the subtree (or leave r≤0 —
  refit will compute it itself, bottom-up, every frame).
* An internal node without bounds (r≤0) is never trivially rejected/accepted
  — descent only: safety by construction.
* A node's visibility bit = the test of its OWN sphere (bitwise parity with
  brute on correct bounds — a property test over 40 random scenes).
* GPU-driven culling (compute + indirect) is NOT claimed: the engine does not
  have these execution paths (Contract 5). The design leaves a seam: the
  bitsets/pool are the same buffers a compute pass would consume.

## API

`createScene(options)` · `createSceneFromBuffer(buffer)` · `createCamera()` ·
`runSceneWorker(sab)` · `runScenePipeline(views, bufferIndex)` ·
`createSceneWorkerBridge({ scene, worker })` ·
`recommendSceneStrategy(inputs)` / `estimatePipelineMs(inputs)` /
`measureScenePipeline(scene, cameras)` ·
`cullViewsHierarchical/cullViewsBrute` · `collectInstancesViews` /
`collectGroupMatrices` · `extractFrustumPlanes` / `classifySphere` ·
`updateWorldViews` / `updateWorldForcedViews` / `refitGroupBoundsViews`.

See `src/*.ts` — every file opens with the manifest of its contract.
