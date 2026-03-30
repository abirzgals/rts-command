/**
 * Command Queue System — processes queued commands when a unit becomes idle.
 *
 * After a unit finishes its current command (no MoveTarget, no AttackTarget,
 * worker idle), the next command in the queue is applied.
 */

import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, MoveTarget, AttackTarget, AttackMove, Velocity,
  IsBuilding, WorkerC, Dead, PathFollower,
  ResourceNode, ResourceDropoff, BuildProgress, Selectable,
} from '../components'
import { shiftCommand, hasQueuedCommands, type Command } from '../commandQueue'
import { spatialHash } from '../../globals'

const idleUnitQuery = defineQuery([Position, Faction])

export function commandQueueSystem(world: IWorld, _dt: number) {
  const entities = idleUnitQuery(world)

  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (!hasQueuedCommands(eid)) continue

    // Check if unit is idle (no active command)
    const hasMoveCmd = hasComponent(world, MoveTarget, eid)
    const hasAttackCmd = hasComponent(world, AttackTarget, eid)
    const isWorkerBusy = hasComponent(world, WorkerC, eid) &&
      WorkerC.state[eid] !== 0 // not idle

    if (hasMoveCmd || hasAttackCmd || isWorkerBusy) continue

    // Unit is idle — pop next command
    const cmd = shiftCommand(eid)
    if (!cmd) continue

    applyCommand(world, eid, cmd)
  }
}

function applyCommand(world: IWorld, eid: number, cmd: Command) {
  switch (cmd.type) {
    case 'move':
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = cmd.x!
      MoveTarget.z[eid] = cmd.z!
      break

    case 'attack':
      if (cmd.targetEid !== undefined) {
        addComponent(world, AttackTarget, eid)
        AttackTarget.eid[eid] = cmd.targetEid
        // Also move toward target
        addComponent(world, MoveTarget, eid)
        MoveTarget.x[eid] = Position.x[cmd.targetEid]
        MoveTarget.z[eid] = Position.z[cmd.targetEid]
      }
      break

    case 'attackMove':
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = cmd.x!
      MoveTarget.z[eid] = cmd.z!
      addComponent(world, AttackMove, eid)
      AttackMove.destX[eid] = cmd.x!
      AttackMove.destZ[eid] = cmd.z!
      break

    case 'gather':
      if (cmd.targetEid !== undefined && hasComponent(world, WorkerC, eid)) {
        WorkerC.state[eid] = 1 // movingToRes
        WorkerC.targetNode[eid] = cmd.targetEid
        // Find nearest dropoff
        const buildingEnts = idleUnitQuery(world)
        let nearestDropoff = 0xFFFFFFFF, nearestDD = Infinity
        for (const bid of buildingEnts) {
          if (!hasComponent(world, IsBuilding, bid)) continue
          if (Faction.id[bid] !== Faction.id[eid]) continue
          if (!hasComponent(world, ResourceDropoff, bid)) continue
          const dd = (Position.x[bid] - Position.x[eid]) ** 2 + (Position.z[bid] - Position.z[eid]) ** 2
          if (dd < nearestDD) { nearestDD = dd; nearestDropoff = bid }
        }
        WorkerC.returnTarget[eid] = nearestDropoff
        addComponent(world, MoveTarget, eid)
        MoveTarget.x[eid] = Position.x[cmd.targetEid]
        MoveTarget.z[eid] = Position.z[cmd.targetEid]
      }
      break

    case 'build':
      if (cmd.targetEid !== undefined && hasComponent(world, WorkerC, eid)) {
        WorkerC.state[eid] = 4 // movingToBuild
        WorkerC.buildTarget[eid] = cmd.targetEid
        const bx = Position.x[cmd.targetEid]
        const bz = Position.z[cmd.targetEid]
        const bRadius = hasComponent(world, Selectable, cmd.targetEid) ? Selectable.radius[cmd.targetEid] : 2.0
        const dx = Position.x[eid] - bx, dz = Position.z[eid] - bz
        const d = Math.sqrt(dx * dx + dz * dz) || 1
        addComponent(world, MoveTarget, eid)
        MoveTarget.x[eid] = bx + (dx / d) * (bRadius + 1.0)
        MoveTarget.z[eid] = bz + (dz / d) * (bRadius + 1.0)
      }
      break
  }
}
