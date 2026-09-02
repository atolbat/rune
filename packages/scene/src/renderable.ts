/**
 * renderable.ts — Task 86: the abstract "WHAT to draw" entity.
 *
 * The "instance group" (slot.group) is the COMPACTION GRANULARITY of visible
 * matrices, an internal pipeline detail (one draw-instanced per pack).
 * The scene's user needs something else: a declarative description of a RENDERABLE —
 * "these nodes are drawn with SUCH a mesh, SUCH a material, in SUCH a pass".
 *
 * Renderable — a table of such descriptions WITHOUT any GPU knowledge:
 *   • MeshRecipe — a lazy geometry source ("reduction to a mesh" —
 *     resolveMesh() calls the loader ONCE and caches the result;
 *     a recipe may be an LOD set — a convention on the resolver's side);
 *   • MaterialRecipe — color/emissive/alpha as DATA (not renderer
 *     state): the presentation layer bakes them into an instance stream or
 *     uniforms — as it sees fit;
 *   • RenderableDesc — the bundle (mesh, material, pass, policy, layer):
 *       pass   —Opaque sky fill is NOT drawn as an object; 'opaque' |
 *               'mirror' | 'transparent' | 'overlay' (the frame's pass order);
 *       policy — 'instanced' (a pack of nodes → one instanced draw) |
 *               'unique' (the mesh on its own: terrain, water, the mirror quad);
 *       layer  — a stable sorting bias within a pass (a guaranteed
 *               order for equal depths).
 *
 * Scenarios covered by ONE abstraction: forest/rocks/buildings
 * (instanced+opaque), crystals (instanced+transparent, sorting of
 * instances), terrain (unique+opaque), water (unique+transparent),
 * the mirror (unique+mirror), future LOD sets and impostors (the mesh recipe
 * decides what to return by distance/on-screen size).
 *
 * The registry is main-thread metadata (the worker does not need it): the
 * scene's SoA buffers remain the only "transport contract" of T0/T1/T2.
 */

/** A frame pass. The order = the order the presentation layer composites the frame. */
export type RenderPassTag = 'opaque' | 'sky' | 'mirror' | 'transparent' | 'overlay'

/** The numeric order of the passes (a sort key, see @rune/gl frameSort). */
export const RENDER_PASS_ORDER: Readonly<Record<RenderPassTag, number>> = {
  opaque: 0,
  sky: 1,
  mirror: 2,
  transparent: 3,
  overlay: 4,
}

/** How a renderable's pack of nodes turns into draw calls. */
export type PackPolicy = 'instanced' | 'unique'

/** A lazy geometry source. The loader is called once. */
export interface MeshRecipe {
  readonly id: number
  /** Loads the geometry (the type is on the presentation side, the scene does not know it). */
  readonly load: () => unknown
}

/** The material as data: shader parameters without GPU state. */
export interface MaterialRecipe {
  readonly id: number
  readonly base: readonly [number, number, number]
  /** The emissive fraction (0 — pure lighting, 1 — "glows by itself"). */
  readonly emissive: number
  /** Alpha: 1 — opaque (the opaque pass), <1 — transparent. */
  readonly alpha: number
}

/** A renderable declaration — "what and how to draw for a pack of nodes". */
export interface RenderableDesc {
  readonly id: number
  readonly mesh: number
  readonly material: number
  readonly pass: RenderPassTag
  readonly policy: PackPolicy
  readonly layer: number
}

/** A resolved (cached) mesh recipe. */
export interface ResolvedMesh {
  readonly meshId: number
  /** The result of load() — the geometry (typing is on the presentation side). */
  readonly geometry: unknown
}

export interface RenderableRegistry {
  /** Register a geometry source; returns the recipe id. */
  addMesh(load: () => unknown): number
  /** Register a material; returns the id. */
  addMaterial(material: Omit<MaterialRecipe, 'id'>): number
  /** Register a renderable. The id is assigned by the registry (dense). */
  add(desc: Omit<RenderableDesc, 'id'>): number
  /** The renderable's description (undefined — an unregistered id). */
  get(id: number): RenderableDesc | undefined
  mesh(id: number): MeshRecipe | undefined
  material(id: number): MaterialRecipe | undefined
  /** "Reduction to a mesh": load and cache the recipe's geometry. */
  resolveMesh(meshId: number): ResolvedMesh | undefined
  readonly count: number
}

/** Create a renderables registry (metadata, does not touch the GPU). */
export function createRenderableRegistry(): RenderableRegistry {
  const meshes: MeshRecipe[] = []
  const materials: MaterialRecipe[] = []
  const descs: RenderableDesc[] = []
  const cache = new Map<number, ResolvedMesh>()

  return {
    addMesh(load) {
      const id = meshes.length
      meshes.push({ id, load })
      return id
    },
    addMaterial(material) {
      const id = materials.length
      materials.push({ id, ...material })
      return id
    },
    add(desc) {
      if (meshes[desc.mesh] === undefined) throw new Error(`scene: mesh ${desc.mesh} is not registered`)
      if (materials[desc.material] === undefined) throw new Error(`scene: material ${desc.material} is not registered`)
      const id = descs.length
      descs.push({ id, ...desc })
      return id
    },
    get(id) { return descs[id] },
    mesh(id) { return meshes[id] },
    material(id) { return materials[id] },
    resolveMesh(meshId) {
      const recipe = meshes[meshId]
      if (recipe === undefined) return undefined
      let resolved = cache.get(meshId)
      if (resolved === undefined) {
        resolved = { meshId, geometry: recipe.load() }
        cache.set(meshId, resolved)
      }
      return resolved
    },
    get count() { return descs.length },
  }
}
