import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Selected, Position, Selectable, Dead } from '../components'
import { updateSelectionRings } from '../../render/meshPools'
import { getTerrainHeight } from '../../terrain/heightmap'

const selectedQuery = defineQuery([Selected, Position])

const _positions: { x: number; y: number; z: number; radius: number }[] = []

export function selectionVisualSystem(world: IWorld, _dt: number) {
  const selected = selectedQuery(world)
  _positions.length = 0

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
  }

  updateSelectionRings(_positions)
}
