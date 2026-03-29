import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, WorkerC, ResourceNode, MoveTarget,
  MoveSpeed, ResourceDropoff, Dead, PathFollower, BuildProgress, IsBuilding,
  CollisionRadius, Selectable,
} from '../components'
import { gameState } from '../../game/state'
import { spatialHash } from '../../globals'
import { removePath } from '../../pathfinding/pathStore'

/** Clear any existing path before setting a new MoveTarget */
function clearPath(world: import('bitecs').IWorld, eid: number) {
  if (hasComponent(world, PathFollower, eid)) {
    removePath(PathFollower.pathId[eid])
    removeComponent(world, PathFollower, eid)
  }
}

const workerQuery = defineQuery([WorkerC, Position, Faction])
const dropoffQuery = defineQuery([ResourceDropoff, Position, Faction])

const GATHER_RANGE = 2.5
const DROPOFF_RANGE = 4.0

/** Move target to the EDGE of a building (not center which is blocked) */
function moveToEntityEdge(world: IWorld, workerEid: number, targetEid: number) {
  const tx = Position.x[targetEid]
  const tz = Position.z[targetEid]
  const wx = Position.x[workerEid]
  const wz = Position.z[workerEid]

  // Get the building radius
  let radius = 1.0
  if (hasComponent(world, Selectable, targetEid)) radius = Selectable.radius[targetEid]
  else if (hasComponent(world, CollisionRadius, targetEid)) radius = CollisionRadius.value[targetEid]

  // Direction from building to worker
  const dx = wx - tx
  const dz = wz - tz
  const dist = Math.sqrt(dx * dx + dz * dz)

  clearPath(world, workerEid)
  addComponent(world, MoveTarget, workerEid)

  if (dist > 0.1) {
    // Target point on the edge of the building, facing the worker
    const nx = dx / dist
    const nz = dz / dist
    MoveTarget.x[workerEid] = tx + nx * (radius + 1.0)
    MoveTarget.z[workerEid] = tz + nz * (radius + 1.0)
  } else {
    // Worker is at center — pick any edge point
    MoveTarget.x[workerEid] = tx + radius + 1.0
    MoveTarget.z[workerEid] = tz
  }
}
const GATHER_AMOUNT = 5
const GATHER_TIME = 1.5 // seconds per gather tick

// Sentinel for "no entity" — entity IDs start at 0 in bitECS, so we can't use 0
const NONE = 0xFFFFFFFF

export function resourceSystem(world: IWorld, dt: number) {
  const workers = workerQuery(world)

  for (const eid of workers) {
    const state = WorkerC.state[eid]

    switch (state) {
      case 0: // idle — try to find nearby resource
        autoFindResource(world, eid)
        break

      case 1: // moving to resource
        moveToResource(world, eid)
        break

      case 2: // gathering
        gather(world, eid, dt)
        break

      case 3: // returning with cargo
        returnCargo(world, eid)
        break

      case 4: // moving to construction site
        moveToBuild(world, eid)
        break

      case 5: // actively building
        activelyBuild(world, eid)
        break
    }
  }
}

function isValidEntity(eid: number): boolean {
  return eid !== NONE && eid < 0xFFFFFFFE
}

function autoFindResource(world: IWorld, eid: number) {
  const px = Position.x[eid]
  const pz = Position.z[eid]
  const nearby: number[] = []
  spatialHash.query(px, pz, 30, nearby)

  let bestNode = -1
  let bestDist = Infinity

  for (const other of nearby) {
    if (!hasComponent(world, ResourceNode, other)) continue
    if (hasComponent(world, Dead, other)) continue
    if (ResourceNode.amount[other] <= 0) continue

    const dx = Position.x[other] - px
    const dz = Position.z[other] - pz
    const dist = dx * dx + dz * dz

    if (dist < bestDist) {
      bestDist = dist
      bestNode = other
    }
  }

  if (bestNode >= 0) {
    WorkerC.state[eid] = 1
    WorkerC.targetNode[eid] = bestNode

    // Find nearest dropoff
    findDropoff(world, eid)

    clearPath(world, eid)
    addComponent(world, MoveTarget, eid)
    MoveTarget.x[eid] = Position.x[bestNode]
    MoveTarget.z[eid] = Position.z[bestNode]
  }
}

function moveToResource(world: IWorld, eid: number) {
  const nodeEid = WorkerC.targetNode[eid]

  // Check if node still valid
  if (!hasComponent(world, ResourceNode, nodeEid) || hasComponent(world, Dead, nodeEid) || ResourceNode.amount[nodeEid] <= 0) {
    WorkerC.state[eid] = 0 // go idle, will re-search
    if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
    return
  }

  // Check if close enough to start gathering
  const dx = Position.x[eid] - Position.x[nodeEid]
  const dz = Position.z[eid] - Position.z[nodeEid]
  const dist = Math.sqrt(dx * dx + dz * dz)

  if (dist <= GATHER_RANGE) {
    WorkerC.state[eid] = 2 // gathering
    WorkerC.gatherTimer[eid] = 0
    if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
  } else if (!hasComponent(world, MoveTarget, eid) && !hasComponent(world, PathFollower, eid)) {
    // Worker lost its path/target (e.g. dynamic obstacle blocked it) — re-issue move
    addComponent(world, MoveTarget, eid)
    MoveTarget.x[eid] = Position.x[nodeEid]
    MoveTarget.z[eid] = Position.z[nodeEid]
  }
}

function gather(world: IWorld, eid: number, dt: number) {
  const nodeEid = WorkerC.targetNode[eid]

  if (!hasComponent(world, ResourceNode, nodeEid) || hasComponent(world, Dead, nodeEid) || ResourceNode.amount[nodeEid] <= 0) {
    if (WorkerC.carryAmount[eid] > 0) {
      WorkerC.state[eid] = 3
      moveToDropoff(world, eid)
    } else {
      WorkerC.state[eid] = 0
    }
    return
  }

  WorkerC.gatherTimer[eid] += dt

  if (WorkerC.gatherTimer[eid] >= GATHER_TIME) {
    WorkerC.gatherTimer[eid] = 0

    const amount = Math.min(GATHER_AMOUNT, ResourceNode.amount[nodeEid])
    ResourceNode.amount[nodeEid] -= amount
    WorkerC.carryAmount[eid] += amount
    WorkerC.carryType[eid] = ResourceNode.type[nodeEid]

    // Worker carries up to a full load then returns
    if (WorkerC.carryAmount[eid] >= GATHER_AMOUNT * 2) {
      WorkerC.state[eid] = 3
      moveToDropoff(world, eid)
    }
  }
}

function returnCargo(world: IWorld, eid: number) {
  const dropoff = WorkerC.returnTarget[eid]
  if (!isValidEntity(dropoff) || hasComponent(world, Dead, dropoff)) {
    findDropoff(world, eid)
    if (!isValidEntity(WorkerC.returnTarget[eid])) {
      WorkerC.state[eid] = 0
      return
    }
  }

  const target = WorkerC.returnTarget[eid]
  const dx = Position.x[eid] - Position.x[target]
  const dz = Position.z[eid] - Position.z[target]
  const dist = Math.sqrt(dx * dx + dz * dz)

  if (dist <= DROPOFF_RANGE) {
    // Deposit resources
    const faction = Faction.id[eid]
    gameState.addResources(faction, WorkerC.carryType[eid], WorkerC.carryAmount[eid])
    WorkerC.carryAmount[eid] = 0

    // Go back to gather
    const nodeEid = WorkerC.targetNode[eid]
    if (hasComponent(world, ResourceNode, nodeEid) && ResourceNode.amount[nodeEid] > 0 && !hasComponent(world, Dead, nodeEid)) {
      WorkerC.state[eid] = 1
      clearPath(world, eid)
      addComponent(world, MoveTarget, eid)
      MoveTarget.x[eid] = Position.x[nodeEid]
      MoveTarget.z[eid] = Position.z[nodeEid]
    } else {
      WorkerC.state[eid] = 0
    }
  } else if (!hasComponent(world, MoveTarget, eid) && !hasComponent(world, PathFollower, eid)) {
    // Worker lost path while returning — re-issue move to dropoff
    moveToDropoff(world, eid)
  }
}

function moveToDropoff(world: IWorld, eid: number) {
  const dropoff = WorkerC.returnTarget[eid]
  if (!isValidEntity(dropoff) || hasComponent(world, Dead, dropoff)) {
    findDropoff(world, eid)
  }

  const target = WorkerC.returnTarget[eid]
  if (isValidEntity(target)) {
    moveToEntityEdge(world, eid, target)
  }
}

function findDropoff(world: IWorld, eid: number) {
  const faction = Faction.id[eid]
  const dropoffs = dropoffQuery(world)
  let nearest = NONE
  let nearestDist = Infinity

  for (const bid of dropoffs) {
    if (Faction.id[bid] !== faction) continue
    const dx = Position.x[bid] - Position.x[eid]
    const dz = Position.z[bid] - Position.z[eid]
    const dist = dx * dx + dz * dz
    if (dist < nearestDist) {
      nearestDist = dist
      nearest = bid
    }
  }

  WorkerC.returnTarget[eid] = nearest
}

// ── Worker state 4: moving to construction site ──────────────

const BUILD_RANGE = 3.5

function moveToBuild(world: IWorld, eid: number) {
  const target = WorkerC.buildTarget[eid]

  // Check if building still exists and is under construction
  if (!isValidEntity(target) || hasComponent(world, Dead, target) || !hasComponent(world, BuildProgress, target)) {
    WorkerC.state[eid] = 0 // building finished or destroyed → idle
    WorkerC.buildTarget[eid] = NONE
    return
  }

  // Check distance to building
  const dx = Position.x[target] - Position.x[eid]
  const dz = Position.z[target] - Position.z[eid]
  const dist = Math.sqrt(dx * dx + dz * dz)

  if (dist < BUILD_RANGE) {
    // Arrived — start building
    WorkerC.state[eid] = 5
    // Stop moving
    if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
    clearPath(world, eid)
  } else if (!hasComponent(world, MoveTarget, eid) && !hasComponent(world, PathFollower, eid)) {
    // Lost path — re-issue move to building EDGE (center is blocked)
    moveToEntityEdge(world, eid, target)
  }
}

// ── Worker state 5: actively building ────────────────────────

function activelyBuild(world: IWorld, eid: number) {
  const target = WorkerC.buildTarget[eid]

  // Check if building still needs construction
  if (!isValidEntity(target) || hasComponent(world, Dead, target) || !hasComponent(world, BuildProgress, target)) {
    WorkerC.state[eid] = 0 // done or destroyed → idle
    WorkerC.buildTarget[eid] = NONE
    return
  }

  // Check distance — if pushed away, go back
  const dx = Position.x[target] - Position.x[eid]
  const dz = Position.z[target] - Position.z[eid]
  if (dx * dx + dz * dz > BUILD_RANGE * BUILD_RANGE * 1.5) {
    WorkerC.state[eid] = 4 // too far — walk back
    addComponent(world, MoveTarget, eid)
    MoveTarget.x[eid] = Position.x[target]
    MoveTarget.z[eid] = Position.z[target]
    return
  }

  // Face the building (rotation handled by movement system)
}
