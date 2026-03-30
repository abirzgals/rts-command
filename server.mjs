// ─── RTS Command — REST API Server ──────────────────────────────────────
// Serves the static game + provides REST endpoints for editor configs
// Usage: node server.mjs
// ────────────────────────────────────────────────────────────────────────

import express from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

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

app.listen(PORT, () => {
  console.log(`\n  RTS Command server running on http://localhost:${PORT}`)
  console.log(`  Game:   http://localhost:${PORT}/`)
  console.log(`  Editor: http://localhost:${PORT}/editor.html`)
  console.log(`  API:    http://localhost:${PORT}/api/config`)
  console.log()
})
