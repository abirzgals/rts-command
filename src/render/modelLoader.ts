import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const loader = new GLTFLoader()

export interface LoadedModel {
  geometry: THREE.BufferGeometry
  material: THREE.Material
}

/**
 * Load a .glb file and extract the merged geometry + first material.
 * Handles models with multiple meshes by merging them.
 */
export async function loadModel(
  url: string,
  scale = 1.0,
): Promise<LoadedModel> {
  const gltf = await loader.loadAsync(url)

  const geometries: THREE.BufferGeometry[] = []
  let material: THREE.Material | null = null

  gltf.scene.updateMatrixWorld(true)

  gltf.scene.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh
      // Clone geometry and apply world transform
      const geo = mesh.geometry.clone()
      geo.applyMatrix4(mesh.matrixWorld)

      // Apply scale
      if (scale !== 1.0) {
        geo.scale(scale, scale, scale)
      }

      // Ensure non-indexed for merge compatibility
      if (geo.index) {
        const ni = geo.toNonIndexed()
        geo.dispose()
        geometries.push(ni)
      } else {
        geometries.push(geo)
      }

      // Grab first material
      if (!material) {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        material = mat.clone()
      }
    }
  })

  if (geometries.length === 0) {
    throw new Error(`No meshes found in ${url}`)
  }

  // Merge all geometries
  let merged: THREE.BufferGeometry
  if (geometries.length === 1) {
    merged = geometries[0]
  } else {
    // Manual merge: concatenate position + normal buffers
    let totalVerts = 0
    for (const g of geometries) totalVerts += g.attributes.position.count

    const pos = new Float32Array(totalVerts * 3)
    const norm = new Float32Array(totalVerts * 3)
    let hasUV = geometries.every(g => g.attributes.uv)
    const uv = hasUV ? new Float32Array(totalVerts * 2) : null

    let offsetV = 0
    let offsetU = 0
    for (const g of geometries) {
      const gPos = g.attributes.position.array as Float32Array
      const gNorm = g.attributes.normal?.array as Float32Array
      pos.set(gPos, offsetV * 3)
      if (gNorm) norm.set(gNorm, offsetV * 3)
      if (uv && g.attributes.uv) {
        const gUV = g.attributes.uv.array as Float32Array
        uv.set(gUV, offsetU * 2)
        offsetU += g.attributes.uv.count
      }
      offsetV += g.attributes.position.count
      g.dispose()
    }

    merged = new THREE.BufferGeometry()
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    merged.setAttribute('normal', new THREE.BufferAttribute(norm, 3))
    if (uv) merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  }

  // Apply scale to final geometry if not done per-piece
  if (scale !== 1.0 && geometries.length > 1) {
    // Already scaled per-piece above
  }

  return {
    geometry: merged,
    material: material || new THREE.MeshPhongMaterial({ color: 0xcccccc, flatShading: true }),
  }
}

/**
 * Load multiple models in parallel. Returns a map of name → LoadedModel.
 */
export async function loadModels(
  manifest: { name: string; url: string; scale?: number }[],
): Promise<Map<string, LoadedModel>> {
  const results = new Map<string, LoadedModel>()

  const promises = manifest.map(async ({ name, url, scale }) => {
    try {
      const model = await loadModel(url, scale)
      results.set(name, model)
      console.log(`[models] Loaded: ${name}`)
    } catch (e) {
      console.warn(`[models] Failed to load ${name} from ${url}:`, e)
    }
  })

  await Promise.all(promises)
  return results
}
