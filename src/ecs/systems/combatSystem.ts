import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Rotation, Faction, Health, AttackC, AttackTarget, MoveTarget,
  Dead, IsBuilding, MoveSpeed, Armor, PathFollower, Velocity, AttackMove,
  CollisionRadius, UnitMode, MODE_ATTACK_MOVE,
} from '../components'
import { removePath } from '../../pathfinding/pathStore'
import { spawnProjectile, spawnArcProjectile } from '../archetypes'
import { UnitTypeC } from '../components'
import { UT_TANK, UT_JEEP, UT_ROCKET } from '../../game/config'
import { spawnMuzzleFlash, spawnRocketTrail, spawnFireExplosion, spawnSmoke } from '../../render/effects'
import { spatialHash } from '../../globals'
import { editorConfig } from '../../render/meshPools'
import { getAnimManager } from '../../render/animatedMeshManager'
import { isVisibleAt } from '../../render/fogOfWar'
import { FACTION_PLAYER } from '../../game/config'
import { MeshRef } from '../components'

const UT_TO_KEY: Record<number, string> = { 0: 'worker', 1: 'marine', 2: 'tank', 3: 'jeep', 4: 'rocket', 5: 'trooper' }

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
        // If attack-move, resume moving to original destination (keep AttackMove for further engagements)
        if (hasComponent(world, AttackMove, eid)) {
          addComponent(world, MoveTarget, eid)
          MoveTarget.x[eid] = AttackMove.destX[eid]
          MoveTarget.z[eid] = AttackMove.destZ[eid]
        }
        continue
      }

      const tx = Position.x[targetEid]
      const tz = Position.z[targetEid]
      const dx = tx - px
      const dz = tz - pz
      const dist = Math.sqrt(dx * dx + dz * dz)
      // Effective distance = center-to-center minus target's collision radius
      const targetR = hasComponent(world, CollisionRadius, targetEid) ? CollisionRadius.value[targetEid] : 0
      const effectiveDist = Math.max(0, dist - targetR)

      if (effectiveDist <= range) {
        // In range — stop and attack
        if (!hasComponent(world, IsBuilding, eid)) {
          if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
          if (hasComponent(world, PathFollower, eid)) {
            removePath(PathFollower.pathId[eid])
            removeComponent(world, PathFollower, eid)
          }
          Velocity.x[eid] = 0
          Velocity.z[eid] = 0
        }
        // Turn to face the target
        if (hasComponent(world, Rotation, eid) && dist > 0.1) {
          Rotation.y[eid] = Math.atan2(dx, dz)
        }
        tryAttack(world, eid, targetEid, dist)
      } else {
        // Chase — move to attack position (within range of target)
        if (!hasComponent(world, IsBuilding, eid) && hasComponent(world, MoveSpeed, eid)) {
          const targetR = hasComponent(world, CollisionRadius, targetEid) ? CollisionRadius.value[targetEid] : 0
          const atkRange = AttackC.range[eid]
          // Move to within attack range of target edge
          const chaseDist = targetR + Math.max(1.0, atkRange * 0.8)
          const cdx = px - tx, cdz = pz - tz
          const cd = Math.sqrt(cdx * cdx + cdz * cdz) || 1
          addComponent(world, MoveTarget, eid)
          MoveTarget.x[eid] = tx + (cdx / cd) * chaseDist
          MoveTarget.z[eid] = tz + (cdz / cd) * chaseDist
        }
      }
      continue
    }

    // Auto-acquire: skip if moving, unless unit is in attack-move mode
    const isMoving = hasComponent(world, MoveTarget, eid) || hasComponent(world, PathFollower, eid)
    const isAttackMoveMode = hasComponent(world, UnitMode, eid) && UnitMode.mode[eid] === MODE_ATTACK_MOVE
    if (isMoving && !isAttackMoveMode) continue

    spatialHash.query(px, pz, range, _nearby)
    let bestTarget = -1
    let bestDist = Infinity

    for (const other of _nearby) {
      if (other === eid) continue
      if (!hasComponent(world, Faction, other)) continue
      if (Faction.id[other] === myFaction) continue
      if (hasComponent(world, Dead, other)) continue
      if (!hasComponent(world, Health, other)) continue
      // Player units can only auto-acquire visible enemies (not in fog)
      if (myFaction === FACTION_PLAYER && !isVisibleAt(Position.x[other], Position.z[other])) continue

      const dx = Position.x[other] - px
      const dz = Position.z[other] - pz
      const dist = Math.sqrt(dx * dx + dz * dz)
      const otherR = hasComponent(world, CollisionRadius, other) ? CollisionRadius.value[other] : 0
      const eDist = Math.max(0, dist - otherR)

      if (eDist <= range && eDist < bestDist) {
        bestDist = eDist
        bestTarget = other
      }
    }

    if (bestTarget >= 0) {
      addComponent(world, AttackTarget, eid)
      AttackTarget.eid[eid] = bestTarget

      // Stop moving to engage
      if (!hasComponent(world, IsBuilding, eid)) {
        // Save destination for resuming after kill (attack-move)
        if (hasComponent(world, MoveTarget, eid) && !hasComponent(world, AttackMove, eid)) {
          addComponent(world, AttackMove, eid)
          AttackMove.destX[eid] = MoveTarget.x[eid]
          AttackMove.destZ[eid] = MoveTarget.z[eid]
        }
        // Stop movement + clear path
        if (hasComponent(world, MoveTarget, eid)) removeComponent(world, MoveTarget, eid)
        if (hasComponent(world, PathFollower, eid)) {
          removePath(PathFollower.pathId[eid])
          removeComponent(world, PathFollower, eid)
        }
        Velocity.x[eid] = 0
        Velocity.z[eid] = 0
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
  const burstSize = AttackC.burstSize[attacker] || 1

  // Burst fire: use burstDelay between shots, full cooldown after last shot
  if (burstSize > 1) {
    AttackC.burstRemaining[attacker]--
    if (AttackC.burstRemaining[attacker] <= 0) {
      // Burst finished — full reload
      AttackC.timer[attacker] = AttackC.cooldown[attacker]
      AttackC.burstRemaining[attacker] = burstSize
    } else {
      // Next shot in burst
      AttackC.timer[attacker] = AttackC.burstDelay[attacker]
    }
  } else {
    AttackC.timer[attacker] = AttackC.cooldown[attacker]
  }

  if (range > 2) {
    const px = Position.x[attacker]
    const pz = Position.z[attacker]
    const utId = hasComponent(world, UnitTypeC, attacker) ? UnitTypeC.id[attacker] : -1
    const isTank = utId === UT_TANK || utId === UT_ROCKET
    const splash = AttackC.splash[attacker]
    const fp = getFirePoint(world, attacker)

    // Read editor config for projectile type and muzzle
    const key = UT_TO_KEY[utId]
    const muzzleCfg = key ? editorConfig?.[key]?.muzzle : null
    const projCfg = key ? editorConfig?.[key]?.projectile : null
    const useShell = projCfg?.type === 'shell' && splash > 0

    const projType = projCfg?.type ?? (splash > 0 ? 'shell' : 'bullet')
    const projSpeed = projCfg?.speed ?? (projType === 'shell' ? 15 : projType === 'rocket' ? 8 : 25)
    const trailFire = projCfg?.trailFire ?? (projType === 'rocket' ? 3 : 0)
    const trailSmoke = projCfg?.trailSmoke ?? (projType === 'rocket' ? 2 : 0)

    if (projType === 'shell') {
      spawnArcProjectile(world, fp.x, fp.z, target, damage, splash, projCfg?.arcHeight, trailFire, trailSmoke)
      spawnMuzzleFlash(fp.x, fp.y, fp.z, muzzleCfg)
      const poolId = MeshRef.poolId[attacker]
      const animMgr = getAnimManager(poolId)
      if (animMgr) animMgr.triggerRecoil(attacker)
    } else if (projType === 'rocket') {
      spawnArcProjectile(world, fp.x, fp.z, target, damage, splash, projCfg?.arcHeight ?? 2, trailFire, trailSmoke)
      spawnMuzzleFlash(fp.x, fp.y, fp.z, muzzleCfg)
      spawnSmoke(fp.x, fp.y, fp.z, 5)
    } else {
      spawnProjectile(world, fp.x, fp.z, target, damage, projSpeed, { ...projCfg, trailFire, trailSmoke })
      spawnMuzzleFlash(fp.x, fp.y, fp.z, muzzleCfg)
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
