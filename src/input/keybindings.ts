/**
 * Keybinding system — configurable controls with presets.
 *
 * Two mouse modes:
 * - 'supcom': left click = select AND command, right click = deselect
 * - 'starcraft': left click = select, right click = command
 */

// ── Game Actions ────────────────────────────────────────────
export type GameAction =
  | 'attackMove'
  | 'stop'
  | 'buildBarracks'
  | 'buildSupplyDepot'
  | 'buildFactory'
  | 'buildCommandCenter'
  | 'produce'
  | 'cancel'

export interface KeyBinding {
  key: string   // e.key value (case-insensitive comparison)
  ctrl?: boolean
  label?: string // display label override
}

export type MouseMode = 'supcom' | 'starcraft'

export interface ControlPreset {
  name: string
  mouseMode: MouseMode
  bindings: Record<GameAction, KeyBinding>
}

// ── Action labels (for UI) ──────────────────────────────────
export const ACTION_LABELS: Record<GameAction, string> = {
  attackMove: 'Attack Move',
  stop: 'Stop',
  buildBarracks: 'Build Barracks',
  buildSupplyDepot: 'Build Supply Depot',
  buildFactory: 'Build Factory',
  buildCommandCenter: 'Build Command Center',
  produce: 'Produce Unit',
  cancel: 'Cancel / ESC',
}

export const ALL_ACTIONS: GameAction[] = Object.keys(ACTION_LABELS) as GameAction[]

// ── Presets ──────────────────────────────────────────────────
const SUPCOM_BINDINGS: Record<GameAction, KeyBinding> = {
  attackMove:         { key: 'a', label: 'A' },
  stop:               { key: 's', label: 'S' },
  buildBarracks:      { key: 'b', label: 'B' },
  buildSupplyDepot:   { key: 'v', label: 'V' },
  buildFactory:       { key: 'f', label: 'F' },
  buildCommandCenter: { key: 'c', label: 'C' },
  produce:            { key: 'q', label: 'Q' },
  cancel:             { key: 'Escape', label: 'ESC' },
}

const STARCRAFT_BINDINGS: Record<GameAction, KeyBinding> = {
  attackMove:         { key: 'a', label: 'A' },
  stop:               { key: 's', label: 'S' },
  buildBarracks:      { key: 'b', label: 'B' },
  buildSupplyDepot:   { key: 'v', label: 'V' },
  buildFactory:       { key: 'f', label: 'F' },
  buildCommandCenter: { key: 'c', label: 'C' },
  produce:            { key: 'q', label: 'Q' },
  cancel:             { key: 'Escape', label: 'ESC' },
}

export const PRESET_SUPCOM: ControlPreset = {
  name: 'Supreme Commander',
  mouseMode: 'supcom',
  bindings: SUPCOM_BINDINGS,
}

export const PRESET_STARCRAFT: ControlPreset = {
  name: 'Starcraft',
  mouseMode: 'starcraft',
  bindings: STARCRAFT_BINDINGS,
}

export const PRESETS: ControlPreset[] = [PRESET_SUPCOM, PRESET_STARCRAFT]

// ── Runtime State ───────────────────────────────────────────
let currentMouseMode: MouseMode = 'supcom'
let bindings: Record<GameAction, KeyBinding> = { ...SUPCOM_BINDINGS }

export function getMouseMode(): MouseMode {
  return currentMouseMode
}

export function getBinding(action: GameAction): KeyBinding {
  return bindings[action]
}

export function getBindingLabel(action: GameAction): string {
  const b = bindings[action]
  return b.label || b.key.toUpperCase()
}

/** Check if a keyboard event matches an action */
export function matchesAction(e: KeyboardEvent, action: GameAction): boolean {
  const b = bindings[action]
  if (!b) return false
  const keyMatch = e.key.toLowerCase() === b.key.toLowerCase()
  if (b.ctrl && !e.ctrlKey) return false
  return keyMatch
}

/** Apply a preset */
export function applyPreset(preset: ControlPreset) {
  currentMouseMode = preset.mouseMode
  bindings = { ...preset.bindings }
}

/** Rebind a single action */
export function rebindAction(action: GameAction, key: string, label?: string) {
  bindings[action] = { key, label: label || key.toUpperCase() }
}

/** Save to localStorage */
export function saveBindings() {
  const data = { mouseMode: currentMouseMode, bindings }
  localStorage.setItem('rts-keybindings', JSON.stringify(data))
}

/** Load from localStorage, fallback to SupCom preset */
export function loadBindings() {
  try {
    const raw = localStorage.getItem('rts-keybindings')
    if (raw) {
      const data = JSON.parse(raw)
      if (data.mouseMode) currentMouseMode = data.mouseMode
      if (data.bindings) {
        // Merge with defaults so new actions get default bindings
        bindings = { ...SUPCOM_BINDINGS, ...data.bindings }
      }
    }
  } catch { /* ignore corrupt data */ }
}

/** Get current preset name or 'custom' */
export function getPresetName(): string {
  for (const p of PRESETS) {
    if (p.mouseMode !== currentMouseMode) continue
    let match = true
    for (const a of ALL_ACTIONS) {
      if (bindings[a].key.toLowerCase() !== p.bindings[a].key.toLowerCase()) {
        match = false
        break
      }
    }
    if (match) return p.name
  }
  return 'Custom'
}
