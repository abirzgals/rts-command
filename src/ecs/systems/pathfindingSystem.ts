import { defineQuery, hasComponent, addComponent, removeComponent, Not } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, MoveTarget, PathFollower, IsBuilding, MoveSpeed, CollisionRadius, Dead, WorkerC, Selectable } from '../components'
import { findPath, invalidateClearance } from '../../pathfinding/astar'
import { storePath, removePath } from '../../pathfinding/pathStore'
import { clearDynamicCosts, markUnitObstacle, markBuildingObstacle } from '../../pathfinding/navGrid'

// Entities that need a path computed
const needsPathQuery = defineQuery([Position, MoveTarget, MoveSpeed, Not(PathFollower), Not(IsBuilding)])
// All units with collision (for dynamic obstacle marking)
const allUnitsQuery = defineQuery([Position, CollisionRadius, MoveSpeed])
// Buildings as obstacles
const buildingQuery = defineQuery([Position, IsBuilding, Selectable])

const MAX_PATHS_PER_FRAME = 4

export function pathfindingSystem(world: IWorld, _dt: number) {
  // Rebuild dynamic cost map — only buildings block paths.
  clearDynamicCosts()
  const buildings = buildingQuery(world)
  for (const eid of buildings) {
    if (hasComponent(world, Dead, eid)) continue
    markBuildingObstacle(Position.x[eid], Position.z[eid], Selectable.radius[eid])
  }
  invalidateClearance() // rebuild clearance maps with new building positions

  const entities = needsPathQuery(world)
  let computed = 0

  for (const eid of entities) {
    if (computed >= MAX_PATHS_PER_FRAME) break

    const sx = Position.x[eid]
    const sz = Position.z[eid]
    const gx = MoveTarget.x[eid]
    const gz = MoveTarget.z[eid]

    // Workers ignore dynamic unit costs while mining
    const isWorker = hasComponent(world, WorkerC, eid)
    const radius = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4
    const waypoints = findPath(sx, sz, gx, gz, isWorker, radius)
    computed++

    if (!waypoints || waypoints.length === 0) {
      // No path found or already at goal — leave MoveTarget for direct movement fallback
      continue
    }

    const pathId = storePath(waypoints)
    addComponent(world, PathFollower, eid)
    PathFollower.waypointIndex[eid] = 0
    PathFollower.pathId[eid] = pathId
  }
}
