/**
 * Supreme Commander-style movement system.
 *
 * Per-unit pipeline each tick:
 *  1. Waypoint management (advance when close)
 *  2. Desired direction = normalize(waypoint - position)
 *  3. Turn rate application (smooth rotation)
 *  4. Acceleration / deceleration
 *  5. Terrain collision — axis-separated wall slide with footprint
 *  6. Position update + Y snap to terrain
 *  7. Stuck escalation (wiggle → repath → stop)
 */

import { defineQuery, hasComponent, removeComponent, addComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Rotation, MoveTarget, MoveSpeed, Velocity,
  IsBuilding, PathFollower, Projectile, CollisionRadius, Dead,
  TurnRate, Acceleration, CurrentSpeed, MaxSlope, StuckState, AttackMove,
} from '../components'
import { getPath, removePath } from '../../pathfinding/pathStore'
import { resetPathAttempt } from './pathfindingSystem'
import { getTerrainHeight, getTerrainTypeAt, T_WATER, worldToGrid, GRID_RES, gridToWorld } from '../../terrain/heightmap'
import { isWorldWalkable, dynamicCost, slopeData, BUILDING_BLOCK_THRESHOLD, getClearanceAt } from '../../pathfinding/navGrid'
import { spatialHash } from '../../globals'
import { telemetry } from '../../debug/movementTelemetry'

// ── Constants ────────────────────────────────────────────────
const ARRIVE_THRESHOLD = 0.8

// Separation
const SEPARATION_RADIUS = 1.5
const SEPARATION_FORCE = 3.0
const _nearby: number[] = []

// Stuck escalation thresholds
const STUCK_SPEED_THRESHOLD = 0.15 // fraction of max speed — below this = "stuck"
const PHASE0_TIMEOUT = 2.5    // seconds before repath (give time for turning)
const PHASE1_COOLDOWN = 3.0   // cooldown after repath before giving up

// ── Queries ──────────────────────────────────────────────────
const pathQuery = defineQuery([Position, PathFollower, MoveSpeed])
const directQuery = defineQuery([Position, MoveTarget, MoveSpeed])
const unitQuery = defineQuery([Position, MoveSpeed, CollisionRadius])

// ── Helpers ──────────────────────────────────────────────────

/** Shortest signed angle difference in [-PI, PI] */
function angleDiff(target: number, current: number): number {
  let d = target - current
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

/** Check if a position is walkable for a unit considering footprint + slope + buildings */
function checkFootprint(x: number, z: number, radius: number, maxSl: number): boolean {
  if (!isWorldWalkable(x, z)) return false
  if (getTerrainTypeAt(x, z) === T_WATER) return false

  const [gx, gz] = worldToGrid(x, z)
  if (gx < 0 || gx >= GRID_RES || gz < 0 || gz >= GRID_RES) return false
  if (dynamicCost[gz * GRID_RES + gx] >= BUILDING_BLOCK_THRESHOLD) return false
  if (maxSl < 100 && slopeData[gz * GRID_RES + gx] > maxSl) return false

  if (radius <= 0.3) return true

  // Check 4 cardinal edge points of footprint
  const offsets = [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]
  for (const [ox, oz] of offsets) {
    const cx = x + ox
    const cz = z + oz
    if (!isWorldWalkable(cx, cz)) return false
    if (getTerrainTypeAt(cx, cz) === T_WATER) return false
    const [ggx, ggz] = worldToGrid(cx, cz)
    if (ggx < 0 || ggx >= GRID_RES || ggz < 0 || ggz >= GRID_RES) return false
    if (dynamicCost[ggz * GRID_RES + ggx] >= BUILDING_BLOCK_THRESHOLD) return false
  }
  return true
}

/** Compute repulsion force from nearby blocked cells.
 *  Samples 8 points around the unit at its radius. For each point on a blocked cell,
 *  adds a push force from that cell toward the unit center. */
function getTerrainRepulsion(x: number, z: number, radius: number, maxSl: number): [number, number] {
  let pushX = 0, pushZ = 0
  const samples = 8
  for (let i = 0; i < samples; i++) {
    const angle = (i / samples) * Math.PI * 2
    const sx = x + Math.cos(angle) * radius
    const sz = z + Math.sin(angle) * radius

    // Check if this edge point is on blocked terrain
    const blocked = !isWorldWalkable(sx, sz)
      || getTerrainTypeAt(sx, sz) === T_WATER
      || (maxSl < 100 && (() => { const [gx2, gz2] = worldToGrid(sx, sz); return gx2 >= 0 && gx2 < GRID_RES && gz2 >= 0 && gz2 < GRID_RES && slopeData[gz2 * GRID_RES + gx2] > maxSl })())

    if (blocked) {
      // Gentle push away from blocked point → toward center
      const dx = x - sx
      const dz = z - sz
      pushX += dx * 0.8
      pushZ += dz * 0.8
    }
  }
  return [pushX, pushZ]
}

// ── Main movement system ─────────────────────────────────────
import { isFPSMode, getFPSEntity } from '../../input/fpsMode'

export function movementSystem(world: IWorld, dt: number) {
  const fpsEid = isFPSMode() ? getFPSEntity() : -1

  // ── 0. Auto-escape: if unit is on blocked terrain with no orders, push out ──
  const allUnits = unitQuery(world)
  for (const eid of allUnits) {
    if (eid === fpsEid) continue // FPS unit moves itself
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, Projectile, eid)) continue
    if (hasComponent(world, MoveTarget, eid)) continue
    if (hasComponent(world, PathFollower, eid)) continue

    const px = Position.x[eid]
    const pz = Position.z[eid]
    const r = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4
    const sl = hasComponent(world, MaxSlope, eid) ? MaxSlope.value[eid] : 100

    if (!checkFootprint(px, pz, r * 0.5, sl)) {
      // Unit is stuck on blocked terrain with no orders — find nearest walkable
      const [gx, gz] = worldToGrid(px, pz)
      for (let ring = 1; ring < 10; ring++) {
        let found = false
        for (let d = -ring; d <= ring && !found; d++) {
          for (const [ox, oz] of [[d, -ring], [d, ring], [-ring, d], [ring, d]]) {
            const nx = gx + ox, nz = gz + oz
            if (nx < 0 || nx >= GRID_RES || nz < 0 || nz >= GRID_RES) continue
            const [wx, wz] = gridToWorld(nx, nz)
            if (checkFootprint(wx, wz, r * 0.5, sl)) {
              addComponent(world, MoveTarget, eid)
              MoveTarget.x[eid] = wx
              MoveTarget.z[eid] = wz
              found = true
              break
            }
          }
        }
        if (found) break
      }
    }
  }

  // ── 1. Unit separation: push overlapping units apart ───────
  for (const eid of allUnits) {
    if (eid === fpsEid) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, Projectile, eid)) continue

    const px = Position.x[eid]
    const pz = Position.z[eid]
    const myRadius = CollisionRadius.value[eid]
    const maxSl = hasComponent(world, MaxSlope, eid) ? MaxSlope.value[eid] : 100

    // Idle units: very gentle separation (settle in place, don't bounce)
    // Moving units: normal separation
    const isIdle = !hasComponent(world, MoveTarget, eid) && !hasComponent(world, PathFollower, eid)
    const sepForce = isIdle ? 0.5 : SEPARATION_FORCE

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
        const overlap = minDist - dist
        const nx = dx / dist
        const nz = dz / dist
        sepX += nx * overlap * sepForce
        sepZ += nz * overlap * sepForce
      } else if (dist < 0.01) {
        const angle = Math.random() * Math.PI * 2
        sepX += Math.cos(angle) * sepForce * 0.3
        sepZ += Math.sin(angle) * sepForce * 0.3
      }
    }

    // Terrain repulsion: push away from nearby blocked cells
    const [tRepX, tRepZ] = getTerrainRepulsion(px, pz, myRadius, maxSl)
    sepX += tRepX
    sepZ += tRepZ

    if (sepX !== 0 || sepZ !== 0) {
      telemetry.recordSeparation(eid, sepX, sepZ)
      const newX = px + sepX * dt
      const newZ = pz + sepZ * dt
      // Only apply if center stays on walkable ground
      if (isWorldWalkable(newX, newZ) && getTerrainTypeAt(newX, newZ) !== T_WATER) {
        Position.x[eid] = newX
        Position.z[eid] = newZ
        Position.y[eid] = getTerrainHeight(newX, newZ)
        spatialHash.update(eid, newX, newZ)
      }
    }
  }

  // ── 2. Path-following movement (SupCom pipeline) ───────────
  const pathEntities = pathQuery(world)

  for (const eid of pathEntities) {
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, Dead, eid)) continue

    // If MoveTarget changed while following a path, cancel and repath
    if (hasComponent(world, MoveTarget, eid)) {
      const pathId = PathFollower.pathId[eid]
      const path = getPath(pathId)
      if (path && path.length > 0) {
        const lastWp = path[path.length - 1]
        const dx = MoveTarget.x[eid] - lastWp.x
        const dz = MoveTarget.z[eid] - lastWp.z
        if (dx * dx + dz * dz > 4) {
          forceRepath(world, eid, pathId)
          continue
        }
      }
    }

    const pathId = PathFollower.pathId[eid]
    const path = getPath(pathId)

    if (!path) {
      removeComponent(world, PathFollower, eid)
      if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
      Velocity.x[eid] = 0; Velocity.z[eid] = 0
      CurrentSpeed.value[eid] = 0
      continue
    }

    let wpIdx = PathFollower.waypointIndex[eid]
    if (wpIdx >= path.length) {
      finishPath(world, eid, pathId)
      continue
    }

    telemetry.beginFrame(eid)

    // ── Step 1: Waypoint management ──────────────────────────
    const wp = path[wpIdx]
    const px = Position.x[eid]
    const pz = Position.z[eid]
    telemetry.set('px', px)
    telemetry.set('pz', pz)
    let dx = wp.x - px
    let dz = wp.z - pz
    let dist = Math.sqrt(dx * dx + dz * dz)

    if (dist < ARRIVE_THRESHOLD) {
      wpIdx++
      PathFollower.waypointIndex[eid] = wpIdx
      if (hasComponent(world, StuckState, eid)) {
        StuckState.phase[eid] = 0
        StuckState.timer[eid] = 0
      }
      if (wpIdx >= path.length) {
        finishPath(world, eid, pathId)
        continue
      }
      const nwp = path[wpIdx]
      dx = nwp.x - px
      dz = nwp.z - pz
      dist = Math.sqrt(dx * dx + dz * dz)
      if (dist < 0.01) { finishPath(world, eid, pathId); continue }
    }

    // Skip-ahead: only when unit is slow/stuck (pushed by others or wall sliding)
    const curSpd = hasComponent(world, CurrentSpeed, eid) ? CurrentSpeed.value[eid] : 0
    const mxSpd = MoveSpeed.value[eid]
    if (wpIdx + 1 < path.length && curSpd < mxSpd * 0.4) {
      const nextWp = path[wpIdx + 1]
      const dxN = nextWp.x - px
      const dzN = nextWp.z - pz
      const distNext = dxN * dxN + dzN * dzN
      if (distNext < dist * dist) {
        wpIdx++
        PathFollower.waypointIndex[eid] = wpIdx
        dx = dxN; dz = dzN
        dist = Math.sqrt(distNext)
      }
    }

    // Yield: only near the waypoint (within 4x radius) and if colliding
    const unitRadius = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4
    _nearby.length = 0
    const yieldRange = unitRadius * 4
    let shouldYield = false
    if (dist < yieldRange) {  // only check when close to waypoint
    spatialHash.query(px, pz, unitRadius * 3, _nearby)
    for (const other of _nearby) {
      if (other === eid) continue
      if (hasComponent(world, Dead, other)) continue
      if (!hasComponent(world, PathFollower, other)) continue
      // Check if other unit targets a similar waypoint (within radius)
      const otherPath = getPath(PathFollower.pathId[other])
      const otherWpIdx = PathFollower.waypointIndex[other]
      if (!otherPath || otherWpIdx >= otherPath.length) continue
      const otherWp = otherPath[otherWpIdx]
      const wpDx = otherWp.x - wp.x, wpDz = otherWp.z - wp.z
      if (wpDx * wpDx + wpDz * wpDz > unitRadius * unitRadius * 4) continue
      // Same waypoint area — who is closer?
      const myDist2 = dx * dx + dz * dz
      const oDx = otherWp.x - Position.x[other], oDz = otherWp.z - Position.z[other]
      const otherDist2 = oDx * oDx + oDz * oDz
      if (otherDist2 < myDist2) {
        shouldYield = true
        break
      }
    }
    } // end yield-range check
    if (shouldYield) {
      // Wait: don't move this frame, let the closer unit pass
      Velocity.x[eid] = 0; Velocity.z[eid] = 0
      if (hasComponent(world, CurrentSpeed, eid)) CurrentSpeed.value[eid] = 0
      telemetry.endFrame(eid)
      continue
    }

    // ── Step 2: Desired direction ────────────────────────────
    const desiredDirX = dx / dist
    const desiredDirZ = dz / dist
    const desiredYaw = Math.atan2(desiredDirX, desiredDirZ)
    telemetry.set('wpX', wp.x)
    telemetry.set('wpZ', wp.z)
    telemetry.set('distToWp', dist)
    telemetry.set('desiredYaw', desiredYaw)

    // Check if on blocked terrain — if so, skip turn rate and move directly
    // unitRadius declared above (before yield check)
    const maxSl = hasComponent(world, MaxSlope, eid) ? MaxSlope.value[eid] : 100
    const checkR = unitRadius
    const onBlockedTerrain = !checkFootprint(px, pz, checkR, maxSl)

    // ── Step 3: Turn rate application ────────────────────────
    let facingX: number, facingZ: number, turnSpeedFactor: number
    let appliedYaw: number, yawDelta: number

    if (onBlockedTerrain) {
      Rotation.y[eid] = desiredYaw
      facingX = desiredDirX
      facingZ = desiredDirZ
      turnSpeedFactor = 1.0
      appliedYaw = desiredYaw
      yawDelta = 0
    } else {
      const turnRate = hasComponent(world, TurnRate, eid) ? TurnRate.value[eid] : 5.0
      const currentYaw = Rotation.y[eid]
      yawDelta = angleDiff(desiredYaw, currentYaw)
      const maxTurn = turnRate * dt
      appliedYaw = currentYaw + Math.max(-maxTurn, Math.min(maxTurn, yawDelta))
      Rotation.y[eid] = appliedYaw
      facingX = Math.sin(appliedYaw)
      facingZ = Math.cos(appliedYaw)
      const facingDot = facingX * desiredDirX + facingZ * desiredDirZ
      turnSpeedFactor = 0.2 + 0.8 * Math.max(0.0, facingDot)
    }
    telemetry.set('yaw', appliedYaw)
    telemetry.set('yawDelta', yawDelta)
    telemetry.set('turnSpeedFactor', turnSpeedFactor)

    // ── Step 4: Acceleration / deceleration ──────────────────
    const maxSpeed = MoveSpeed.value[eid]
    const accel = hasComponent(world, Acceleration, eid) ? Acceleration.value[eid] : 8.0
    const targetSpeed = maxSpeed * turnSpeedFactor

    let curSpeed = hasComponent(world, CurrentSpeed, eid) ? CurrentSpeed.value[eid] : maxSpeed
    if (targetSpeed > curSpeed) {
      curSpeed = Math.min(targetSpeed, curSpeed + accel * dt)
    } else {
      curSpeed = Math.max(targetSpeed, curSpeed - accel * 2.0 * dt) // decel is 2x accel
    }
    if (hasComponent(world, CurrentSpeed, eid)) CurrentSpeed.value[eid] = curSpeed
    telemetry.set('maxSpeed', maxSpeed)
    telemetry.set('targetSpeed', targetSpeed)
    telemetry.set('currentSpeed', curSpeed)

    // ── Step 5: Compute displacement ─────────────────────────
    const stepDist = curSpeed * dt
    let moveX = facingX * stepDist
    let moveZ = facingZ * stepDist

    // Clamp step to not overshoot waypoint
    if (stepDist > dist) {
      moveX = dx
      moveZ = dz
    }

    let newX = px + moveX
    let newZ = pz + moveZ

    // ── Step 6: Terrain collision — axis-separated wall slide ─
    // unitRadius, maxSl, checkR, onBlockedTerrain computed above in step 3

    // Collision check:
    // - Normal: full footprint check (center + 4 edge points)
    // - Escape mode: skip edge points but ALWAYS check center is walkable
    //   (prevents center from entering fully blocked cells)
    let fullOk: boolean
    if (onBlockedTerrain) {
      // Escape: allow if center stays on walkable ground
      fullOk = isWorldWalkable(newX, newZ) && getTerrainTypeAt(newX, newZ) !== T_WATER
    } else {
      fullOk = checkFootprint(newX, newZ, checkR, maxSl)
    }
    telemetry.set('moveX', moveX)
    telemetry.set('moveZ', moveZ)
    telemetry.set('fullOk', fullOk)

    if (!fullOk) {
      // Wall slide: use CENTER-ONLY check (radius=0.2) so corners don't block both axes
      // Full radius blocks the straight move, but slide should be permissive
      const slideR = Math.min(checkR, 0.2)
      const xOk = checkFootprint(px + moveX, pz, slideR, maxSl)
      const zOk = checkFootprint(px, pz + moveZ, slideR, maxSl)
      telemetry.set('xOnlyOk', xOk)
      telemetry.set('zOnlyOk', zOk)

      if (xOk && !zOk) {
        newX = px + moveX; newZ = pz
        telemetry.set('blocked', true)
        telemetry.set('slideX', true)
      } else if (!xOk && zOk) {
        newX = px; newZ = pz + moveZ
        telemetry.set('blocked', true)
        telemetry.set('slideZ', true)
      } else if (xOk && zOk) {
        if (Math.abs(moveX) > Math.abs(moveZ)) {
          newX = px + moveX; newZ = pz
        } else {
          newX = px; newZ = pz + moveZ
        }
        telemetry.set('blocked', true)
      } else {
        newX = px; newZ = pz
        telemetry.set('blocked', true)
        telemetry.set('bothBlocked', true)
      }
    }

    // ── Step 7: Position update + Y snap ─────────────────────
    Position.x[eid] = newX
    Position.z[eid] = newZ
    Position.y[eid] = getTerrainHeight(newX, newZ)
    Velocity.x[eid] = facingX * curSpeed
    Velocity.z[eid] = facingZ * curSpeed
    spatialHash.update(eid, newX, newZ)

    // ── Step 8: Stuck detection — no teleport, just repath then give up
    const actualMovedDist = Math.sqrt((newX - px) * (newX - px) + (newZ - pz) * (newZ - pz))
    telemetry.set('actualDist', actualMovedDist)

    if (hasComponent(world, StuckState, eid)) {
      const actualSpeed = actualMovedDist / Math.max(dt, 0.001)
      const isStuck = actualSpeed < maxSpeed * STUCK_SPEED_THRESHOLD && curSpeed > 0.1

      if (!isStuck) {
        // Moving fine — reset
        StuckState.phase[eid] = 0
        StuckState.timer[eid] = 0
      } else {
        StuckState.timer[eid] += dt
        const phase = StuckState.phase[eid]
        const timer = StuckState.timer[eid]

        if (phase === 0 && timer > PHASE0_TIMEOUT) {
          // Phase 1: Force repath — find a new route
          StuckState.phase[eid] = 1
          StuckState.timer[eid] = 0
          telemetry.set('stuckPhase', 1)
          telemetry.set('stuckTimer', 0)
          telemetry.endFrame(eid)
          telemetry.dump(`STUCK → repath (unit #${eid})`)
          forceRepath(world, eid, pathId)
          continue
        } else if (phase === 1 && timer > PHASE1_COOLDOWN) {
          // Phase 2: Give up — stop
          StuckState.phase[eid] = 2
          StuckState.timer[eid] = 0
          telemetry.set('stuckPhase', 2)
          telemetry.endFrame(eid)
          telemetry.dump(`GIVE UP (unit #${eid})`)
          finishPath(world, eid, pathId)
          continue
        }
      }
      telemetry.set('stuckPhase', StuckState.phase[eid])
      telemetry.set('stuckTimer', StuckState.timer[eid])
    }
    telemetry.endFrame(eid)
  }

  // ── 3. Direct movement (no path, short distances) ──────────
  const directEntities = directQuery(world)

  for (const eid of directEntities) {
    if (hasComponent(world, IsBuilding, eid)) continue
    if (hasComponent(world, PathFollower, eid)) continue
    if (hasComponent(world, Dead, eid)) continue

    const tx = MoveTarget.x[eid]
    const tz = MoveTarget.z[eid]
    const px = Position.x[eid]
    const pz = Position.z[eid]
    const dx = tx - px
    const dz = tz - pz
    const dist = Math.sqrt(dx * dx + dz * dz)

    // Long distance: wait for pathfinding system to assign a path
    // Only move directly for short distances (< 3 units)
    const isProjectile = hasComponent(world, Projectile, eid)
    if (dist > 3 && !isProjectile) continue

    if (dist < ARRIVE_THRESHOLD) {
      removeComponent(world, MoveTarget, eid)
      Velocity.x[eid] = 0; Velocity.z[eid] = 0
      if (hasComponent(world, CurrentSpeed, eid)) CurrentSpeed.value[eid] = 0
      continue
    }

    const maxSpeed = MoveSpeed.value[eid]

    // Direct movers also get turn rate + acceleration
    const desiredDirX = dx / dist
    const desiredDirZ = dz / dist

    if (!isProjectile) {
      // Apply turn rate
      const desiredYaw = Math.atan2(desiredDirX, desiredDirZ)
      const turnRate = hasComponent(world, TurnRate, eid) ? TurnRate.value[eid] : 5.0
      const currentYaw = Rotation.y[eid]
      const delta = angleDiff(desiredYaw, currentYaw)
      const maxTurn = turnRate * dt
      const newYaw = currentYaw + Math.max(-maxTurn, Math.min(maxTurn, delta))
      Rotation.y[eid] = newYaw

      const facingX = Math.sin(newYaw)
      const facingZ = Math.cos(newYaw)
      const facingDot = Math.max(0, facingX * desiredDirX + facingZ * desiredDirZ)

      // Acceleration
      const accel = hasComponent(world, Acceleration, eid) ? Acceleration.value[eid] : 8.0
      const targetSpeed = maxSpeed * (0.2 + 0.8 * facingDot)
      let curSpeed = hasComponent(world, CurrentSpeed, eid) ? CurrentSpeed.value[eid] : maxSpeed
      if (targetSpeed > curSpeed) curSpeed = Math.min(targetSpeed, curSpeed + accel * dt)
      else curSpeed = Math.max(targetSpeed, curSpeed - accel * 2.0 * dt)
      if (hasComponent(world, CurrentSpeed, eid)) CurrentSpeed.value[eid] = curSpeed

      const step = curSpeed * dt
      let moveX = facingX * step
      let moveZ = facingZ * step
      if (step > dist) { moveX = dx; moveZ = dz }

      let newX = px + moveX
      let newZ = pz + moveZ

      // Wall slide
      const unitRadius = hasComponent(world, CollisionRadius, eid) ? CollisionRadius.value[eid] : 0.4
      const maxSl = hasComponent(world, MaxSlope, eid) ? MaxSlope.value[eid] : 100
      const checkR = unitRadius

      const curOk = checkFootprint(px, pz, checkR, maxSl)
      // Escape: center must stay walkable. Normal: full footprint check.
      const newOk = curOk ? checkFootprint(newX, newZ, checkR, maxSl)
        : (isWorldWalkable(newX, newZ) && getTerrainTypeAt(newX, newZ) !== T_WATER)
      if (!newOk) {
        const slideR = Math.min(checkR, 0.2)
        const xOk = checkFootprint(px + moveX, pz, slideR, maxSl)
        const zOk = checkFootprint(px, pz + moveZ, slideR, maxSl)

        if (xOk && !zOk) { newX = px + moveX; newZ = pz }
        else if (!xOk && zOk) { newX = px; newZ = pz + moveZ }
        else if (xOk && zOk) {
          if (Math.abs(moveX) > Math.abs(moveZ)) { newX = px + moveX; newZ = pz }
          else { newX = px; newZ = pz + moveZ }
        } else {
          removeComponent(world, MoveTarget, eid)
          Velocity.x[eid] = 0; Velocity.z[eid] = 0
          if (hasComponent(world, CurrentSpeed, eid)) CurrentSpeed.value[eid] = 0
          continue
        }
      }

      Position.x[eid] = newX
      Position.z[eid] = newZ
      Velocity.x[eid] = facingX * curSpeed
      Velocity.z[eid] = facingZ * curSpeed
      Position.y[eid] = getTerrainHeight(newX, newZ)
      spatialHash.update(eid, newX, newZ)

      if (step >= dist) {
        removeComponent(world, MoveTarget, eid)
        Velocity.x[eid] = 0; Velocity.z[eid] = 0
        if (hasComponent(world, CurrentSpeed, eid)) CurrentSpeed.value[eid] = 0
      }
    } else {
      // Projectiles — simple direct movement, no turn rate or collision
      const step = maxSpeed * dt
      let newX: number, newZ: number
      if (step >= dist) { newX = tx; newZ = tz }
      else { newX = px + desiredDirX * step; newZ = pz + desiredDirZ * step }

      Position.x[eid] = newX
      Position.z[eid] = newZ
      if (step >= dist) {
        removeComponent(world, MoveTarget, eid)
        Velocity.x[eid] = 0; Velocity.z[eid] = 0
      } else {
        Velocity.x[eid] = desiredDirX * maxSpeed
        Velocity.z[eid] = desiredDirZ * maxSpeed
        Rotation.y[eid] = Math.atan2(desiredDirX, desiredDirZ)
      }
      Position.y[eid] = getTerrainHeight(newX, newZ)
      spatialHash.update(eid, newX, newZ)
    }
  }
}

function forceRepath(world: IWorld, eid: number, pathId: number) {
  removePath(pathId)
  removeComponent(world, PathFollower, eid)
  Velocity.x[eid] = 0
  Velocity.z[eid] = 0
  if (hasComponent(world, CurrentSpeed, eid)) CurrentSpeed.value[eid] = 0
  resetPathAttempt(eid)
}

function finishPath(world: IWorld, eid: number, pathId: number) {
  removePath(pathId)
  removeComponent(world, PathFollower, eid)
  if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
  Velocity.x[eid] = 0
  Velocity.z[eid] = 0
  if (hasComponent(world, CurrentSpeed, eid)) CurrentSpeed.value[eid] = 0
  if (hasComponent(world, StuckState, eid)) {
    StuckState.phase[eid] = 0
    StuckState.timer[eid] = 0
  }
}
