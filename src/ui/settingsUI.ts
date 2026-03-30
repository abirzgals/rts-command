/**
 * Settings UI — control scheme selection and key rebinding.
 */

import {
  ALL_ACTIONS, ACTION_LABELS, PRESETS,
  getBinding, getPresetName, applyPreset, rebindAction,
  saveBindings, saveBindingsToServer, loadBindingsFromServer, listServerPresets,
  getMouseMode, type GameAction,
} from '../input/keybindings'

let overlay: HTMLDivElement | null = null
let listenAction: GameAction | null = null
let listenEl: HTMLElement | null = null

export function openSettingsUI() {
  if (overlay) return

  overlay = document.createElement('div')
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2000',
    background: 'rgba(5,5,15,0.95)', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
    fontFamily: "'Segoe UI', Arial, sans-serif",
  })

  const box = document.createElement('div')
  Object.assign(box.style, {
    background: '#12121e', border: '1px solid #333', borderRadius: '12px',
    padding: '24px', minWidth: '380px', maxWidth: '500px',
  })

  const presetOptions = PRESETS.map(p =>
    `<option value="${p.name}" ${p.name === getPresetName() ? 'selected' : ''}>${p.name}</option>`
  ).join('') + `<option value="Custom" ${getPresetName() === 'Custom' ? 'selected' : ''}>Custom</option>`

  const mouseInfo = getMouseMode() === 'supcom'
    ? 'Left click = select & command, Right click = deselect'
    : 'Left click = select, Right click = command'

  const inputStyle = 'width:100%;padding:6px;border:1px solid #444;border-radius:4px;background:#1a1a2e;color:#fff;font-size:13px'

  box.innerHTML = `
    <h2 style="color:#8af;font-size:18px;margin:0 0 16px">Controls Settings</h2>
    <div style="margin-bottom:12px">
      <span style="color:#888;font-size:12px">PRESET</span>
      <select id="settings-preset" style="${inputStyle};margin-top:4px">${presetOptions}</select>
      <div id="settings-mouse-info" style="color:#666;font-size:11px;margin-top:4px">${mouseInfo}</div>
    </div>
    <div style="color:#888;font-size:12px;margin-bottom:8px">KEY BINDINGS</div>
    <div id="settings-bindings" style="max-height:220px;overflow-y:auto"></div>
    <div style="margin-top:12px;padding:10px;background:#1a1a2a;border:1px solid #333;border-radius:6px">
      <span style="color:#888;font-size:12px">SAVE / LOAD PRESET</span>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input id="settings-name" type="text" placeholder="Preset name..." style="${inputStyle};flex:1">
        <button id="settings-save-server" style="padding:6px 12px;border:1px solid #4a8a4a;border-radius:4px;background:#2a5a2a;color:#fff;cursor:pointer;font-size:12px;white-space:nowrap">Save</button>
      </div>
      <div id="settings-server-presets" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px"></div>
      <div id="settings-status" style="color:#6a6;font-size:11px;margin-top:4px"></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="settings-apply" style="flex:1;padding:8px;border:1px solid #4a8a4a;border-radius:4px;background:#2a5a2a;color:#fff;cursor:pointer;font-size:14px">Apply & Close</button>
      <button id="settings-close" style="flex:1;padding:8px;border:1px solid #666;border-radius:4px;background:#333;color:#fff;cursor:pointer;font-size:14px">Cancel</button>
    </div>
  `

  overlay.appendChild(box)
  document.body.appendChild(overlay)

  buildBindingRows()
  loadServerPresets()

  // Preset change
  document.getElementById('settings-preset')!.addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value
    const preset = PRESETS.find(p => p.name === name)
    if (preset) {
      applyPreset(preset)
      buildBindingRows()
      updateMouseInfo()
    }
  })

  // Save to server
  document.getElementById('settings-save-server')!.addEventListener('click', async () => {
    const nameEl = document.getElementById('settings-name') as HTMLInputElement
    const name = nameEl.value.trim()
    if (!name) { setStatus('Enter a name'); return }
    const ok = await saveBindingsToServer(name)
    setStatus(ok ? `Saved "${name}" to server` : `Saved "${name}" locally`)
    loadServerPresets()
  })

  // Apply & Close
  document.getElementById('settings-apply')!.addEventListener('click', () => {
    saveBindings()
    closeSettingsUI()
  })

  // Close
  document.getElementById('settings-close')!.addEventListener('click', closeSettingsUI)

  // Key capture listener
  document.addEventListener('keydown', onSettingsKeyDown)
}

export function closeSettingsUI() {
  if (overlay) {
    overlay.remove()
    overlay = null
  }
  listenAction = null
  listenEl = null
  document.removeEventListener('keydown', onSettingsKeyDown)
}

function updateMouseInfo() {
  const el = document.getElementById('settings-mouse-info')
  if (el) {
    el.textContent = getMouseMode() === 'supcom'
      ? 'Left click = select & command, Right click = deselect'
      : 'Left click = select, Right click = command'
  }
}

function buildBindingRows() {
  const container = document.getElementById('settings-bindings')!
  container.innerHTML = ''

  for (const action of ALL_ACTIONS) {
    const binding = getBinding(action)
    const row = document.createElement('div')
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 8px', margin: '2px 0', borderRadius: '4px',
      background: '#1a1a2a', border: '1px solid #333',
    })

    const label = document.createElement('span')
    label.style.color = '#ccc'
    label.style.fontSize = '13px'
    label.textContent = ACTION_LABELS[action]

    const keyBtn = document.createElement('button')
    Object.assign(keyBtn.style, {
      padding: '4px 12px', border: '1px solid #555', borderRadius: '3px',
      background: '#252535', color: '#fff', cursor: 'pointer', fontSize: '13px',
      minWidth: '50px', textAlign: 'center',
    })
    keyBtn.textContent = binding.label || binding.key.toUpperCase()
    keyBtn.dataset.action = action

    keyBtn.addEventListener('click', () => {
      // Enter listen mode
      if (listenEl) listenEl.style.borderColor = '#555'
      listenAction = action
      listenEl = keyBtn
      keyBtn.textContent = '...'
      keyBtn.style.borderColor = '#4a8aff'
    })

    row.appendChild(label)
    row.appendChild(keyBtn)
    container.appendChild(row)
  }
}

function setStatus(msg: string) {
  const el = document.getElementById('settings-status')
  if (el) el.textContent = msg
}

async function loadServerPresets() {
  const container = document.getElementById('settings-server-presets')
  if (!container) return
  const presets = await listServerPresets()
  if (presets.length === 0) {
    container.innerHTML = '<span style="color:#555;font-size:11px">No saved presets</span>'
    return
  }
  container.innerHTML = ''
  for (const name of presets) {
    const btn = document.createElement('button')
    Object.assign(btn.style, {
      padding: '4px 10px', border: '1px solid #444', borderRadius: '3px',
      background: '#252535', color: '#aaf', cursor: 'pointer', fontSize: '12px',
    })
    btn.textContent = name
    btn.addEventListener('click', async () => {
      const ok = await loadBindingsFromServer(name)
      if (ok) {
        buildBindingRows()
        updateMouseInfo()
        const presetSelect = document.getElementById('settings-preset') as HTMLSelectElement
        if (presetSelect) presetSelect.value = getPresetName()
        setStatus(`Loaded "${name}"`)
        const nameEl = document.getElementById('settings-name') as HTMLInputElement
        if (nameEl) nameEl.value = name
      } else {
        setStatus(`Failed to load "${name}"`)
      }
    })
    container.appendChild(btn)
  }
}

function onSettingsKeyDown(e: KeyboardEvent) {
  if (!listenAction || !listenEl) return
  e.preventDefault()
  e.stopPropagation()

  const key = e.key
  const label = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key

  rebindAction(listenAction, key, label)
  listenEl.textContent = label
  listenEl.style.borderColor = '#4a8a4a'

  // Update preset dropdown to "Custom" if bindings diverge
  const presetSelect = document.getElementById('settings-preset') as HTMLSelectElement
  if (presetSelect) presetSelect.value = getPresetName()

  listenAction = null
  listenEl = null
}
