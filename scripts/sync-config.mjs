// Pre-build script: download latest config from production server
// and save as public/default-config.json so it ships with the build.
// This way editor changes survive redeployments.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_URL = process.env.CONFIG_URL || 'https://rts-command-harbor-app.artplace.cc/api/config'
const OUTPUT = path.join(__dirname, '..', 'public', 'default-config.json')

async function sync() {
  console.log(`[sync-config] Fetching from ${CONFIG_URL}...`)
  try {
    const res = await fetch(CONFIG_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()

    if (json.data && Object.keys(json.data).length > 0) {
      fs.writeFileSync(OUTPUT, JSON.stringify(json.data, null, 2))
      console.log(`[sync-config] Saved ${Object.keys(json.data).length} models to default-config.json`)
    } else {
      console.log('[sync-config] Server returned empty config, keeping existing default-config.json')
    }
  } catch (err) {
    console.log(`[sync-config] Could not fetch (${err.message}), keeping existing default-config.json`)
  }
}

sync()
