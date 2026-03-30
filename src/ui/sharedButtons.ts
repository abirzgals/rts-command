// ─── Shared floating buttons — injected into every scene ────────────────
// Debug toggle, navigation links (Game, Editor, Sandbox)
// Call initSharedButtons() once after DOM is ready.

import { toggleDebug, isDebugEnabled } from '../render/debugOverlay'
import { telemetry } from '../debug/movementTelemetry'
import { Selected } from '../ecs/components'
import { defineQuery, removeComponent } from 'bitecs'
import { gameState } from '../game/state'
import { openSettingsUI } from './settingsUI'
import { FACTION_PLAYER, FACTION_ENEMY, UT_WORKER, UT_MARINE, UT_TANK, UT_JEEP, UT_ROCKET, UNIT_DEFS, BT_COMMAND_CENTER, BT_SUPPLY_DEPOT, BT_BARRACKS, BT_FACTORY, BUILDING_DEFS } from '../game/config'
import { spawnUnit, spawnBuilding } from '../ecs/archetypes'
import { mouseWorldX, mouseWorldZ } from '../input/input'
import { Faction } from '../ecs/components'
import { resetAIState } from '../ecs/systems/aiSystem'

const selectedQuery = defineQuery([Selected])
const factionQuery = defineQuery([Faction])

const BUTTON_STYLE = `
  position:fixed; width:40px; height:40px; border-radius:50%;
  background:rgba(80,80,80,0.7); border:1px solid rgba(200,200,200,0.3);
  color:#fff; font-size:18px; z-index:100; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  text-decoration:none; -webkit-tap-highlight-color:transparent;
`

interface ButtonDef {
  id: string
  icon: string
  title: string
  href?: string
  right: number
  onClick?: () => void
}

export function initSharedButtons() {
  // Don't double-init
  if (document.getElementById('_shared-btns')) return

  const currentPath = window.location.pathname

  const buttons: ButtonDef[] = [
    { id: 'sb-debug', icon: '\u{1F41B}', title: 'Toggle Debug (F1)', right: 16,
      onClick: () => {
        toggleDebug()
        const dbg = isDebugEnabled()
        const btn = document.getElementById('sb-debug')
        if (btn) btn.style.background = dbg
          ? 'rgba(50,200,100,0.7)' : 'rgba(80,80,80,0.7)'
        const moneyBtn = document.getElementById('sb-money')
        if (moneyBtn) moneyBtn.style.display = dbg ? 'flex' : 'none'
        const swapBtn = document.getElementById('sb-swap')
        if (swapBtn) swapBtn.style.display = dbg ? 'flex' : 'none'
      }},
    { id: 'sb-money', icon: '💰', title: '+1000 minerals & gas', right: 16,
      onClick: () => {
        const res = gameState.getResources(FACTION_PLAYER)
        res.minerals += 1000
        res.gas += 1000
      }},
    { id: 'sb-swap', icon: '🔄', title: 'Swap Teams (T)', right: 16,
      onClick: () => swapTeams() },
    { id: 'sb-settings', icon: '\u2699\uFE0F', title: 'Controls Settings', right: 64,
      onClick: () => openSettingsUI() },
  ]

  // Navigation links — skip the one for the current page
  if (!currentPath.endsWith('/editor.html')) {
    buttons.push({ id: 'sb-editor', icon: '\u2699', title: 'Editor', href: '/editor.html', right: 64 })
  }
  if (!currentPath.endsWith('/sandbox.html')) {
    buttons.push({ id: 'sb-sandbox', icon: '\u2694', title: 'Sandbox', href: '/sandbox.html', right: 112 })
  }
  if (!currentPath.endsWith('/mapeditor.html')) {
    buttons.push({ id: 'sb-mapeditor', icon: '\u{1F5FA}', title: 'Map Editor', href: '/mapeditor.html', right: 16 + buttons.length * 48 })
  }
  if (currentPath.endsWith('/editor.html') || currentPath.endsWith('/sandbox.html') || currentPath.endsWith('/mapeditor.html')) {
    buttons.push({ id: 'sb-game', icon: '\u{1F3AE}', title: 'Game', href: '/', right: 16 + buttons.length * 48 })
  }

  const wrapper = document.createElement('div')
  wrapper.id = '_shared-btns'

  for (const def of buttons) {
    const el = def.href
      ? document.createElement('a')
      : document.createElement('button')

    el.id = def.id
    el.title = def.title
    el.innerHTML = def.icon
    const top = def.id === 'sb-money' ? 96 : def.id === 'sb-swap' ? 142 : 50
    const hidden = (def.id === 'sb-money' || def.id === 'sb-swap') ? 'display:none;' : ''
    el.setAttribute('style', BUTTON_STYLE + `top:${top}px; right:${def.right}px;` + hidden)

    if (def.href) (el as HTMLAnchorElement).href = def.href
    if (def.onClick) el.addEventListener('click', def.onClick)

    // Hover effect
    el.addEventListener('mouseenter', () => {
      if (!isDebugEnabled() || el.id !== 'sb-debug')
        el.style.background = 'rgba(100,120,255,0.7)'
    })
    el.addEventListener('mouseleave', () => {
      if (el.id === 'sb-debug' && isDebugEnabled()) {
        el.style.background = 'rgba(50,200,100,0.7)'
      } else {
        el.style.background = 'rgba(80,80,80,0.7)'
      }
    })

    wrapper.appendChild(el)
  }

  document.body.appendChild(wrapper)

  // F1 keyboard shortcut for debug toggle
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F1') {
      e.preventDefault()
      const btn = document.getElementById('sb-debug')
      if (btn) btn.click()
    }
    // F2: toggle movement telemetry for selected unit
    if (e.key === 'F2') {
      e.preventDefault()
      if (telemetry.enabled) {
        telemetry.dump('Manual dump (F2)')
        telemetry.stop()
      } else {
        // Find selected unit in any world
        const w = (window as any).__ecsWorld
        if (w) {
          const sel = selectedQuery(w)
          if (sel.length > 0) {
            telemetry.start(sel[0])
          } else {
            console.log('[TELEMETRY] Select a unit first, then press F2')
          }
        }
      }
    }
    // F3: dump telemetry without stopping
    if (e.key === 'F3') {
      e.preventDefault()
      if (telemetry.enabled) {
        telemetry.dump('Snapshot (F3)')
      }
    }

    // T: swap teams
    if (isDebugEnabled() && (e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      swapTeams()
    }

    // Debug spawn: number keys 1-9 spawn units/buildings at cursor
    if (isDebugEnabled() && e.key >= '1' && e.key <= '9' && !e.ctrlKey && !e.altKey) {
      const w = (window as any).__ecsWorld
      if (!w) return
      const num = parseInt(e.key)
      const debugSpawns: { type: 'unit' | 'building'; id: number; name: string }[] = [
        { type: 'unit', id: 0, name: 'Worker' },      // 1
        { type: 'unit', id: 1, name: 'Marine' },      // 2
        { type: 'unit', id: 2, name: 'Tank' },        // 3
        { type: 'unit', id: 3, name: 'Jeep' },        // 4
        { type: 'unit', id: 4, name: 'Rocket' },      // 5
        { type: 'unit', id: 5, name: 'Trooper' },     // 6
        { type: 'building', id: 100, name: 'CC' },    // 7
        { type: 'building', id: 102, name: 'Barracks' }, // 8
        { type: 'building', id: 103, name: 'Factory' },  // 9
      ]
      const spawn = debugSpawns[num - 1]
      if (spawn) {
        const x = mouseWorldX, z = mouseWorldZ
        if (spawn.type === 'unit') {
          spawnUnit(w, spawn.id, FACTION_PLAYER, x, z)
        } else {
          spawnBuilding(w, spawn.id, FACTION_PLAYER, x, z, true)
        }
        console.log(`[DEBUG] Spawned ${spawn.name} at (${x.toFixed(1)}, ${z.toFixed(1)})`)
      }
    }
  })
}

function swapTeams() {
  const w = (window as any).__ecsWorld
  if (!w) return

  // 1. Swap faction on all entities
  const entities = factionQuery(w)
  for (const eid of entities) {
    Faction.id[eid] = Faction.id[eid] === FACTION_PLAYER ? FACTION_ENEMY : FACTION_PLAYER
  }

  // 2. Swap resources between factions
  const playerRes = gameState.getResources(FACTION_PLAYER)
  const enemyRes = gameState.getResources(FACTION_ENEMY)
  const tmpMin = playerRes.minerals
  const tmpGas = playerRes.gas
  const tmpSupCur = playerRes.supplyCurrent
  const tmpSupMax = playerRes.supplyMax
  playerRes.minerals = enemyRes.minerals
  playerRes.gas = enemyRes.gas
  playerRes.supplyCurrent = enemyRes.supplyCurrent
  playerRes.supplyMax = enemyRes.supplyMax
  enemyRes.minerals = tmpMin
  enemyRes.gas = tmpGas
  enemyRes.supplyCurrent = tmpSupCur
  enemyRes.supplyMax = tmpSupMax

  // 3. Clear player selection
  const selected = selectedQuery(w)
  for (const eid of selected) {
    removeComponent(w, Selected, eid)
  }

  // 4. Reset AI state so it re-evaluates with new units
  resetAIState()

  console.log(`[DEBUG] Teams swapped! ${entities.length} entities affected`)
}
