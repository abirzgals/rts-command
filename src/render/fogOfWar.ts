/**
 * Fog of War — Starcraft-style visibility system.
 *
 * Three states per cell:
 *  0 = unexplored (black)
 *  1 = explored but not currently visible (semi-dark)
 *  2 = currently visible (full brightness)
 *
 * Uses a low-res texture (FOG_RES x FOG_RES) updated on CPU each frame,
 * sampled in the terrain shader for zero-cost GPU fog rendering.
 */

import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Faction, SightRadius, Dead, IsBuilding, MeshRef, Rotation } from '../ecs/components'
import { FACTION_PLAYER, MAP_SIZE } from '../game/config'
import { getPool } from './meshPools'
import { getAnimManager } from './animatedMeshManager'

// ── Config ──────────────────────────────────────────────────
export const FOG_RES = 128
const FOG_CELL = MAP_SIZE / FOG_RES
const HALF_MAP = MAP_SIZE / 2

// ── Data arrays ─────────────────────────────────────────────
// fogState: persistent map state (0=unexplored, 1=explored, 2=visible)
export const fogState = new Uint8Array(FOG_RES * FOG_RES)

// currentVis: which cells are visible THIS frame (reset each frame)
const currentVis = new Uint8Array(FOG_RES * FOG_RES)

// Texture pixel data (single channel, uploaded to GPU)
const texPixels = new Uint8Array(FOG_RES * FOG_RES)

// ── Three.js texture ────────────────────────────────────────
export let fogTexture: THREE.DataTexture

const sightQuery = defineQuery([Position, SightRadius])
const enemyQuery = defineQuery([Position, Faction, MeshRef])

export function initFogOfWar() {
  fogTexture = new THREE.DataTexture(
    texPixels,
    FOG_RES, FOG_RES,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  )
  fogTexture.minFilter = THREE.LinearFilter
  fogTexture.magFilter = THREE.LinearFilter
  fogTexture.wrapS = THREE.ClampToEdgeWrapping
  fogTexture.wrapT = THREE.ClampToEdgeWrapping
  fogTexture.needsUpdate = true
}

// ── Coordinate conversion ───────────────────────────────────
function worldToFog(w: number): number {
  return Math.floor((w + HALF_MAP) / FOG_CELL)
}

/** Check if a world position is currently visible to the player */
export function isVisibleAt(wx: number, wz: number): boolean {
  const fx = worldToFog(wx)
  const fz = worldToFog(wz)
  if (fx < 0 || fx >= FOG_RES || fz < 0 || fz >= FOG_RES) return false
  return currentVis[fz * FOG_RES + fx] === 1
}

/** Check if a world position has been explored */
export function isExploredAt(wx: number, wz: number): boolean {
  const fx = worldToFog(wx)
  const fz = worldToFog(wz)
  if (fx < 0 || fx >= FOG_RES || fz < 0 || fz >= FOG_RES) return false
  return fogState[fz * FOG_RES + fx] > 0
}

// ── Per-frame update ────────────────────────────────────────
export function updateFogOfWar(world: IWorld) {
  // 1. Clear current visibility
  currentVis.fill(0)

  // 2. Fill visibility circles for player entities
  const entities = sightQuery(world)
  for (const eid of entities) {
    if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== FACTION_PLAYER) continue
    if (hasComponent(world, Dead, eid)) continue

    const wx = Position.x[eid]
    const wz = Position.z[eid]
    const radius = SightRadius.value[eid]

    const cx = worldToFog(wx)
    const cz = worldToFog(wz)
    const fogR = radius / FOG_CELL
    const fogR2 = fogR * fogR
    const intR = Math.ceil(fogR)

    for (let dz = -intR; dz <= intR; dz++) {
      for (let dx = -intR; dx <= intR; dx++) {
        if (dx * dx + dz * dz > fogR2) continue
        const fx = cx + dx
        const fz = cz + dz
        if (fx < 0 || fx >= FOG_RES || fz < 0 || fz >= FOG_RES) continue
        currentVis[fz * FOG_RES + fx] = 1
      }
    }
  }

  // 3. Update fogState + texture pixels
  for (let i = 0; i < FOG_RES * FOG_RES; i++) {
    if (currentVis[i]) {
      fogState[i] = 2
      texPixels[i] = 255  // fully visible
    } else if (fogState[i] === 2) {
      fogState[i] = 1     // was visible, now explored
      texPixels[i] = 100  // semi-dark
    } else if (fogState[i] === 1) {
      texPixels[i] = 100  // still explored
    } else {
      texPixels[i] = 0    // unexplored = black
    }
  }

  // 4. Upload to GPU
  fogTexture.needsUpdate = true

  // 5. Hide/show enemy entities based on visibility
  updateEnemyVisibility(world)
}

// ── Enemy visibility culling ────────────────────────────────
function updateEnemyVisibility(world: IWorld) {
  const entities = enemyQuery(world)

  for (const eid of entities) {
    if (Faction.id[eid] === FACTION_PLAYER) continue
    if (hasComponent(world, Dead, eid)) continue

    const visible = isVisibleAt(Position.x[eid], Position.z[eid])
    const poolId = MeshRef.poolId[eid]

    // Animated mesh managers (units)
    const animMgr = getAnimManager(poolId)
    if (animMgr && animMgr.has(eid)) {
      animMgr.setVisible(eid, visible)
      continue
    }

    // Instanced mesh pools (buildings, resources)
    const pool = getPool(poolId)
    if (pool) {
      if (!visible) {
        // Move off-screen to hide
        pool.updateTransform(eid, 0, -9999, 0, 0)
      } else {
        // Restore real position
        const y = Position.y[eid]
        const rot = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
        pool.updateTransform(eid, Position.x[eid], y, Position.z[eid], rot)
      }
    }
  }
}
