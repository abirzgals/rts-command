import {
  GRID_RES, terrainType, heightData,
  T_WATER, T_CLIFF, T_ROCK,
  worldToGrid, gridToWorld, CELL_SIZE,
} from '../terrain/heightmap'
import { MAP_SIZE } from '../game/config'

// ── Navigation data ──────────────────────────────────────────
export const walkable = new Uint8Array(GRID_RES * GRID_RES)
export const moveCost = new Float32Array(GRID_RES * GRID_RES)

// ── Initialize nav grid from terrain ─────────────────────────
export function initNavGrid() {
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    const type = terrainType[i]
    if (type === T_WATER || type === T_CLIFF) {
      walkable[i] = 0
      moveCost[i] = 0
    } else {
      walkable[i] = 1
      moveCost[i] = type === T_ROCK ? 1.5 : 1.0
    }
  }

  // Buffer zone around cliffs — mark 1-cell border as unwalkable
  const tempWalkable = new Uint8Array(walkable)
  for (let gz = 1; gz < GRID_RES - 1; gz++) {
    for (let gx = 1; gx < GRID_RES - 1; gx++) {
      const i = gz * GRID_RES + gx
      if (tempWalkable[i] === 0) continue
      // If any neighbor is a cliff/water, add friction
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = (gz + dz) * GRID_RES + (gx + dx)
          if (terrainType[ni] === T_CLIFF) {
            moveCost[i] = Math.max(moveCost[i], 2.0)
          }
        }
      }
    }
  }
}

// ── Block/unblock cells for buildings ────────────────────────
export function blockCells(wx: number, wz: number, radius: number) {
  const [cx, cz] = worldToGrid(wx, wz)
  const r = Math.ceil(radius / CELL_SIZE)
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx
      const gz = cz + dz
      if (gx >= 0 && gx < GRID_RES && gz >= 0 && gz < GRID_RES) {
        walkable[gz * GRID_RES + gx] = 0
        moveCost[gz * GRID_RES + gx] = 0
      }
    }
  }
}

export function unblockCells(wx: number, wz: number, radius: number) {
  const [cx, cz] = worldToGrid(wx, wz)
  const r = Math.ceil(radius / CELL_SIZE) + 1
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx
      const gz = cz + dz
      if (gx >= 0 && gx < GRID_RES && gz >= 0 && gz < GRID_RES) {
        const i = gz * GRID_RES + gx
        const type = terrainType[i]
        if (type !== T_WATER && type !== T_CLIFF) {
          walkable[i] = 1
          moveCost[i] = type === T_ROCK ? 1.5 : 1.0
        }
      }
    }
  }
}

export function isWalkable(gx: number, gz: number): boolean {
  if (gx < 0 || gx >= GRID_RES || gz < 0 || gz >= GRID_RES) return false
  return walkable[gz * GRID_RES + gx] === 1
}

export function isWorldWalkable(wx: number, wz: number): boolean {
  const [gx, gz] = worldToGrid(wx, wz)
  return isWalkable(gx, gz)
}

// ── Dynamic unit obstacle overlay ───────────────────────────
// Extra cost from units occupying cells. Updated each frame before pathfinding.
export const dynamicCost = new Float32Array(GRID_RES * GRID_RES)
const UNIT_COST = 2.0 // units make cells slightly expensive but not impassable

export function clearDynamicCosts() {
  dynamicCost.fill(0)
}

/** Mark cells near a unit as high-cost for pathfinding */
export function markUnitObstacle(wx: number, wz: number, radius: number) {
  const [cx, cz] = worldToGrid(wx, wz)
  const r = Math.max(1, Math.ceil(radius / CELL_SIZE))
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx
      const gz = cz + dz
      if (gx >= 0 && gx < GRID_RES && gz >= 0 && gz < GRID_RES) {
        const i = gz * GRID_RES + gx
        if (walkable[i] === 1) {
          dynamicCost[i] = UNIT_COST
        }
      }
    }
  }
}
