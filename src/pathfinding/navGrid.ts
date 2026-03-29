import {
  GRID_RES, terrainType, heightData,
  T_WATER, T_CLIFF, T_ROCK,
  worldToGrid, gridToWorld, CELL_SIZE,
} from '../terrain/heightmap'
import { MAP_SIZE } from '../game/config'

const TOTAL = GRID_RES * GRID_RES

// ── Navigation data ──────────────────────────────────────────
export const walkable = new Uint8Array(TOTAL)
export const moveCost = new Float32Array(TOTAL)

// ── Slope data (max height delta to any cardinal neighbor) ───
export const slopeData = new Float32Array(TOTAL)

// ── Distance-transform clearance map ─────────────────────────
// Value = Chebyshev distance to nearest blocked cell (in cells)
// A unit with radius R needs clearance >= ceil(R)
const clearanceMap = new Float32Array(TOTAL)
let clearanceDirty = true

// ── Initialize nav grid from terrain ─────────────────────────
export function initNavGrid() {
  // 35° slope threshold: tan(35°) ≈ 0.70 height delta per cell
  const SLOPE_BLOCK = 0.70

  for (let i = 0; i < TOTAL; i++) {
    const type = terrainType[i]
    if (type === T_WATER) {
      walkable[i] = 0
      moveCost[i] = 0
    } else {
      walkable[i] = 1
      moveCost[i] = type === T_CLIFF ? 2.0 : type === T_ROCK ? 1.5 : 1.0
    }
  }

  // Build slope map, then block cells steeper than 35°
  buildSlopeMap()
  for (let i = 0; i < TOTAL; i++) {
    if (walkable[i] === 1 && slopeData[i] > SLOPE_BLOCK) {
      walkable[i] = 0
      moveCost[i] = 0
    }
  }

  // Buffer zone around cliffs/steep — increase friction on neighbors
  const tempWalkable = new Uint8Array(walkable)
  for (let gz = 1; gz < GRID_RES - 1; gz++) {
    for (let gx = 1; gx < GRID_RES - 1; gx++) {
      const i = gz * GRID_RES + gx
      if (tempWalkable[i] === 0) continue
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = (gz + dz) * GRID_RES + (gx + dx)
          if (tempWalkable[ni] === 0 && terrainType[ni] !== T_WATER) {
            moveCost[i] = Math.max(moveCost[i], 2.0)
          }
        }
      }
    }
  }

  // Build initial clearance map
  rebuildClearance()
}

// ── Slope map — max |h_diff| to any cardinal neighbor ────────
function buildSlopeMap() {
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const i = gz * GRID_RES + gx
      const h = heightData[i]
      let maxDelta = 0

      // 4 cardinal neighbors
      if (gx > 0) maxDelta = Math.max(maxDelta, Math.abs(h - heightData[i - 1]))
      if (gx < GRID_RES - 1) maxDelta = Math.max(maxDelta, Math.abs(h - heightData[i + 1]))
      if (gz > 0) maxDelta = Math.max(maxDelta, Math.abs(h - heightData[i - GRID_RES]))
      if (gz < GRID_RES - 1) maxDelta = Math.max(maxDelta, Math.abs(h - heightData[i + GRID_RES]))

      slopeData[i] = maxDelta
    }
  }
}

// ── Distance transform clearance (Chebyshev) ────────────────
// O(n) two-pass algorithm — computes min distance to nearest
// blocked cell for every cell in the grid.
export function rebuildClearance() {
  const MAX_CLR = 255

  // Pass 1: initialize — blocked cells get 0, free get MAX
  for (let i = 0; i < TOTAL; i++) {
    if (walkable[i] === 0 || dynamicCost[i] >= BUILDING_BLOCK_THRESHOLD) {
      clearanceMap[i] = 0
    } else {
      clearanceMap[i] = MAX_CLR
    }
  }

  // Pass 2: forward (top-left → bottom-right)
  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      const i = gz * GRID_RES + gx
      let v = clearanceMap[i]
      if (v === 0) continue

      // Check up, left, up-left, up-right
      if (gz > 0) v = Math.min(v, clearanceMap[i - GRID_RES] + 1)
      if (gx > 0) v = Math.min(v, clearanceMap[i - 1] + 1)
      if (gz > 0 && gx > 0) v = Math.min(v, clearanceMap[i - GRID_RES - 1] + 1)
      if (gz > 0 && gx < GRID_RES - 1) v = Math.min(v, clearanceMap[i - GRID_RES + 1] + 1)

      clearanceMap[i] = v
    }
  }

  // Pass 3: backward (bottom-right → top-left)
  for (let gz = GRID_RES - 1; gz >= 0; gz--) {
    for (let gx = GRID_RES - 1; gx >= 0; gx--) {
      const i = gz * GRID_RES + gx
      let v = clearanceMap[i]
      if (v === 0) continue

      if (gz < GRID_RES - 1) v = Math.min(v, clearanceMap[i + GRID_RES] + 1)
      if (gx < GRID_RES - 1) v = Math.min(v, clearanceMap[i + 1] + 1)
      if (gz < GRID_RES - 1 && gx < GRID_RES - 1) v = Math.min(v, clearanceMap[i + GRID_RES + 1] + 1)
      if (gz < GRID_RES - 1 && gx > 0) v = Math.min(v, clearanceMap[i + GRID_RES - 1] + 1)

      clearanceMap[i] = v
    }
  }

  clearanceDirty = false
}

/** Get clearance (distance to nearest obstacle) at grid cell */
export function getClearanceAt(gx: number, gz: number): number {
  if (gx < 0 || gx >= GRID_RES || gz < 0 || gz >= GRID_RES) return 0
  return clearanceMap[gz * GRID_RES + gx]
}

/** Check if a unit with given radius (in cells) can stand at this cell */
export function isClearFor(gx: number, gz: number, radiusCells: number): boolean {
  if (gx < 0 || gx >= GRID_RES || gz < 0 || gz >= GRID_RES) return false
  return clearanceMap[gz * GRID_RES + gx] >= radiusCells
}

/** Check if a cell is passable for a unit considering slope */
export function isClearForUnit(gx: number, gz: number, radiusCells: number, maxSlope: number): boolean {
  if (!isClearFor(gx, gz, radiusCells)) return false
  if (maxSlope < 100 && slopeData[gz * GRID_RES + gx] > maxSlope) return false
  return true
}

/** Mark clearance as needing rebuild */
export function invalidateClearance() {
  clearanceDirty = true
}

/** Rebuild clearance if dirty */
export function ensureClearance() {
  if (clearanceDirty) rebuildClearance()
}

// ── Block/unblock cells for buildings ────────────────────────
export function blockCells(wx: number, wz: number, radius: number) {
  const [cx, cz] = worldToGrid(wx, wz)
  const r = Math.ceil(radius / CELL_SIZE)
  const rSq = (radius / CELL_SIZE) * (radius / CELL_SIZE)
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > rSq) continue
      const gx = cx + dx
      const gz = cz + dz
      if (gx >= 0 && gx < GRID_RES && gz >= 0 && gz < GRID_RES) {
        walkable[gz * GRID_RES + gx] = 0
        moveCost[gz * GRID_RES + gx] = 0
      }
    }
  }
  clearanceDirty = true
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
  clearanceDirty = true
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
export const dynamicCost = new Float32Array(TOTAL)
const UNIT_COST = 2.0
export const BUILDING_BLOCK_THRESHOLD = 50

export function clearDynamicCosts() {
  dynamicCost.fill(0)
}

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

const BUILDING_COST = 100

export function markBuildingObstacle(wx: number, wz: number, radius: number) {
  const [cx, cz] = worldToGrid(wx, wz)
  const r = Math.max(1, Math.ceil(radius / CELL_SIZE))
  const rSq = (radius / CELL_SIZE) * (radius / CELL_SIZE)
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz > rSq) continue
      const gx = cx + dx
      const gz = cz + dz
      if (gx >= 0 && gx < GRID_RES && gz >= 0 && gz < GRID_RES) {
        dynamicCost[gz * GRID_RES + gx] = BUILDING_COST
      }
    }
  }
}
