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
    // Fill everything as visible
    fogState.fill(2)
    texPixels.fill(255)
    if (fogTexture) fogTexture.needsUpdate = true
  } else if (mode === 'revealed') {
    // Mark all as explored (not currently visible, but seen)
    for (let i = 0; i < FOG_RES * FOG_RES; i++) {
      if (fogState[i] === 0) fogState[i] = 1
    }
  }
}

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
  // Disabled mode: everything visible, no enemy hiding
  if (fogMode === 'disabled') return

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
    } else if (fogState[i] === 1 || fogMode === 'revealed') {
      fogState[i] = 1
      texPixels[i] = 100  // explored (revealed mode: everything starts explored)
    } else {
      texPixels[i] = 0    // unexplored = black
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
    if (Faction.id[eid] === FACTION_PLAYER) continue
    if (hasComponent(world, Dead, eid)) continue

    const wx = Position.x[eid], wz = Position.z[eid]
    const visible = isVisibleAt(wx, wz)
    const explored = isExploredAt(wx, wz)
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
      // Buildings: show if explored (snapshot behavior)
      // Units/resources: show only if currently visible
      const show = isBuilding ? explored : visible

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
