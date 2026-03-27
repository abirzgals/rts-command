import { GRID_RES, worldToGrid, gridToWorld } from '../terrain/heightmap'
import { walkable, moveCost, dynamicCost, isWalkable } from './navGrid'
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
const MAX_EXPANSIONS = 12000

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
const inOpen = new Uint8Array(GRID_RES * GRID_RES)
let generation = 0

function idx(gx: number, gz: number) { return gz * GRID_RES + gx }

// Octile distance heuristic
function heuristic(ax: number, az: number, bx: number, bz: number): number {
  const dx = Math.abs(ax - bx)
  const dz = Math.abs(az - bz)
  return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)
}

// ── Main A* function ─────────────────────────────────────────
export function findPath(
  startX: number, startZ: number,
  goalX: number, goalZ: number,
  ignoreDynamic = false,
): Waypoint[] | null {
  let [sx, sz] = worldToGrid(startX, startZ)
  const [gx, gz] = worldToGrid(goalX, goalZ)

  // If start is unwalkable, find nearest walkable cell
  if (!isWalkable(sx, sz)) {
    const found = findNearestWalkable(sx, sz)
    if (!found) return null
    ;[sx, sz] = found
  }

  // If goal is unwalkable, find nearest walkable cell
  let tgx = gx, tgz = gz
  if (!isWalkable(gx, gz)) {
    const found = findNearestWalkable(gx, gz)
    if (!found) return null
    ;[tgx, tgz] = found
  }

  if (sx === tgx && sz === tgz) return []

  generation++
  const heap = new BinaryHeap(GRID_RES * GRID_RES)

  const startIdx = idx(sx, sz)
  gCost[startIdx] = 0
  fCost[startIdx] = heuristic(sx, sz, tgx, tgz)
  visited[startIdx] = generation
  inOpen[startIdx] = 1
  cameFrom[startIdx] = -1
  heap.push(startIdx, fCost[startIdx])

  let expansions = 0

  while (heap.size > 0 && expansions < MAX_EXPANSIONS) {
    const current = heap.pop()
    const cx = current % GRID_RES
    const cz = (current / GRID_RES) | 0

    inOpen[current] = 0

    if (cx === tgx && cz === tgz) {
      return reconstructPath(current, startIdx)
    }

    expansions++

    for (const [dx, dz, baseCost] of DIRS) {
      const nx = cx + dx
      const nz = cz + dz

      if (nx < 0 || nx >= GRID_RES || nz < 0 || nz >= GRID_RES) continue

      const ni = idx(nx, nz)
      if (walkable[ni] === 0) continue

      // Prevent corner cutting through diagonals
      if (dx !== 0 && dz !== 0) {
        if (!isWalkable(cx + dx, cz) || !isWalkable(cx, cz + dz)) continue
      }

      const cost = baseCost * (moveCost[ni] + (ignoreDynamic ? 0 : dynamicCost[ni]))
      const tentativeG = gCost[current] + cost

      if (visited[ni] === generation && tentativeG >= gCost[ni]) continue

      cameFrom[ni] = current
      gCost[ni] = tentativeG
      fCost[ni] = tentativeG + heuristic(nx, nz, tgx, tgz)
      visited[ni] = generation

      if (inOpen[ni] !== 1) {
        inOpen[ni] = 1
        heap.push(ni, fCost[ni])
      } else {
        heap.updateScore(ni, fCost[ni])
      }
    }
  }

  return null // No path found
}

function reconstructPath(goalIdx: number, startIdx: number): Waypoint[] {
  const gridPath: number[] = []
  let current = goalIdx
  while (current !== startIdx && current !== -1) {
    gridPath.push(current)
    current = cameFrom[current]
  }
  gridPath.reverse()

  // Convert to world coordinates and simplify
  const waypoints: Waypoint[] = []
  for (let i = 0; i < gridPath.length; i++) {
    const gx = gridPath[i] % GRID_RES
    const gz = (gridPath[i] / GRID_RES) | 0
    const [wx, wz] = gridToWorld(gx, gz)
    waypoints.push({ x: wx, z: wz })
  }

  // Path smoothing: skip waypoints that are in line-of-sight
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

  // Bresenham line
  let dx = Math.abs(gx2 - gx1)
  let dz = Math.abs(gz2 - gz1)
  let sx = gx1 < gx2 ? 1 : -1
  let sz = gz1 < gz2 ? 1 : -1
  let err = dx - dz
  let cx = gx1, cz = gz1

  while (cx !== gx2 || cz !== gz2) {
    if (!isWalkable(cx, cz)) return false
    const e2 = 2 * err
    if (e2 > -dz) { err -= dz; cx += sx }
    if (e2 < dx) { err += dx; cz += sz }
  }
  return isWalkable(gx2, gz2)
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
