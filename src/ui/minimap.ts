import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Faction, IsBuilding, ResourceNode, Dead, Health } from '../ecs/components'
import { MAP_SIZE, FACTION_PLAYER, FACTION_ENEMY } from '../game/config'
import { camera } from '../render/engine'
import { GRID_RES, terrainType, T_GRASS, T_DIRT, T_ROCK, T_WATER, T_CLIFF, T_DARK_GRASS } from '../terrain/heightmap'

const canvas = document.getElementById('minimap') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

const unitQuery = defineQuery([Position, Faction, Health])
const resourceQuery = defineQuery([Position, ResourceNode])

let lastDraw = 0
const DRAW_INTERVAL = 200
let terrainImageData: ImageData | null = null

function buildTerrainImage(w: number, h: number) {
  terrainImageData = ctx.createImageData(w, h)
  const d = terrainImageData.data

  const terrainColors: Record<number, [number, number, number]> = {
    [T_GRASS]: [40, 100, 45],
    [T_DARK_GRASS]: [30, 80, 35],
    [T_DIRT]: [130, 98, 58],
    [T_ROCK]: [108, 102, 95],
    [T_WATER]: [22, 55, 110],
    [T_CLIFF]: [80, 70, 62],
  }

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const gx = Math.floor((px / w) * GRID_RES)
      const gz = Math.floor((py / h) * GRID_RES)
      const type = terrainType[gz * GRID_RES + gx]
      const [r, g, b] = terrainColors[type] || [40, 100, 45]
      const i = (py * w + px) * 4
      d[i] = r
      d[i + 1] = g
      d[i + 2] = b
      d[i + 3] = 255
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

  // Draw terrain background
  if (!terrainImageData || terrainImageData.width !== w) {
    buildTerrainImage(w, h)
  }
  ctx.putImageData(terrainImageData!, 0, 0)

  // Resources
  const resources = resourceQuery(world)
  for (const eid of resources) {
    if (hasComponent(world, Dead, eid)) continue
    const type = ResourceNode.type[eid]
    ctx.fillStyle = type === 0 ? '#4fc3f7' : '#66bb6a'
    ctx.fillRect(toX(Position.x[eid]) - 1, toY(Position.z[eid]) - 1, 3, 3)
  }

  // Units and buildings
  const units = unitQuery(world)
  for (const eid of units) {
    if (hasComponent(world, Dead, eid)) continue
    const faction = Faction.id[eid]
    const isBuilding = hasComponent(world, IsBuilding, eid)

    ctx.fillStyle = faction === FACTION_PLAYER
      ? (isBuilding ? '#3366cc' : '#4488ff')
      : (isBuilding ? '#cc3333' : '#ff4444')

    const size = isBuilding ? 3 : 2
    ctx.fillRect(toX(Position.x[eid]) - size / 2, toY(Position.z[eid]) - size / 2, size, size)
  }

  // Camera viewport
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.lineWidth = 1
  ctx.strokeRect(toX(camera.position.x) - 15, toY(camera.position.z) - 10, 30, 20)
}

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
