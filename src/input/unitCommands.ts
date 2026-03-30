/**
 * Shared unit command logic — used by both game (input.ts) and sandbox.
 * Formation movement, attack assignment, rally points.
 */

import { addComponent, removeComponent, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, MoveTarget, AttackTarget, MoveSpeed,
  CollisionRadius, Dead, Selected, PathFollower, WorkerC,
  ResourceNode, ResourceDropoff, IsBuilding, Producer,
} from '../ecs/components'
import { spatialHash } from '../globals'
import { isWorldWalkable } from '../pathfinding/navGrid'
import { spawnMoveMarker } from '../render/effects'

/**
 * Issue move/attack command to selected units with formation.
 * Called on right-click in both game and sandbox.
 */
export function issueCommand(
  world: IWorld,
  hitX: number, hitY: number, hitZ: number,
  faction: number,
) {
  // Collect selected movable units
  const movable: number[] = []
  const allEnts: number[] = []
  spatialHash.query(0, 0, 9999, allEnts)
  for (const eid of allEnts) {
    if (!hasComponent(world, Selected, eid)) continue
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (!hasComponent(world, MoveSpeed, eid)) continue
    if (hasComponent(world, Faction, eid) && Faction.id[eid] !== faction) continue
    movable.push(eid)
  }

  if (movable.length === 0) return false

  // Check for rally point (selected buildings)
  let hasBuildings = false
  for (const eid of allEnts) {
    if (!hasComponent(world, Selected, eid)) continue
    if (!hasComponent(world, IsBuilding, eid)) continue
    if (!hasComponent(world, Producer, eid)) continue
    hasBuildings = true

    // Check if clicking on resource
    const nearbyR: number[] = []
    spatialHash.query(hitX, hitZ, 2, nearbyR)
    let resEid = 0
    for (const rid of nearbyR) {
      if (hasComponent(world, ResourceNode, rid) && !hasComponent(world, Dead, rid)) {
        const dx = Position.x[rid] - hitX, dz = Position.z[rid] - hitZ
        if (dx * dx + dz * dz < 4) { resEid = rid; break }
      }
    }
    Producer.rallyX[eid] = hitX
    Producer.rallyZ[eid] = hitZ
    Producer.rallyTargetEid[eid] = resEid
  }
  if (hasBuildings && movable.length === 0) {
    spawnMoveMarker(hitX, hitY, hitZ)
    return true
  }

  // Find target entity near click
  const nearby: number[] = []
  spatialHash.query(hitX, hitZ, 3, nearby)
  let targetEid = -1
  let targetDist = Infinity
  let isResource = false

  for (const eid of nearby) {
    if (hasComponent(world, Dead, eid)) continue
    const dx = Position.x[eid] - hitX
    const dz = Position.z[eid] - hitZ
    const dist = Math.sqrt(dx * dx + dz * dz)

    if (hasComponent(world, ResourceNode, eid) && dist < 2) {
      if (dist < targetDist) { targetEid = eid; targetDist = dist; isResource = true }
    } else if (hasComponent(world, Faction, eid) && Faction.id[eid] !== faction && dist < 2) {
      if (dist < targetDist) { targetEid = eid; targetDist = dist; isResource = false }
    }
  }

  spawnMoveMarker(hitX, hitY, hitZ)

  // Attack target
  if (targetEid >= 0 && !isResource) {
    for (const eid of movable) {
      addComponent(world, AttackTarget, eid)
      AttackTarget.eid[eid] = targetEid
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = Position.x[targetEid]
      MoveTarget.z[eid] = Position.z[targetEid]
    }
    return true
  }

  // Gather resource (workers only)
  if (targetEid >= 0 && isResource) {
    for (const eid of movable) {
      if (!hasComponent(world, WorkerC, eid)) continue
      WorkerC.state[eid] = 1
      WorkerC.targetNode[eid] = targetEid
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = Position.x[targetEid]
      MoveTarget.z[eid] = Position.z[targetEid]
    }
    return true
  }

  // ── Formation move ─────────────────────────────────────
  const count = movable.length

  // Spacing based on largest unit
  let maxR = 0.5
  for (const eid of movable) {
    if (hasComponent(world, CollisionRadius, eid)) maxR = Math.max(maxR, CollisionRadius.value[eid])
  }
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const spacing = maxR * 2.8

  // Generate slots, skip blocked cells
  const slots: { x: number; z: number }[] = []
  for (let r = 0; r < rows + 5; r++) { // extra rows in case some are blocked
    for (let c = 0; c < cols; c++) {
      if (slots.length >= count) break
      const sx = hitX + (c - (cols - 1) / 2) * spacing
      const sz = hitZ + (r - (rows - 1) / 2) * spacing
      if (isWorldWalkable(sx, sz)) {
        slots.push({ x: sx, z: sz })
      }
    }
    if (slots.length >= count) break
  }

  // Fallback: if not enough walkable slots, fill remaining at target
  while (slots.length < count) {
    slots.push({ x: hitX + (Math.random() - 0.5) * spacing * 2, z: hitZ + (Math.random() - 0.5) * spacing * 2 })
  }

  // Assign by angle (left units → left slots, no crossing)
  const unitA = movable.map(eid => ({
    eid,
    angle: Math.atan2(Position.x[eid] - hitX, Position.z[eid] - hitZ),
  })).sort((a, b) => a.angle - b.angle)

  const slotA = slots.map((s, i) => ({
    idx: i,
    angle: Math.atan2(s.x - hitX, s.z - hitZ),
  })).sort((a, b) => a.angle - b.angle)

  for (let i = 0; i < unitA.length; i++) {
    const eid = unitA[i].eid
    const slot = slots[slotA[i % slotA.length].idx]
    if (hasComponent(world, AttackTarget, eid)) removeComponent(world, AttackTarget, eid)
    if (hasComponent(world, PathFollower, eid)) removeComponent(world, PathFollower, eid)
    addComponent(world, MoveTarget, eid)
    MoveTarget.x[eid] = slot.x
    MoveTarget.z[eid] = slot.z
  }

  return true
}
