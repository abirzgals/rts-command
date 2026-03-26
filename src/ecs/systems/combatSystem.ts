import { defineQuery, hasComponent, addComponent, removeComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, Health, AttackC, AttackTarget, MoveTarget,
  Dead, IsBuilding, MoveSpeed, Armor,
} from '../components'
import { spawnProjectile } from '../archetypes'
import { spatialHash } from '../../globals'

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
        // In range — attack
        if (hasComponent(world, MoveTarget, eid) && !hasComponent(world, IsBuilding, eid)) {
          removeComponent(world, MoveTarget, eid)
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
      tryAttack(world, eid, bestTarget, bestDist)
    }
  }
}

function tryAttack(world: IWorld, attacker: number, target: number, dist: number) {
  if (AttackC.timer[attacker] > 0) return

  const damage = AttackC.damage[attacker]
  const range = AttackC.range[attacker]
  AttackC.timer[attacker] = AttackC.cooldown[attacker]

  if (range > 2) {
    // Ranged: spawn projectile
    spawnProjectile(world, Position.x[attacker], Position.z[attacker], target, damage)
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
