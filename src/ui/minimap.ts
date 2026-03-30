import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Faction, IsBuilding, ResourceNode, Dead, Health, UnitTypeC } from '../ecs/components'
import { MAP_SIZE, FACTION_PLAYER, FACTION_ENEMY } from '../game/config'
import { camera } from '../render/engine'
import { GRID_RES, terrainType, T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS } from '../terrain/heightmap'
import { fogState, FOG_RES, isVisibleAt } from '../render/fogOfWar'
import * as THREE from 'three'

const canvas = document.getElementById('minimap') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

const unitQuery = defineQuery([Position, Faction, Health])
const resourceQuery = defineQuery([Position, ResourceNode])

let lastDraw = 0
const DRAW_INTERVAL = 150
let terrainImageData: ImageData | null = null

const terrainColors: Record<number, [number, number, number]> = {
  [T_GRASS]: [40, 100, 45],
  [T_DARK_GRASS]: [30, 80, 35],
  [T_DIRT]: [130, 98, 58],
  [T_ROCK]: [108, 102, 95],
  [T_WATER]: [22, 55, 110],
  [T_CLIFF]: [80, 70, 62],
}

function buildTerrainImage(w: number, h: number) {
  terrainImageData = ctx.createImageData(w, h)
  const d = terrainImageData.data

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const gx = Math.floor((px / w) * GRID_RES)
      const gz = Math.floor((py / h) * GRID_RES)
      const type = terrainType[gz * GRID_RES + gx]
      let [r, g, b] = terrainColors[type] || [40, 100, 45]

      // Apply fog of war darkening
      const fx = Math.floor((px / w) * FOG_RES)
      const fz = Math.floor((py / h) * FOG_RES)
      const fog = fogState[fz * FOG_RES + fx]
      if (fog === 0) {
        // Unexplored
        r = Math.floor(r * 0.25)
        g = Math.floor(g * 0.25)
        b = Math.floor(b * 0.25)
      } else if (fog === 1) {
        // Explored but not visible
        r = Math.floor(r * 0.55)
        g = Math.floor(g * 0.55)
        b = Math.floor(b * 0.55)
      }

      const i = (py * w + px) * 4
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
    }
  }
}

export function updateMinimap(world: IWorld, time: number) {
  if (time - lastDraw < DRAW_INTERVAL) return
  lastDraw = time

  const w = canvas.width = canvas.offsetWidth
  const h = canvas.height = canvas.offsetHeight
  const half = MAP_SIZE / 2

  const toX = (worldX: number) => ((worldX + half) / MAP_SIZE) * w
  const toY = (worldZ: number) => ((worldZ + half) / MAP_SIZE) * h

  // Rebuild terrain with fog every draw (fog changes)
  buildTerrainImage(w, h)
  ctx.putImageData(terrainImageData!, 0, 0)

  // Resources (only visible or explored)
  const resources = resourceQuery(world)
  for (const eid of resources) {
    if (hasComponent(world, Dead, eid)) continue
    const rx = Position.x[eid], rz = Position.z[eid]
    const fx = Math.floor((toX(rx) / w) * FOG_RES)
    const fz = Math.floor((toY(rz) / h) * FOG_RES)
    const fog = fogState[fz * FOG_RES + fx]
    if (fog === 0) continue // unexplored

    const type = ResourceNode.type[eid]
    ctx.globalAlpha = fog === 1 ? 0.5 : 1.0
    ctx.fillStyle = type === 0 ? '#4fc3f7' : '#66bb6a'
    ctx.fillRect(toX(rx) - 1, toY(rz) - 1, 3, 3)
    ctx.globalAlpha = 1.0
  }

  // Units and buildings
  const units = unitQuery(world)
  for (const eid of units) {
    if (hasComponent(world, Dead, eid)) continue
    const faction = Faction.id[eid]
    const isBuilding = hasComponent(world, IsBuilding, eid)
    const ux = Position.x[eid], uz = Position.z[eid]

    if (faction === FACTION_PLAYER) {
      // Always show own units
      ctx.fillStyle = isBuilding ? '#3366cc' : '#4488ff'
    } else {
      // Enemy: only show if visible, or building in explored area (snapshot)
      const visible = isVisibleAt(ux, uz)
      if (visible) {
        ctx.fillStyle = isBuilding ? '#cc3333' : '#ff4444'
      } else if (isBuilding) {
        // Explored building snapshot — dark, semi-transparent
        const fx = Math.floor((toX(ux) / w) * FOG_RES)
        const fz = Math.floor((toY(uz) / h) * FOG_RES)
        if (fogState[fz * FOG_RES + fx] >= 1) {
          ctx.globalAlpha = 0.4
          ctx.fillStyle = '#882222'
        } else {
          continue // unexplored, hide
        }
      } else {
        continue // enemy unit not visible
      }
    }

    const size = isBuilding ? 4 : 2
    ctx.fillRect(toX(ux) - size / 2, toY(uz) - size / 2, size, size)
    ctx.globalAlpha = 1.0
  }

  // Camera viewport — diamond shape matching perspective view
  drawViewportDiamond(ctx, w, h, toX, toY)
}

// ── Viewport diamond ────────────────────────────────────────
// Project the 4 corners of the screen frustum onto the ground plane (Y=0)
// to get the actual visible area shape (a trapezoid/diamond)

const _ray = new THREE.Raycaster()
const _ndc = new THREE.Vector2()
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const _target = new THREE.Vector3()

function screenToGround(ndcX: number, ndcY: number): { x: number; z: number } | null {
  _ndc.set(ndcX, ndcY)
  _ray.setFromCamera(_ndc, camera)
  if (_ray.ray.intersectPlane(_plane, _target)) {
    return { x: _target.x, z: _target.z }
  }
  return null
}

function drawViewportDiamond(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  toX: (x: number) => number,
  toY: (z: number) => number,
) {
  // Project screen corners to ground
  const corners = [
    screenToGround(-1, -1), // top-left
    screenToGround(1, -1),  // top-right
    screenToGround(1, 1),   // bottom-right
    screenToGround(-1, 1),  // bottom-left
  ]

  // If any corner misses ground (looking at sky), skip
  if (corners.some(c => !c)) return

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(toX(corners[0]!.x), toY(corners[0]!.z))
  for (let i = 1; i < 4; i++) {
    ctx.lineTo(toX(corners[i]!.x), toY(corners[i]!.z))
  }
  ctx.closePath()
  ctx.stroke()
}

// Click to move camera
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const w = canvas.offsetWidth
  const h = canvas.offsetHeight
  const half = MAP_SIZE / 2
  const worldX = (x / w) * MAP_SIZE - half
  const worldZ = (y / h) * MAP_SIZE - half
  ;(window as any).__minimapTarget = { x: worldX, z: worldZ }
})
