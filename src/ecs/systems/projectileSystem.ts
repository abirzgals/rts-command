import * as THREE from 'three'
import { defineQuery, hasComponent, addComponent, removeEntity } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Projectile, ArcProjectile, Dead, Health, MeshRef, Faction, Rotation, CollisionRadius } from '../components'
import { addComponent as addComp } from 'bitecs'
import { applyDamage } from './combatSystem'
import { playSfx } from '../../audio/audioManager'
import { getPool } from '../../render/meshPools'
import { projectileMeshes, removeProjectileMesh, projectileEffects } from '../archetypes'
import { getTerrainHeight } from '../../terrain/heightmap'
import { spatialHash } from '../../globals'
import { spawnExplosion, spawnSmoke, spawnMuzzleFlash, spawnRocketTrail, spawnFireExplosion, spawnImpact, spawnImpactFlash } from '../../render/effects'
import { profCount } from '../../debug/profiler'

const projectileQuery = defineQuery([Projectile, Position])
const arcQuery = defineQuery([ArcProjectile, Position])

const HIT_DIST = 0.5

export function projectileSystem(world: IWorld, dt: number) {
  // ── Standard projectiles (marine bullets) ──
  const projectiles = projectileQuery(world)
  profCount('projectiles', projectiles.length)

  for (const eid of projectiles) {
    const speed = Projectile.speed[eid]
    const step = speed * dt
    const nx = Projectile.dirX[eid]
    const ny = Projectile.dirY[eid]
    const nz = Projectile.dirZ[eid]

    // Move along fixed direction (all projectiles are directional — can miss)
    Position.x[eid] += nx * step
    Position.y[eid] += ny * step
    Position.z[eid] += nz * step
    Projectile.traveled[eid] += step

    const px = Position.x[eid], py = Position.y[eid], pz = Position.z[eid]

    // Check collision with ENEMY entities along path (pass through allies)
    const projFaction = Projectile.faction[eid]
    const nearby: number[] = []
    spatialHash.query(px, pz, 1.5, nearby)
    let hitEid = -1
    for (const other of nearby) {
      if (hasComponent(world, Dead, other)) continue
      if (!hasComponent(world, Health, other)) continue
      // Skip allies — projectiles pass through own team
      if (hasComponent(world, Faction, other) && Faction.id[other] === projFaction) continue
      const ox = Position.x[other] - px
      const oy = (Position.y[other] + 1.0) - py
      const oz = Position.z[other] - pz
      const d = Math.sqrt(ox * ox + oy * oy + oz * oz)
      const r = hasComponent(world, CollisionRadius, other) ? CollisionRadius.value[other] : 0.5
      if (d < r + HIT_DIST) { hitEid = other; break }
    }

    if (hitEid >= 0) {
      applyDamage(world, hitEid, Projectile.damage[eid], px, pz)
      const fx = projectileEffects.get(eid)
      spawnImpact(px, py, pz, fx?.impact)
      spawnImpactFlash(px, py, pz)
      projectileEffects.delete(eid)
      destroyProjectile(world, eid, 30)
      continue
    }

    // Hit ground (only after traveling a minimum distance to avoid instant ground hits)
    const groundY = getTerrainHeight(px, pz)
    if (Projectile.traveled[eid] > 1.0 && py <= groundY + 0.1) {
      const fx = projectileEffects.get(eid)
      spawnImpact(px, groundY, pz, fx?.impact)
      spawnImpactFlash(px, groundY + 0.1, pz)
      projectileEffects.delete(eid)
      destroyProjectile(world, eid, 30)
      continue
    }

    // Max range reached — disappear
    if (Projectile.traveled[eid] >= Projectile.maxRange[eid]) {
      projectileEffects.delete(eid)
      destroyProjectile(world, eid, 30)
      continue
    }

    // Update tracer line: front = current position, tail = behind (max 2m, clamped to spawn)
    const projLine = projectileMeshes.get(eid)
    if (projLine && (projLine as any).isLine) {
      const geo = (projLine as THREE.Line).geometry as THREE.BufferGeometry
      const posAttr = geo.attributes.position as THREE.BufferAttribute
      const TRACER_LEN = 2.0
      const traveled = Projectile.traveled[eid]
      const tailDist = Math.min(traveled, TRACER_LEN)
      // Front point = current projectile world position
      posAttr.setXYZ(0, px, py, pz)
      // Tail point = behind the bullet along its direction
      const tailX = px - nx * tailDist
      const tailY = py - ny * tailDist
      const tailZ = pz - nz * tailDist
      posAttr.setXYZ(1, tailX, tailY, tailZ)
      posAttr.needsUpdate = true
      // Force bounding sphere recalculation
      geo.computeBoundingSphere()
    }

    // Trail effects from config
    const tFire = Projectile.trailFire[eid]
    const tSmoke = Projectile.trailSmoke[eid]
    if (tFire > 0) {
      spawnRocketTrail(Position.x[eid] - nx * 0.3, Position.y[eid] - ny * 0.3, Position.z[eid] - nz * 0.3, tFire)
    }
    if (tSmoke > 0) {
      spawnSmoke(Position.x[eid] - nx * 0.3, Position.y[eid] - ny * 0.3, Position.z[eid] - nz * 0.3, tSmoke)
    }
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

      // Explosion effect from config
      const fx = projectileEffects.get(eid)
      const hasFire = ArcProjectile.trailFire[eid] > 0 || ArcProjectile.arcHeight[eid] <= 3
      const explRadius = fx?.explosion?.radius ?? splash
      if (hasFire) {
        spawnFireExplosion(tx, ty, tz, explRadius + 1)
      } else {
        spawnExplosion(tx, ty, tz, explRadius)
      }
      playSfx('explosion')
      projectileEffects.delete(eid)

      // Apply splash damage to all nearby enemies
      const targetEid = ArcProjectile.targetEid[eid]
      const srcX = ArcProjectile.startX[eid]
      const srcZ = ArcProjectile.startZ[eid]

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
            applyDamage(world, other, damage * falloff, srcX, srcZ)
          }
        }
      } else {
        // Direct hit on target
        if (hasComponent(world, Health, targetEid) && !hasComponent(world, Dead, targetEid)) {
          applyDamage(world, targetEid, damage, srcX, srcZ)
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

    // Orient projectile along trajectory tangent (XZ direction)
    const dirX = ex - sx
    const dirZ = ez - sz
    if (dirX !== 0 || dirZ !== 0) {
      if (!hasComponent(world, Rotation, eid)) addComp(world, Rotation, eid)
      Rotation.y[eid] = Math.atan2(dirX, dirZ)
    }

    // Trail effects from config
    const tFire = ArcProjectile.trailFire[eid]
    const tSmoke = ArcProjectile.trailSmoke[eid]
    if (tFire > 0) {
      spawnRocketTrail(x, y - 0.2, z, tFire)
    } else if (arcH <= 3) {
      // Fallback: rocket-like trail for low arc if no explicit config
      spawnRocketTrail(x, y - 0.2, z)
    }
    if (tSmoke > 0) {
      spawnSmoke(x, y - 0.3, z, tSmoke)
    } else if (arcH > 3 && Math.random() < 0.4) {
      // Fallback: occasional smoke puff for shells
      spawnSmoke(x, y - 0.3, z, 1)
    }
  }
}

function destroyProjectile(world: IWorld, eid: number, poolId: number) {
  projectileEffects.delete(eid)
  // Individual mesh projectile (poolId=255)
  if (projectileMeshes.has(eid)) {
    removeProjectileMesh(eid)
  } else {
    const pool = getPool(poolId)
    if (pool) pool.remove(eid)
  }
  removeEntity(world, eid)
}
