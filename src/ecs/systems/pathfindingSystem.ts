import { defineQuery, hasComponent, addComponent, removeComponent, Not } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, MoveTarget, PathFollower, IsBuilding, MoveSpeed, CollisionRadius, Dead, WorkerC, Selectable, MaxSlope } from '../components'
import { findPathHierarchical } from '../../pathfinding/astar'
import { storePath } from '../../pathfinding/pathStore'
import { clearDynamicCosts, markBuildingObstacle, rebuildClearance } from '../../pathfinding/navGrid'
import { buildSectorGraph } from '../../pathfinding/sectorGraph'

const needsPathQuery = defineQuery([Position, MoveTarget, MoveSpeed, Not(PathFollower), Not(IsBuilding)])
const buildingQuery = defineQuery([Position, IsBuilding, Selectable])

const MAX_PATHS_PER_FRAME = 4
let lastBuildingCount = -1

// Simple cooldown per entity — don't retry pathfinding more than once per second
const pathCooldown = new Float32Array(8000)

export function pathfindingSystem(world: IWorld, dt: number) {
  // Rebuild dynamic costs + sector graph when building count changes
  const buildings = buildingQuery(world)
  if (buildings.length !== lastBuildingCount) {
    lastBuildingCount = buildings.length
    clearDynamicCosts()
    for (const eid of buildings) {
      if (hasComponent(world, Dead, eid)) continue
      markBuildingObstacle(Position.x[eid], Position.z[eid], Selectable.radius[eid])
    }
    // Rebuild clearance map (distance transform) and sector connectivity
    rebuildClearance()
    buildSectorGraph()
  }

  const entities = needsPathQuery(world)
  let computed = 0

  for (const eid of entities) {
    if (computed >= MAX_PATHS_PER_FRAME) break
    if (hasComponent(world, Dead, eid)) continue

    // Cooldown — don't retry failed paths every frame
    if (pathCooldown[eid] > 0) { pathCooldown[eid] -= dt; continue }

    const sx = Position.x[eid]
    const sz = Position.z[eid]
    const gx = MoveTarget.x[eid]
    const gz = MoveTarget.z[eid]

    // Very short distance — skip pathfinding, direct movement handles it
    const ddx = gx - sx, ddz = gz - sz
    if (ddx * ddx + ddz * ddz < 4) continue

    const isWorker = hasComponent(world, WorkerC, eid)
    const unitRadius = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4
    const maxSlope = hasComponent(world, MaxSlope, eid) ? MaxSlope.value[eid] : 100.0

    // Hierarchical A* with unit-specific clearance and slope
    let waypoints = findPathHierarchical(sx, sz, gx, gz, unitRadius, maxSlope, isWorker)
    computed++

    // Fallback: if path fails with clearance, try without (unit will squeeze through)
    if ((!waypoints || waypoints.length === 0) && unitRadius > 0.5) {
      waypoints = findPathHierarchical(sx, sz, gx, gz, 0, maxSlope, isWorker)
    }
    // Fallback 2: try without slope restriction
    if ((!waypoints || waypoints.length === 0) && maxSlope < 50) {
      waypoints = findPathHierarchical(sx, sz, gx, gz, 0, 100, isWorker)
    }

    if (!waypoints || waypoints.length === 0) {
      pathCooldown[eid] = 2.0 // retry after 2 seconds
      continue
    }

    pathCooldown[eid] = 0
    const pathId = storePath(waypoints)
    addComponent(world, PathFollower, eid)
    PathFollower.waypointIndex[eid] = 0
    PathFollower.pathId[eid] = pathId
  }
}

/** Reset pathfinding cooldown for an entity */
export function resetPathAttempt(eid: number) {
  pathCooldown[eid] = 0
}
