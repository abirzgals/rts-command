/**
 * Hierarchical sector graph for Supreme Commander-style pathfinding.
 *
 * Divides the 200×200 grid into 16×16 sectors (13×13 = 169 sectors).
 * Precomputes connectivity between adjacent sectors by scanning shared
 * border cells. A* on the sector graph produces a "corridor" of sectors,
 * then fine A* is constrained to run only within that corridor.
 */

import { GRID_RES } from '../terrain/heightmap'
import { walkable, dynamicCost, BUILDING_BLOCK_THRESHOLD } from './navGrid'

// ── Constants ────────────────────────────────────────────────
export const SECTOR_SIZE = 16
export const SECTOR_COLS = Math.ceil(GRID_RES / SECTOR_SIZE) // 13
export const SECTOR_ROWS = Math.ceil(GRID_RES / SECTOR_SIZE) // 13
export const SECTOR_COUNT = SECTOR_COLS * SECTOR_ROWS         // 169

/** Get sector ID for a grid cell */
export function sectorId(gx: number, gz: number): number {
  const sx = Math.min((gx / SECTOR_SIZE) | 0, SECTOR_COLS - 1)
  const sz = Math.min((gz / SECTOR_SIZE) | 0, SECTOR_ROWS - 1)
  return sz * SECTOR_COLS + sx
}

// ── Portal-based sector connectivity ─────────────────────────
interface Portal {
  // The two sectors this portal connects
  sectorA: number
  sectorB: number
  // Midpoint of the portal on the border (grid coords)
  midX: number
  midZ: number
  // Portal width (number of contiguous passable border cells)
  width: number
}

// Adjacency list: for each sector, list of (neighborSector, cost, portalMidX, portalMidZ)
interface SectorEdge {
  neighbor: number
  cost: number
  portalX: number
  portalZ: number
}

const adjacency: SectorEdge[][] = new Array(SECTOR_COUNT)
let graphBuilt = false

function isCellPassable(gx: number, gz: number): boolean {
  if (gx < 0 || gx >= GRID_RES || gz < 0 || gz >= GRID_RES) return false
  const i = gz * GRID_RES + gx
  return walkable[i] === 1 && dynamicCost[i] < BUILDING_BLOCK_THRESHOLD
}

/** Build the sector connectivity graph by scanning borders between adjacent sectors */
export function buildSectorGraph() {
  for (let i = 0; i < SECTOR_COUNT; i++) {
    adjacency[i] = []
  }

  // Scan horizontal borders (sector above <-> sector below)
  for (let sz = 0; sz < SECTOR_ROWS - 1; sz++) {
    for (let sx = 0; sx < SECTOR_COLS; sx++) {
      const sectorA = sz * SECTOR_COLS + sx
      const sectorB = (sz + 1) * SECTOR_COLS + sx

      // Border is at gz = (sz+1) * SECTOR_SIZE - 1 (bottom of A) and gz = (sz+1) * SECTOR_SIZE (top of B)
      const borderZ_A = (sz + 1) * SECTOR_SIZE - 1
      const borderZ_B = (sz + 1) * SECTOR_SIZE
      if (borderZ_B >= GRID_RES) continue

      const startX = sx * SECTOR_SIZE
      const endX = Math.min(startX + SECTOR_SIZE, GRID_RES)

      findPortalsOnBorder(sectorA, sectorB, startX, endX, borderZ_A, borderZ_B, true)
    }
  }

  // Scan vertical borders (sector left <-> sector right)
  for (let sz = 0; sz < SECTOR_ROWS; sz++) {
    for (let sx = 0; sx < SECTOR_COLS - 1; sx++) {
      const sectorA = sz * SECTOR_COLS + sx
      const sectorB = sz * SECTOR_COLS + (sx + 1)

      const borderX_A = (sx + 1) * SECTOR_SIZE - 1
      const borderX_B = (sx + 1) * SECTOR_SIZE
      if (borderX_B >= GRID_RES) continue

      const startZ = sz * SECTOR_SIZE
      const endZ = Math.min(startZ + SECTOR_SIZE, GRID_RES)

      findPortalsOnBorder(sectorA, sectorB, startZ, endZ, borderX_A, borderX_B, false)
    }
  }

  graphBuilt = true
}

function findPortalsOnBorder(
  sectorA: number, sectorB: number,
  rangeStart: number, rangeEnd: number,
  border_A: number, border_B: number,
  isHorizontal: boolean,
) {
  // Scan the shared border for contiguous runs of passable cell pairs
  let runStart = -1

  for (let i = rangeStart; i <= rangeEnd; i++) {
    const inRange = i < rangeEnd
    let passable = false

    if (inRange) {
      if (isHorizontal) {
        passable = isCellPassable(i, border_A) && isCellPassable(i, border_B)
      } else {
        passable = isCellPassable(border_A, i) && isCellPassable(border_B, i)
      }
    }

    if (passable && runStart < 0) {
      runStart = i
    } else if (!passable && runStart >= 0) {
      // End of a contiguous run — create portal
      const mid = (runStart + i - 1) / 2
      let midX: number, midZ: number

      if (isHorizontal) {
        midX = mid
        midZ = (border_A + border_B) / 2
      } else {
        midX = (border_A + border_B) / 2
        midZ = mid
      }

      // Cost = 1 (since sectors are adjacent, real cost comes from fine A*)
      adjacency[sectorA].push({ neighbor: sectorB, cost: 1, portalX: midX, portalZ: midZ })
      adjacency[sectorB].push({ neighbor: sectorA, cost: 1, portalX: midX, portalZ: midZ })

      runStart = -1
    }
  }
}

// ── Sector-level A* ──────────────────────────────────────────
// With only 169 sectors, this is trivially fast (<0.01ms)

const sectorGCost = new Float32Array(SECTOR_COUNT)
const sectorFrom = new Int16Array(SECTOR_COUNT)
const sectorVisited = new Uint32Array(SECTOR_COUNT)
let sectorGen = 0

function sectorHeuristic(a: number, b: number): number {
  const ax = a % SECTOR_COLS
  const az = (a / SECTOR_COLS) | 0
  const bx = b % SECTOR_COLS
  const bz = (b / SECTOR_COLS) | 0
  return Math.abs(ax - bx) + Math.abs(az - bz)
}

/** Find path through sector graph. Returns ordered list of sector IDs, or null if unreachable. */
export function findSectorPath(startSector: number, goalSector: number): number[] | null {
  if (!graphBuilt) buildSectorGraph()

  if (startSector === goalSector) return [startSector]

  sectorGen++
  const open: number[] = []
  const fScore = new Float32Array(SECTOR_COUNT)

  sectorGCost[startSector] = 0
  fScore[startSector] = sectorHeuristic(startSector, goalSector)
  sectorVisited[startSector] = sectorGen
  sectorFrom[startSector] = -1
  open.push(startSector)

  while (open.length > 0) {
    // Find node with lowest fScore (linear scan — fine for 169 nodes)
    let bestIdx = 0
    for (let i = 1; i < open.length; i++) {
      if (fScore[open[i]] < fScore[open[bestIdx]]) bestIdx = i
    }
    const current = open[bestIdx]
    open[bestIdx] = open[open.length - 1]
    open.pop()

    if (current === goalSector) {
      // Reconstruct
      const path: number[] = []
      let c = current
      while (c !== -1) {
        path.push(c)
        c = sectorFrom[c]
      }
      path.reverse()
      return path
    }

    for (const edge of adjacency[current]) {
      const tentG = sectorGCost[current] + edge.cost
      if (sectorVisited[edge.neighbor] === sectorGen && tentG >= sectorGCost[edge.neighbor]) continue

      sectorGCost[edge.neighbor] = tentG
      fScore[edge.neighbor] = tentG + sectorHeuristic(edge.neighbor, goalSector)
      sectorFrom[edge.neighbor] = current
      sectorVisited[edge.neighbor] = sectorGen

      if (!open.includes(edge.neighbor)) {
        open.push(edge.neighbor)
      }
    }
  }

  return null // No sector path found (isolated regions)
}

/** Invalidate and rebuild the sector graph */
export function invalidateSectors() {
  graphBuilt = false
}
