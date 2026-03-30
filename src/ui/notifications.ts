// ─── In-game notification system ────────────────────────────────
// Starcraft-style event messages: "Unit under attack", "Not enough minerals", etc.

import { FACTION_PLAYER } from '../game/config'

export type NotifType = 'warning' | 'info' | 'error'

interface Notification {
  text: string
  type: NotifType
  time: number   // timestamp when created
  el: HTMLDivElement
}

const NOTIF_DURATION = 4000   // ms before fade out
const NOTIF_FADE = 600        // ms fade animation
const MAX_VISIBLE = 5         // max notifications visible at once
const COOLDOWNS = new Map<string, number>() // prevent spam: key → last shown timestamp
const COOLDOWN_MS = 3000      // minimum ms between same notification

let container: HTMLDivElement | null = null
const active: Notification[] = []

export function initNotifications() {
  if (container) return
  container = document.createElement('div')
  container.id = 'notification-container'
  container.style.cssText = `
    position: fixed; top: 50px; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    z-index: 28; pointer-events: none;
  `
  document.body.appendChild(container)
}

const TYPE_STYLES: Record<NotifType, string> = {
  warning: 'border-left: 3px solid #ff9800; background: rgba(40,30,10,0.92);',
  error:   'border-left: 3px solid #f44336; background: rgba(40,10,10,0.92);',
  info:    'border-left: 3px solid #4fc3f7; background: rgba(10,20,40,0.92);',
}

export function showNotification(text: string, type: NotifType = 'warning', cooldownKey?: string) {
  if (!container) initNotifications()

  // Cooldown check — prevent spamming same message
  const key = cooldownKey ?? text
  const now = performance.now()
  const lastShown = COOLDOWNS.get(key)
  if (lastShown && now - lastShown < COOLDOWN_MS) return
  COOLDOWNS.set(key, now)

  // Remove oldest if too many
  while (active.length >= MAX_VISIBLE) {
    removeNotification(active[0])
  }

  const el = document.createElement('div')
  el.textContent = text
  el.style.cssText = `
    padding: 6px 16px; border-radius: 3px; font-size: 13px; font-weight: 600;
    color: #e0e0e0; white-space: nowrap; opacity: 0;
    transition: opacity 0.2s, transform 0.2s;
    transform: translateY(-10px);
    ${TYPE_STYLES[type]}
  `
  container!.appendChild(el)

  // Animate in
  requestAnimationFrame(() => {
    el.style.opacity = '1'
    el.style.transform = 'translateY(0)'
  })

  const notif: Notification = { text, type, time: now, el }
  active.push(notif)

  // Auto-remove after duration
  setTimeout(() => removeNotification(notif), NOTIF_DURATION)
}

function removeNotification(notif: Notification) {
  const idx = active.indexOf(notif)
  if (idx < 0) return
  active.splice(idx, 1)

  notif.el.style.opacity = '0'
  notif.el.style.transform = 'translateY(-10px)'
  setTimeout(() => notif.el.remove(), NOTIF_FADE)
}

// ── Convenience helpers ─────────────────────────────────────
export function notifyUnitUnderAttack() {
  showNotification('Your units are under attack!', 'warning', 'unit-attacked')
}

export function notifyBaseUnderAttack() {
  showNotification('Your base is under attack!', 'error', 'base-attacked')
}

export function notifyEnemyBaseSpotted() {
  showNotification('Enemy base spotted!', 'info', 'enemy-base-spotted')
}

export function notifyNotEnoughMinerals() {
  showNotification('Not enough minerals', 'error', 'no-minerals')
}

export function notifyNotEnoughGas() {
  showNotification('Not enough gas', 'error', 'no-gas')
}

export function notifyNotEnoughSupply() {
  showNotification('Not enough supply — build Supply Depots', 'error', 'no-supply')
}

export function notifyProductionBlocked() {
  showNotification('Production blocked — insufficient supply', 'warning', 'prod-blocked')
}

export function notifyBuildingComplete(name: string) {
  showNotification(`${name} complete`, 'info', `building-${name}`)
}

export function notifyUnitReady(name: string) {
  showNotification(`${name} ready`, 'info', `unit-${name}`)
}

export function notifyScoutingReport(msg: string) {
  showNotification(msg, 'info', 'scout-report')
}
