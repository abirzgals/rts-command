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

// Simple cooldown per entity — don't retry pathfinding more than once per second
const pathCooldown = new Float32Array(8000)

export function pathfindingSystem(world: IWorld, dt: number) {
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
    // No clearance for pathfinding — let movement system handle wall sliding
    const waypoints = findPath(sx, sz, gx, gz, isWorker, 0)
    computed++

    if (!waypoints || waypoints.length === 0) {
      pathCooldown[eid] = 1.0 // retry after 1 second
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
