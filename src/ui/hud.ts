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
      // Show queue
      const queue = gameState.getQueue(eid)
      if (queue.length > 1) {
        const queueNames = queue.slice(1).map(q => UNIT_DEFS[q.unitType]?.name ?? '?').join(', ')
        stats.push(`Queue: ${queueNames}`)
      }
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
  updateModeHighlight(world, selected)
}

function updateModeHighlight(world: IWorld, selected: number[]) {
  if (selected.length === 0) return
  const eid = selected[0]
  if (!hasComponent(world, UnitMode, eid)) return
  const mode = UnitMode.mode[eid]
  const btns = actionButtonsEl.querySelectorAll('.action-btn')
  btns.forEach(btn => {
    const label = btn.querySelector('.label')?.textContent || ''
    if (label === 'Move') {
      btn.classList.toggle('active', mode === MODE_MOVE)
    } else if (label === 'Attack (A)') {
      btn.classList.toggle('active', mode === MODE_ATTACK_MOVE)
    }
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
      // Rally point button
      actionButtonsEl.appendChild(createActionButton('🚩', 'Rally Point', '', () => {
        setRallyMode(true)
      }))
    }
  }

  // ── Unit commands (for all player units) ──
  if (!isBuilding && hasComponent(world, MoveSpeed, eid)) {
    // Determine current mode of first selected unit
    const currentMode = hasComponent(world, UnitMode, eid) ? UnitMode.mode[eid] : MODE_MOVE

    // Move mode button
    const moveBtn = createActionButton('🏃', 'Move', '', () => {
      setForceAttackMode(false)
      const sel = selectedQuery(world)
      for (const sid of sel) {
        if (hasComponent(world, UnitMode, sid)) UnitMode.mode[sid] = MODE_MOVE
      }
      refreshModeHighlight()
    })
    if (currentMode === MODE_MOVE) moveBtn.classList.add('active')
    actionButtonsEl.appendChild(moveBtn)

    // Attack-Move mode button
    const atkBtn = createActionButton('⚔️', 'Attack (A)', '', () => {
      setForceAttackMode(false)
      const sel = selectedQuery(world)
      for (const sid of sel) {
        if (hasComponent(world, UnitMode, sid)) UnitMode.mode[sid] = MODE_ATTACK_MOVE
      }
      refreshModeHighlight()
    })
    if (currentMode === MODE_ATTACK_MOVE) atkBtn.classList.add('active')
    actionButtonsEl.appendChild(atkBtn)

    // Stop command (S) — stop moving, keep shooting in range
    actionButtonsEl.appendChild(createActionButton('⏹️', 'Stop (S)', '', () => {
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

function refreshModeHighlight() {
  const btns = actionButtonsEl.querySelectorAll('.action-btn')
  btns.forEach(btn => {
    const label = btn.querySelector('.label')?.textContent || ''
    if (label === 'Move' || label === 'Attack (A)') {
      btn.classList.remove('active')
    }
  })
  // Re-check first selected unit's mode
  const sel = selectedQuery(lastWorld!)
  if (sel.length > 0) {
    const mode = hasComponent(lastWorld!, UnitMode, sel[0]) ? UnitMode.mode[sel[0]] : MODE_MOVE
    btns.forEach(btn => {
      const label = btn.querySelector('.label')?.textContent || ''
      if (label === 'Move' && mode === MODE_MOVE) btn.classList.add('active')
      if (label === 'Attack (A)' && mode === MODE_ATTACK_MOVE) btn.classList.add('active')
    })
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
