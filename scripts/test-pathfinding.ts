/**
 * Pathfinding integration test.
 *
 * Creates a small known map with obstacles, runs pathfinding,
 * simulates movement ticks, and verifies everything works.
 *
 * Run:  npx tsx scripts/test-pathfinding.ts
 */

import {
  GRID_RES, heightData, terrainType, CELL_SIZE,
  T_GRASS, T_WATER, T_CLIFF,
  worldToGrid, gridToWorld,
} from '../src/terrain/heightmap'

import {
  walkable, moveCost, initNavGrid,
  blockCells, slopeData, getClearanceAt, rebuildClearance, clearDynamicCosts, dynamicCost,
} from '../src/pathfinding/navGrid'

import { buildSectorGraph } from '../src/pathfinding/sectorGraph'
import { findPathHierarchical } from '../src/pathfinding/astar'
import type { Waypoint } from '../src/pathfinding/pathStore'

// ═══════════════════════════════════════════════════════════════
// Test map definitions
// ═══════════════════════════════════════════════════════════════

/**
 * Test map: a 40×40 area in the center of the 200×200 grid.
 * Legend:  . = grass (flat)   # = wall (unwalkable)   ~ = water   ^ = steep slope
 */
interface TestMap {
  name: string
  width: number
  height: number
  // Each char: '.' grass, '#' wall, '~' water, '^' steep
  grid: string[]
}

const TEST_MAPS: TestMap[] = [
  {
    name: 'Wall with gap',
    width: 20, height: 20,
    grid: [
      // 0         1
      // 0123456789012345678 9
      '....................',  // 0
      '....................',  // 1
      '....................',  // 2
      '....................',  // 3
      '....................',  // 4
      '....................',  // 5
      '....................',  // 6
      '....................',  // 7
      '....................',  // 8
      '########....########',  // 9  wall with 4-cell gap in middle
      '########....########',  // 10
      '....................',  // 11
      '....................',  // 12
      '....................',  // 13
      '....................',  // 14
      '....................',  // 15
      '....................',  // 16
      '....................',  // 17
      '....................',  // 18
      '....................',  // 19
    ],
  },
  {
    name: 'U-shape obstacle (open top)',
    width: 20, height: 20,
    grid: [
      '....................',
      '....................',
      '....................',
      '....................',
      '....#..........#....',  // open top — unit can exit upward
      '....#..........#....',
      '....#..........#....',
      '....#..........#....',
      '....#..........#....',
      '....#..........#....',
      '....#..........#....',
      '....#..........#....',
      '....#..........#....',
      '....############....',  // closed bottom
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
    ],
  },
  {
    name: 'Narrow corridor (2 cells wide)',
    width: 20, height: 20,
    grid: [
      '....................',
      '....................',
      '....................',
      '....................',
      '########..##########',  // 2-cell gap at x=8,9
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
    ],
  },
  {
    name: 'Steep slope zone',
    width: 20, height: 20,
    grid: [
      '....................',
      '....................',
      '....................',
      '....................',
      '........^^^^........',  // steep slope band
      '........^^^^........',
      '........^^^^........',
      '........^^^^........',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
      '....................',
    ],
  },
  {
    // Tight maze — corridors of varying width (2, 3, 4 cells)
    // Tank (r=1.2, clearance=2) needs ~3+ cells to pass
    // Marine (r=0.4, clearance=0) passes everywhere
    // S = start area, G = goal area
    name: 'Tight maze',
    width: 30, height: 20,
    grid: [
      //0         1         2
      //0123456789012345678901234567890
      '..............................',  // 0  S area
      '..............................',  // 1
      '####..########################',  // 2  2-cell gap at x=4,5
      '..............................',  // 3
      '..............................',  // 4
      '########################..####',  // 5  2-cell gap at x=24,25
      '..............................',  // 6
      '..............................',  // 7
      '####....######################',  // 8  4-cell gap at x=4,5,6,7
      '..............................',  // 9
      '..............................',  // 10
      '##################....########',  // 11 4-cell gap at x=18,19,20,21
      '..............................',  // 12
      '..............................',  // 13
      '######...#####################',  // 14 3-cell gap at x=6,7,8
      '..............................',  // 15
      '..............................',  // 16
      '#################...##########',  // 17 3-cell gap at x=17,18,19
      '..............................',  // 18
      '..............................',  // 19  G area
    ],
  },
]

// ═══════════════════════════════════════════════════════════════
// Map loader — writes test map into the global heightData/terrainType
// ═══════════════════════════════════════════════════════════════

/** Fill the entire 200x200 grid with flat grass, then overlay the test map in the center */
function loadTestMap(map: TestMap) {
  // 1. Fill everything with flat grass at height 3.0
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    heightData[i] = 3.0
    terrainType[i] = T_GRASS
  }

  // 2. Overlay the test map in the center of the grid
  const offsetX = Math.floor((GRID_RES - map.width) / 2)   // 90
  const offsetZ = Math.floor((GRID_RES - map.height) / 2)  // 90

  for (let z = 0; z < map.height; z++) {
    const row = map.grid[z]
    for (let x = 0; x < map.width; x++) {
      const ch = row[x]
      const gx = offsetX + x
      const gz = offsetZ + z
      const i = gz * GRID_RES + gx

      switch (ch) {
        case '.': // flat grass
          heightData[i] = 3.0
          terrainType[i] = T_GRASS
          break
        case '#': // wall — SAME height as grass to avoid false slope at edges
          heightData[i] = 3.0
          terrainType[i] = T_WATER // T_WATER → walkable=0 in initNavGrid
          break
        case '~': // water (lower)
          heightData[i] = -2.0
          terrainType[i] = T_WATER
          break
        case '^': // steep slope
          heightData[i] = 10.0 // much higher than neighbors → big slope
          terrainType[i] = T_GRASS // walkable terrain type, but steep
          break
      }
    }
  }

  // 3. Build nav grid + sector graph from this terrain
  clearDynamicCosts()
  initNavGrid()
  buildSectorGraph()
}

/** Convert map-local coords (0..width, 0..height) to world coords */
function mapToWorld(map: TestMap, mx: number, mz: number): [number, number] {
  const offsetX = Math.floor((GRID_RES - map.width) / 2)
  const offsetZ = Math.floor((GRID_RES - map.height) / 2)
  return gridToWorld(offsetX + mx, offsetZ + mz)
}

// ═══════════════════════════════════════════════════════════════
// Test runner
// ═══════════════════════════════════════════════════════════════

interface PathTest {
  name: string
  startMapX: number; startMapZ: number
  goalMapX: number; goalMapZ: number
  unitRadius: number
  maxSlope: number
  expectPath: boolean  // do we expect a path to be found?
  expectMinWaypoints?: number
}

function printMapWithPath(map: TestMap, path: Waypoint[] | null) {
  const offsetX = Math.floor((GRID_RES - map.width) / 2)
  const offsetZ = Math.floor((GRID_RES - map.height) / 2)

  // Build a set of grid cells on the path
  const pathCells = new Set<string>()
  if (path) {
    for (const wp of path) {
      const [gx, gz] = worldToGrid(wp.x, wp.z)
      const mx = gx - offsetX
      const mz = gz - offsetZ
      pathCells.add(`${mx},${mz}`)
    }
  }

  const lines: string[] = []
  for (let z = 0; z < map.height; z++) {
    let line = ''
    for (let x = 0; x < map.width; x++) {
      if (pathCells.has(`${x},${z}`)) {
        line += '\x1b[32m*\x1b[0m' // green star for path
      } else {
        const ch = map.grid[z][x]
        if (ch === '#' || ch === '~') line += '\x1b[31m' + ch + '\x1b[0m' // red
        else if (ch === '^') line += '\x1b[33m' + ch + '\x1b[0m' // yellow
        else line += ch
      }
    }
    lines.push('  ' + line)
  }
  console.log(lines.join('\n'))
}

function simulateMovement(
  path: Waypoint[],
  speed: number,
  turnRate: number,
  accel: number,
): { totalTime: number; totalDist: number; ticks: number } {
  if (path.length === 0) return { totalTime: 0, totalDist: 0, ticks: 0 }

  const DT = 1 / 30 // 30 Hz sim like Spring
  let px = path[0].x
  let pz = path[0].z
  let wpIdx = 1
  let curSpeed = 0
  let yaw = 0
  let totalTime = 0
  let totalDist = 0
  let ticks = 0
  const MAX_TICKS = 10000 // safety limit

  while (wpIdx < path.length && ticks < MAX_TICKS) {
    const wp = path[wpIdx]
    const dx = wp.x - px
    const dz = wp.z - pz
    const dist = Math.sqrt(dx * dx + dz * dz)

    if (dist < 0.8) {
      wpIdx++
      continue
    }

    // Desired direction
    const desiredX = dx / dist
    const desiredZ = dz / dist
    const desiredYaw = Math.atan2(desiredX, desiredZ)

    // Turn
    let delta = desiredYaw - yaw
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    const maxTurn = turnRate * DT
    yaw += Math.max(-maxTurn, Math.min(maxTurn, delta))

    const facingX = Math.sin(yaw)
    const facingZ = Math.cos(yaw)
    const dot = Math.max(0, facingX * desiredX + facingZ * desiredZ)

    // Accelerate
    const targetSpeed = speed * dot
    if (targetSpeed > curSpeed) curSpeed = Math.min(targetSpeed, curSpeed + accel * DT)
    else curSpeed = Math.max(targetSpeed, curSpeed - accel * 2 * DT)

    // Move
    const step = curSpeed * DT
    const moveX = facingX * step
    const moveZ = facingZ * step
    px += moveX
    pz += moveZ
    totalDist += step
    totalTime += DT
    ticks++
  }

  return { totalTime, totalDist, ticks }
}

// ═══════════════════════════════════════════════════════════════
// Run tests
// ═══════════════════════════════════════════════════════════════

let passed = 0
let failed = 0

function runTest(map: TestMap, test: PathTest) {
  const label = `[${map.name}] ${test.name}`
  const [sx, sz] = mapToWorld(map, test.startMapX, test.startMapZ)
  const [gx, gz] = mapToWorld(map, test.goalMapX, test.goalMapZ)

  const t0 = performance.now()
  const path = findPathHierarchical(sx, sz, gx, gz, test.unitRadius, test.maxSlope)
  const pathTime = performance.now() - t0

  const found = path !== null && path.length > 0
  const ok = found === test.expectPath

  if (ok) {
    passed++
    console.log(`\x1b[32m✓ PASS\x1b[0m ${label}`)
  } else {
    failed++
    console.log(`\x1b[31m✗ FAIL\x1b[0m ${label}`)
    console.log(`  Expected path: ${test.expectPath}, Got: ${found}`)
  }

  console.log(`  Path: ${path ? path.length + ' waypoints' : 'null'} (${pathTime.toFixed(2)}ms)`)

  if (path && path.length > 0) {
    // Print waypoints
    const wpStr = path.map(w => `(${w.x.toFixed(1)}, ${w.z.toFixed(1)})`).join(' → ')
    console.log(`  Route: ${wpStr}`)

    // Show map with path
    printMapWithPath(map, path)

    // Simulate movement
    const speed = test.unitRadius > 0.8 ? 2.0 : 3.0 // tank vs infantry speed
    const turnRate = test.unitRadius > 0.8 ? 1.5 : 5.0
    const acceleration = test.unitRadius > 0.8 ? 3.0 : 7.0
    const sim = simulateMovement(path, speed, turnRate, acceleration)
    console.log(`  Movement sim: ${sim.totalTime.toFixed(2)}s, ${sim.totalDist.toFixed(1)} units, ${sim.ticks} ticks @ 30Hz`)

    if (test.expectMinWaypoints && path.length < test.expectMinWaypoints) {
      console.log(`  \x1b[33m⚠ Path has fewer waypoints than expected (${path.length} < ${test.expectMinWaypoints})\x1b[0m`)
    }
  } else if (!test.expectPath) {
    printMapWithPath(map, null)
  }

  console.log()
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════')
console.log('  Supreme Commander Pathfinding — Integration Test')
console.log('═══════════════════════════════════════════════════')
console.log(`  Grid: ${GRID_RES}×${GRID_RES}, Cell: ${CELL_SIZE}m`)
console.log()

// ── Test 1: Wall with gap ────────────────────────────────────
const map1 = TEST_MAPS[0]
loadTestMap(map1)

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`  Map: "${map1.name}"`)
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
printMapWithPath(map1, null)
console.log()

runTest(map1, {
  name: 'Marine through gap (top→bottom)',
  startMapX: 10, startMapZ: 2,
  goalMapX: 10, goalMapZ: 17,
  unitRadius: 0.4, maxSlope: 2.5,
  expectPath: true,
})

runTest(map1, {
  name: 'Marine blocked side (top→bottom, no gap)',
  startMapX: 3, startMapZ: 2,
  goalMapX: 3, goalMapZ: 17,
  unitRadius: 0.4, maxSlope: 2.5,
  expectPath: true, // should route through the gap
  expectMinWaypoints: 3, // needs to detour
})

runTest(map1, {
  name: 'Tank through gap (wider unit)',
  startMapX: 10, startMapZ: 2,
  goalMapX: 10, goalMapZ: 17,
  unitRadius: 1.2, maxSlope: 1.5,
  expectPath: true,
})

// ── Test 2: U-shape ──────────────────────────────────────────
const map2 = TEST_MAPS[1]
loadTestMap(map2)

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`  Map: "${map2.name}"`)
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
printMapWithPath(map2, null)
console.log()

runTest(map2, {
  name: 'Marine outside U (left→right, must go around)',
  startMapX: 2, startMapZ: 8,
  goalMapX: 17, goalMapZ: 8,
  unitRadius: 0.4, maxSlope: 2.5,
  expectPath: true,
  expectMinWaypoints: 3, // must detour around U
})

runTest(map2, {
  name: 'Marine inside U → outside (must exit through open side)',
  startMapX: 8, startMapZ: 8,
  goalMapX: 2, goalMapZ: 8,
  unitRadius: 0.4, maxSlope: 2.5,
  expectPath: true,
})

// ── Test 3: Narrow corridor ──────────────────────────────────
const map3 = TEST_MAPS[2]
loadTestMap(map3)

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`  Map: "${map3.name}"`)
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
printMapWithPath(map3, null)
console.log()

runTest(map3, {
  name: 'Marine through 2-cell corridor (radius 0.4 — fits)',
  startMapX: 9, startMapZ: 2,
  goalMapX: 9, goalMapZ: 8,
  unitRadius: 0.4, maxSlope: 2.5,
  expectPath: true,
})

runTest(map3, {
  name: 'Tank avoids 2-cell corridor (radius 1.2 — routes around)',
  startMapX: 9, startMapZ: 2,
  goalMapX: 9, goalMapZ: 8,
  unitRadius: 1.2, maxSlope: 1.5,
  expectPath: true, // tank routes AROUND the wall (can't fit through gap)
  expectMinWaypoints: 3, // needs detour
})

// ── Test 4: Steep slope ──────────────────────────────────────
const map4 = TEST_MAPS[3]
loadTestMap(map4)

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`  Map: "${map4.name}"`)
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
printMapWithPath(map4, null)
console.log()

// Check slope values at the steep zone
const [steepGX, steepGZ] = worldToGrid(...mapToWorld(map4, 10, 5))
console.log(`  Slope at steep zone (10,5): ${slopeData[steepGZ * GRID_RES + steepGX].toFixed(2)}`)
console.log(`  Clearance at steep zone: ${getClearanceAt(steepGX, steepGZ)}`)
console.log()

runTest(map4, {
  name: 'Marine through steep slope (maxSlope=2.5, actual~7.0 — blocks)',
  startMapX: 10, startMapZ: 2,
  goalMapX: 10, goalMapZ: 10,
  unitRadius: 0.4, maxSlope: 2.5,
  expectPath: true, // should route AROUND the steep zone
  expectMinWaypoints: 3,
})

runTest(map4, {
  name: 'Unit with high maxSlope (100) — goes straight through',
  startMapX: 10, startMapZ: 2,
  goalMapX: 10, goalMapZ: 10,
  unitRadius: 0.4, maxSlope: 100,
  expectPath: true,
})

// ── Test 5: Tight maze ───────────────────────────────────────
const map5 = TEST_MAPS[4]
loadTestMap(map5)

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log(`  Map: "${map5.name}"`)
console.log('  Corridors: 2-cell (rows 2,5), 3-cell (rows 14,17), 4-cell (rows 8,11)')
console.log('  Tank r=1.2 → clearance=2 cells. Needs 3+ wide corridor.')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
printMapWithPath(map5, null)
console.log()

runTest(map5, {
  name: 'Marine top→bottom through ALL corridors',
  startMapX: 5, startMapZ: 0,
  goalMapX: 18, goalMapZ: 19,
  unitRadius: 0.4, maxSlope: 2.5,
  expectPath: true,
})

runTest(map5, {
  name: 'Tank top→bottom (must avoid 2-cell gaps, use 3+ cell gaps)',
  startMapX: 5, startMapZ: 0,
  goalMapX: 18, goalMapZ: 19,
  unitRadius: 1.2, maxSlope: 1.5,
  expectPath: true,
  expectMinWaypoints: 3,
})

// Tank through specific corridor widths
runTest(map5, {
  name: 'Tank through 4-cell gap (row 8, x=4-7) — should fit',
  startMapX: 5, startMapZ: 7,
  goalMapX: 5, goalMapZ: 9,
  unitRadius: 1.2, maxSlope: 1.5,
  expectPath: true,
})

runTest(map5, {
  name: 'Tank through 3-cell gap (row 14, x=6-8) — borderline',
  startMapX: 7, startMapZ: 13,
  goalMapX: 7, goalMapZ: 15,
  unitRadius: 1.2, maxSlope: 1.5,
  expectPath: true,
})

runTest(map5, {
  name: 'Tank full maze traversal (top row 0 → bottom row 19)',
  startMapX: 15, startMapZ: 0,
  goalMapX: 20, goalMapZ: 19,
  unitRadius: 1.2, maxSlope: 1.5,
  expectPath: true,
  expectMinWaypoints: 3,
})

// ── Performance benchmark ────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('  Performance Benchmark')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

loadTestMap(map1)

const BENCH_RUNS = 100
const [bsx, bsz] = mapToWorld(map1, 2, 2)
const [bgx, bgz] = mapToWorld(map1, 17, 17)

const t0 = performance.now()
for (let i = 0; i < BENCH_RUNS; i++) {
  findPathHierarchical(bsx, bsz, bgx, bgz, 0.4, 2.5)
}
const totalMs = performance.now() - t0
console.log(`  ${BENCH_RUNS} paths: ${totalMs.toFixed(1)}ms total, ${(totalMs / BENCH_RUNS).toFixed(3)}ms/path`)
console.log()

// ── Test 6: Straight line (no obstacles) ─────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
console.log('  Straight line (flat terrain, no obstacles)')
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

// Clear terrain — all flat grass
for (let i = 0; i < GRID_RES * GRID_RES; i++) {
  heightData[i] = 3.0
  terrainType[i] = T_GRASS
}
initNavGrid()
buildSectorGraph()

const [slx, slz] = gridToWorld(10, 100)
const [elx, elz] = gridToWorld(190, 100)
const straightPath = findPathHierarchical(slx, slz, elx, elz, 0.4, 2.5)
if (straightPath) {
  console.log(`  Path found: ${straightPath.length} waypoints across 180 cells`)
  const firstWp = straightPath[0]
  const lastWp = straightPath[straightPath.length - 1]
  console.log(`  Start: (${firstWp.x.toFixed(1)}, ${firstWp.z.toFixed(1)})`)
  console.log(`  End:   (${lastWp.x.toFixed(1)}, ${lastWp.z.toFixed(1)})`)

  // On flat terrain with no obstacles, path should be smoothed to ~1-2 waypoints
  if (straightPath.length <= 3) {
    passed++
    console.log(`  \x1b[32m✓ PASS\x1b[0m Path properly smoothed (${straightPath.length} waypoints)`)
  } else {
    failed++
    console.log(`  \x1b[31m✗ FAIL\x1b[0m Path should be smoothed to ≤3 waypoints, got ${straightPath.length}`)
  }
} else {
  failed++
  console.log(`  \x1b[31m✗ FAIL\x1b[0m No path found on flat terrain!`)
}
console.log()

// ── Summary ──────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════')
console.log(`  Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`)
console.log('═══════════════════════════════════════════════════')

process.exit(failed > 0 ? 1 : 0)
