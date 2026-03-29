import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Position, Faction, MeshRef, PathFollower, MoveTarget,
  AttackTarget, WorkerC, Dead, Velocity, Selected, CollisionRadius,
  CurrentSpeed, MoveSpeed, StuckState, TurnRate,
} from '../ecs/components'
import { getPath } from '../pathfinding/pathStore'
import { getTerrainHeight, GRID_RES, gridToWorld, CELL_SIZE } from '../terrain/heightmap'
import { walkable, dynamicCost } from '../pathfinding/navGrid'
import { scene } from './engine'
import { FACTION_PLAYER } from '../game/config'

let pathLines: THREE.Line | null = null
let stateSprites: THREE.Points | null = null
let colliderLines: THREE.LineSegments | null = null
let navGridMesh: THREE.Mesh | null = null
let navGridBuilt = false
let enabled = false

// Clearance overlay removed — was too noisy

const MAX_PATH_POINTS = 8000
const pathPositions = new Float32Array(MAX_PATH_POINTS * 3)
const pathColors = new Float32Array(MAX_PATH_POINTS * 3)
let pathGeometry: THREE.BufferGeometry

// State label sprites using Points with color coding
const MAX_LABELS = 500
const labelPositions = new Float32Array(MAX_LABELS * 3)
const labelColors = new Float32Array(MAX_LABELS * 3)
let labelGeometry: THREE.BufferGeometry

// Collider circles
const CIRCLE_SEGS = 16 // segments per circle
const MAX_COLLIDERS = 500
const MAX_COLLIDER_POINTS = MAX_COLLIDERS * CIRCLE_SEGS * 2 // 2 verts per segment
const colliderPositions = new Float32Array(MAX_COLLIDER_POINTS * 3)
const colliderColors = new Float32Array(MAX_COLLIDER_POINTS * 3)
let colliderGeometry: THREE.BufferGeometry

const unitQuery = defineQuery([Position, MeshRef, Faction])

// Color constants
const PATH_PLAYER = new THREE.Color(0x00ff88)
const PATH_ENEMY = new THREE.Color(0xff4444)
const ATTACK_DOT = new THREE.Color(0xff0000)
const MOVE_DOT = new THREE.Color(0x00aaff)
const GATHER_DOT = new THREE.Color(0xffaa00)
const IDLE_DOT = new THREE.Color(0x888888)
const SELECTED_DOT = new THREE.Color(0x00ff00)
const STUCK_DOT = new THREE.Color(0xff8800)

// DOM element for selected unit info
let unitInfoDiv: HTMLDivElement | null = null

export function isDebugEnabled() { return enabled }

export function toggleDebug() {
  enabled = !enabled
  if (pathLines) pathLines.visible = enabled
  if (stateSprites) stateSprites.visible = enabled
  if (colliderLines) colliderLines.visible = enabled

  // Build nav grid overlay on first enable
  if (enabled && !navGridBuilt) {
    buildNavGridOverlay()
    navGridBuilt = true
  }
  if (navGridMesh) navGridMesh.visible = enabled
  if (!enabled && unitInfoDiv) unitInfoDiv.style.display = 'none'

  // Show/hide legend
  let legend = document.getElementById('debug-legend')
  if (!legend) {
    legend = document.createElement('div')
    legend.id = 'debug-legend'
    legend.innerHTML = `
      <b>DEBUG</b> (F1)<br>
      <span style="color:#0f8">━━</span> player path
      <span style="color:#f44">━━</span> enemy path<br>
      <span style="color:#0af">●</span> moving
      <span style="color:#fa0">●</span> gathering
      <span style="color:#f00">●</span> attacking<br>
      <span style="color:#888">●</span> idle
      <span style="color:#0f0">●</span> selected
      <span style="color:#f80">●</span> stuck<br>
      <span style="color:#ff0">○</span> collider
      <span style="color:#f00;opacity:0.5">■</span> blocked<br>
      <span style="color:#1b4">■</span> passable
      <span style="color:#c21">■</span> blocked (clearance)
      <span style="color:#cc0;opacity:0.5">■</span> steep slope<br>
      <small>Select unit: shows speed/turn/slope info</small>
    `
    Object.assign(legend.style, {
      position: 'absolute', top: '44px', left: '8px',
      background: 'rgba(0,0,0,0.75)', color: '#ddd',
      padding: '8px 12px', borderRadius: '6px',
      fontSize: '12px', lineHeight: '1.6', zIndex: '30',
      fontFamily: 'monospace', pointerEvents: 'none',
    })
    document.body.appendChild(legend)
  }
  legend.style.display = enabled ? 'block' : 'none'

  console.log(`[debug] Overlay ${enabled ? 'ON' : 'OFF'}`)
}

function buildNavGridOverlay() {
  // Count blocked cells
  let blockedCount = 0
  for (let i = 0; i < GRID_RES * GRID_RES; i++) {
    if (walkable[i] === 0) blockedCount++
  }

  if (blockedCount === 0) return

  // Build a single merged geometry of small quads for each blocked cell
  const positions = new Float32Array(blockedCount * 6 * 3) // 2 triangles * 3 verts * 3 coords
  let vi = 0

  for (let gz = 0; gz < GRID_RES; gz++) {
    for (let gx = 0; gx < GRID_RES; gx++) {
      if (walkable[gz * GRID_RES + gx] !== 0) continue

      const [wx, wz] = gridToWorld(gx, gz)
      const y = getTerrainHeight(wx, wz) + 0.2
      const half = 0.45 // slightly smaller than cell to show grid

      // Triangle 1
      positions[vi++] = wx - half; positions[vi++] = y; positions[vi++] = wz - half
      positions[vi++] = wx + half; positions[vi++] = y; positions[vi++] = wz - half
      positions[vi++] = wx + half; positions[vi++] = y; positions[vi++] = wz + half
      // Triangle 2
      positions[vi++] = wx - half; positions[vi++] = y; positions[vi++] = wz - half
      positions[vi++] = wx + half; positions[vi++] = y; positions[vi++] = wz + half
      positions[vi++] = wx - half; positions[vi++] = y; positions[vi++] = wz + half
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

  const mat = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
    depthWrite: false,
  })

  navGridMesh = new THREE.Mesh(geo, mat)
  navGridMesh.frustumCulled = false
  navGridMesh.renderOrder = 98
  navGridMesh.visible = true
  scene.add(navGridMesh)

  console.log(`[debug] NavGrid overlay: ${blockedCount} blocked cells`)
}

export function initDebugOverlay() {
  // Path lines (using segments: pairs of points)
  pathGeometry = new THREE.BufferGeometry()
  pathGeometry.setAttribute('position', new THREE.BufferAttribute(pathPositions, 3))
  pathGeometry.setAttribute('color', new THREE.BufferAttribute(pathColors, 3))

  const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 2, transparent: true, opacity: 0.85, depthTest: false })
  pathLines = new THREE.LineSegments(pathGeometry, lineMat)
  pathLines.frustumCulled = false
  pathLines.visible = false
  pathLines.renderOrder = 100
  scene.add(pathLines)

  // State dots (points above units)
  labelGeometry = new THREE.BufferGeometry()
  labelGeometry.setAttribute('position', new THREE.BufferAttribute(labelPositions, 3))
  labelGeometry.setAttribute('color', new THREE.BufferAttribute(labelColors, 3))

  const pointMat = new THREE.PointsMaterial({ size: 10, vertexColors: true, sizeAttenuation: false, transparent: true, opacity: 0.95, depthTest: false })
  stateSprites = new THREE.Points(labelGeometry, pointMat)
  stateSprites.frustumCulled = false
  stateSprites.visible = false
  stateSprites.renderOrder = 101
  scene.add(stateSprites)

  // Collider circles
  colliderGeometry = new THREE.BufferGeometry()
  colliderGeometry.setAttribute('position', new THREE.BufferAttribute(colliderPositions, 3))
  colliderGeometry.setAttribute('color', new THREE.BufferAttribute(colliderColors, 3))

  const colliderMat = new THREE.LineBasicMaterial({ vertexColors: true, linewidth: 1, transparent: true, opacity: 0.6, depthTest: false })
  colliderLines = new THREE.LineSegments(colliderGeometry, colliderMat)
  colliderLines.frustumCulled = false
  colliderLines.visible = false
  colliderLines.renderOrder = 99
  scene.add(colliderLines)
}

export function updateDebugOverlay(world: IWorld) {
  if (!enabled) return

  let pathIdx = 0 // counts vertices (each line segment = 2 vertices)
  let labelIdx = 0

  const entities = unitQuery(world)

  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue

    const px = Position.x[eid]
    const py = Position.y[eid]
    const pz = Position.z[eid]
    const isPlayer = Faction.id[eid] === FACTION_PLAYER
    const pathColor = isPlayer ? PATH_PLAYER : PATH_ENEMY

    // ── Draw path lines ─────────────────────────
    if (hasComponent(world, PathFollower, eid)) {
      const pathId = PathFollower.pathId[eid]
      const path = getPath(pathId)
      const wpIdx = PathFollower.waypointIndex[eid]

      if (path && wpIdx < path.length) {
        let prevX = px, prevZ = pz, prevY = getTerrainHeight(px, pz) + 0.5

        for (let i = wpIdx; i < path.length && pathIdx < MAX_PATH_POINTS - 2; i++) {
          const wp = path[i]
          const wpY = getTerrainHeight(wp.x, wp.z) + 0.5

          const pi = pathIdx * 3
          pathPositions[pi] = prevX
          pathPositions[pi + 1] = prevY
          pathPositions[pi + 2] = prevZ
          pathColors[pi] = pathColor.r
          pathColors[pi + 1] = pathColor.g
          pathColors[pi + 2] = pathColor.b
          pathIdx++

          const pi2 = pathIdx * 3
          pathPositions[pi2] = wp.x
          pathPositions[pi2 + 1] = wpY
          pathPositions[pi2 + 2] = wp.z
          pathColors[pi2] = pathColor.r
          pathColors[pi2 + 1] = pathColor.g
          pathColors[pi2 + 2] = pathColor.b
          pathIdx++

          prevX = wp.x
          prevZ = wp.z
          prevY = wpY
        }
      }
    }
    // Draw line to MoveTarget (direct movement)
    else if (hasComponent(world, MoveTarget, eid) && pathIdx < MAX_PATH_POINTS - 2) {
      const tx = MoveTarget.x[eid]
      const tz = MoveTarget.z[eid]
      const ty = getTerrainHeight(tx, tz) + 0.3

      const pi = pathIdx * 3
      pathPositions[pi] = px
      pathPositions[pi + 1] = py + 0.3
      pathPositions[pi + 2] = pz
      pathColors[pi] = pathColor.r
      pathColors[pi + 1] = pathColor.g
      pathColors[pi + 2] = pathColor.b
      pathIdx++

      const pi2 = pathIdx * 3
      pathPositions[pi2] = tx
      pathPositions[pi2 + 1] = ty
      pathPositions[pi2 + 2] = tz
      pathColors[pi2] = pathColor.r
      pathColors[pi2 + 1] = pathColor.g
      pathColors[pi2 + 2] = pathColor.b
      pathIdx++
    }

    // ── State dot above unit ────────────────────
    if (labelIdx < MAX_LABELS) {
      let dotColor: THREE.Color

      if (hasComponent(world, StuckState, eid) && StuckState.phase[eid] > 0) {
        dotColor = STUCK_DOT // stuck unit — orange
      } else if (hasComponent(world, Selected, eid)) {
        dotColor = SELECTED_DOT
      } else if (hasComponent(world, AttackTarget, eid)) {
        dotColor = ATTACK_DOT
      } else if (hasComponent(world, WorkerC, eid)) {
        const ws = WorkerC.state[eid]
        dotColor = ws === 0 ? IDLE_DOT : ws === 2 ? GATHER_DOT : MOVE_DOT
      } else {
        const vx = Velocity.x[eid]
        const vz = Velocity.z[eid]
        dotColor = (vx * vx + vz * vz) > 0.5 ? MOVE_DOT : IDLE_DOT
      }

      const li = labelIdx * 3
      labelPositions[li] = px
      labelPositions[li + 1] = py + 4
      labelPositions[li + 2] = pz
      labelColors[li] = dotColor.r
      labelColors[li + 1] = dotColor.g
      labelColors[li + 2] = dotColor.b
      labelIdx++
    }
  }

  // ── Collider circles ─────────────────────────
  let colliderIdx = 0
  const COLLIDER_COLOR_R = 1.0, COLLIDER_COLOR_G = 1.0, COLLIDER_COLOR_B = 0.0 // yellow

  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue
    if (!hasComponent(world, CollisionRadius, eid)) continue
    if (colliderIdx >= MAX_COLLIDER_POINTS - CIRCLE_SEGS * 2) break

    const cx = Position.x[eid]
    const cy = Position.y[eid] + 0.15
    const cz = Position.z[eid]
    const r = CollisionRadius.value[eid]

    for (let s = 0; s < CIRCLE_SEGS; s++) {
      const a1 = (s / CIRCLE_SEGS) * Math.PI * 2
      const a2 = ((s + 1) / CIRCLE_SEGS) * Math.PI * 2

      const i1 = colliderIdx * 3
      colliderPositions[i1] = cx + Math.cos(a1) * r
      colliderPositions[i1 + 1] = cy
      colliderPositions[i1 + 2] = cz + Math.sin(a1) * r
      colliderColors[i1] = COLLIDER_COLOR_R
      colliderColors[i1 + 1] = COLLIDER_COLOR_G
      colliderColors[i1 + 2] = COLLIDER_COLOR_B
      colliderIdx++

      const i2 = colliderIdx * 3
      colliderPositions[i2] = cx + Math.cos(a2) * r
      colliderPositions[i2 + 1] = cy
      colliderPositions[i2 + 2] = cz + Math.sin(a2) * r
      colliderColors[i2] = COLLIDER_COLOR_R
      colliderColors[i2 + 1] = COLLIDER_COLOR_G
      colliderColors[i2 + 2] = COLLIDER_COLOR_B
      colliderIdx++
    }
  }

  // Update geometry draw ranges
  pathGeometry.setDrawRange(0, pathIdx)
  pathGeometry.attributes.position.needsUpdate = true
  pathGeometry.attributes.color.needsUpdate = true

  labelGeometry.setDrawRange(0, labelIdx)
  labelGeometry.attributes.position.needsUpdate = true
  labelGeometry.attributes.color.needsUpdate = true

  colliderGeometry.setDrawRange(0, colliderIdx)
  colliderGeometry.attributes.position.needsUpdate = true
  colliderGeometry.attributes.color.needsUpdate = true

  // ── Unit info panel (single selected unit, debug mode only) ──
  let selectedEid = -1
  for (const eid of entities) {
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, Selected, eid)) {
      if (selectedEid >= 0) { selectedEid = -1; break } // multiple — skip
      selectedEid = eid
    }
  }

  if (selectedEid >= 0 && hasComponent(world, CollisionRadius, selectedEid)) {
    if (!unitInfoDiv) {
      unitInfoDiv = document.createElement('div')
      unitInfoDiv.id = 'debug-unit-info'
      Object.assign(unitInfoDiv.style, {
        position: 'absolute', top: '44px', right: '8px',
        background: 'rgba(0,0,0,0.8)', color: '#ddd',
        padding: '8px 12px', borderRadius: '6px',
        fontSize: '12px', lineHeight: '1.5', zIndex: '30',
        fontFamily: 'monospace', pointerEvents: 'none',
        minWidth: '180px',
      })
      document.body.appendChild(unitInfoDiv)
    }

    const eid = selectedEid
    const curSpd = hasComponent(world, CurrentSpeed, eid) ? CurrentSpeed.value[eid] : 0
    const maxSpd = hasComponent(world, MoveSpeed, eid) ? MoveSpeed.value[eid] : 0
    const turnR = hasComponent(world, TurnRate, eid) ? TurnRate.value[eid] : 0
    const stuckP = hasComponent(world, StuckState, eid) ? StuckState.phase[eid] : 0
    const stuckT = hasComponent(world, StuckState, eid) ? StuckState.timer[eid] : 0
    const hasPath = hasComponent(world, PathFollower, eid)
    const hasMT = hasComponent(world, MoveTarget, eid)

    const stuckLabels = ['normal', 'repath', 'stopped']
    const stuckColor = stuckP === 0 ? '#0f8' : stuckP === 1 ? '#f80' : '#f00'

    unitInfoDiv.innerHTML = `
      <b>Unit #${eid}</b><br>
      Speed: <b>${curSpd.toFixed(1)}</b> / ${maxSpd.toFixed(1)} u/s<br>
      Turn rate: ${turnR.toFixed(1)} rad/s<br>
      Radius: ${CollisionRadius.value[eid].toFixed(1)}<br>
      Stuck: <span style="color:${stuckColor}">${stuckLabels[stuckP] || '?'}</span> (${stuckT.toFixed(1)}s)<br>
      Path: ${hasPath ? 'following' : hasMT ? 'seeking' : 'idle'}
    `
    unitInfoDiv.style.display = 'block'
  } else {
    if (unitInfoDiv) unitInfoDiv.style.display = 'none'
  }
}
