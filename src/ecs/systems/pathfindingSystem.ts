import { defineQuery, hasComponent, addComponent, removeComponent, Not } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, MoveTarget, PathFollower, IsBuilding, MoveSpeed, CollisionRadius, Dead, WorkerC, Selectable } from '../components'
import { findPath, invalidateClearance } from '../../pathfinding/astar'
import { storePath } from '../../pathfinding/pathStore'
import { clearDynamicCosts, markBuildingObstacle } from '../../pathfinding/navGrid'

const needsPathQuery = defineQuery([Position, MoveTarget, MoveSpeed, Not(PathFollower), Not(IsBuilding)])
const buildingQuery = defineQuery([Position, IsBuilding, Selectable])

const MAX_PATHS_PER_FRAME = 4
let lastBuildingCount = -1

// Track last target per entity to avoid recomputing same path
const lastTargetX = new Float32Array(8000)
const lastTargetZ = new Float32Array(8000)
const pathAttempted = new Uint8Array(8000) // 1 = already tried for current target

export function pathfindingSystem(world: IWorld, _dt: number) {
  // Rebuild dynamic costs when building count changes
  const buildings = buildingQuery(world)
  if (buildings.length !== lastBuildingCount) {
    lastBuildingCount = buildings.length
    clearDynamicCosts()
    for (const eid of buildings) {
      if (hasComponent(world, Dead, eid)) continue
      markBuildingObstacle(Position.x[eid], Position.z[eid], Selectable.radius[eid])
    }
    invalidateClearance()
  }

  const entities = needsPathQuery(world)
  let computed = 0

  for (const eid of entities) {
    if (computed >= MAX_PATHS_PER_FRAME) break
    if (hasComponent(world, Dead, eid)) continue

    const gx = MoveTarget.x[eid]
    const gz = MoveTarget.z[eid]

    // Skip if we already tried pathfinding for this exact target
    if (pathAttempted[eid] === 1 &&
        Math.abs(lastTargetX[eid] - gx) < 0.5 &&
        Math.abs(lastTargetZ[eid] - gz) < 0.5) {
      continue
    }

    // Mark this target as attempted
    lastTargetX[eid] = gx
    lastTargetZ[eid] = gz
    pathAttempted[eid] = 1

    const sx = Position.x[eid]
    const sz = Position.z[eid]
    const isWorker = hasComponent(world, WorkerC, eid)
    const radius = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4

    let waypoints = findPath(sx, sz, gx, gz, isWorker, radius)
    if (!waypoints && radius > 0) {
      waypoints = findPath(sx, sz, gx, gz, isWorker, 0)
    }
    computed++

    if (!waypoints || waypoints.length === 0) continue

    const pathId = storePath(waypoints)
    addComponent(world, PathFollower, eid)
    PathFollower.waypointIndex[eid] = 0
    PathFollower.pathId[eid] = pathId
  }
}

/** Reset path attempt tracking for an entity (call when target changes) */
export function resetPathAttempt(eid: number) {
  pathAttempted[eid] = 0
}
