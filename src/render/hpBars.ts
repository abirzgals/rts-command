import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Position, Health, Dead, IsBuilding, Faction } from '../ecs/components'
import { camera, renderer } from './engine'

const hpQuery = defineQuery([Position, Health])

// DOM container for HP bars
let container: HTMLDivElement
const barElements = new Map<number, HTMLDivElement>()
const _vec3 = new THREE.Vector3()

const BAR_WIDTH = 40
const BAR_HEIGHT = 4
const SHOW_THRESHOLD = 0.99 // only show bars for damaged units (< 99% HP)

export function initHPBars() {
  container = document.createElement('div')
  container.id = 'hp-bars'
  Object.assign(container.style, {
    position: 'absolute',
    top: '0', left: '0',
    width: '100%', height: '100%',
    pointerEvents: 'none',
    overflow: 'hidden',
    zIndex: '15',
  })
  // Parent to canvas wrapper so positioning is relative to the canvas, not body.
  // This makes HP bars work identically in game, sandbox, or any layout.
  const canvasParent = renderer.domElement.parentElement
  if (canvasParent) {
    // Ensure the parent is a positioning context
    const pos = getComputedStyle(canvasParent).position
    if (pos === 'static') canvasParent.style.position = 'relative'
    canvasParent.appendChild(container)
  } else {
    document.body.appendChild(container)
  }
}

function getOrCreateBar(eid: number): HTMLDivElement {
  let bar = barElements.get(eid)
  if (!bar) {
    bar = document.createElement('div')
    Object.assign(bar.style, {
      position: 'absolute',
      width: BAR_WIDTH + 'px',
      height: BAR_HEIGHT + 'px',
      background: '#333',
      borderRadius: '2px',
      overflow: 'hidden',
      border: '1px solid rgba(0,0,0,0.5)',
      transform: 'translate(-50%, -100%)',
    })

    const fill = document.createElement('div')
    fill.className = 'hp-fill'
    Object.assign(fill.style, {
      width: '100%',
      height: '100%',
      borderRadius: '1px',
      transition: 'width 0.15s',
    })
    bar.appendChild(fill)

    container.appendChild(bar)
    barElements.set(eid, bar)
  }
  return bar
}

function removeBar(eid: number) {
  const bar = barElements.get(eid)
  if (bar) {
    bar.remove()
    barElements.delete(eid)
  }
}

export function updateHPBars(world: IWorld) {
  const entities = hpQuery(world)
  const activeEids = new Set<number>()

  // Use canvas dimensions — container is parented to the canvas wrapper so no offset needed
  const w = renderer.domElement.clientWidth
  const h = renderer.domElement.clientHeight

  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue

    const ratio = Health.current[eid] / Health.max[eid]

    // Only show for damaged units
    if (ratio >= SHOW_THRESHOLD || ratio <= 0) {
      removeBar(eid)
      continue
    }

    activeEids.add(eid)

    // Project world position to screen
    const isBuilding = hasComponent(world, IsBuilding, eid)
    const yOffset = isBuilding ? 5.0 : 3.5 // above the unit/building

    _vec3.set(Position.x[eid], Position.y[eid] + yOffset, Position.z[eid])
    _vec3.project(camera)

    // Check if behind camera
    if (_vec3.z > 1) {
      const bar = barElements.get(eid)
      if (bar) bar.style.display = 'none'
      continue
    }

    const sx = ((_vec3.x + 1) / 2) * w
    const sy = ((-_vec3.y + 1) / 2) * h

    // Cull off-screen
    if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) {
      const bar = barElements.get(eid)
      if (bar) bar.style.display = 'none'
      continue
    }

    const bar = getOrCreateBar(eid)
    bar.style.display = 'block'
    bar.style.left = sx + 'px'
    bar.style.top = sy + 'px'

    // Size based on building vs unit
    const bw = isBuilding ? 56 : BAR_WIDTH
    bar.style.width = bw + 'px'

    // Color based on HP ratio
    const fill = bar.firstChild as HTMLDivElement
    fill.style.width = (ratio * 100) + '%'

    if (ratio > 0.6) {
      fill.style.background = '#4caf50' // green
    } else if (ratio > 0.3) {
      fill.style.background = '#ff9800' // orange
    } else {
      fill.style.background = '#f44336' // red
    }
  }

  // Clean up bars for entities that no longer exist
  for (const [eid] of barElements) {
    if (!activeEids.has(eid)) {
      removeBar(eid)
    }
  }
}
