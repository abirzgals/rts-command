// ─── Multiplayer Lobby UI ────────────────────────────────────────
// Shows host/join room interface before game starts.

import { connect, createRoom, joinRoom, setMap, startGame, on, disconnect, isConnected, getRoomId } from '../network/netClient'

export interface LobbyResult {
  mapName: string
  seed: number
  faction: number
}

/** Show multiplayer lobby. Resolves when the game starts. */
export function showMultiplayerLobby(
  mapList: string[],
  getWsUrl: () => string,
): Promise<LobbyResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.id = 'mp-lobby'
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:200;
      background:rgba(0,0,0,0.85);
      display:flex; align-items:center; justify-content:center;
      font-family:sans-serif; color:#eee;
    `

    let state: 'menu' | 'hosting' | 'joining' | 'waiting' | 'ready' = 'menu'
    let selectedMap = mapList[0] || 'random'
    let opponentName = ''
    let myFaction = 0

    function render() {
      if (state === 'menu') {
        overlay.innerHTML = `
          <div style="text-align:center;max-width:400px">
            <h2 style="margin-bottom:20px">Multiplayer</h2>
            <div style="display:flex;gap:12px;justify-content:center">
              <button id="mp-host" style="padding:12px 28px;font-size:16px;cursor:pointer;border-radius:6px;border:1px solid #555;background:#2a4a2a;color:#eee">
                Host Game
              </button>
              <button id="mp-join" style="padding:12px 28px;font-size:16px;cursor:pointer;border-radius:6px;border:1px solid #555;background:#2a3a5a;color:#eee">
                Join Game
              </button>
            </div>
            <button id="mp-back" style="margin-top:20px;padding:8px 20px;cursor:pointer;background:transparent;border:1px solid #666;color:#aaa;border-radius:4px">
              Back
            </button>
          </div>
        `
        overlay.querySelector('#mp-host')!.addEventListener('click', onHost)
        overlay.querySelector('#mp-join')!.addEventListener('click', onJoin)
        overlay.querySelector('#mp-back')!.addEventListener('click', () => { overlay.remove(); disconnect() })
      }

      else if (state === 'hosting') {
        const roomId = getRoomId() || '...'
        const mapOptions = mapList.map(m => `<option value="${m}" ${m === selectedMap ? 'selected' : ''}>${m}</option>`).join('')
        overlay.innerHTML = `
          <div style="text-align:center;max-width:400px">
            <h2>Hosting Game</h2>
            <div style="font-size:28px;letter-spacing:8px;margin:16px 0;color:#4c8;font-family:monospace">${roomId}</div>
            <div style="color:#999;margin-bottom:16px">Share this code with your opponent</div>
            ${opponentName
              ? `<div style="color:#4c8;margin-bottom:12px">Player 2: ${opponentName}</div>`
              : `<div style="color:#aa0;margin-bottom:12px">Waiting for player...</div>`
            }
            <div style="margin-bottom:12px">
              <label style="color:#aaa">Map: </label>
              <select id="mp-map" style="padding:4px 8px;font-size:14px">${mapOptions}</select>
            </div>
            <button id="mp-start" style="padding:10px 28px;font-size:16px;cursor:pointer;border-radius:6px;border:none;background:${opponentName ? '#2a6a2a' : '#555'};color:#eee"
              ${opponentName ? '' : 'disabled'}>
              Start Game
            </button>
            <br>
            <button id="mp-cancel" style="margin-top:12px;padding:6px 16px;cursor:pointer;background:transparent;border:1px solid #666;color:#aaa;border-radius:4px">
              Cancel
            </button>
          </div>
        `
        overlay.querySelector('#mp-map')!.addEventListener('change', (e) => {
          selectedMap = (e.target as HTMLSelectElement).value
          setMap(selectedMap)
        })
        if (opponentName) {
          overlay.querySelector('#mp-start')!.addEventListener('click', () => {
            startGame()
          })
        }
        overlay.querySelector('#mp-cancel')!.addEventListener('click', () => { state = 'menu'; disconnect(); render() })
      }

      else if (state === 'joining') {
        overlay.innerHTML = `
          <div style="text-align:center;max-width:400px">
            <h2>Join Game</h2>
            <div style="margin-bottom:12px">
              <input id="mp-code" type="text" maxlength="4" placeholder="Room Code"
                style="font-size:24px;text-align:center;letter-spacing:6px;width:150px;padding:8px;text-transform:uppercase;border-radius:6px;border:1px solid #555;background:#222;color:#eee">
            </div>
            <button id="mp-connect" style="padding:10px 28px;font-size:16px;cursor:pointer;border-radius:6px;border:none;background:#2a3a5a;color:#eee">
              Connect
            </button>
            <div id="mp-join-error" style="color:#f44;margin-top:8px"></div>
            <br>
            <button id="mp-cancel" style="margin-top:12px;padding:6px 16px;cursor:pointer;background:transparent;border:1px solid #666;color:#aaa;border-radius:4px">
              Cancel
            </button>
          </div>
        `
        overlay.querySelector('#mp-connect')!.addEventListener('click', async () => {
          const code = (overlay.querySelector('#mp-code') as HTMLInputElement).value.trim().toUpperCase()
          if (code.length !== 4) return
          try {
            if (!isConnected()) await connect(getWsUrl())
            joinRoom(code, 'Player 2')
          } catch {
            overlay.querySelector('#mp-join-error')!.textContent = 'Connection failed'
          }
        })
        overlay.querySelector('#mp-cancel')!.addEventListener('click', () => { state = 'menu'; disconnect(); render() })
        setTimeout(() => (overlay.querySelector('#mp-code') as HTMLInputElement)?.focus(), 50)
      }

      else if (state === 'waiting') {
        overlay.innerHTML = `
          <div style="text-align:center;max-width:400px">
            <h2>Joined Room ${getRoomId()}</h2>
            <div style="color:#aaa;margin:12px 0">Map: <b>${selectedMap}</b></div>
            <div style="color:#aa0">Waiting for host to start...</div>
            <br>
            <button id="mp-cancel" style="margin-top:12px;padding:6px 16px;cursor:pointer;background:transparent;border:1px solid #666;color:#aaa;border-radius:4px">
              Leave
            </button>
          </div>
        `
        overlay.querySelector('#mp-cancel')!.addEventListener('click', () => { state = 'menu'; disconnect(); render() })
      }
    }

    async function onHost() {
      try {
        if (!isConnected()) await connect(getWsUrl())
        createRoom('Player 1')
      } catch {
        alert('Failed to connect to server')
      }
    }

    function onJoin() {
      state = 'joining'
      render()
    }

    // Network events
    on('room_created', (data: any) => {
      myFaction = data.faction
      state = 'hosting'
      setMap(selectedMap)
      render()
    })

    on('room_joined', (data: any) => {
      myFaction = data.faction
      state = 'waiting'
      render()
    })

    on('player_joined', (data: any) => {
      opponentName = data.name
      render()
    })

    on('player_left', () => {
      opponentName = ''
      render()
    })

    on('map_set', (data: any) => {
      selectedMap = data.mapName
      render()
    })

    on('game_start', (data: any) => {
      overlay.remove()
      resolve({
        mapName: data.mapName,
        seed: data.seed,
        faction: myFaction,
      })
    })

    on('error', (data: any) => {
      const el = overlay.querySelector('#mp-join-error')
      if (el) el.textContent = data.message
    })

    document.body.appendChild(overlay)
    render()
  })
}
