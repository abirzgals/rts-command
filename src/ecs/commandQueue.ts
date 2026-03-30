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
