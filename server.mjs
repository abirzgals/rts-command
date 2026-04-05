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
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3001

// Data directory for configs/maps
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// ─── SQLite Database ─────────────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'stats.db'))
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    games_played INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    buildings_destroyed INTEGER DEFAULT 0,
    resources_gathered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    map_name TEXT,
    mode TEXT,
    duration_sec REAL DEFAULT 0,
    winner_name TEXT,
    player1_name TEXT,
    player1_faction INTEGER,
    player1_kills INTEGER DEFAULT 0,
    player1_deaths INTEGER DEFAULT 0,
    player1_buildings_destroyed INTEGER DEFAULT 0,
    player1_resources INTEGER DEFAULT 0,
    player2_name TEXT,
    player2_faction INTEGER,
    player2_kills INTEGER DEFAULT 0,
    player2_deaths INTEGER DEFAULT 0,
    player2_buildings_destroyed INTEGER DEFAULT 0,
    player2_resources INTEGER DEFAULT 0,
    played_at TEXT DEFAULT (datetime('now'))
  );
`)

const stmtUpsertPlayer = db.prepare(`
  INSERT INTO players (name) VALUES (?)
  ON CONFLICT(name) DO UPDATE SET last_seen = datetime('now')
`)
const stmtGetPlayer = db.prepare(`SELECT * FROM players WHERE name = ?`)
const stmtUpdatePlayerWin = db.prepare(`
  UPDATE players SET wins = wins + 1, games_played = games_played + 1,
    kills = kills + ?2, deaths = deaths + ?3, buildings_destroyed = buildings_destroyed + ?4,
    resources_gathered = resources_gathered + ?5, last_seen = datetime('now')
  WHERE name = ?1
`)
const stmtUpdatePlayerLoss = db.prepare(`
  UPDATE players SET losses = losses + 1, games_played = games_played + 1,
    kills = kills + ?2, deaths = deaths + ?3, buildings_destroyed = buildings_destroyed + ?4,
    resources_gathered = resources_gathered + ?5, last_seen = datetime('now')
  WHERE name = ?1
`)
const stmtInsertGame = db.prepare(`
  INSERT INTO games (map_name, mode, duration_sec, winner_name,
    player1_name, player1_faction, player1_kills, player1_deaths, player1_buildings_destroyed, player1_resources,
    player2_name, player2_faction, player2_kills, player2_deaths, player2_buildings_destroyed, player2_resources)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const stmtLeaderboard = db.prepare(`
  SELECT name, games_played, wins, losses, kills, deaths, buildings_destroyed, resources_gathered
  FROM players ORDER BY wins DESC, kills DESC LIMIT 50
`)
const stmtRecentGames = db.prepare(`
  SELECT * FROM games ORDER BY played_at DESC LIMIT 20
`)

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

// ─── Stats API ───────────────────────────────────────────────────────

// POST /api/stats/register — register/touch player (called on game start)
app.post('/api/stats/register', (req, res) => {
  const name = req.body.name?.trim()
  if (!name) return res.status(400).json({ error: 'Name required' })
  stmtUpsertPlayer.run(name)
  const player = stmtGetPlayer.get(name)
  res.json({ data: player })
})

// GET /api/stats/player/:name — get player stats
app.get('/api/stats/player/:name', (req, res) => {
  const player = stmtGetPlayer.get(req.params.name)
  if (!player) return res.status(404).json({ error: 'Player not found' })
  res.json({ data: player })
})

// GET /api/stats/leaderboard — top 50 players
app.get('/api/stats/leaderboard', (_req, res) => {
  res.json({ data: stmtLeaderboard.all() })
})

// GET /api/stats/games — recent games
app.get('/api/stats/games', (_req, res) => {
  res.json({ data: stmtRecentGames.all() })
})

// POST /api/stats/game — record a finished game (called by client on victory/defeat)
app.post('/api/stats/game', (req, res) => {
  const g = req.body
  if (!g.player1_name || !g.player2_name) return res.status(400).json({ error: 'Players required' })

  stmtInsertGame.run(
    g.map_name || 'unknown', g.mode || 'pvp', g.duration_sec || 0, g.winner_name || '',
    g.player1_name, g.player1_faction ?? 0, g.player1_kills ?? 0, g.player1_deaths ?? 0, g.player1_buildings_destroyed ?? 0, g.player1_resources ?? 0,
    g.player2_name, g.player2_faction ?? 1, g.player2_kills ?? 0, g.player2_deaths ?? 0, g.player2_buildings_destroyed ?? 0, g.player2_resources ?? 0,
  )

  // Update player stats
  const isP1Winner = g.winner_name === g.player1_name
  const isP2Winner = g.winner_name === g.player2_name

  if (isP1Winner) {
    stmtUpdatePlayerWin.run(g.player1_name, g.player1_kills ?? 0, g.player1_deaths ?? 0, g.player1_buildings_destroyed ?? 0, g.player1_resources ?? 0)
    stmtUpdatePlayerLoss.run(g.player2_name, g.player2_kills ?? 0, g.player2_deaths ?? 0, g.player2_buildings_destroyed ?? 0, g.player2_resources ?? 0)
  } else if (isP2Winner) {
    stmtUpdatePlayerWin.run(g.player2_name, g.player2_kills ?? 0, g.player2_deaths ?? 0, g.player2_buildings_destroyed ?? 0, g.player2_resources ?? 0)
    stmtUpdatePlayerLoss.run(g.player1_name, g.player1_kills ?? 0, g.player1_deaths ?? 0, g.player1_buildings_destroyed ?? 0, g.player1_resources ?? 0)
  }

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

function getRoomPlayers(room) {
  const result = {}
  for (const [, info] of room.players) {
    result[`player${info.faction + 1}`] = info.name
  }
  if (room.hasBot) result.player2 = 'AI'
  return result
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    if (msg.type === 'play_vs_ai') {
      leaveRoom(ws)
      const name = msg.name || 'Player'
      const mapName = msg.mapName || 'random'
      const id = genRoomId()
      const room = { id, players: new Map(), mapName, started: true, currentTurn: 0, turnCmds: new Map(), seed: Math.floor(Math.random() * 0x7FFFFFFF), hasBot: true }
      room.players.set(ws, { faction: 0, name })
      // Bot placeholder — faction 1, no real ws
      room.botFaction = 1
      rooms.set(id, room)
      stmtUpsertPlayer.run(name)
      send(ws, 'room_created', { roomId: id, faction: 0 })
      send(ws, 'game_start', { mapName, seed: room.seed, vsAI: true, players: getRoomPlayers(room) })
      console.log(`[MP] Play vs AI: ${name} room ${id}`)
    }

    else if (msg.type === 'quick_play') {
      leaveRoom(ws)
      const name = msg.name || 'Player'
      const mapName = msg.mapName || 'random'
      // Find any waiting room (not started, 1 player)
      let found = null
      for (const room of rooms.values()) {
        if (!room.started && room.players.size === 1 && !room.hasBot) {
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
        // Register both players
        for (const [, info] of found.players) stmtUpsertPlayer.run(info.name)
        broadcast(found, 'game_start', { mapName: found.mapName, seed: found.seed, players: getRoomPlayers(found) })
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
      for (const [, info] of room.players) stmtUpsertPlayer.run(info.name)
      broadcast(room, 'game_start', { mapName: room.mapName, seed: room.seed, players: getRoomPlayers(room) })
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

      // Bot auto-submits empty commands
      if (room.hasBot && room.botFaction !== undefined) {
        tc.set(room.botFaction, [])
      }

      // Both sides submitted?
      const needed = room.hasBot ? 2 : room.players.size
      if (tc.size >= needed) {
        const cmds = [tc.get(0) || [], tc.get(1) || []]
        broadcast(room, 'turn_commands', { turn, commands: cmds })
        room.turnCmds.delete(turn)
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
