import { defineQuery, hasComponent, addComponent, removeComponent, Not } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, MoveTarget, PathFollower, IsBuilding, MoveSpeed } from '../components'
import { findPath } from '../../pathfinding/astar'
import { storePath, removePath } from '../../pathfinding/pathStore'

// Entities that need a path computed
const needsPathQuery = defineQuery([Position, MoveTarget, MoveSpeed, Not(PathFollower), Not(IsBuilding)])

const MAX_PATHS_PER_FRAME = 8

export function pathfindingSystem(world: IWorld, _dt: number) {
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

    const waypoints = findPath(sx, sz, gx, gz)
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
