// @rune/prims — процедурные примитивы (Task 106→109): параметризованные
// генераторы (позиции/нормали/UV, один буфер на атрибут) + каталог SHAPES
// для UI + адаптивный/квадтри-террейн. Восстановлен из /tmp-дерева.

// базовые тела
export { cube, box } from './cube.ts'
export type { CubeGeometry, BoxParams } from './cube.ts'
export { quad } from './quad.ts'
export type { QuadGeometry } from './quad.ts'
export { sphere } from './sphere.ts'
export type { SphereParams } from './sphere.ts'
export { plane } from './plane.ts'
export type { PlaneParams } from './plane.ts'
export { cylinder, cone } from './cylinder.ts'
export type { CylinderParams, ConeParams } from './cylinder.ts'
export { capsule } from './capsule.ts'
export type { CapsuleParams } from './capsule.ts'
export { torus, torusKnot } from './torus.ts'
export type { TorusParams, TorusKnotParams } from './torus.ts'
// superellipsoid удалён из публичного API (Task 109, тест «суперэллипсоиды удалены»)

// платоновы тела
export { tetrahedron, octahedron, icosahedron, dodecahedron } from './platonic.ts'
export type { PolyhedronParams } from './platonic.ts'

// диски/кольца/сетка
export { disk, ring } from './disk.ts'
export type { DiskParams, RingParams } from './disk.ts'
export { grid } from './grid.ts'
export type { GridGeometry, GridOptions } from './grid.ts'

// каталог примитивов (Task 109): единая точка правды для демо и тестов
export { SHAPES, segmentValue, shapeById, defaultValues } from './registry.ts'
export type { ParamMeta, ShapeMeta } from './registry.ts'

// террейн: статический + адаптивный + квадтри-патчи
export { terrain, heightHills, heightRidged, heightIsland, heightDunes, heightCanyon } from './terrain.ts'
export type { TerrainHeightFn, TerrainOptions } from './terrain.ts'
export { createAdaptiveTerrain, worldHills, worldRidged, worldDunes, worldCanyon, worldIsland, adaptivePresets } from './adaptive.ts'
export type { WorldHeightFn, AdaptiveTerrainParams, AdaptiveTerrain, AdaptivePreset } from './adaptive.ts'
export { createTerrainQuadtree, terrainHills, terrainRidges, terrainDunes, terrainCanyon } from './terrainQuadtree.ts'
export type { TerrainQuadtreeParams, TerrainQuadtree, TerrainQuadtreePreset } from './terrainQuadtree.ts'
export { selectQuadtreeTiles, quadtreeTileMesh, PATCH_CELLS, PATCH_VERTEX_COUNT } from './quadtree.ts'
export type { QuadtreeTilesSelection, QuadtreeSelectOptions, QuadtreeTileMesh, QuadtreeTileMeshOptions } from './quadtree.ts'

// шум и утилиты
export { hash2i, valueNoise2D, fbm2D, ridged2D } from './noise.ts'
export { createPrimitiveFeed } from './feed.ts'
export type { PrimitiveFeedParams, PrimitiveFeed } from './feed.ts'

// общие типы
export type { Geometry } from './types.ts'
export { triangles, geometryBytes } from './types.ts'
