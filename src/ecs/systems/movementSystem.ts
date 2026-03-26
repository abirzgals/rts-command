import { defineQuery, hasComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Rotation, MoveTarget, MoveSpeed, Velocity, IsBuilding, PathFollower } from '../components'
import { getPath, removePath } from '../../pathfinding/pathStore'
import { getTerrainHeight } from '../../terrain/heightmap'
import { spatialHash } from '../../globals'

// Entities following a path
const pathQuery = defineQuery([Position, PathFollower, MoveSpeed])
// Entities with MoveTarget but no path (direct movement fallback for projectiles etc.)
const directQuery = defineQuery([Position, MoveTarget, MoveSpeed])

const ARRIVE_THRESHOLD = 0.8

export function movementSystem(world: IWorld, dt: number) {
  // ── Path-following movement ─────────────────────────
  const pathEntities = pathQuery(world)

  for (const eid of pathEntities) {
    if (hasComponent(world, IsBuilding, eid)) continue

    const pathId = PathFollower.pathId[eid]
    const path = getPath(pathId)

    if (!path) {
      // Path was removed — clean up
      removeComponent(world, PathFollower, eid)
      if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
      Velocity.x[eid] = 0
      Velocity.z[eid] = 0
      continue
    }

    let wpIdx = PathFollower.waypointIndex[eid]

    if (wpIdx >= path.length) {
      // Arrived at destination
      finishPath(world, eid, pathId)
      continue
    }

    const wp = path[wpIdx]
    const px = Position.x[eid]
    const pz = Position.z[eid]
    const dx = wp.x - px
    const dz = wp.z - pz
    const dist = Math.sqrt(dx * dx + dz * dz)

    if (dist < ARRIVE_THRESHOLD) {
      // Move to next waypoint
      wpIdx++
      PathFollower.waypointIndex[eid] = wpIdx

      if (wpIdx >= path.length) {
        finishPath(world, eid, pathId)
        continue
      }
      // Continue to next waypoint in same frame
      continue
    }

    const speed = MoveSpeed.value[eid]
    const nx = dx / dist
    const nz = dz / dist

    const step = speed * dt
    if (step >= dist) {
      Position.x[eid] = wp.x
      Position.z[eid] = wp.z
    } else {
      Position.x[eid] += nx * step
      Position.z[eid] += nz * step
    }

    Velocity.x[eid] = nx * speed
    Velocity.z[eid] = nz * speed
    Rotation.y[eid] = Math.atan2(nx, nz)

    // Terrain height
    Position.y[eid] = getTerrainHeight(Position.x[eid], Position.z[eid]) + 0.5

    spatialHash.update(eid, Position.x[eid], Position.z[eid])
  }

  // ── Direct movement (entities with MoveTarget but no PathFollower) ──
  const directEntities = directQuery(world)

  for (const eid of directEntities) {
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, PathFollower, eid)) continue // handled above

    const tx = MoveTarget.x[eid]
    const tz = MoveTarget.z[eid]
    const px = Position.x[eid]
    const pz = Position.z[eid]
    const dx = tx - px
    const dz = tz - pz
    const dist = Math.sqrt(dx * dx + dz * dz)

    if (dist < ARRIVE_THRESHOLD) {
      removeComponent(world, MoveTarget, eid)
      Velocity.x[eid] = 0
      Velocity.z[eid] = 0
      continue
    }

    const speed = MoveSpeed.value[eid]
    const nx = dx / dist
    const nz = dz / dist
    const step = speed * dt

    if (step >= dist) {
      Position.x[eid] = tx
      Position.z[eid] = tz
      removeComponent(world, MoveTarget, eid)
      Velocity.x[eid] = 0
      Velocity.z[eid] = 0
    } else {
      Position.x[eid] += nx * step
      Position.z[eid] += nz * step
      Velocity.x[eid] = nx * speed
      Velocity.z[eid] = nz * speed
      Rotation.y[eid] = Math.atan2(nx, nz)
    }

    Position.y[eid] = getTerrainHeight(Position.x[eid], Position.z[eid]) + 0.5
    spatialHash.update(eid, Position.x[eid], Position.z[eid])
  }
}

function finishPath(world: IWorld, eid: number, pathId: number) {
  removePath(pathId)
  removeComponent(world, PathFollower, eid)
  if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
  Velocity.x[eid] = 0
  Velocity.z[eid] = 0
}
