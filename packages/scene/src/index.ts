// @rune/scene — a maximally flat data-oriented scene graph (Task 81).
//
// Cameras, frustum culling (hierarchical, spheres, trivial accept/reject),
// instance groups (compaction of visible matrices into one pool per group)
// and moving the pipeline into a worker over a SharedArrayBuffer — one
// buffer, the same hot loops in both modes (T0 local / T1-T2 worker).

export {
  createSceneBuffer,
  buildSceneViews,
  sceneBitsWords,
  freeListWord,
  SCENE_MAGIC,
  H_MAGIC, H_CAPACITY, H_NODE_COUNT, H_CAMERA_MAX, H_CAMERA_COUNT,
  H_INPUT_EPOCH, H_OUTPUT_EPOCH, H_LAYOUT_EPOCH, H_CLOCK, H_CMD_FLAGS,
  H_BITS_WORDS, H_GROUP_COUNT, H_INSTANCE_POOL, H_DROPPED_INSTANCES,
  H_STALE_TAKES, H_INT_WORDS, H_FLOAT_FLOATS, H_MAX_INSTANCES, H_GROUP_MAX,
  H_COLLECT_LAYOUT_EPOCH,
  H_WORDS,
  CMD_UPDATE_WORLD, CMD_CULL, CMD_INSTANCES, CMD_REFIT, CMD_ALL, CMD_STOP,
  NF_VISIBLE, NF_ALIVE,
} from './layout.ts'
export type { SceneBufferOptions, SceneViews } from './layout.ts'

export { createScene, createSceneFromBuffer } from './scene.ts'
export type { Scene, SceneNodeInit, SceneOptions, SceneCullResult } from './scene.ts'

export { createCamera, applyObliqueClipPlane } from './camera.ts'
export type { Camera } from './camera.ts'

// Task 86: Renderable — an abstract "what to draw" entity (pass/policy/
// mesh recipe/material), reduced to a mesh by the resolver; the instance
// pack is a compaction detail, not a user-facing entity.
export {
  createRenderableRegistry,
  RENDER_PASS_ORDER,
} from './renderable.ts'
export type {
  RenderPassTag,
  PackPolicy,
  MeshRecipe,
  MaterialRecipe,
  RenderableDesc,
  ResolvedMesh,
  RenderableRegistry,
} from './renderable.ts'

export {
  extractFrustumPlanes,
  classifySphere,
  writeCameraPlanes,
  PLANE_LEFT, PLANE_RIGHT, PLANE_BOTTOM, PLANE_TOP, PLANE_NEAR, PLANE_FAR,
  SPHERE_OUTSIDE, SPHERE_INTERSECT, SPHERE_INSIDE,
} from './frustum.ts'

export {
  cullViewsHierarchical,
  cullViewsBrute,
  fillBits,
  popcountBits,
  bitsBase,
  isVisibleRank,
  rankNodeVisible,
} from './culling.ts'
export type { CullStats, MutableCullStats } from './culling.ts'

export {
  collectInstancesViews,
  instanceMatricesView,
  instancePoolBase,
  collectGroupMatrices,
} from './instances.ts'

export {
  updateWorldViews,
  updateWorldForcedViews,
  refitGroupBoundsViews,
  refitGroupBoundsForcedViews,
} from './transforms.ts'

export { runScenePipeline, runSceneWorker } from './worker.ts'
export type { SceneWorkerHooks } from './worker.ts'

export { createSceneWorkerBridge } from './mirror.ts'
export type { SceneWorkerPort, SceneSnapshot, SceneWorkerBridge, SceneWorkerBridgeStats } from './mirror.ts'

export {
  recommendSceneStrategy,
  measureScenePipeline,
  estimatePipelineMs,
  STATIC_NS_PER_NODE,
  ANIMATED_NS_PER_NODE,
  INSTANCE_NS,
  WORKER_SYNC_MS,
  WORKER_PIPELINE_INFLATION,
  MIN_GAIN_MS,
} from './strategy.ts'
export type { SceneStrategy, SceneStrategyInputs } from './strategy.ts'
