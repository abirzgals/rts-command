import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Rotation, Faction, Health, AttackC, AttackTarget, MoveTarget,
  Dead, IsBuilding, MoveSpeed, Armor,
} from '../components'
import { spawnProjectile, spawnArcProjectile } from '../archetypes'
import { UnitTypeC } from '../components'
import { UT_TANK, UT_JEEP } from '../../game/config'
import { spawnMuzzleFlash } from '../../render/effects'
import { spatialHash } from '../../globals'
import { editorConfig } from '../../render/meshPools'
import { getAnimManager } from '../../render/animatedMeshManager'
import { MeshRef } from '../components'

const UT_TO_KEY: Record<number, string> = { 0: 'worker', 1: 'marine', 2: 'tank', 3: 'jeep' }

const combatQuery = defineQuery([Position, AttackC, Faction])
const _nearby: number[] = []

export function combatSystem(world: IWorld, dt: number) {
  const entities = combatQuery(world)

  for (const eid of entities) {
    // Tick cooldown
    if (AttackC.timer[eid] > 0) {
      AttackC.timer[eid] -= dt
    }

    const range = AttackC.range[eid]
    const px = Position.x[eid]
    const pz = Position.z[eid]
    const myFaction = Faction.id[eid]

    // If has explicit attack target, try to attack it
    if (hasComponent(world, AttackTarget, eid)) {
      const targetEid = AttackTarget.eid[eid]

      // Check target still alive
      if (hasComponent(world, Dead, targetEid) || !hasComponent(world, Health, targetEid)) {
        removeComponent(world, AttackTarget, eid)
        continue
      }

      const tx = Position.x[targetEid]
      const tz = Position.z[targetEid]
      const dx = tx - px
      const dz = tz - pz
      const dist = Math.sqrt(dx * dx + dz * dz)

      if (dist <= range) {
        // In range — face target and attack
        if (hasComponent(world, MoveTarget, eid) && !hasComponent(world, IsBuilding, eid)) {
          removeComponent(world, MoveTarget, eid)
        }
        // Turn to face the target
        if (hasComponent(world, Rotation, eid) && dist > 0.1) {
          Rotation.y[eid] = Math.atan2(dx, dz)
        }
        tryAttack(world, eid, targetEid, dist)
      } else {
        // Chase — move toward target
        if (!hasComponent(world, IsBuilding, eid) && hasComponent(world, MoveSpeed, eid)) {
          addComponent(world, MoveTarget, eid)
          MoveTarget.x[eid] = tx
          MoveTarget.z[eid] = tz
        }
      }
      continue
    }

    // Auto-acquire: find nearest enemy in range
    spatialHash.query(px, pz, range, _nearby)
    let bestTarget = -1
    let bestDist = Infinity

    for (const other of _nearby) {
      if (other === eid) continue
      if (!hasComponent(world, Faction, other)) continue
      if (Faction.id[other] === myFaction) continue
      if (hasComponent(world, Dead, other)) continue
      if (!hasComponent(world, Health, other)) continue

      const dx = Position.x[other] - px
      const dz = Position.z[other] - pz
      const dist = Math.sqrt(dx * dx + dz * dz)

      if (dist <= range && dist < bestDist) {
        bestDist = dist
        bestTarget = other
      }
    }

    if (bestTarget >= 0) {
      addComponent(world, AttackTarget, eid)
      AttackTarget.eid[eid] = bestTarget

      // Stop moving to engage — attack-move behavior
      if (hasComponent(world, MoveTarget, eid) && !hasComponent(world, IsBuilding, eid)) {
        removeComponent(world, MoveTarget, eid)
      }

      // Face target
      const edx = Position.x[bestTarget] - px
      const edz = Position.z[bestTarget] - pz
      if (hasComponent(world, Rotation, eid) && bestDist > 0.1) {
        Rotation.y[eid] = Math.atan2(edx, edz)
      }

      tryAttack(world, eid, bestTarget, bestDist)
    }
  }
}

function getFirePoint(world: IWorld, attacker: number): { x: number; y: number; z: number } {
  const utId = hasComponent(world, UnitTypeC, attacker) ? UnitTypeC.id[attacker] : -1
  const key = UT_TO_KEY[utId]
  const fp = key ? editorConfig?.[key]?.firePoint : null

  // For animated units with bones, transform the local offset through the bone hierarchy
  if (fp && hasComponent(world, MeshRef, attacker)) {
    const poolId = MeshRef.poolId[attacker]
    const animMgr = getAnimManager(poolId)
    if (animMgr && animMgr.has(attacker)) {
      const worldPos = animMgr.getFirePointWorld(attacker, fp.x ?? 0, fp.y ?? 1.5, fp.z ?? 0, fp.boneName)
      if (worldPos) return { x: worldPos.x, y: worldPos.y, z: worldPos.z }
    }
  }

  // Fallback: simple offset from unit position
  return {
    x: Position.x[attacker] + (fp?.x ?? 0),
    y: Position.y[attacker] + (fp?.y ?? 1.5),
    z: Position.z[attacker] + (fp?.z ?? 0),
  }
}

function tryAttack(world: IWorld, attacker: number, target: number, dist: number) {
  if (AttackC.timer[attacker] > 0) return

  const damage = AttackC.damage[attacker]
  const range = AttackC.range[attacker]
  AttackC.timer[attacker] = AttackC.cooldown[attacker]

  if (range > 2) {
    const px = Position.x[attacker]
    const pz = Position.z[attacker]
    const isTank = hasComponent(world, UnitTypeC, attacker) && UnitTypeC.id[attacker] === UT_TANK
    const splash = AttackC.splash[attacker]
    const fp = getFirePoint(world, attacker)

    if (isTank && splash > 0) {
      // Tank: artillery arc projectile from fire point + barrel recoil
      spawnArcProjectile(world, fp.x, fp.z, target, damage, splash)
      spawnMuzzleFlash(fp.x, fp.y, fp.z)
      const poolId = MeshRef.poolId[attacker]
      const animMgr = getAnimManager(poolId)
      if (animMgr) animMgr.triggerRecoil(attacker)
    } else {
      // Marine/Jeep/other: straight bullet from fire point
      spawnProjectile(world, fp.x, fp.z, target, damage)
      spawnMuzzleFlash(fp.x, fp.y, fp.z)
    }
  } else {
    // Melee: direct damage
    applyDamage(world, target, damage)
  }
}

export function applyDamage(world: IWorld, target: number, damage: number) {
  if (!hasComponent(world, Health, target)) return

  const armor = hasComponent(world, Armor, target) ? Armor.value[target] : 0
  const effective = Math.max(1, damage - armor)

  Health.current[target] -= effective

  if (Health.current[target] <= 0) {
    addComponent(world, Dead, target)
  }
}
