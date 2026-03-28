import { defineQuery, hasComponent, removeComponent, addComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Rotation, MoveTarget, MoveSpeed, Velocity, IsBuilding, PathFollower, Projectile, CollisionRadius, Dead } from '../components'
import { getPath, removePath } from '../../pathfinding/pathStore'
import { resetPathAttempt } from './pathfindingSystem'
import { getTerrainHeight, getTerrainTypeAt, T_WATER, T_CLIFF, worldToGrid, GRID_RES } from '../../terrain/heightmap'
import { isWorldWalkable, dynamicCost } from '../../pathfinding/navGrid'
import { spatialHash } from '../../globals'

const BUILDING_COST_THRESHOLD = 50 // dynamicCost above this = building (impassable)

/** Check if a point is blocked by a building (dynamic obstacle) */
function isBlockedByBuilding(x: number, z: number): boolean {
  const [gx, gz] = worldToGrid(x, z)
  if (gx < 0 || gx >= GRID_RES || gz < 0 || gz >= GRID_RES) return false
  return dynamicCost[gz * GRID_RES + gx] >= BUILDING_COST_THRESHOLD
}

/** Check if a circle of given radius is fully on walkable terrain and not inside buildings */
function isRadiusWalkable(x: number, z: number, radius: number): boolean {
  if (!isWorldWalkable(x, z)) return false
  const t = getTerrainTypeAt(x, z)
  if (t === T_WATER || t === T_CLIFF) return false
  if (isBlockedByBuilding(x, z)) return false
  if (radius <= 0.2) return true
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI * 0.5
    const cx = x + Math.cos(angle) * radius
    const cz = z + Math.sin(angle) * radius
    const ct = getTerrainTypeAt(cx, cz)
    if (ct === T_WATER || ct === T_CLIFF || !isWorldWalkable(cx, cz)) return false
    if (isBlockedByBuilding(cx, cz)) return false
  }
  return true
}

const pathQuery = defineQuery([Position, PathFollower, MoveSpeed])
const directQuery = defineQuery([Position, MoveTarget, MoveSpeed])
const unitQuery = defineQuery([Position, MoveSpeed, CollisionRadius])

const ARRIVE_THRESHOLD = 0.8

// Stuck detection
const lastX = new Float32Array(8000)
const lastZ = new Float32Array(8000)
const stuckTimer = new Float32Array(8000)
const STUCK_CHECK_DIST = 0.3
const STUCK_TIMEOUT = 1.5
const REPATH_COOLDOWN = 2.0
const repathCooldown = new Float32Array(8000)

// Separation
const SEPARATION_RADIUS = 1.5
const SEPARATION_FORCE = 3.0
const _nearby: number[] = []

export function movementSystem(world: IWorld, dt: number) {
  // ── Unit separation: push overlapping units apart ──────────
  const allUnits = unitQuery(world)
  for (const eid of allUnits) {
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, Projectile, eid)) continue

    const px = Position.x[eid]
    const pz = Position.z[eid]
    const myRadius = CollisionRadius.value[eid]

    _nearby.length = 0
    spatialHash.query(px, pz, SEPARATION_RADIUS + myRadius, _nearby)

    let sepX = 0, sepZ = 0
    for (const other of _nearby) {
      if (other === eid) continue
      if (hasComponent(world, IsBuilding, other)) continue
      if (hasComponent(world, Dead, other)) continue
      if (!hasComponent(world, CollisionRadius, other)) continue

      const ox = Position.x[other]
      const oz = Position.z[other]
      const dx = px - ox
      const dz = pz - oz
      const dist = Math.sqrt(dx * dx + dz * dz)
      const minDist = myRadius + CollisionRadius.value[other]

      if (dist < minDist && dist > 0.01) {
        // Push apart proportional to overlap
        const overlap = minDist - dist
        const nx = dx / dist
        const nz = dz / dist
        sepX += nx * overlap * SEPARATION_FORCE
        sepZ += nz * overlap * SEPARATION_FORCE
      } else if (dist < 0.01) {
        // Exactly on top — push in random direction
        const angle = Math.random() * Math.PI * 2
        sepX += Math.cos(angle) * SEPARATION_FORCE * 0.5
        sepZ += Math.sin(angle) * SEPARATION_FORCE * 0.5
      }
    }

    if (sepX !== 0 || sepZ !== 0) {
      const newX = px + sepX * dt
      const newZ = pz + sepZ * dt
      // Only apply separation if result is walkable (radius-aware)
      if (isRadiusWalkable(newX, newZ, myRadius * 0.6)) {
        Position.x[eid] = newX
        Position.z[eid] = newZ
        Position.y[eid] = getTerrainHeight(newX, newZ)
        spatialHash.update(eid, newX, newZ)
      }
    }
  }

  // ── Path-following movement ─────────────────────────
  const pathEntities = pathQuery(world)

  for (const eid of pathEntities) {
    if (hasComponent(world, IsBuilding, eid)) continue

    if (repathCooldown[eid] > 0) repathCooldown[eid] -= dt

    const pathId = PathFollower.pathId[eid]
    const path = getPath(pathId)

    if (!path) {
      removeComponent(world, PathFollower, eid)
      if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
      Velocity.x[eid] = 0
      Velocity.z[eid] = 0
      continue
    }

    let wpIdx = PathFollower.waypointIndex[eid]

    if (wpIdx >= path.length) {
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
      wpIdx++
      PathFollower.waypointIndex[eid] = wpIdx
      lastX[eid] = px
      lastZ[eid] = pz
      stuckTimer[eid] = 0

      if (wpIdx >= path.length) {
        finishPath(world, eid, pathId)
        continue
      }
      continue
    }

    const speed = MoveSpeed.value[eid]
    const nx = dx / dist
    const nz = dz / dist

    const step = speed * dt
    let newX: number, newZ: number
    if (step >= dist) {
      newX = wp.x
      newZ = wp.z
    } else {
      newX = px + nx * step
      newZ = pz + nz * step
    }

    // Block on unwalkable terrain (check with unit radius)
    const unitRadius = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4
    if (!isRadiusWalkable(newX, newZ, unitRadius * 0.6)) {
      // Try sliding along X or Z axis separately
      const slideX = px + nx * step
      const slideZ = pz + nz * step
      if (isRadiusWalkable(slideX, pz, unitRadius * 0.6)) {
        newX = slideX
        newZ = pz
      } else if (isRadiusWalkable(px, slideZ, unitRadius * 0.6)) {
        newX = px
        newZ = slideZ
      } else {
        forceRepath(world, eid, pathId)
        continue
      }
    }

    Position.x[eid] = newX
    Position.z[eid] = newZ
    Velocity.x[eid] = nx * speed
    Velocity.z[eid] = nz * speed
    Rotation.y[eid] = Math.atan2(nx, nz)
    Position.y[eid] = getTerrainHeight(newX, newZ)
    spatialHash.update(eid, newX, newZ)

    // Stuck detection
    const movedX = newX - lastX[eid]
    const movedZ = newZ - lastZ[eid]
    const movedDist = Math.sqrt(movedX * movedX + movedZ * movedZ)

    if (movedDist > STUCK_CHECK_DIST) {
      lastX[eid] = newX
      lastZ[eid] = newZ
      stuckTimer[eid] = 0
    } else {
      stuckTimer[eid] += dt
      if (stuckTimer[eid] > STUCK_TIMEOUT && repathCooldown[eid] <= 0) {
        forceRepath(world, eid, pathId)
      }
    }
  }

  // ── Direct movement ──────────────────────────────────
  const directEntities = directQuery(world)

  for (const eid of directEntities) {
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, PathFollower, eid)) continue

    const tx = MoveTarget.x[eid]
    const tz = MoveTarget.z[eid]
    const px = Position.x[eid]
    const pz = Position.z[eid]
    const dx = tx - px
    const dz = tz - pz
    const dist = Math.sqrt(dx * dx + dz * dz)

    // Long distances: wait for pathfinding, but not forever
    // (pathfinding will assign PathFollower next frame if a path exists)

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
    const isProjectile = hasComponent(world, Projectile, eid)

    let newX: number, newZ: number
    if (step >= dist) {
      newX = tx
      newZ = tz
    } else {
      newX = px + nx * step
      newZ = pz + nz * step
    }

    // Block non-projectile units from walking into unwalkable terrain — slide along edges
    if (!isProjectile) {
      const unitRadius = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4
      if (!isRadiusWalkable(newX, newZ, unitRadius * 0.6)) {
        // Try sliding: move only along X or only along Z
        const slideX = px + nx * step
        const slideZ = pz + nz * step
        if (isRadiusWalkable(slideX, pz, unitRadius * 0.6)) {
          newX = slideX
          newZ = pz
        } else if (isRadiusWalkable(px, slideZ, unitRadius * 0.6)) {
          newX = px
          newZ = slideZ
        } else {
          // Completely blocked — stop
          removeComponent(world, MoveTarget, eid)
          Velocity.x[eid] = 0
          Velocity.z[eid] = 0
          continue
        }
      }
    }

    Position.x[eid] = newX
    Position.z[eid] = newZ
    if (step >= dist) {
      removeComponent(world, MoveTarget, eid)
      Velocity.x[eid] = 0
      Velocity.z[eid] = 0
    } else {
      Velocity.x[eid] = nx * speed
      Velocity.z[eid] = nz * speed
      Rotation.y[eid] = Math.atan2(nx, nz)
    }

    Position.y[eid] = getTerrainHeight(newX, newZ)
    spatialHash.update(eid, newX, newZ)
  }
}

function forceRepath(world: IWorld, eid: number, pathId: number) {
  removePath(pathId)
  removeComponent(world, PathFollower, eid)
  Velocity.x[eid] = 0
  Velocity.z[eid] = 0
  stuckTimer[eid] = 0
  repathCooldown[eid] = REPATH_COOLDOWN
  resetPathAttempt(eid)
}

function finishPath(world: IWorld, eid: number, pathId: number) {
  removePath(pathId)
  removeComponent(world, PathFollower, eid)
  if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
  Velocity.x[eid] = 0
  Velocity.z[eid] = 0
  stuckTimer[eid] = 0
}
