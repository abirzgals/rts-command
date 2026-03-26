import * as THREE from 'three'
import { MAP_SIZE } from '../game/config'
import {
  GRID_RES, heightData, terrainType,
  T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS,
} from './heightmap'
import { scene } from '../render/engine'

// ── Terrain colors ───────────────────────────────────────────
const COLORS: Record<number, THREE.Color> = {
  [T_GRASS]:      new THREE.Color(0.16, 0.40, 0.18),
  [T_DARK_GRASS]: new THREE.Color(0.12, 0.32, 0.14),
  [T_DIRT]:       new THREE.Color(0.50, 0.38, 0.22),
  [T_ROCK]:       new THREE.Color(0.42, 0.40, 0.37),
  [T_WATER]:      new THREE.Color(0.08, 0.20, 0.42),
  [T_CLIFF]:      new THREE.Color(0.32, 0.28, 0.25),
}

export let terrainMesh: THREE.Mesh

export function createTerrainMesh(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, GRID_RES - 1, GRID_RES - 1)
  geo.rotateX(-Math.PI / 2)

  // Apply heightmap to vertices
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    // PlaneGeometry after rotateX: x stays x, y becomes z, z becomes -y
    // Actually after rotateX(-PI/2): (x, y, z) → (x, -z, y)
    // So vertex i maps to grid position based on its (x, z) in world space
    const x = pos.getX(i)
    const z = pos.getZ(i)

    // Map world x,z to grid
    const gx = Math.round((x + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const gz = Math.round((z + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))
    const cgx = Math.max(0, Math.min(GRID_RES - 1, gx))
    const cgz = Math.max(0, Math.min(GRID_RES - 1, gz))

    const h = heightData[cgz * GRID_RES + cgx]
    pos.setY(i, h)
  }
  pos.needsUpdate = true
  geo.computeVertexNormals()

  // Apply vertex colors from terrain type (with neighbor blending)
  const colors = new Float32Array(pos.count * 3)
  const tmpColor = new THREE.Color()

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const gx = Math.max(0, Math.min(GRID_RES - 1, Math.round((x + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))))
    const gz = Math.max(0, Math.min(GRID_RES - 1, Math.round((z + MAP_SIZE / 2) / (MAP_SIZE / (GRID_RES - 1)))))

    const type = terrainType[gz * GRID_RES + gx]
    const base = COLORS[type] || COLORS[T_GRASS]

    // Blend with neighbors for smooth transitions
    let r = base.r, g = base.g, b = base.b
    let count = 1

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue
        const nx = gx + dx
        const nz = gz + dz
        if (nx >= 0 && nx < GRID_RES && nz >= 0 && nz < GRID_RES) {
          const nt = terrainType[nz * GRID_RES + nx]
          const nc = COLORS[nt] || COLORS[T_GRASS]
          r += nc.r
          g += nc.g
          b += nc.b
          count++
        }
      }
    }

    // Add slight noise variation for visual interest
    const noise = (Math.sin(x * 2.3 + z * 1.7) * 0.02 +
                   Math.cos(x * 1.1 - z * 3.2) * 0.015)

    colors[i * 3] = r / count + noise
    colors[i * 3 + 1] = g / count + noise * 0.8
    colors[i * 3 + 2] = b / count + noise * 0.5
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
  })

  terrainMesh = new THREE.Mesh(geo, mat)
  terrainMesh.receiveShadow = true
  scene.add(terrainMesh)

  // ── Water plane ──────────────────────────────────────
  const waterGeo = new THREE.PlaneGeometry(MAP_SIZE * 1.2, MAP_SIZE * 1.2)
  waterGeo.rotateX(-Math.PI / 2)
  const waterMat = new THREE.MeshPhongMaterial({
    color: 0x1a6088,
    transparent: true,
    opacity: 0.55,
    shininess: 120,
    specular: 0x446688,
  })
  const water = new THREE.Mesh(waterGeo, waterMat)
  water.position.y = -1.5
  water.receiveShadow = true
  scene.add(water)

  return terrainMesh
}
