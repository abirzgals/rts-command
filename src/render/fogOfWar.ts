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

// ── Settings ────────────────────────────────────────────────
export type FogMode = 'normal' | 'revealed' | 'disabled'
export let fogMode: FogMode = 'normal'

export function setFogMode(mode: FogMode) {
  fogMode = mode
  if (mode === 'disabled') {
    // Fill everything as visible for both factions
    for (const s of fogStateByFaction) s.fill(2)
    texPixels.fill(255)
    if (fogTexture) fogTexture.needsUpdate = true
  } else if (mode === 'revealed') {
    // Mark all as explored for both factions
    for (const s of fogStateByFaction) {
      for (let i = 0; i < FOG_RES * FOG_RES; i++) {
        if (s[i] === 0) s[i] = 1
      }
    }
  }
}

// ── Config ──────────────────────────────────────────────────
export const FOG_RES = 128
const FOG_CELL = MAP_SIZE / FOG_RES
const HALF_MAP = MAP_SIZE / 2

// ── Data arrays ─────────────────────────────────────────────
// Per-faction fog state (0=unexplored, 1=explored, 2=visible)
const fogStateByFaction: Uint8Array[] = [
  new Uint8Array(FOG_RES * FOG_RES), // FACTION_PLAYER (0)
  new Uint8Array(FOG_RES * FOG_RES), // FACTION_ENEMY (1)
]

// Active fog state — points to the current player's fog
export let fogState = fogStateByFaction[FACTION_PLAYER]

// Per-faction current visibility this frame
const currentVisByFaction: Uint8Array[] = [
  new Uint8Array(FOG_RES * FOG_RES),
  new Uint8Array(FOG_RES * FOG_RES),
]
let currentVis = currentVisByFaction[FACTION_PLAYER]

// Which faction the fog is rendered for
let fogViewFaction = FACTION_PLAYER

// Texture pixel data (single channel, uploaded to GPU)
const texPixels = new Uint8Array(FOG_RES * FOG_RES)

/** Swap which faction's fog is rendered (call after team swap) */
export function setFogViewFaction(faction: number) {
  fogViewFaction = faction
  fogState = fogStateByFaction[faction]
  currentVis = currentVisByFaction[faction]
}

/** Swap fog data between factions (call when teams are swapped) */
export function swapFogData() {
  const size = FOG_RES * FOG_RES
  // Swap fog state arrays content
  const tmpState = new Uint8Array(size)
  tmpState.set(fogStateByFaction[0])
  fogStateByFaction[0].set(fogStateByFaction[1])
  fogStateByFaction[1].set(tmpState)
  // Swap current visibility
  const tmpVis = new Uint8Array(size)
  tmpVis.set(currentVisByFaction[0])
  currentVisByFaction[0].set(currentVisByFaction[1])
  currentVisByFaction[1].set(tmpVis)
  // Update references
  fogState = fogStateByFaction[fogViewFaction]
  currentVis = currentVisByFaction[fogViewFaction]
  // Clear seen buildings cache
  seenBuildings.clear()
}

// ── Three.js texture ────────────────────────────────────────
export let fogTexture: THREE.DataTexture

const sightQuery = defineQuery([Position, SightRadius])
const enemyQuery = defineQuery([Position, Faction, MeshRef])

// ── Fog overlay (fullscreen quad darkens everything) ────────
export let fogOverlayScene: THREE.Scene
export let fogOverlayCamera: THREE.OrthographicCamera
let fogOverlayMaterial: THREE.ShaderMaterial

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

  // Fullscreen overlay quad
  fogOverlayScene = new THREE.Scene()
  fogOverlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

  fogOverlayMaterial = new THREE.ShaderMaterial({
    uniforms: {
      fogMap: { value: fogTexture },
      invViewProj: { value: new THREE.Matrix4() },
      mapSize: { value: MAP_SIZE },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUV;
      void main() {
        vUV = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D fogMap;
      uniform mat4 invViewProj;
      uniform float mapSize;
      varying vec2 vUV;

      void main() {
        // Reconstruct world XZ from screen position via ray-plane intersection
        vec4 ndc = vec4(vUV * 2.0 - 1.0, -1.0, 1.0);
        vec4 nearW = invViewProj * ndc;
        nearW /= nearW.w;
        vec4 farNdc = vec4(vUV * 2.0 - 1.0, 1.0, 1.0);
        vec4 farW = invViewProj * farNdc;
        farW /= farW.w;

        vec3 dir = normalize(farW.xyz - nearW.xyz);
        // Intersect with Y=0 plane (approximate ground)
        float t = -nearW.y / dir.y;
        if (t < 0.0) discard;

        vec3 worldPos = nearW.xyz + dir * t;
        vec2 fogUV = (worldPos.xz + mapSize * 0.5) / mapSize;
        fogUV = clamp(fogUV, 0.0, 1.0);

        float fogVal = texture2D(fogMap, fogUV).r;
        // unexplored: 65% dark, explored: 30% dark, visible: transparent
        float alpha = fogVal > 0.5 ? 0.0 : fogVal > 0.01 ? 0.30 : 0.65;
        gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })

  const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    fogOverlayMaterial,
  )
  fogOverlayScene.add(quad)
}

// ── Coordinate conversion ───────────────────────────────────
function worldToFog(w: number): number {
  return Math.floor((w + HALF_MAP) / FOG_CELL)
}

/** Check if a world position is currently visible to a faction (default: view faction) */
export function isVisibleAt(wx: number, wz: number, faction?: number): boolean {
  const fx = worldToFog(wx)
  const fz = worldToFog(wz)
  if (fx < 0 || fx >= FOG_RES || fz < 0 || fz >= FOG_RES) return false
  const vis = faction !== undefined ? currentVisByFaction[faction] : currentVisByFaction[fogViewFaction]
  return vis[fz * FOG_RES + fx] === 1
}

/** Check if a world position has been explored by a faction (default: view faction) */
export function isExploredAt(wx: number, wz: number, faction?: number): boolean {
  const fx = worldToFog(wx)
  const fz = worldToFog(wz)
  if (fx < 0 || fx >= FOG_RES || fz < 0 || fz >= FOG_RES) return false
  const state = faction !== undefined ? fogStateByFaction[faction] : fogStateByFaction[fogViewFaction]
  return state[fz * FOG_RES + fx] > 0
}

// ── Per-frame update ────────────────────────────────────────
export function updateFogOfWar(world: IWorld) {
  // Disabled mode: everything visible, no enemy hiding
  if (fogMode === 'disabled') return

  // 1. Update visibility for BOTH factions
  const entities = sightQuery(world)
  for (let faction = 0; faction <= 1; faction++) {
    const vis = currentVisByFaction[faction]
    const state = fogStateByFaction[faction]
    vis.fill(0)

    // Fill visibility circles for this faction's entities
    for (const eid of entities) {
      if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== faction) continue
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
          vis[fz * FOG_RES + fx] = 1
        }
      }
    }

    // Update fog state for this faction
    for (let i = 0; i < FOG_RES * FOG_RES; i++) {
      if (vis[i]) {
        state[i] = 2
      } else if (state[i] === 2) {
        state[i] = 1
      } else if (fogMode === 'revealed' && state[i] === 0) {
        state[i] = 1
      }
    }
  }

  // 2. Build texture pixels from the VIEW faction's fog
  const viewState = fogStateByFaction[fogViewFaction]
  for (let i = 0; i < FOG_RES * FOG_RES; i++) {
    if (viewState[i] === 2) {
      texPixels[i] = 255
    } else if (viewState[i] === 1) {
      texPixels[i] = 100
    } else {
      texPixels[i] = 0
    }
  }

  // 4. Upload to GPU
  fogTexture.needsUpdate = true

  // 5. Hide/show enemy entities based on visibility
  updateEnemyVisibility(world)
}

/** Call after renderer.render(scene, camera) to apply fog overlay */
export function renderFogOverlay(rendererRef: THREE.WebGLRenderer, cam: THREE.Camera) {
  if (!fogOverlayMaterial || !fogOverlayScene || fogMode === 'disabled') return

  // Update inverse view-projection matrix for world reconstruction
  const vp = new THREE.Matrix4()
  vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  fogOverlayMaterial.uniforms.invViewProj.value.copy(vp).invert()

  rendererRef.autoClear = false
  rendererRef.render(fogOverlayScene, fogOverlayCamera)
  rendererRef.autoClear = true
}

// ── Enemy visibility culling ────────────────────────────────

// Track which enemy buildings have been "seen" by the player
const seenBuildings = new Set<number>()

// Snapshots: enemy buildings last seen in fog — kept visible until re-explored
interface FogSnapshot {
  poolId: number
  x: number; y: number; z: number; rot: number
  idx: number // instanced mesh index
}
const fogSnapshots = new Map<number, FogSnapshot>() // fog cell index → snapshot

/** Called by death system when an enemy building dies */
export function onEnemyBuildingDeath(eid: number, world: IWorld) {
  const wx = Position.x[eid], wz = Position.z[eid]
  if (isVisibleAt(wx, wz)) return // player can see it die — no snapshot needed

  if (!isExploredAt(wx, wz)) return // never seen — no snapshot

  // Create snapshot: keep the mesh in place as a ghost
  const poolId = MeshRef.poolId[eid]
  const pool = getPool(poolId)
  if (!pool) return

  const fogIdx = worldToFog(wz) * FOG_RES + worldToFog(wx)
  fogSnapshots.set(fogIdx, {
    poolId,
    x: wx, y: Position.y[eid], z: wz,
    rot: hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0,
    idx: pool.getIndex(eid),
  })
}

function updateEnemyVisibility(world: IWorld) {
  const entities = enemyQuery(world)

  for (const eid of entities) {
    // Skip entities belonging to the view faction (our own units — always visible)
    if (Faction.id[eid] === fogViewFaction) continue
    if (hasComponent(world, Dead, eid)) continue

    const wx = Position.x[eid], wz = Position.z[eid]
    const visible = isVisibleAt(wx, wz, fogViewFaction)
    const explored = isExploredAt(wx, wz, fogViewFaction)
    const isBuilding = hasComponent(world, IsBuilding, eid)
    const poolId = MeshRef.poolId[eid]

    // Animated mesh managers (units) — only show if currently visible
    const animMgr = getAnimManager(poolId)
    if (animMgr && animMgr.has(eid)) {
      animMgr.setVisible(eid, visible)
      continue
    }

    // Instanced mesh pools (buildings, resources)
    const pool = getPool(poolId)
    if (pool) {
      let show = false
      if (isBuilding) {
        // Buildings: show if currently visible OR if previously seen (snapshot)
        if (visible) { seenBuildings.add(eid); show = true }
        else if (seenBuildings.has(eid) && explored) { show = true }
      } else {
        show = visible
      }

      if (!show) {
        pool.updateTransform(eid, 0, -9999, 0, 0)
      } else {
        const y = Position.y[eid]
        const rot = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0
        pool.updateTransform(eid, wx, y, wz, rot)
      }
    }
  }

  // Clean up snapshots: remove ghost buildings when area is re-explored
  for (const [fogIdx, snap] of fogSnapshots) {
    const fx = fogIdx % FOG_RES
    const fz = Math.floor(fogIdx / FOG_RES)
    if (currentVis[fogIdx]) {
      // Player can see this cell now — remove the ghost
      fogSnapshots.delete(fogIdx)
    }
  }
}
