import { defineQuery, enterQuery, hasComponent, addComponent, removeComponent, Not } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, MoveTarget, PathFollower, IsBuilding, MoveSpeed, CollisionRadius, Dead, WorkerC, Selectable } from '../components'
import { findPath, invalidateClearance } from '../../pathfinding/astar'
import { storePath } from '../../pathfinding/pathStore'
import { clearDynamicCosts, markBuildingObstacle } from '../../pathfinding/navGrid'

// Entities that JUST GOT a MoveTarget (enter query = only fires once)
const needsPathQuery = defineQuery([Position, MoveTarget, MoveSpeed, Not(PathFollower), Not(IsBuilding)])
const needsPathEnter = enterQuery(needsPathQuery)
// Buildings as obstacles
const buildingQuery = defineQuery([Position, IsBuilding, Selectable])

// Track building count to know when to rebuild dynamic costs
let lastBuildingCount = -1

export function pathfindingSystem(world: IWorld, _dt: number) {
  // Only rebuild dynamic costs when building count changes
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

  // Only compute paths for units that JUST received a MoveTarget
  const newEntities = needsPathEnter(world)

  for (const eid of newEntities) {
    if (hasComponent(world, Dead, eid)) continue

    const sx = Position.x[eid]
    const sz = Position.z[eid]
    const gx = MoveTarget.x[eid]
    const gz = MoveTarget.z[eid]

    const isWorker = hasComponent(world, WorkerC, eid)
    const radius = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4

    // Try with radius, fallback to zero clearance
    let waypoints = findPath(sx, sz, gx, gz, isWorker, radius)
    if (!waypoints && radius > 0) {
      waypoints = findPath(sx, sz, gx, gz, isWorker, 0)
    }

    if (!waypoints || waypoints.length === 0) {
      // No path — direct movement will handle it with wall sliding
      continue
    }

    const pathId = storePath(waypoints)
    addComponent(world, PathFollower, eid)
    PathFollower.waypointIndex[eid] = 0
    PathFollower.pathId[eid] = pathId
  }
}
