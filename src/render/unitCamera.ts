// ─── Unit first-person camera ───────────────────────────────────
// Shows a small viewport in the bottom-right when a single unit is selected.
// Camera positioned at the unit's eye level, looking in the unit's facing direction.

import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Selected, Position, IsBuilding, Dead } from '../ecs/components'
import { enterFPSMode, exitFPSMode, isFPSMode } from '../input/fpsMode'

const selectedQuery = defineQuery([Selected, Position])

let container: HTMLElement | null = null

export function initUnitCamera() {
  container = document.getElementById('unitcam-container')
  if (!container) return

  // Click → toggle FPS mode
  container.addEventListener('click', (e) => {
    e.stopPropagation()
    if (isFPSMode()) {
      exitFPSMode()
      return
    }
    const w = (window as any).__ecsWorld
    if (!w) return
    const selected = selectedQuery(w)
    if (selected.length === 1 && !hasComponent(w, IsBuilding, selected[0]) && !hasComponent(w, Dead, selected[0])) {
      enterFPSMode(selected[0], w)
    }
  })
}

export function updateUnitCamera(world: IWorld) {
  if (!container) return

  // In FPS mode: show "EXIT FPS" button
  if (isFPSMode()) {
    container.style.display = 'flex'
    if (container.dataset.mode !== 'fps') {
      container.dataset.mode = 'fps'
      container.innerHTML = '<div style="color:#f88;font-size:14px;font-weight:600">EXIT FPS</div>'
    }
    return
  }

  // Normal mode: show "FPS" button when single unit selected
  const selected = selectedQuery(world)
  if (selected.length !== 1) {
    container.style.display = 'none'
    return
  }
  const eid = selected[0]
  if (hasComponent(world, IsBuilding, eid) || hasComponent(world, Dead, eid)) {
    container.style.display = 'none'
    return
  }

  container.style.display = 'flex'
  if (container.dataset.mode !== 'rts') {
    container.dataset.mode = 'rts'
    container.innerHTML = '<div style="color:#8cf;font-size:13px;font-weight:600">FPS MODE<br><span style="font-size:10px;color:#888">Click to enter</span></div>'
  }
}
