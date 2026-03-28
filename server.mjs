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
app.use(express.static(path.join(__dirname, 'dist')))

// ─── REST API ─────────────────────────────────────────────────────────

// GET /api/config — load the editor config
app.get('/api/config', (req, res) => {
  const file = path.join(DATA_DIR, 'editor-config.json')
  if (!fs.existsSync(file)) return res.json({ data: null })
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
  res.json({ data })
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

// ─── SPA fallback ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const file = path.join(__dirname, 'dist', req.path)
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    return res.sendFile(file)
  }
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`\n  RTS Command server running on http://localhost:${PORT}`)
  console.log(`  Game:   http://localhost:${PORT}/`)
  console.log(`  Editor: http://localhost:${PORT}/editor.html`)
  console.log(`  API:    http://localhost:${PORT}/api/config`)
  console.log()
})
