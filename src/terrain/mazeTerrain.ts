/**
 * Maze terrain generator for pathfinding testing.
 * Overwrites heightData/terrainType with a maze pattern.
 * Walls = water (height -1), corridors = flat grass (height 3).
 * Varying corridor widths test tank clearance.
 */

import {
  GRID_RES, heightData, terrainType,
  T_GRASS, T_WATER, CELL_SIZE,
  gridToWorld,
} from './heightmap'

const H = GRID_RES // 200
const BASE_H = 3.0
const WALL_H = 3.0 // same height to avoid false slopes

/**
 * Generate a maze terrain.
 * The maze has corridors of varying widths (2, 3, 4, 6 cells).
 * Tanks (clearance 2) can only pass through 3+ cell corridors.
 */
export function generateMazeTerrain() {
  // Start: fill everything with grass
  for (let i = 0; i < H * H; i++) {
    heightData[i] = BASE_H
    terrainType[i] = T_GRASS
  }

  // Helper: fill rect with wall
  function wall(x1: number, z1: number, x2: number, z2: number) {
    for (let z = z1; z <= z2; z++) {
      for (let x = x1; x <= x2; x++) {
        if (x >= 0 && x < H && z >= 0 && z < H) {
          const i = z * H + x
          heightData[i] = WALL_H
          terrainType[i] = T_WATER
        }
      }
    }
  }

  // Helper: carve corridor (set to grass) within a wall
  function corridor(x1: number, z1: number, x2: number, z2: number) {
    for (let z = z1; z <= z2; z++) {
      for (let x = x1; x <= x2; x++) {
        if (x >= 0 && x < H && z >= 0 && z < H) {
          const i = z * H + x
          heightData[i] = BASE_H
          terrainType[i] = T_GRASS
        }
      }
    }
  }

  // ── Build the maze ─────────────────────────────────────────
  // Map area: center 120x120 (grid cells 40..159)
  const L = 40   // left edge
  const R = 159  // right edge
  const T = 40   // top edge
  const B = 159  // bottom edge
  const CX = 100 // center x
  const CZ = 100 // center z

  // Outer walls (border of play area)
  wall(L, T, R, T + 2)       // top wall
  wall(L, B - 2, R, B)       // bottom wall
  wall(L, T, L + 2, B)       // left wall
  wall(R - 2, T, R, B)       // right wall

  // ── Horizontal walls with gaps of varying widths ───────────

  // Wall 1 (z=60): gap=6 cells at center (tank-friendly)
  wall(L + 3, 58, R - 3, 60)
  corridor(CX - 3, 58, CX + 2, 60) // 6-cell gap

  // Wall 2 (z=78): gap=4 cells on left side
  wall(L + 3, 76, R - 3, 78)
  corridor(L + 15, 76, L + 18, 78) // 4-cell gap left
  corridor(R - 25, 76, R - 22, 78) // 4-cell gap right

  // Wall 3 (z=95): gap=3 cells (borderline for tank)
  wall(L + 3, 93, R - 3, 95)
  corridor(CX + 10, 93, CX + 12, 95) // 3-cell gap right of center

  // Wall 4 (z=112): gap=2 cells (marine only!)
  wall(L + 3, 110, R - 3, 112)
  corridor(CX - 1, 110, CX, 112)     // 2-cell gap center (tank CAN'T pass)
  corridor(R - 12, 110, R - 10, 112)  // 3-cell gap on right (tank CAN pass)

  // Wall 5 (z=130): mix of gaps
  wall(L + 3, 128, R - 3, 130)
  corridor(L + 10, 128, L + 11, 130)  // 2-cell gap (marine only)
  corridor(CX - 2, 128, CX + 2, 130) // 5-cell gap (tank OK)
  corridor(R - 15, 128, R - 13, 130)  // 3-cell gap (tank borderline)

  // ── Vertical walls creating channels ───────────────────────

  // Vertical wall on left (x=70), from z=60 to z=95
  wall(68, 61, 70, 92)
  corridor(68, 72, 70, 75) // 4-cell gap in vertical wall

  // Vertical wall on right (x=130), from z=78 to z=130
  wall(128, 79, 130, 127)
  corridor(128, 100, 130, 102) // 3-cell gap

  // ── Some obstacle blocks (islands) ─────────────────────────
  wall(80, 65, 88, 70)   // block in upper area
  wall(115, 82, 122, 87) // block in middle-right
  wall(50, 100, 56, 106) // block in lower-left
  wall(105, 115, 112, 120) // block in lower-middle
}

/** Predefined spawn positions for maze testing */
export interface MazeSpawn {
  x: number  // world coords
  z: number
  type: 'tank' | 'marine' | 'worker'
  faction: number // 0=player, 1=enemy
}

export function getMazeSpawns(): MazeSpawn[] {
  // Convert grid → world coords
  const gw = (gx: number, gz: number): [number, number] => gridToWorld(gx, gz)

  const spawns: MazeSpawn[] = []

  // Player units (top area, above first wall)
  const [px1, pz1] = gw(80, 48)
  const [px2, pz2] = gw(85, 48)
  const [px3, pz3] = gw(90, 48)
  const [px4, pz4] = gw(95, 48)
  const [px5, pz5] = gw(100, 50)
  const [px6, pz6] = gw(105, 50)

  spawns.push({ x: px1, z: pz1, type: 'tank', faction: 0 })
  spawns.push({ x: px2, z: pz2, type: 'tank', faction: 0 })
  spawns.push({ x: px3, z: pz3, type: 'marine', faction: 0 })
  spawns.push({ x: px4, z: pz4, type: 'marine', faction: 0 })
  spawns.push({ x: px5, z: pz5, type: 'marine', faction: 0 })
  spawns.push({ x: px6, z: pz6, type: 'marine', faction: 0 })

  // Enemy units (bottom area, below last wall)
  const [ex1, ez1] = gw(80, 145)
  const [ex2, ez2] = gw(90, 145)
  const [ex3, ez3] = gw(100, 140)
  const [ex4, ez4] = gw(110, 140)

  spawns.push({ x: ex1, z: ez1, type: 'tank', faction: 1 })
  spawns.push({ x: ex2, z: ez2, type: 'marine', faction: 1 })
  spawns.push({ x: ex3, z: ez3, type: 'marine', faction: 1 })
  spawns.push({ x: ex4, z: ez4, type: 'marine', faction: 1 })

  return spawns
}

/** Target position at the bottom of the maze (for player units to navigate to) */
export function getMazeGoal(): [number, number] {
  return gridToWorld(100, 148) // bottom center of maze
}
