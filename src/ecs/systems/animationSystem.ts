import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, MeshRef, Dead, MoveTarget, AttackTarget,
  WorkerC, PathFollower, Health, Velocity,
} from '../components'
import { getAnimManager } from '../../render/animatedMeshManager'

const animQuery = defineQuery([Position, MeshRef])

/**
 * Chooses the right animation for each animated unit based on ECS state.
 * Run AFTER movement/combat systems, BEFORE render.
 */
export function animationSystem(world: IWorld, _dt: number) {
  const entities = animQuery(world)

  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue

    const poolId = MeshRef.poolId[eid]
    const mgr = getAnimManager(poolId)
    if (!mgr || !mgr.has(eid)) continue

    // Check if unit is moving (has velocity)
    const vx = hasComponent(world, Velocity, eid) ? Velocity.x[eid] : 0
    const vz = hasComponent(world, Velocity, eid) ? Velocity.z[eid] : 0
    const isMoving = (vx * vx + vz * vz) > 0.5

    let anim = 'Idle'

    // Worker-specific animations
    if (hasComponent(world, WorkerC, eid)) {
      const state = WorkerC.state[eid]
      const carrying = WorkerC.carryAmount[eid] > 0

      if (state === 2) {
        anim = 'PickUp'
      } else if (isMoving) {
        anim = carrying ? 'Run_Carry' : 'Run'
      } else {
        anim = 'Idle'
      }
    }
    // Tank (pool 2) — uses Quaternius tank animation names
    else if (poolId === 2) {
      if (isMoving) {
        anim = 'TankArmature|Tank_Forward'
      } else if (hasComponent(world, AttackTarget, eid)) {
        // Tank has no shoot anim — use idle (turret stays still)
        anim = 'TankArmature|Tank_Forward' // slight idle rumble
      } else {
        // No idle animation — just stop at frame 0 of forward
        anim = 'TankArmature|Tank_Forward'
      }
    }
    // Marine / other humanoid
    else if (hasComponent(world, AttackTarget, eid) && !isMoving) {
      anim = 'Shoot_OneHanded'
    }
    else if (isMoving) {
      anim = 'Run'
    }

    // Dying
    if (hasComponent(world, Health, eid) && Health.current[eid] <= 0) {
      anim = poolId === 2 ? 'TankArmature|Tank_Forward' : 'Death'
    }

    mgr.playAnimation(eid, anim)
  }
}
