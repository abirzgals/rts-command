// ─── RTS Command — REST API Server ──────────────────────────────────────
// Serves the static game + provides REST endpoints for editor configs
// Usage: node server.mjs
// ────────────────────────────────────────────────────────────────────────

import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

// Data directory for configs/maps
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// ─── Serve static files (built game) ──────────────────────────────────
// Custom textures from persistent volume take priority over built-in
const texDir = path.join(DATA_DIR, 'textures')
if (!fs.existsSync(texDir)) fs.mkdirSync(texDir, { recursive: true })
app.use('/textures', express.static(texDir))  // persistent volume first
app.use(express.static(path.join(__dirname, 'dist')))

// ─── REST API ─────────────────────────────────────────────────────────

// GET /api/config — load the editor config (data dir → built-in fallback)
app.get('/api/config', (req, res) => {
  const file = path.join(DATA_DIR, 'editor-config.json')
  if (fs.existsSync(file)) {
    return res.json({ data: JSON.parse(fs.readFileSync(file, 'utf-8')) })
  }
  // Fallback: check for built-in default
  const fallback = path.join(__dirname, 'dist', 'default-config.json')
  if (fs.existsSync(fallback)) {
    return res.json({ data: JSON.parse(fs.readFileSync(fallback, 'utf-8')) })
  }
  res.json({ data: null })
})

// POST /api/config — save the editor config
app.post('/api/config', (req, res) => {
  const file = path.join(DATA_DIR, 'editor-config.json')
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2))
  res.json({ ok: true, saved: file })
})

// GET /api/maps — list saved maps
app.get('/api/maps', (req, res) => {
  const dir = path.join(DATA_DIR, 'maps')
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return res.json({ data: [] }) }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({
    name: f.replace('.json', ''),
    file: f,
    modified: fs.statSync(path.join(dir, f)).mtime.toISOString(),
  }))
  res.json({ data: files })
})

// GET /api/maps/:name — load a map
app.get('/api/maps/:name', (req, res) => {
  const file = path.join(DATA_DIR, 'maps', req.params.name + '.json')
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Map not found' })
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  res.json({ data })
})

// POST /api/maps/:name — save a map
app.post('/api/maps/:name', (req, res) => {
  const dir = path.join(DATA_DIR, 'maps')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, req.params.name + '.json')
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2))
  res.json({ ok: true, saved: file })
})

// DELETE /api/maps/:name — delete a map
app.delete('/api/maps/:name', (req, res) => {
  const file = path.join(DATA_DIR, 'maps', req.params.name + '.json')
  if (fs.existsSync(file)) fs.unlinkSync(file)
  res.json({ ok: true })
})

// POST /api/textures/:name — upload a texture to persistent volume (base64 body)
app.post('/api/textures/:name', (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '')
  const file = path.join(texDir, name)
  if (req.body.data) {
    // base64-encoded image
    const buf = Buffer.from(req.body.data, 'base64')
    fs.writeFileSync(file, buf)
    res.json({ ok: true, saved: file })
  } else {
    res.status(400).json({ error: 'Missing data field' })
  }
})

// GET /api/textures — list available textures
app.get('/api/textures', (req, res) => {
  const files = fs.readdirSync(texDir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
  res.json({ data: files })
})

// GET /api/keybindings — list saved presets
app.get('/api/keybindings', (req, res) => {
  const dir = path.join(DATA_DIR, 'keybindings')
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return res.json({ data: [] }) }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  res.json({ data: files })
})

// GET /api/keybindings/:name — load a preset
app.get('/api/keybindings/:name', (req, res) => {
  const file = path.join(DATA_DIR, 'keybindings', req.params.name + '.json')
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' })
  res.json({ data: JSON.parse(fs.readFileSync(file, 'utf-8')) })
})

// POST /api/keybindings/:name — save a preset
app.post('/api/keybindings/:name', (req, res) => {
  const dir = path.join(DATA_DIR, 'keybindings')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, req.params.name + '.json')
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2))
  res.json({ ok: true })
})

// DELETE /api/keybindings/:name — delete a preset
app.delete('/api/keybindings/:name', (req, res) => {
  const file = path.join(DATA_DIR, 'keybindings', req.params.name + '.json')
  if (fs.existsSync(file)) fs.unlinkSync(file)
  res.json({ ok: true })
})

// ─── SPA fallback (Express 5 syntax) ──────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

const server = app.listen(PORT, () => {
  console.log(`\n  RTS Command server running on http://localhost:${PORT}`)
  console.log(`  Game:   http://localhost:${PORT}/`)
  console.log(`  Editor: http://localhost:${PORT}/editor.html`)
  console.log(`  API:    http://localhost:${PORT}/api/config`)
  console.log()
})

// ─── WebSocket Multiplayer Server ────────────────────────────────────

const wss = new WebSocketServer({ server })

/** @type {Map<string, { id: string, players: Map<import('ws'), { faction: number, name: string }>, mapName: string|null, started: boolean, currentTurn: number, turnCmds: Map<number, Map<number, any[]>> }>} */
const rooms = new Map()

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let id = ''
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)]
  return rooms.has(id) ? genRoomId() : id
}

function send(ws, type, data = {}) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...data }))
}

function broadcast(room, type, data = {}) {
  for (const [ws] of room.players) send(ws, type, data)
}

function getRoom(ws) {
  for (const room of rooms.values()) {
    if (room.players.has(ws)) return room
  }
  return null
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'quick_play') {
      leaveRoom(ws)
      const name = msg.name || 'Player'
      const mapName = msg.mapName || 'random'
      // Find a waiting room (not started, 1 player, same map)
      let found = null
      for (const room of rooms.values()) {
        if (!room.started && room.players.size === 1 && room.mapName === mapName) {
          found = room; break
        }
      }
      if (found) {
        // Join as player 2
        found.players.set(ws, { faction: 1, name })
        send(ws, 'room_joined', { roomId: found.id, faction: 1 })
        for (const [other] of found.players) {
          if (other !== ws) send(other, 'player_joined', { name, faction: 1 })
        }
        // Auto-start
        found.started = true
        found.currentTurn = 0
        broadcast(found, 'game_start', { mapName: found.mapName, seed: found.seed })
        console.log(`[MP] Quick play: ${name} joined room ${found.id}, auto-started`)
      } else {
        // Create new room and wait
        const id = genRoomId()
        const room = { id, players: new Map(), mapName, started: false, currentTurn: 0, turnCmds: new Map(), seed: Math.floor(Math.random() * 0x7FFFFFFF) }
        room.players.set(ws, { faction: 0, name })
        rooms.set(id, room)
        send(ws, 'room_created', { roomId: id, faction: 0, waiting: true })
        console.log(`[MP] Quick play: ${name} created room ${id}, waiting...`)
      }
    }

    else if (msg.type === 'create_room') {
      // Leave current room if any
      leaveRoom(ws)
      const id = genRoomId()
      const room = { id, players: new Map(), mapName: null, started: false, currentTurn: 0, turnCmds: new Map(), seed: Math.floor(Math.random() * 0x7FFFFFFF) }
      room.players.set(ws, { faction: 0, name: msg.name || 'Player 1' })
      rooms.set(id, room)
      send(ws, 'room_created', { roomId: id, faction: 0 })
      console.log(`[MP] Room ${id} created`)
    }

    else if (msg.type === 'join_room') {
      leaveRoom(ws)
      const room = rooms.get(msg.roomId?.toUpperCase())
      if (!room) return send(ws, 'error', { message: 'Room not found' })
      if (room.started) return send(ws, 'error', { message: 'Game already started' })
      if (room.players.size >= 2) return send(ws, 'error', { message: 'Room full' })

      const name = msg.name || 'Player 2'
      room.players.set(ws, { faction: 1, name })
      send(ws, 'room_joined', { roomId: room.id, faction: 1 })

      // Notify host
      for (const [other, info] of room.players) {
        if (other !== ws) send(other, 'player_joined', { name, faction: 1 })
        else if (room.mapName) send(ws, 'map_set', { mapName: room.mapName })
      }
      console.log(`[MP] ${name} joined room ${room.id}`)
    }

    else if (msg.type === 'leave_room') {
      leaveRoom(ws)
    }

    else if (msg.type === 'set_map') {
      const room = getRoom(ws)
      if (!room) return
      room.mapName = msg.mapName
      broadcast(room, 'map_set', { mapName: msg.mapName })
    }

    else if (msg.type === 'start_game') {
      const room = getRoom(ws)
      if (!room || room.players.size < 2) return send(ws, 'error', { message: 'Need 2 players' })
      const hostInfo = room.players.get(ws)
      if (!hostInfo || hostInfo.faction !== 0) return send(ws, 'error', { message: 'Only host can start' })
      room.started = true
      room.currentTurn = 0
      broadcast(room, 'game_start', { mapName: room.mapName, seed: room.seed })
      console.log(`[MP] Room ${room.id} game started, map=${room.mapName}`)
    }

    else if (msg.type === 'submit_commands') {
      const room = getRoom(ws)
      if (!room || !room.started) return
      const info = room.players.get(ws)
      if (!info) return
      const turn = msg.turn

      if (!room.turnCmds.has(turn)) room.turnCmds.set(turn, new Map())
      const tc = room.turnCmds.get(turn)
      tc.set(info.faction, msg.commands || [])

      // Both players submitted for this turn?
      if (tc.size >= room.players.size) {
        const cmds = [tc.get(0) || [], tc.get(1) || []]
        broadcast(room, 'turn_commands', { turn, commands: cmds })
        room.turnCmds.delete(turn) // cleanup
      }
    }
  })

  ws.on('close', () => {
    leaveRoom(ws)
  })
})

function leaveRoom(ws) {
  const room = getRoom(ws)
  if (!room) return
  const info = room.players.get(ws)
  room.players.delete(ws)
  if (room.players.size === 0) {
    rooms.delete(room.id)
    console.log(`[MP] Room ${room.id} closed (empty)`)
  } else {
    broadcast(room, 'player_left', { faction: info?.faction })
    console.log(`[MP] Player left room ${room.id}`)
  }
}
