import * as THREE from 'three'
import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Selected, Position, Selectable, Dead, IsBuilding, Producer } from '../components'
import { updateSelectionRings } from '../../render/meshPools'
import { getTerrainHeight } from '../../terrain/heightmap'
import { scene } from '../../render/engine'

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
}
