/**
 * Terrain brush engine for the map editor.
 * Modifies heightData/terrainType in-place and updates mesh geometry locally.
 */

import * as THREE from 'three'
import {
  GRID_RES, heightData, terrainType, worldToGrid, gridToWorld, CELL_SIZE,
  T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS,
} from './heightmap'
import { terrainMesh } from './terrainMesh'

// ── Brush settings ───────────────────────────────────────────

export type BrushTool = 'paint' | 'raise' | 'lower' | 'smooth' | 'flatten'

export interface BrushSettings {
  tool: BrushTool
  radius: number        // grid cells (1-20)
  strength: number      // 0.1-1.0
  terrainType: number   // for paint tool
}

// ── Apply brush at world position ────────────────────────────

export function applyBrush(wx: number, wz: number, settings: BrushSettings, dt: number) {
  const [cx, cz] = worldToGrid(wx, wz)
  const r = settings.radius
  let dirty = false

  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx
      const gz = cz + dz
      if (gx < 0 || gx >= GRID_RES || gz < 0 || gz >= GRID_RES) continue

      const dist = Math.sqrt(dx * dx + dz * dz)
      if (dist > r) continue

      // Circular falloff: 1 at center, 0 at edge
      const falloff = 1 - dist / r
      const weight = falloff * falloff * settings.strength
      const i = gz * GRID_RES + gx

      switch (settings.tool) {
        case 'paint':
          if (weight > 0.3) { // threshold to avoid painting too far
            terrainType[i] = settings.terrainType
            // Adjust height for water painting
            if (settings.terrainType === T_WATER && heightData[i] > -1.0) {
              heightData[i] = -2.0
            }
            dirty = true
          }
          break

        case 'raise':
          heightData[i] += weight * 5.0 * dt
          dirty = true
          break

        case 'lower':
          heightData[i] -= weight * 5.0 * dt
          dirty = true
          break

        case 'smooth': {
          // Average with neighbors
          let sum = 0, count = 0
          for (let sz = -1; sz <= 1; sz++) {
            for (let sx = -1; sx <= 1; sx++) {
              const nx = gx + sx, nz = gz + sz
              if (nx >= 0 && nx < GRID_RES && nz >= 0 && nz < GRID_RES) {
                sum += heightData[nz * GRID_RES + nx]
                count++
              }
            }
          }
          const avg = sum / count
          heightData[i] += (avg - heightData[i]) * weight * 3.0 * dt
          dirty = true
          break
        }

        case 'flatten': {
          // Flatten to center height
          const centerH = heightData[cz * GRID_RES + cx]
          heightData[i] += (centerH - heightData[i]) * weight * 4.0 * dt
          dirty = true
          break
        }
      }
    }
  }

  if (dirty) {
    // Reclassify terrain types in affected area (for height tools)
    if (settings.tool !== 'paint') {
      reclassifyRegion(cx - r - 1, cz - r - 1, cx + r + 1, cz + r + 1)
    }
    // Update mesh geometry in affected region
    updateMeshRegion(cx - r - 2, cz - r - 2, cx + r + 2, cz + r + 2)
  }
}

// ── Reclassify terrain types in a region ─────────────────────

function reclassifyRegion(x1: number, z1: number, x2: number, z2: number) {
  const minX = Math.max(0, x1), maxX = Math.min(GRID_RES - 1, x2)
  const minZ = Math.max(0, z1), maxZ = Math.min(GRID_RES - 1, z2)

  for (let gz = minZ; gz <= maxZ; gz++) {
    for (let gx = minX; gx <= maxX; gx++) {
      const i = gz * GRID_RES + gx
      const h = heightData[i]
      if (h < -1.0) terrainType[i] = T_WATER
      else if (h < 2.0) terrainType[i] = T_GRASS
      else if (h < 4.5) terrainType[i] = T_DIRT
      else if (h < 7.0) terrainType[i] = T_DARK_GRASS
      else terrainType[i] = T_ROCK
    }
  }

  // Cliff detection
  for (let gz = Math.max(1, minZ); gz <= Math.min(GRID_RES - 2, maxZ); gz++) {
    for (let gx = Math.max(1, minX); gx <= Math.min(GRID_RES - 2, maxX); gx++) {
      const i = gz * GRID_RES + gx
      const h = heightData[i]
      const maxSlope = Math.max(
        Math.abs(h - heightData[i - 1]),
        Math.abs(h - heightData[i + 1]),
        Math.abs(h - heightData[i - GRID_RES]),
        Math.abs(h - heightData[i + GRID_RES]),
      )
      if (maxSlope > 3.0 && terrainType[i] !== T_WATER) terrainType[i] = T_CLIFF
    }
  }
}

// ── Update terrain mesh geometry in a region ─────────────────
// Instead of rebuilding entire 40k-vertex mesh, update only affected vertices.

function updateMeshRegion(x1: number, z1: number, x2: number, z2: number) {
  if (!terrainMesh) return

  const geo = terrainMesh.geometry
  const posAttr = geo.attributes.position as THREE.BufferAttribute
  const splatAttr = geo.attributes.aSplat as THREE.BufferAttribute

  const minX = Math.max(0, x1), maxX = Math.min(GRID_RES - 1, x2)
  const minZ = Math.max(0, z1), maxZ = Math.min(GRID_RES - 1, z2)

  // PlaneGeometry(200, 200, GRID_RES-1, GRID_RES-1) after rotateX(-PI/2)
  // Vertex count: GRID_RES * GRID_RES, laid out row by row
  // After rotateX(-PI/2): original Y becomes -Z, original Z becomes Y
  // So vertex (gx, gz) has: x = world_x, y = height, z = world_z

  for (let gz = minZ; gz <= maxZ; gz++) {
    for (let gx = minX; gx <= maxX; gx++) {
      const vi = gz * GRID_RES + gx
      const i = gz * GRID_RES + gx

      // Update Y (height)
      posAttr.setY(vi, heightData[i])

      // Update splat weights with blur
      if (splatAttr) {
        const splat = computeSplatAt(gx, gz)
        splatAttr.setXYZW(vi, splat[0], splat[1], splat[2], splat[3])
      }
    }
  }

  posAttr.needsUpdate = true
  if (splatAttr) splatAttr.needsUpdate = true
  geo.computeVertexNormals()
}

// ── Compute per-vertex splat weight (same logic as terrainMesh.ts) ─

function computeSplatAt(gx: number, gz: number): [number, number, number, number] {
  // Gaussian blur 5x5 kernel around the cell
  let wGrass = 0, wDirt = 0, wRock = 0, wCliff = 0
  const BLUR_R = 2

  for (let dz = -BLUR_R; dz <= BLUR_R; dz++) {
    for (let dx = -BLUR_R; dx <= BLUR_R; dx++) {
      const nx = Math.max(0, Math.min(GRID_RES - 1, gx + dx))
      const nz = Math.max(0, Math.min(GRID_RES - 1, gz + dz))
      const type = terrainType[nz * GRID_RES + nx]
      // Gaussian weight: center=1, edges~0.13
      const d = dx * dx + dz * dz
      const w = Math.exp(-d * 0.5)

      switch (type) {
        case T_GRASS: case T_DARK_GRASS: wGrass += w; break
        case T_DIRT: wDirt += w; break
        case T_ROCK: wRock += w; break
        case T_CLIFF: wCliff += w; break
        case T_WATER: wGrass += w * 0.5; break // water edges blend to grass
      }
    }
  }

  const total = wGrass + wDirt + wRock + wCliff || 1
  return [wGrass / total, wDirt / total, wRock / total, wCliff / total]
}
