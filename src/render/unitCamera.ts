// ─── Unit first-person camera ───────────────────────────────────
// Shows a small viewport in the bottom-right when a single unit is selected.
// Camera positioned at the unit's eye level, looking in the unit's facing direction.

import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Selected, Position, Rotation, IsBuilding, Dead } from '../ecs/components'
import { scene, renderer } from './engine'
import { getTerrainHeight } from '../terrain/heightmap'
import { enterFPSMode, isFPSMode } from '../input/fpsMode'

const selectedQuery = defineQuery([Selected, Position])

let unitCam: THREE.PerspectiveCamera | null = null
let renderTarget: THREE.WebGLRenderTarget | null = null
let canvas: HTMLCanvasElement | null = null
let ctx2d: CanvasRenderingContext2D | null = null
let container: HTMLElement | null = null

const CAM_WIDTH = 200
const CAM_HEIGHT = 160
const EYE_HEIGHT = 1.8

export function initUnitCamera() {
  container = document.getElementById('unitcam-container')
  if (!container) return

  canvas = document.createElement('canvas')
  canvas.width = CAM_WIDTH
  canvas.height = CAM_HEIGHT
  container.appendChild(canvas)
  ctx2d = canvas.getContext('2d')!

  unitCam = new THREE.PerspectiveCamera(70, CAM_WIDTH / CAM_HEIGHT, 0.5, 150)
  renderTarget = new THREE.WebGLRenderTarget(CAM_WIDTH, CAM_HEIGHT)

  // Click on unit camera → enter FPS mode
  canvas.style.cursor = 'pointer'
  canvas.addEventListener('click', () => {
    if (isFPSMode()) return
    const w = (window as any).__ecsWorld
    if (!w) return
    const selected = selectedQuery(w)
    if (selected.length === 1 && !hasComponent(w, IsBuilding, selected[0]) && !hasComponent(w, Dead, selected[0])) {
      enterFPSMode(selected[0], w)
    }
  })
}

const _pixelBuf = new Uint8Array(CAM_WIDTH * CAM_HEIGHT * 4)

export function updateUnitCamera(world: IWorld) {
  if (!unitCam || !renderTarget || !canvas || !ctx2d || !container) return

  const selected = selectedQuery(world)

  // Only show for single non-building unit
  if (selected.length !== 1) {
    container.style.display = 'none'
    return
  }
  const eid = selected[0]
  if (hasComponent(world, IsBuilding, eid) || hasComponent(world, Dead, eid)) {
    container.style.display = 'none'
    return
  }

  container.style.display = 'block'

  const x = Position.x[eid]
  const z = Position.z[eid]
  const y = getTerrainHeight(x, z) + EYE_HEIGHT
  const rot = hasComponent(world, Rotation, eid) ? Rotation.y[eid] : 0

  // Position camera at unit's eyes, looking in facing direction
  unitCam.position.set(x, y, z)
  const lookX = x + Math.sin(rot) * 10
  const lookZ = z + Math.cos(rot) * 10
  const lookY = y - 0.3 // slight downward look
  unitCam.lookAt(lookX, lookY, lookZ)

  // Render scene from unit's perspective into offscreen target
  const oldTarget = renderer.getRenderTarget()
  renderer.setRenderTarget(renderTarget)
  renderer.render(scene, unitCam)
  renderer.setRenderTarget(oldTarget)

  // Read pixels and draw to 2D canvas
  renderer.readRenderTargetPixels(renderTarget, 0, 0, CAM_WIDTH, CAM_HEIGHT, _pixelBuf)
  const imgData = ctx2d.createImageData(CAM_WIDTH, CAM_HEIGHT)
  // Flip Y (WebGL is bottom-up, canvas is top-down)
  for (let row = 0; row < CAM_HEIGHT; row++) {
    const srcRow = (CAM_HEIGHT - 1 - row) * CAM_WIDTH * 4
    const dstRow = row * CAM_WIDTH * 4
    for (let col = 0; col < CAM_WIDTH * 4; col++) {
      imgData.data[dstRow + col] = _pixelBuf[srcRow + col]
    }
  }
  ctx2d.putImageData(imgData, 0, 0)
}
