import { defineQuery, hasComponent, addComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Projectile, Dead, Health } from '../components'
import { applyDamage } from './combatSystem'
import { getPool } from '../../render/meshPools'
import { removeEntity } from 'bitecs'

const projectileQuery = defineQuery([Projectile, Position])

const HIT_DIST = 0.5

export function projectileSystem(world: IWorld, dt: number) {
  const projectiles = projectileQuery(world)

  for (const eid of projectiles) {
    const targetEid = Projectile.targetEid[eid]

    // If target is dead/gone, remove projectile
    if (hasComponent(world, Dead, targetEid) || !hasComponent(world, Health, targetEid)) {
      destroyProjectile(world, eid)
      continue
    }

    const tx = Position.x[targetEid]
    const ty = Position.y[targetEid]
    const tz = Position.z[targetEid]

    const dx = tx - Position.x[eid]
    const dy = ty - Position.y[eid]
    const dz = tz - Position.z[eid]
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

    if (dist < HIT_DIST) {
      // Hit!
      applyDamage(world, targetEid, Projectile.damage[eid])
      destroyProjectile(world, eid)
      continue
    }

    // Move toward target
    const speed = Projectile.speed[eid]
    const step = speed * dt
    const nx = dx / dist
    const ny = dy / dist
    const nz = dz / dist

    Position.x[eid] += nx * step
    Position.y[eid] += ny * step
    Position.z[eid] += nz * step
  }
}

function destroyProjectile(world: IWorld, eid: number) {
  // Remove from mesh pool
  const pool = getPool(30)
  if (pool) pool.remove(eid)
  removeEntity(world, eid)
}
