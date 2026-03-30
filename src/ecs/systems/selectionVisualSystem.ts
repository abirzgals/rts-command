import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Selected, Position, Selectable, Dead, IsBuilding, Producer,
  PathFollower, MoveTarget, AttackTarget, Faction,
} from '../components'
import { updateSelectionRings } from '../../render/meshPools'
import { getTerrainHeight } from '../../terrain/heightmap'
import { scene } from '../../render/engine'
import { getPath } from '../../pathfinding/pathStore'
import { getQueue, type Command } from '../commandQueue'
import { FACTION_PLAYER } from '../../game/config'

const selectedQuery = defineQuery([Selected, Position])

const _positions: { x: number; y: number; z: number; radius: number }[] = []

// Rally point line
let rallyLine: THREE.Line | null = null
let rallyMarker: THREE.Mesh | null = null

function ensureRallyVisuals() {
  if (!rallyLine) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,0,0], 3))
    const mat = new THREE.LineDashedMaterial({ color: 0xffcc00, dashSize: 0.8, gapSize: 0.4, linewidth: 2, transparent: true, opacity: 0.7, depthTest: false })
    rallyLine = new THREE.Line(geo, mat)
    rallyLine.computeLineDistances()
    rallyLine.frustumCulled = false
    rallyLine.renderOrder = 90
    rallyLine.visible = false
    scene.add(rallyLine)
  }
  if (!rallyMarker) {
    const geo = new THREE.ConeGeometry(0.4, 1.0, 6)
    geo.rotateX(Math.PI) // point down
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00, transparent: true, opacity: 0.8, depthTest: false })
    rallyMarker = new THREE.Mesh(geo, mat)
    rallyMarker.renderOrder = 90
    rallyMarker.visible = false
    scene.add(rallyMarker)
  }
}

export function selectionVisualSystem(world: IWorld, _dt: number) {
  const selected = selectedQuery(world)
  _positions.length = 0

  let rallyBuildingEid = -1

  for (const eid of selected) {
    if (hasComponent(world, Dead, eid)) continue

    const radius = hasComponent(world, Selectable, eid) ? Selectable.radius[eid] : 0.5
    const x = Position.x[eid]
    const z = Position.z[eid]
    _positions.push({
      x,
      y: getTerrainHeight(x, z),
      z,
      radius,
    })

    // Track if a producer building is selected (for rally display)
    if (hasComponent(world, IsBuilding, eid) && hasComponent(world, Producer, eid)) {
      rallyBuildingEid = eid
    }
  }

  updateSelectionRings(_positions)

  // Rally point visualization
  ensureRallyVisuals()
  if (rallyBuildingEid >= 0) {
    const bx = Position.x[rallyBuildingEid]
    const bz = Position.z[rallyBuildingEid]
    const by = getTerrainHeight(bx, bz) + 0.5
    const rx = Producer.rallyX[rallyBuildingEid]
    const rz = Producer.rallyZ[rallyBuildingEid]
    const ry = getTerrainHeight(rx, rz) + 0.5

    // Update line
    const pos = rallyLine!.geometry.attributes.position as THREE.BufferAttribute
    pos.setXYZ(0, bx, by, bz)
    pos.setXYZ(1, rx, ry, rz)
    pos.needsUpdate = true
    rallyLine!.geometry.computeBoundingSphere()
    rallyLine!.computeLineDistances()
    rallyLine!.visible = true

    // Update marker (cone at rally point)
    rallyMarker!.position.set(rx, ry + 1.5, rz)
    rallyMarker!.rotation.y += 0.02 // slow spin
    rallyMarker!.visible = true
  } else {
    if (rallyLine) rallyLine.visible = false
    if (rallyMarker) rallyMarker.visible = false
  }

  // ── Path + queue visualization (visible when shift held) ──
  updatePathQueueVisuals(world, selected, shiftVisualActive)
}

// ── Shift-held path/queue visualization ──────────────────────

let shiftVisualActive = false

// Listen for shift key to toggle visualization
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { if (e.key === 'Shift') shiftVisualActive = true })
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') shiftVisualActive = false })
}

// Pre-allocated line for path visualization (up to 200 points per unit, max 20 units)
const MAX_PATH_POINTS = 4000
const pathVizPositions = new Float32Array(MAX_PATH_POINTS * 3)
const pathVizColors = new Float32Array(MAX_PATH_POINTS * 3)
let pathVizLine: THREE.LineSegments | null = null

// Queue command markers (small diamonds at queue destinations)
const queueMarkers: THREE.Mesh[] = []
const markerGeo = new THREE.SphereGeometry(0.3, 6, 6)

function ensurePathVizLine() {
  if (pathVizLine) return
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pathVizPositions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(pathVizColors, 3))
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
  })
  pathVizLine = new THREE.LineSegments(geo, mat)
  pathVizLine.frustumCulled = false
  pathVizLine.renderOrder = 95
  pathVizLine.visible = false
  scene.add(pathVizLine)
}

function hideQueueMarkers() {
  for (const m of queueMarkers) m.visible = false
}

function getOrCreateMarker(idx: number, color: number): THREE.Mesh {
  while (queueMarkers.length <= idx) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false })
    const mesh = new THREE.Mesh(markerGeo, mat)
    mesh.renderOrder = 96
    mesh.visible = false
    scene.add(mesh)
    queueMarkers.push(mesh)
  }
  const m = queueMarkers[idx]
  ;(m.material as THREE.MeshBasicMaterial).color.setHex(color)
  m.visible = true
  return m
}

function updatePathQueueVisuals(world: IWorld, selected: number[], active: boolean) {
  ensurePathVizLine()

  if (!active || selected.length === 0) {
    pathVizLine!.visible = false
    hideQueueMarkers()
    return
  }

  let lineIdx = 0
  let markerIdx = 0
  const Y_OFF = 0.4

  function addSegment(x1: number, z1: number, x2: number, z2: number, r: number, g: number, b: number) {
    if (lineIdx + 2 > MAX_PATH_POINTS) return
    const i1 = lineIdx * 3, i2 = (lineIdx + 1) * 3
    const y1 = getTerrainHeight(x1, z1) + Y_OFF
    const y2 = getTerrainHeight(x2, z2) + Y_OFF
    pathVizPositions[i1] = x1; pathVizPositions[i1+1] = y1; pathVizPositions[i1+2] = z1
    pathVizPositions[i2] = x2; pathVizPositions[i2+1] = y2; pathVizPositions[i2+2] = z2
    pathVizColors[i1] = r; pathVizColors[i1+1] = g; pathVizColors[i1+2] = b
    pathVizColors[i2] = r; pathVizColors[i2+1] = g; pathVizColors[i2+2] = b
    lineIdx += 2
  }

  for (const eid of selected) {
    if (hasComponent(world, Dead, eid)) continue
    if (hasComponent(world, IsBuilding, eid)) continue
    if (!hasComponent(world, Faction, eid) || Faction.id[eid] !== FACTION_PLAYER) continue

    let endX = Position.x[eid]
    let endZ = Position.z[eid]

    // 1. Draw current A* path
    if (hasComponent(world, PathFollower, eid)) {
      const path = getPath(PathFollower.pathId[eid])
      if (path) {
        const startIdx = PathFollower.waypointIndex[eid]
        let prevX = endX, prevZ = endZ
        for (let wi = startIdx; wi < path.length; wi++) {
          addSegment(prevX, prevZ, path[wi].x, path[wi].z, 0.2, 0.9, 0.4) // green
          prevX = path[wi].x
          prevZ = path[wi].z
        }
        endX = prevX
        endZ = prevZ
      }
    } else if (hasComponent(world, MoveTarget, eid)) {
      // Direct move (no path yet)
      addSegment(endX, endZ, MoveTarget.x[eid], MoveTarget.z[eid], 0.2, 0.9, 0.4)
      endX = MoveTarget.x[eid]
      endZ = MoveTarget.z[eid]
    }

    // 2. If has attack target, draw line to it
    if (hasComponent(world, AttackTarget, eid)) {
      const tgt = AttackTarget.eid[eid]
      if (hasComponent(world, Position, tgt)) {
        addSegment(endX, endZ, Position.x[tgt], Position.z[tgt], 1.0, 0.2, 0.2) // red
        endX = Position.x[tgt]
        endZ = Position.z[tgt]
      }
    }

    // 3. Draw queued commands
    const queue = getQueue(eid)
    for (const cmd of queue) {
      let cx: number, cz: number
      let color: number

      if (cmd.type === 'attack' && cmd.targetEid !== undefined && hasComponent(world, Position, cmd.targetEid)) {
        cx = Position.x[cmd.targetEid]; cz = Position.z[cmd.targetEid]
        color = 0xff3333
        addSegment(endX, endZ, cx, cz, 1.0, 0.2, 0.2)
      } else if (cmd.type === 'gather' && cmd.targetEid !== undefined && hasComponent(world, Position, cmd.targetEid)) {
        cx = Position.x[cmd.targetEid]; cz = Position.z[cmd.targetEid]
        color = 0x44ff88
        addSegment(endX, endZ, cx, cz, 0.2, 1.0, 0.5)
      } else if (cmd.type === 'build' && cmd.targetEid !== undefined && hasComponent(world, Position, cmd.targetEid)) {
        cx = Position.x[cmd.targetEid]; cz = Position.z[cmd.targetEid]
        color = 0xffffff
        addSegment(endX, endZ, cx, cz, 1.0, 1.0, 1.0)
      } else if ((cmd.type === 'move' || cmd.type === 'attackMove') && cmd.x !== undefined) {
        cx = cmd.x; cz = cmd.z!
        color = cmd.type === 'attackMove' ? 0xff8844 : 0x44ff44
        const r = cmd.type === 'attackMove' ? 1.0 : 0.2
        const g = cmd.type === 'attackMove' ? 0.5 : 1.0
        addSegment(endX, endZ, cx, cz, r, g, 0.2)
      } else {
        continue
      }

      // Place marker at command destination
      const marker = getOrCreateMarker(markerIdx++, color)
      marker.position.set(cx!, getTerrainHeight(cx!, cz!) + Y_OFF + 0.3, cz!)
      endX = cx!; endZ = cz!
    }
  }

  // Update geometry
  const posAttr = pathVizLine!.geometry.attributes.position as THREE.BufferAttribute
  posAttr.needsUpdate = true
  const colAttr = pathVizLine!.geometry.attributes.color as THREE.BufferAttribute
  colAttr.needsUpdate = true
  pathVizLine!.geometry.setDrawRange(0, lineIdx)
  pathVizLine!.visible = lineIdx > 0

  // Hide unused markers
  for (let i = markerIdx; i < queueMarkers.length; i++) {
    queueMarkers[i].visible = false
  }
}
