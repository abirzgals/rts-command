import { defineQuery, hasComponent, addComponent, removeComponent, Not } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, MoveTarget, PathFollower, IsBuilding, MoveSpeed, CollisionRadius, Dead, WorkerC, Selectable } from '../components'
import { findPath } from '../../pathfinding/astar'
import { storePath, removePath } from '../../pathfinding/pathStore'
import { clearDynamicCosts, markUnitObstacle, markBuildingObstacle } from '../../pathfinding/navGrid'

// Entities that need a path computed
const needsPathQuery = defineQuery([Position, MoveTarget, MoveSpeed, Not(PathFollower), Not(IsBuilding)])
// All units with collision (for dynamic obstacle marking)
const allUnitsQuery = defineQuery([Position, CollisionRadius, MoveSpeed])
// Buildings as obstacles
const buildingQuery = defineQuery([Position, IsBuilding, Selectable])

const MAX_PATHS_PER_FRAME = 8

export function pathfindingSystem(world: IWorld, _dt: number) {
  // Rebuild dynamic cost map from unit + building positions
  clearDynamicCosts()
  const allUnits = allUnitsQuery(world)
  for (const eid of allUnits) {
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, WorkerC, eid)) continue // workers don't block paths
    markUnitObstacle(Position.x[eid], Position.z[eid], CollisionRadius.value[eid])
  }
  // Buildings as hard obstacles in dynamic cost
  const buildings = buildingQuery(world)
  for (const eid of buildings) {
    if (hasComponent(world, Dead, eid)) continue
    markBuildingObstacle(Position.x[eid], Position.z[eid], Selectable.radius[eid])
  }

  const entities = needsPathQuery(world)
  let computed = 0

  for (const eid of entities) {
    if (computed >= MAX_PATHS_PER_FRAME) break

    const sx = Position.x[eid]
    const sz = Position.z[eid]
    const gx = MoveTarget.x[eid]
    const gz = MoveTarget.z[eid]

    // Skip very short distances — let direct movement handle them
    const dx = gx - sx
    const dz = gz - sz
    if (dx * dx + dz * dz < 4) continue // less than 2 units — direct movement is fine

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
