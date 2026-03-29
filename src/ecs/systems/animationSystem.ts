import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, MeshRef, Dead, MoveTarget, AttackTarget,
  WorkerC, PathFollower, Health, Velocity,
} from '../components'
import { getAnimManager } from '../../render/animatedMeshManager'
import { editorConfig } from '../../render/meshPools'

const POOL_TO_KEY: Record<number, string> = { 0: 'worker', 1: 'marine', 2: 'tank', 3: 'jeep' }

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
      } else if (state === 5) {
        anim = 'PickUp' // building animation
      } else if (state === 1 || state === 3 || state === 4 || isMoving) {
        // States 1,3,4 = moving (to resource, returning, to build site)
        anim = carrying ? 'Run_Carry' : 'Run'
      } else {
        anim = 'Idle'
      }
    }
    // Tank (pool 2) — turret rotation handled by renderSystem via bones
    else if (poolId === 2) {
      // New tank model (tank-v3) has no skeletal animations,
      // turret/barrel aiming is done via direct bone manipulation.
      // Try legacy animation names as fallback for idle rumble.
      if (isMoving) {
        anim = 'TankArmature|Tank_Forward'
      } else {
        anim = 'Idle'
      }
    }
    // Marine / other humanoid
    else if (hasComponent(world, AttackTarget, eid) && !isMoving) {
      anim = 'Shoot_OneHanded'
    }
    else if (isMoving) {
      anim = 'Run'
    }

    // Dying — look up death animation from editor config, fallback to 'Death'
    if (hasComponent(world, Health, eid) && Health.current[eid] <= 0) {
      const key = POOL_TO_KEY[poolId]
      const deathEvent = key && editorConfig?.[key]?.events?.find(
        (e: any) => e.type === 'death',
      )
      anim = deathEvent?.animation ?? 'Death'
    }

    mgr.playAnimation(eid, anim)
  }
}
