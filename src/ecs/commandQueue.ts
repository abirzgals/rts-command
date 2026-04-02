// ── Command Queue ─────────────────────────────────────────────
// Each entity can have a queue of commands, executed sequentially.
// Shift+click adds to queue; regular click replaces the queue.

export type CommandType = 'move' | 'attack' | 'gather' | 'build' | 'attackMove'

export interface Command {
  type: CommandType
  x?: number       // target position (move, attackMove)
  z?: number
  targetEid?: number  // target entity (attack, gather, build)
}

const queues = new Map<number, Command[]>()

/** Get the full command queue (readonly) */
export function getQueue(eid: number): readonly Command[] {
  return queues.get(eid) || []
}

/** Add a command to the end of the queue */
export function pushCommand(eid: number, cmd: Command) {
  let q = queues.get(eid)
  if (!q) { q = []; queues.set(eid, q) }
  q.push(cmd)
}

/** Clear the queue */
export function clearQueue(eid: number) {
  queues.delete(eid)
}

/** Replace entire queue with a single command */
export function setCommands(eid: number, cmds: Command[]) {
  queues.set(eid, cmds)
}

/** Pop the first command from the queue */
export function shiftCommand(eid: number): Command | undefined {
  const q = queues.get(eid)
  if (!q || q.length === 0) return undefined
  return q.shift()
}

/** Check if entity has queued commands */
export function hasQueuedCommands(eid: number): boolean {
  const q = queues.get(eid)
  return !!q && q.length > 0
}

/** Remove entity entirely (on death) */
export function removeFromQueues(eid: number) {
  queues.delete(eid)
}

// ── Network command application ────────────────────────────────
// Used by multiplayer to replay commands received from the server.

import type { NetCommand, NetworkCommand, ProductionCommand, BuildPlaceCommand } from '../network/netClient'

let netApplyImmediate: ((world: any, eids: number[], cmd: Command) => void) | null = null
let netApplyProduce: ((buildingEid: number, unitType: number) => void) | null = null
let netApplyBuildPlace: ((world: any, type: number, x: number, z: number, faction: number, workerEids: number[]) => void) | null = null

/** Register handlers from input.ts / main.ts (avoids circular imports) */
export function registerNetHandlers(handlers: {
  applyImmediate: (world: any, eids: number[], cmd: Command) => void
  applyProduce: (buildingEid: number, unitType: number) => void
  applyBuildPlace: (world: any, type: number, x: number, z: number, faction: number, workerEids: number[]) => void
}) {
  netApplyImmediate = handlers.applyImmediate
  netApplyProduce = handlers.applyProduce
  netApplyBuildPlace = handlers.applyBuildPlace
}

/** Apply a batch of network commands to the world */
export function applyNetworkCommands(world: any, commands: NetCommand[]) {
  for (const cmd of commands) {
    if ('entityIds' in cmd) {
      // Unit command (move, attack, gather, etc.)
      const nc = cmd as NetworkCommand
      if (nc.replace) {
        // Immediate command — clear queue, apply now
        if (netApplyImmediate) {
          netApplyImmediate(world, nc.entityIds, nc.command)
        }
      } else {
        // Shift-queue — append to queue
        for (const eid of nc.entityIds) {
          pushCommand(eid, nc.command)
        }
      }
    } else if (cmd.type === 'produce') {
      const pc = cmd as ProductionCommand
      if (netApplyProduce) netApplyProduce(pc.buildingEid, pc.unitType)
    } else if (cmd.type === 'build_place') {
      const bp = cmd as BuildPlaceCommand
      if (netApplyBuildPlace) netApplyBuildPlace(world, bp.buildingType, bp.x, bp.z, bp.faction, bp.workerEids)
    }
  }
}
