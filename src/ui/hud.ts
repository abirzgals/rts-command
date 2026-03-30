import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import {
  Selected, Position, Faction, Health, UnitTypeC,
  IsBuilding, WorkerC, Producer, AttackC, MoveSpeed, Armor, MoveTarget, Velocity,
  AttackTarget, AttackMove, PathFollower, UnitMode, MODE_MOVE, MODE_ATTACK_MOVE,
} from '../ecs/components'
import {
  FACTION_PLAYER, UNIT_DEFS, BUILDING_DEFS,
  BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY,
} from '../game/config'
import { gameState } from '../game/state'
import { queueProduction, setForceAttackMode, setRallyMode, enterBuildMode, cancelBuildMode } from '../input/input'
import { getBindingLabel } from '../input/keybindings'
import { clearQueue } from '../ecs/commandQueue'
import { removePath } from '../pathfinding/pathStore'
import { removeComponent, addComponent } from 'bitecs'

const selectedQuery = defineQuery([Selected])

// DOM elements
const mineralsEl = document.getElementById('minerals')!
const gasEl = document.getElementById('gas')!
const supplyEl = document.getElementById('supply')!
const fpsEl = document.getElementById('fps')!
const selectedNameEl = document.getElementById('selected-name')!
const selectedStatsEl = document.getElementById('selected-stats')!
const hpBarContainer = document.getElementById('hp-bar-container')!
const hpBarFill = document.getElementById('hp-bar-fill')!
const selectedCountEl = document.getElementById('selected-count')!
const actionButtonsEl = document.getElementById('action-buttons')!

let lastFpsUpdate = 0
let frameCount = 0

// Track what buttons are currently shown to avoid DOM thrashing
let lastSelectedEid = -1
let lastSelectedCount = -1

export function updateHUD(world: IWorld, _dt: number, time: number) {
  lastWorld = world
  // FPS counter
  frameCount++
  if (time - lastFpsUpdate > 1000) {
    fpsEl.textContent = `${frameCount} FPS`
    frameCount = 0
    lastFpsUpdate = time
  }

  // Resources
  const res = gameState.getResources(FACTION_PLAYER)
  mineralsEl.textContent = Math.floor(res.minerals).toString()
  gasEl.textContent = Math.floor(res.gas).toString()
  supplyEl.textContent = `${res.supplyCurrent}/${res.supplyMax}`

  // Selection info
  const selected = selectedQuery(world)
  const selectionChanged = selected.length !== lastSelectedCount ||
    (selected.length === 1 && selected[0] !== lastSelectedEid)

  // Deselect button visibility
  const deselectBtn = document.getElementById('deselect-btn')
  if (deselectBtn) deselectBtn.style.display = selected.length > 0 ? 'block' : 'none'

  if (selected.length === 0) {
    if (selectionChanged) {
      selectedNameEl.textContent = 'No selection'
      selectedStatsEl.textContent = ''
      hpBarContainer.style.display = 'none'
      selectedCountEl.textContent = ''
      actionButtonsEl.innerHTML = ''
      lastSelectedEid = -1
      lastSelectedCount = 0
    }
    return
  }

  if (selected.length === 1) {
    const eid = selected[0]
    const ut = UnitTypeC.id[eid]
    const isBuilding = hasComponent(world, IsBuilding, eid)
    const def = isBuilding ? BUILDING_DEFS[ut] : UNIT_DEFS[ut]

    selectedNameEl.textContent = def?.name ?? 'Unknown'

    // Stats — update every frame for live data
    const stats: string[] = []
    if (hasComponent(world, Health, eid)) {
      stats.push(`HP: ${Math.ceil(Health.current[eid])}/${Health.max[eid]}`)
    }
    if (hasComponent(world, AttackC, eid)) {
      stats.push(`ATK: ${AttackC.damage[eid]} | Range: ${AttackC.range[eid]}`)
    }
    if (hasComponent(world, MoveSpeed, eid)) {
      stats.push(`Speed: ${MoveSpeed.value[eid]}`)
    }
    if (hasComponent(world, Armor, eid) && Armor.value[eid] > 0) {
      stats.push(`Armor: ${Armor.value[eid]}`)
    }
    if (hasComponent(world, Producer, eid) && Producer.active[eid]) {
      const pct = Math.floor((Producer.progress[eid] / Producer.duration[eid]) * 100)
      const unitDef = UNIT_DEFS[Producer.unitType[eid]]
      stats.push(`Producing: ${unitDef?.name ?? '?'} (${pct}%)`)
    }
    selectedStatsEl.innerHTML = stats.join('<br>')

    // HP bar
    if (hasComponent(world, Health, eid)) {
      hpBarContainer.style.display = 'block'
      const pct = (Health.current[eid] / Health.max[eid]) * 100
      hpBarFill.style.width = pct + '%'
      hpBarFill.style.background = pct > 60 ? '#4caf50' : pct > 30 ? '#ff9800' : '#f44336'
    } else {
      hpBarContainer.style.display = 'none'
    }

    selectedCountEl.textContent = ''

    // Action buttons — only rebuild when selection changes
    if (selectionChanged) {
      updateActionButtons(world, eid)
      lastSelectedEid = eid
      lastSelectedCount = 1
    }
  } else {
    // Multiple selected
    selectedNameEl.textContent = `${selected.length} units selected`
    selectedStatsEl.textContent = ''
    hpBarContainer.style.display = 'none'
    selectedCountEl.textContent = ''
    if (selectionChanged) {
      actionButtonsEl.innerHTML = ''
      // Use first unit's mode for highlight
      updateActionButtons(world, selected[0])
      lastSelectedEid = -1
      lastSelectedCount = selected.length
    }
  }

  // Update mode highlight every frame
  // Update affordability styling every frame
  updateAffordability()

  // Update production queue display for selected building
  updateProductionQueue(world, selected)
}

const UNIT_ICONS: Record<number, string> = {
  0: '👷', 1: '🔫', 2: '🛡️', 3: '🚙', 4: '🚀', 5: '🔫',
}

let queueContainer: HTMLDivElement | null = null

function updateProductionQueue(world: IWorld, selected: number[]) {
  if (selected.length !== 1) {
    if (queueContainer) { queueContainer.style.display = 'none' }
    return
  }
  const eid = selected[0]
  if (!hasComponent(world, Producer, eid) || !hasComponent(world, IsBuilding, eid)) {
    if (queueContainer) { queueContainer.style.display = 'none' }
    return
  }

  const queue = gameState.getQueue(eid)
  if (queue.length === 0 && !Producer.active[eid]) {
    if (queueContainer) { queueContainer.style.display = 'none' }
    return
  }

  // Create container if needed
  if (!queueContainer) {
    queueContainer = document.createElement('div')
    Object.assign(queueContainer.style, {
      position: 'fixed', bottom: '165px', left: '210px',
      display: 'flex', gap: '3px', flexWrap: 'wrap', zIndex: '50',
      padding: '4px 8px', background: 'rgba(10,10,20,0.85)',
      borderRadius: '6px', border: '1px solid #333',
    })
    document.body.appendChild(queueContainer)
  }
  queueContainer.style.display = 'flex'

  // Build queue icons — first is currently producing (with progress bar)
  const items: { unitType: number; index: number; active: boolean }[] = []
  if (Producer.active[eid]) {
    items.push({ unitType: Producer.unitType[eid], index: 0, active: true })
  }
  for (let i = 0; i < queue.length; i++) {
    // Skip index 0 if it matches the active production (already shown)
    if (i === 0 && Producer.active[eid]) continue
    items.push({ unitType: queue[i].unitType, index: i, active: false })
  }

  // Rebuild only if count changed
  if (queueContainer.children.length !== items.length) {
    queueContainer.innerHTML = ''
    for (const item of items) {
      const el = document.createElement('div')
      Object.assign(el.style, {
        width: '32px', height: '32px', borderRadius: '4px',
        border: '1px solid #555', background: '#1a1a2e',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '18px', cursor: 'pointer', position: 'relative',
      })
      el.textContent = UNIT_ICONS[item.unitType] || '?'
      el.title = `${UNIT_DEFS[item.unitType]?.name ?? '?'} — click to cancel`
      el.addEventListener('click', (ev) => {
        ev.stopPropagation()
        cancelQueueItem(eid, item.index)
      })
      queueContainer.appendChild(el)
    }
  }

  // Update progress on first item
  if (items.length > 0 && items[0].active && queueContainer.firstChild) {
    const pct = Producer.duration[eid] > 0
      ? Math.floor((Producer.progress[eid] / Producer.duration[eid]) * 100) : 0
    const el = queueContainer.firstChild as HTMLElement
    el.style.background = `linear-gradient(to top, rgba(40,120,40,0.6) ${pct}%, #1a1a2e ${pct}%)`
    el.style.borderColor = '#4a8a4a'
  }
}

function cancelAllProduction(buildingEid: number) {
  const queue = gameState.getQueue(buildingEid)
  const faction = Faction.id[buildingEid]
  const res = gameState.getResources(faction)
  // Refund currently producing
  if (Producer.active[buildingEid]) {
    const def = UNIT_DEFS[Producer.unitType[buildingEid]]
    if (def) {
      res.minerals += def.cost.minerals
      res.gas += def.cost.gas
      res.supplyCurrent = Math.max(0, res.supplyCurrent - def.supply)
    }
    Producer.active[buildingEid] = 0
    Producer.progress[buildingEid] = 0
  }
  // Refund all queued
  for (const item of queue) {
    const def = UNIT_DEFS[item.unitType]
    if (def) {
      res.minerals += def.cost.minerals
      res.gas += def.cost.gas
      res.supplyCurrent = Math.max(0, res.supplyCurrent - def.supply)
    }
  }
  queue.length = 0
  if (queueContainer) queueContainer.innerHTML = ''
}

function cancelQueueItem(buildingEid: number, index: number) {
  const queue = gameState.getQueue(buildingEid)

  if (index === 0 && Producer.active[buildingEid]) {
    // Cancel currently producing — refund cost
    const unitType = Producer.unitType[buildingEid]
    const def = UNIT_DEFS[unitType]
    if (def) {
      const res = gameState.getResources(Faction.id[buildingEid])
      res.minerals += def.cost.minerals
      res.gas += def.cost.gas
      res.supplyCurrent = Math.max(0, res.supplyCurrent - def.supply)
    }
    queue.shift()
    if (queue.length > 0) {
      const next = queue[0]
      Producer.unitType[buildingEid] = next.unitType
      Producer.progress[buildingEid] = 0
      Producer.duration[buildingEid] = next.remaining
    } else {
      Producer.active[buildingEid] = 0
      Producer.progress[buildingEid] = 0
    }
  } else {
    // Cancel queued item — refund
    const actualIdx = Producer.active[buildingEid] ? index : index
    if (actualIdx >= 0 && actualIdx < queue.length) {
      const item = queue[actualIdx]
      const def = UNIT_DEFS[item.unitType]
      if (def) {
        const res = gameState.getResources(Faction.id[buildingEid])
        res.minerals += def.cost.minerals
        res.gas += def.cost.gas
        res.supplyCurrent = Math.max(0, res.supplyCurrent - def.supply)
      }
      queue.splice(actualIdx, 1)
    }
  }
  // Force rebuild
  if (queueContainer) queueContainer.innerHTML = ''
}

function updateAffordability() {
  const res = gameState.getResources(FACTION_PLAYER)
  const btns = actionButtonsEl.querySelectorAll('.action-btn')
  btns.forEach(btn => {
    const costEl = btn.querySelectorAll('.label')[1] // second .label is cost
    if (!costEl) return
    const costText = costEl.textContent || ''
    if (!costText.includes('m')) return // not a cost button
    // Parse cost: "100m 50g" or "100m"
    const mMatch = costText.match(/(\d+)m/)
    const gMatch = costText.match(/(\d+)g/)
    const mineralCost = mMatch ? parseInt(mMatch[1]) : 0
    const gasCost = gMatch ? parseInt(gMatch[1]) : 0
    const canAfford = res.minerals >= mineralCost && res.gas >= gasCost
    btn.classList.toggle('disabled', !canAfford)
  })
}

function updateActionButtons(world: IWorld, eid: number) {
  actionButtonsEl.innerHTML = ''

  const faction = Faction.id[eid]
  if (faction !== FACTION_PLAYER) return

  const isBuilding = hasComponent(world, IsBuilding, eid)
  const ut = UnitTypeC.id[eid]

  if (isBuilding) {
    const bdef = BUILDING_DEFS[ut]
    if (bdef?.canProduce) {
      for (const unitType of bdef.canProduce) {
        const udef = UNIT_DEFS[unitType]
        if (!udef) continue
        const btn = createActionButton(
          unitType === 0 ? '👷' : unitType === 1 ? '🔫' : unitType === 3 ? '🚙' : unitType === 4 ? '🚀' : unitType === 5 ? '🔫' : '🛡️',
          `${udef.name} (Q)`,
          `${udef.cost.minerals}m ${udef.cost.gas > 0 ? udef.cost.gas + 'g' : ''}`,
          () => queueProduction(eid, unitType),
        )
        actionButtonsEl.appendChild(btn)
      }
      // Rally point button (for mobile)
      actionButtonsEl.appendChild(createActionButton('🚩', 'Rally', 'tap ground', () => {
        setRallyMode(true)
      }))
      // Stop all production
      actionButtonsEl.appendChild(createActionButton('⏹️', 'Cancel All', '', () => {
        cancelAllProduction(eid)
      }))
    }
  }

  // ── Unit commands (for all player units) ──
  if (!isBuilding && hasComponent(world, MoveSpeed, eid)) {
    // Attack-move action button (one-shot: click then click ground)
    actionButtonsEl.appendChild(createActionButton('⚔️', `Attack (${getBindingLabel('attackMove')})`, 'tap target', () => {
      setForceAttackMode(true)
    }))

    // Stop command (S) — stop moving, keep shooting in range
    actionButtonsEl.appendChild(createActionButton('⏹️', `Stop (${getBindingLabel('stop')})`, '', () => {
      const sel = selectedQuery(world)
      for (const sid of sel) {
        if (hasComponent(world, MoveTarget, sid)) removeComponent(world, MoveTarget, sid)
        if (hasComponent(world, AttackMove, sid)) removeComponent(world, AttackMove, sid)
        if (hasComponent(world, PathFollower, sid)) { removePath(PathFollower.pathId[sid]); removeComponent(world, PathFollower, sid) }
        Velocity.x[sid] = 0; Velocity.z[sid] = 0
        clearQueue(sid)
        if (hasComponent(world, WorkerC, sid)) WorkerC.state[sid] = 0
      }
    }))
  }

  if (hasComponent(world, WorkerC, eid)) {
    const buildOptions = [
      { type: BT_COMMAND_CENTER, icon: '🏛️', key: 'C' },
      { type: BT_SUPPLY_DEPOT, icon: '📦', key: 'V' },
      { type: BT_BARRACKS, icon: '⚔️', key: 'B' },
      { type: BT_FACTORY, icon: '🏭', key: 'F' },
    ]
    for (const opt of buildOptions) {
      const bdef = BUILDING_DEFS[opt.type]
      if (!bdef) continue
      const btn = createActionButton(
        opt.icon,
        `${bdef.name} (${opt.key})`,
        `${bdef.cost.minerals}m ${bdef.cost.gas > 0 ? bdef.cost.gas + 'g' : ''}`,
        () => enterBuildMode(opt.type),
      )
      actionButtonsEl.appendChild(btn)
    }
  }
}

let lastWorld: IWorld | null = null

function createActionButton(
  icon: string,
  label: string,
  cost: string,
  onClick: () => void,
): HTMLElement {
  const btn = document.createElement('div')
  btn.className = 'action-btn'
  btn.innerHTML = `<span class="icon">${icon}</span><span class="label">${label}</span><span class="label" style="color:#aaa">${cost}</span>`
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    onClick()
  })
  return btn
}
