import { GRID_RES, worldToGrid, gridToWorld, CELL_SIZE } from '../terrain/heightmap'
import { walkable, moveCost, dynamicCost, isWalkable, isClearFor, isClearForUnit, slopeData, ensureClearance } from './navGrid'
import { sectorId, findSectorPath, SECTOR_SIZE, SECTOR_COLS } from './sectorGraph'
import type { Waypoint } from './pathStore'

// ── Binary min-heap ──────────────────────────────────────────
class BinaryHeap {
  private data: number[] = []
  private scores: Float32Array

  constructor(maxSize: number) {
    this.scores = new Float32Array(maxSize)
  }

  push(node: number, score: number) {
    this.scores[node] = score
    this.data.push(node)
    this._bubbleUp(this.data.length - 1)
  }

  pop(): number {
    const top = this.data[0]
    const end = this.data.pop()!
    if (this.data.length > 0) {
      this.data[0] = end
      this._sinkDown(0)
    }
    return top
  }

  get size() { return this.data.length }

  updateScore(node: number, score: number) {
    this.scores[node] = score
    const idx = this.data.indexOf(node)
    if (idx >= 0) this._bubbleUp(idx)
  }

  private _bubbleUp(i: number) {
    const node = this.data[i]
    const score = this.scores[node]
    while (i > 0) {
      const parentIdx = (i - 1) >> 1
      const parent = this.data[parentIdx]
      if (score >= this.scores[parent]) break
      this.data[i] = parent
      this.data[parentIdx] = node
      i = parentIdx
    }
  }

  private _sinkDown(i: number) {
    const len = this.data.length
    const node = this.data[i]
    const score = this.scores[node]
    while (true) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let smallest = i
      if (l < len && this.scores[this.data[l]] < this.scores[this.data[smallest]]) smallest = l
      if (r < len && this.scores[this.data[r]] < this.scores[this.data[smallest]]) smallest = r
      if (smallest === i) break
      ;[this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]]
      i = smallest
    }
  }
}

// ── A* constants ─────────────────────────────────────────────
const SQRT2 = Math.SQRT2
const MAX_EXPANSIONS = 50000

// 8-direction neighbors: dx, dz, cost multiplier
const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [-1, 1, SQRT2], [1, -1, SQRT2], [-1, -1, SQRT2],
]

// Reusable arrays with generation counter to avoid clearing
const gCost = new Float32Array(GRID_RES * GRID_RES)
const fCost = new Float32Array(GRID_RES * GRID_RES)
const cameFrom = new Int32Array(GRID_RES * GRID_RES)
const visited = new Uint32Array(GRID_RES * GRID_RES)
// inOpen uses generation counter too — prevents stale values from previous searches
const inOpen = new Uint32Array(GRID_RES * GRID_RES)
let generation = 0

// Current search params (used by smoothPath)
let currentClearance = 0
let currentMaxSlope = 100.0

function idx(gx: number, gz: number) { return gz * GRID_RES + gx }

// Octile distance heuristic
function heuristic(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx)
  const dz = Math.abs(az - bz)
  return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)
}

/** Check if cell passable for current search (clearance + slope) */
function isPassableForSearch(gx: number, gz: number): boolean {
  if (gx < 0 || gx >= GRID_RES || gz < 0 || gz >= GRID_RES) return false
  const i = gz * GRID_RES + gx
  if (walkable[i] === 0) return false
  if (currentClearance > 0 && !isClearFor(gx, gz, currentClearance)) return false
  if (currentMaxSlope < 100 && slopeData[i] > currentMaxSlope) return false
  return true
}

// ── Hierarchical A* (Supreme Commander style) ────────────────
// 1. Find sector path (coarse)
// 2. Run fine A* constrained to the sector corridor

export function findPathHierarchical(
  startX: number, startZ: number,
  goalX: number, goalZ: number,
  unitRadius = 0,
  maxSlope = 100.0,
  ignoreDynamic = false,
): Waypoint[] | null {
  ensureClearance()

  const clearance = unitRadius > 0.8 ? Math.ceil(unitRadius / CELL_SIZE) : 0

  let [sx, sz] = worldToGrid(startX, startZ)
  const [gx, gz] = worldToGrid(goalX, goalZ)

  // If start is unwalkable, find nearest walkable cell
  if (!isWalkable(sx, sz)) {
    const found = findNearestWalkable(sx, sz)
    if (!found) return null
    ;[sx, sz] = found
  }

  let tgx = gx, tgz = gz
  if (!isWalkable(gx, gz)) {
    const found = findNearestWalkable(gx, gz)
    if (!found) return null
    ;[tgx, tgz] = found
  }

  if (sx === tgx && sz === tgz) return []

  // Set search params
  currentClearance = clearance
  currentMaxSlope = maxSlope

  const startSector = sectorId(sx, sz)
  const goalSector = sectorId(tgx, tgz)

  // Same sector or adjacent → run fine A* directly (no corridor constraint overhead)
  if (startSector === goalSector || Math.abs(startSector % SECTOR_COLS - goalSector % SECTOR_COLS) <= 1 &&
      Math.abs(((startSector / SECTOR_COLS) | 0) - ((goalSector / SECTOR_COLS) | 0)) <= 1) {
    return findPathDirect(sx, sz, tgx, tgz, ignoreDynamic)
  }

  // Hierarchical: find sector corridor first
  const sectorPath = findSectorPath(startSector, goalSector)
  if (!sectorPath) {
    // No sector path — try direct A* as fallback (maybe sectors are stale)
    return findPathDirect(sx, sz, tgx, tgz, ignoreDynamic)
  }

  // Build allowed sectors set (corridor + 1-sector padding for path smoothing)
  const allowedSectors = new Set<number>()
  for (const s of sectorPath) {
    allowedSectors.add(s)
    // Add 8-neighbor sectors as padding
    const scol = s % SECTOR_COLS
    const srow = (s / SECTOR_COLS) | 0
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = srow + dr
        const nc = scol + dc
        if (nr >= 0 && nr < Math.ceil(GRID_RES / SECTOR_SIZE) && nc >= 0 && nc < SECTOR_COLS) {
          allowedSectors.add(nr * SECTOR_COLS + nc)
        }
      }
    }
  }

  // Corridor-constrained fine A*
  const result = findPathConstrained(sx, sz, tgx, tgz, ignoreDynamic, allowedSectors)

  // Fallback to unconstrained if corridor fails
  if (!result) return findPathDirect(sx, sz, tgx, tgz, ignoreDynamic)

  return result
}

/** Direct (unconstrained) fine A* — used for short distances or fallback */
function findPathDirect(
  sx: number, sz: number,
  tgx: number, tgz: number,
  ignoreDynamic: boolean,
): Waypoint[] | null {
  return runAStar(sx, sz, tgx, tgz, ignoreDynamic, null)
}

/** Corridor-constrained A* — only expand nodes in allowed sectors */
function findPathConstrained(
  sx: number, sz: number,
  tgx: number, tgz: number,
  ignoreDynamic: boolean,
  allowedSectors: Set<number>,
): Waypoint[] | null {
  return runAStar(sx, sz, tgx, tgz, ignoreDynamic, allowedSectors)
}

/** Core A* search — optionally constrained to a set of sectors */
function runAStar(
  sx: number, sz: number,
  tgx: number, tgz: number,
  ignoreDynamic: boolean,
  allowedSectors: Set<number> | null,
): Waypoint[] | null {
  generation++
  const heap = new BinaryHeap(GRID_RES * GRID_RES)

  const startIdx = idx(sx, sz)
  gCost[startIdx] = 0
  fCost[startIdx] = heuristic(sx, sz, tgx, tgz)
  visited[startIdx] = generation
  inOpen[startIdx] = generation
  cameFrom[startIdx] = -1
  heap.push(startIdx, fCost[startIdx])

  let expansions = 0

  while (heap.size > 0 && expansions < MAX_EXPANSIONS) {
    const current = heap.pop()
    const cx = current % GRID_RES
    const cz = (current / GRID_RES) | 0

    inOpen[current] = 0  // mark as closed (no longer in open)

    if (cx === tgx && cz === tgz) {
      return reconstructPath(current, startIdx)
    }

    expansions++

    for (const [dx, dz, baseCost] of DIRS) {
      const nx = cx + dx
      const nz = cz + dz

      if (nx < 0 || nx >= GRID_RES || nz < 0 || nz >= GRID_RES) continue

      // Corridor constraint — skip cells outside allowed sectors
      if (allowedSectors && !allowedSectors.has(sectorId(nx, nz))) continue

      if (!isPassableForSearch(nx, nz)) continue

      // Prevent corner cutting: for diagonal moves, both adjacent cardinals must be passable
      if (dx !== 0 && dz !== 0) {
        if (!isPassableForSearch(cx + dx, cz) || !isPassableForSearch(cx, cz + dz)) continue
      }

      const ni = idx(nx, nz)
      const cost = baseCost * (moveCost[ni] + (ignoreDynamic ? 0 : dynamicCost[ni]))
      const tentativeG = gCost[current] + cost

      if (visited[ni] === generation && tentativeG >= gCost[ni]) continue

      cameFrom[ni] = current
      gCost[ni] = tentativeG
      fCost[ni] = tentativeG + heuristic(nx, nz, tgx, tgz)
      visited[ni] = generation

      if (inOpen[ni] !== generation) {
        inOpen[ni] = generation
        heap.push(ni, fCost[ni])
      } else {
        heap.updateScore(ni, fCost[ni])
      }
    }
  }

  return null
}

function reconstructPath(goalIdx: number, startIdx: number): Waypoint[] {
  const gridPath: number[] = []
  let current = goalIdx
  while (current !== startIdx && current !== -1) {
    gridPath.push(current)
    current = cameFrom[current]
  }
  gridPath.reverse()

  const waypoints: Waypoint[] = []
  for (let i = 0; i < gridPath.length; i++) {
    const gx = gridPath[i] % GRID_RES
    const gz = (gridPath[i] / GRID_RES) | 0
    const [wx, wz] = gridToWorld(gx, gz)
    waypoints.push({ x: wx, z: wz })
  }

  return smoothPath(waypoints)
}

function smoothPath(path: Waypoint[]): Waypoint[] {
  if (path.length <= 2) return path

  const result: Waypoint[] = [path[0]]
  let current = 0

  while (current < path.length - 1) {
    let furthest = current + 1
    for (let i = current + 2; i < path.length; i++) {
      if (hasLineOfSight(path[current].x, path[current].z, path[i].x, path[i].z)) {
        furthest = i
      } else {
        break
      }
    }
    result.push(path[furthest])
    current = furthest
  }

  return result
}

function hasLineOfSight(x1: number, z1: number, x2: number, z2: number): boolean {
  const [gx1, gz1] = worldToGrid(x1, z1)
  const [gx2, gz2] = worldToGrid(x2, z2)

  const steps = Math.max(Math.abs(gx2 - gx1), Math.abs(gz2 - gz1))
  if (steps === 0) return isPassableForSearch(gx1, gz1)

  const stepX = (gx2 - gx1) / steps
  const stepZ = (gz2 - gz1) / steps

  for (let i = 0; i <= steps; i++) {
    const cx = Math.round(gx1 + stepX * i)
    const cz = Math.round(gz1 + stepZ * i)
    if (!isPassableForSearch(cx, cz)) return false
    // Diagonal corner-cutting check
    if (i > 0) {
      const prevX = Math.round(gx1 + stepX * (i - 1))
      const prevZ = Math.round(gz1 + stepZ * (i - 1))
      if (cx !== prevX && cz !== prevZ) {
        if (!isPassableForSearch(prevX, cz) || !isPassableForSearch(cx, prevZ)) return false
      }
    }
  }
  return true
}

function findNearestWalkable(gx: number, gz: number): [number, number] | null {
  for (let r = 1; r < 20; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue
        const nx = gx + dx
        const nz = gz + dz
        if (isWalkable(nx, nz)) return [nx, nz]
      }
    }
  }
  return null
}

// Legacy export for backward compatibility (sandbox etc.)
export { findPathHierarchical as findPath }
