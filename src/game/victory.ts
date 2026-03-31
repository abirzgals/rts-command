// ─── Victory / Defeat system ────────────────────────────────────
// Checks if either faction has lost all buildings. Shows end screen with stats.

import { defineQuery, hasComponent } from 'bitecs'
import type { IWorld } from 'bitecs'
import { Faction, IsBuilding, Dead, Health } from '../ecs/components'
import { FACTION_PLAYER, FACTION_ENEMY } from '../game/config'
import { getPlayerFaction } from './factions'
import { isFPSMode, exitFPSMode } from '../input/fpsMode'

// ── Game stats (tracked continuously) ───────────────────────
export const gameStats: Record<number, { unitsKilled: number; unitsLost: number; buildingsDestroyed: number; resourcesGathered: number }> = {
  [FACTION_PLAYER]: { unitsKilled: 0, unitsLost: 0, buildingsDestroyed: 0, resourcesGathered: 0 },
  [FACTION_ENEMY]:  { unitsKilled: 0, unitsLost: 0, buildingsDestroyed: 0, resourcesGathered: 0 },
}

export function recordKill(killerFaction: number, victimIsBuilding: boolean) {
  const victim = killerFaction === FACTION_PLAYER ? FACTION_ENEMY : FACTION_PLAYER
  if (victimIsBuilding) {
    gameStats[killerFaction].buildingsDestroyed++
  } else {
    gameStats[killerFaction].unitsKilled++
  }
  if (victimIsBuilding) {
    gameStats[victim].buildingsDestroyed++ // not quite right, track as lost
  } else {
    gameStats[victim].unitsLost++
  }
}

export function recordGather(faction: number, amount: number) {
  gameStats[faction].resourcesGathered += amount
}

// ── Victory check ───────────────────────────────────────────
const buildingQuery = defineQuery([Faction, IsBuilding, Health])
let gameOver = false
let checkTimer = 0

export function isGameOver() { return gameOver }

export function checkVictory(world: IWorld, dt: number) {
  if (gameOver) return
  checkTimer += dt
  if (checkTimer < 3.0) return // check every 3 seconds
  checkTimer = 0

  const buildings = buildingQuery(world)
  let playerBuildings = 0
  let enemyBuildings = 0

  for (const eid of buildings) {
    if (hasComponent(world, Dead, eid)) continue
    if (Faction.id[eid] === getPlayerFaction()) playerBuildings++
    else enemyBuildings++
  }

  if (enemyBuildings === 0 && playerBuildings > 0) {
    showEndScreen(true)
  } else if (playerBuildings === 0 && enemyBuildings > 0) {
    showEndScreen(false)
  }
}

// ── End screen ──────────────────────────────────────────────
function showEndScreen(victory: boolean) {
  gameOver = true
  if (isFPSMode()) exitFPSMode()

  const pf = getPlayerFaction()
  const ef = pf === FACTION_PLAYER ? FACTION_ENEMY : FACTION_PLAYER
  const ps = gameStats[pf]
  const es = gameStats[ef]

  const overlay = document.createElement('div')
  overlay.id = 'end-screen'
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2000',
    background: victory ? 'rgba(10,30,10,0.92)' : 'rgba(40,10,10,0.92)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'Segoe UI', Arial, sans-serif",
  })

  const titleColor = victory ? '#4caf50' : '#f44336'
  const titleText = victory ? 'VICTORY' : 'DEFEAT'

  overlay.innerHTML = `
    <div style="background:rgba(15,15,25,0.9);border:1px solid ${titleColor}40;border-radius:12px;
      padding:32px 48px;text-align:center;min-width:400px;max-width:550px">
      <h1 style="color:${titleColor};font-size:36px;margin-bottom:8px;letter-spacing:4px">${titleText}</h1>
      <p style="color:#888;font-size:13px;margin-bottom:20px">${victory ? 'All enemy buildings destroyed' : 'All your buildings destroyed'}</p>

      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#ccc;margin-bottom:24px">
        <tr style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px">
          <td style="padding:6px 8px;text-align:left">Stat</td>
          <td style="padding:6px 8px;text-align:center;color:#6af">You</td>
          <td style="padding:6px 8px;text-align:center;color:#f66">Enemy</td>
        </tr>
        <tr style="border-top:1px solid #333">
          <td style="padding:6px 8px">Units Killed</td>
          <td style="padding:6px 8px;text-align:center;font-weight:600">${ps.unitsKilled}</td>
          <td style="padding:6px 8px;text-align:center;font-weight:600">${es.unitsKilled}</td>
        </tr>
        <tr style="border-top:1px solid #222">
          <td style="padding:6px 8px">Units Lost</td>
          <td style="padding:6px 8px;text-align:center">${ps.unitsLost}</td>
          <td style="padding:6px 8px;text-align:center">${es.unitsLost}</td>
        </tr>
        <tr style="border-top:1px solid #222">
          <td style="padding:6px 8px">Buildings Destroyed</td>
          <td style="padding:6px 8px;text-align:center">${ps.buildingsDestroyed}</td>
          <td style="padding:6px 8px;text-align:center">${es.buildingsDestroyed}</td>
        </tr>
        <tr style="border-top:1px solid #222">
          <td style="padding:6px 8px">Resources Gathered</td>
          <td style="padding:6px 8px;text-align:center">${ps.resourcesGathered}</td>
          <td style="padding:6px 8px;text-align:center">${es.resourcesGathered}</td>
        </tr>
      </table>

      <button id="end-menu-btn" style="
        padding:12px 32px;border:1px solid ${titleColor};border-radius:6px;
        background:${victory ? '#2a5a2a' : '#5a2a2a'};color:#fff;cursor:pointer;
        font-size:15px;width:100%
      ">Return to Main Menu</button>
    </div>
  `
  document.body.appendChild(overlay)

  document.getElementById('end-menu-btn')!.addEventListener('click', () => {
    window.location.reload()
  })
}
