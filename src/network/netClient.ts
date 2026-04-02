// ─── Multiplayer Network Client ─────────────────────────────────
// WebSocket-based command relay for 2-player RTS.
// In multiplayer: commands are sent to server, executed when both players submit.
// In single-player: this module is inactive, game runs as before.

import type { Command } from '../ecs/commandQueue'

// ── Types ──────────────────────────────────────────────────────

export interface NetworkCommand {
  entityIds: number[]
  command: Command
  replace: boolean // true = clear queue (normal click), false = shift-queue
}

export interface ProductionCommand {
  type: 'produce'
  buildingEid: number
  unitType: number
}

export interface BuildPlaceCommand {
  type: 'build_place'
  buildingType: number
  x: number
  z: number
  faction: number
  workerEids: number[]
}

export type NetCommand = NetworkCommand | ProductionCommand | BuildPlaceCommand

type EventCb<T> = (data: T) => void

// ── State ──────────────────────────────────────────────────────

let ws: WebSocket | null = null
let connected = false
let multiplayer = false
let localFaction = 0
let roomId: string | null = null

// Pending commands for the current turn (accumulated between turns)
const pendingCommands: NetCommand[] = []

// Turn tracking
let currentTurn = 0
let turnSubmitted = false
let turnReady = false
let receivedTurnCommands: [NetCommand[], NetCommand[]] | null = null

// Callbacks
const callbacks: Record<string, Function[]> = {}

function emit(event: string, data?: any) {
  for (const cb of callbacks[event] ?? []) cb(data)
}

// ── Public API ─────────────────────────────────────────────────

export function isMultiplayer(): boolean { return multiplayer }
export function isConnected(): boolean { return connected }
export function getLocalFaction(): number { return localFaction }
export function getRoomId(): string | null { return roomId }
export function getCurrentTurn(): number { return currentTurn }

export function on(event: string, cb: Function) {
  if (!callbacks[event]) callbacks[event] = []
  callbacks[event].push(cb)
}

export function off(event: string, cb: Function) {
  const arr = callbacks[event]
  if (arr) {
    const idx = arr.indexOf(cb)
    if (idx >= 0) arr.splice(idx, 1)
  }
}

// ── Connection ─────────────────────────────────────────────────

export function connect(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url)
    ws.onopen = () => { connected = true; resolve() }
    ws.onerror = () => reject(new Error('WebSocket connection failed'))
    ws.onclose = () => {
      connected = false
      if (multiplayer) emit('disconnected')
    }
    ws.onmessage = (e) => {
      let msg: any
      try { msg = JSON.parse(e.data) } catch { return }
      handleMessage(msg)
    }
  })
}

export function disconnect() {
  multiplayer = false
  connected = false
  roomId = null
  pendingCommands.length = 0
  receivedTurnCommands = null
  if (ws) { ws.close(); ws = null }
}

// ── Lobby ──────────────────────────────────────────────────────

function send(type: string, data: Record<string, any> = {}) {
  if (ws && connected) ws.send(JSON.stringify({ type, ...data }))
}

export function createRoom(name: string) { send('create_room', { name }) }
export function joinRoom(id: string, name: string) { send('join_room', { roomId: id, name }) }
export function quickPlay(name: string, mapName: string) { send('quick_play', { name, mapName }) }
export function leaveRoom() { send('leave_room'); roomId = null; multiplayer = false }
export function setMap(mapName: string) { send('set_map', { mapName }) }
export function startGame() { send('start_game') }

// ── Gameplay: command accumulation ─────────────────────────────

/** Queue a command for the current turn (called by input.ts instead of direct ECS) */
export function queueNetCommand(cmd: NetCommand) {
  pendingCommands.push(cmd)
}

/** Submit accumulated commands for the current turn to the server */
export function submitTurn() {
  if (turnSubmitted) return
  send('submit_commands', { turn: currentTurn, commands: pendingCommands.slice() })
  turnSubmitted = true
  pendingCommands.length = 0
}

/** Check if we have received confirmed commands for the current turn */
export function isTurnReady(): boolean { return turnReady }

/** Consume the confirmed turn commands (resets ready flag) */
export function consumeTurnCommands(): [NetCommand[], NetCommand[]] | null {
  if (!receivedTurnCommands) return null
  const cmds = receivedTurnCommands
  receivedTurnCommands = null
  turnReady = false
  turnSubmitted = false
  currentTurn++
  return cmds
}

// ── Message handling ───────────────────────────────────────────

function handleMessage(msg: any) {
  switch (msg.type) {
    case 'room_created':
      roomId = msg.roomId
      localFaction = msg.faction
      emit('room_created', { roomId: msg.roomId, faction: msg.faction })
      break

    case 'room_joined':
      roomId = msg.roomId
      localFaction = msg.faction
      emit('room_joined', { roomId: msg.roomId, faction: msg.faction })
      break

    case 'player_joined':
      emit('player_joined', { name: msg.name, faction: msg.faction })
      break

    case 'player_left':
      emit('player_left', { faction: msg.faction })
      break

    case 'map_set':
      emit('map_set', { mapName: msg.mapName })
      break

    case 'game_start':
      multiplayer = true
      currentTurn = 0
      turnSubmitted = false
      turnReady = false
      receivedTurnCommands = null
      pendingCommands.length = 0
      emit('game_start', { mapName: msg.mapName, seed: msg.seed })
      break

    case 'turn_commands':
      receivedTurnCommands = msg.commands as [NetCommand[], NetCommand[]]
      turnReady = true
      break

    case 'error':
      emit('error', { message: msg.message })
      break
  }
}
