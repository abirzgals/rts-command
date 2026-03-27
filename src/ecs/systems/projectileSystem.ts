import { defineQuery, hasComponent, addComponent, removeEntity } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Projectile, ArcProjectile, Dead, Health, MeshRef, Faction } from '../components'
import { applyDamage } from './combatSystem'
import { getPool } from '../../render/meshPools'
import { getTerrainHeight } from '../../terrain/heightmap'
import { spatialHash } from '../../globals'
import { spawnExplosion, spawnSmoke, spawnMuzzleFlash } from '../../render/effects'

const projectileQuery = defineQuery([Projectile, Position])
const arcQuery = defineQuery([ArcProjectile, Position])

const HIT_DIST = 0.5

export function projectileSystem(world: IWorld, dt: number) {
  // ── Standard projectiles (marine bullets) ──
  const projectiles = projectileQuery(world)

  for (const eid of projectiles) {
    const targetEid = Projectile.targetEid[eid]

    if (hasComponent(world, Dead, targetEid) || !hasComponent(world, Health, targetEid)) {
      destroyProjectile(world, eid, 30)
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
      applyDamage(world, targetEid, Projectile.damage[eid])
      destroyProjectile(world, eid, 30)
      continue
    }

    const speed = Projectile.speed[eid]
    const step = speed * dt
    const nx = dx / dist
    const ny = dy / dist
    const nz = dz / dist

    Position.x[eid] += nx * step
    Position.y[eid] += ny * step
    Position.z[eid] += nz * step
  }

  // ── Arc projectiles (tank shells) ──
  const arcs = arcQuery(world)

  for (const eid of arcs) {
    ArcProjectile.elapsed[eid] += dt
    const t = ArcProjectile.elapsed[eid] / ArcProjectile.duration[eid]

    if (t >= 1.0) {
      // Impact!
      const tx = ArcProjectile.targetX[eid]
      const tz = ArcProjectile.targetZ[eid]
      const ty = getTerrainHeight(tx, tz)
      const splash = ArcProjectile.splash[eid]
      const damage = ArcProjectile.damage[eid]

      // Explosion effect
      spawnExplosion(tx, ty, tz, splash)

      // Apply splash damage to all nearby enemies
      const targetEid = ArcProjectile.targetEid[eid]
      const attackerFaction = -1 // damage everything near impact

      if (splash > 0) {
        const nearby: number[] = []
        spatialHash.query(tx, tz, splash, nearby)
        for (const other of nearby) {
          if (hasComponent(world, Dead, other)) continue
          if (!hasComponent(world, Health, other)) continue
          const dx = Position.x[other] - tx
          const dz = Position.z[other] - tz
          const dist = Math.sqrt(dx * dx + dz * dz)
          if (dist <= splash) {
            // Damage falloff with distance
            const falloff = 1 - (dist / splash) * 0.5
            applyDamage(world, other, damage * falloff)
          }
        }
      } else {
        // Direct hit on target
        if (hasComponent(world, Health, targetEid) && !hasComponent(world, Dead, targetEid)) {
          applyDamage(world, targetEid, damage)
        }
      }

      destroyProjectile(world, eid, 31)
      continue
    }

    // Parabolic arc: lerp XZ, arc Y
    const sx = ArcProjectile.startX[eid]
    const sz = ArcProjectile.startZ[eid]
    const ex = ArcProjectile.targetX[eid]
    const ez = ArcProjectile.targetZ[eid]

    const x = sx + (ex - sx) * t
    const z = sz + (ez - sz) * t
    const groundY = getTerrainHeight(x, z)

    // Parabolic arc: y = groundY + arcHeight * 4 * t * (1 - t)
    const arcH = ArcProjectile.arcHeight[eid]
    const y = groundY + arcH * 4 * t * (1 - t) + 1.0

    Position.x[eid] = x
    Position.y[eid] = y
    Position.z[eid] = z

    // Spawn smoke trail every few frames
    if (Math.random() < 0.4) {
      spawnSmoke(x, y - 0.3, z, 1)
    }
  }
}

function destroyProjectile(world: IWorld, eid: number, poolId: number) {
  const pool = getPool(poolId)
  if (pool) pool.remove(eid)
  removeEntity(world, eid)
}
