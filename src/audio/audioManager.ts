// ─── Audio Manager ──────────────────────────────────────────────
// Music: menu theme + random ingame tracks with crossfade
// SFX: positional one-shot sounds for combat

import { profLoadStart, profLoadEnd } from '../debug/profiler'

const MUSIC_VOLUME = 0.25
const SFX_VOLUME = 0.5
const CROSSFADE_MS = 2000
let soundEnabled = true

// ── Music tracks ────────────────────────────────────────────
const MENU_MUSIC = '/sounds/music/strategic-frontier.mp3'
const INGAME_MUSIC = [
  '/sounds/music/electronic-warfare.mp3',
  '/sounds/music/tactical-operations.mp3',
  '/sounds/music/mechanical-calm.mp3',
  '/sounds/music/mechanical-calm-2.mp3',
  '/sounds/music/siege-of-the-last-banner.mp3',
]

// ── SFX: manifest-based lazy loading ────────────────────────
// Manifest lists all available files. Audio data loaded on first play.
// Pattern: /sounds/sfx/{key}-{N}.mp3 → playSfx('marine-shot') picks random variant
const sfxRegistry = new Map<string, string[]>()
let manifestLoaded = false

/** Load manifest once, build registry by grouping files into keys */
async function loadManifest() {
  if (manifestLoaded) return
  manifestLoaded = true
  try {
    const resp = await fetch('/sounds/sfx-manifest.json')
    const names: string[] = await resp.json()
    for (const name of names) {
      // 'marine-shot-1' → key='marine-shot', url='/sounds/sfx/marine-shot-1.mp3'
      const match = name.match(/^(.+)-(\d+)$/)
      if (!match) continue
      const key = match[1]
      const url = `/sounds/sfx/${name}.mp3`
      if (!sfxRegistry.has(key)) sfxRegistry.set(key, [])
      sfxRegistry.get(key)!.push(url)
    }
  } catch (e) {
    console.warn('[Audio] Failed to load sfx manifest:', e)
  }
}

// ── State ───────────────────────────────────────────────────
let ctx: AudioContext | null = null
let musicGain: GainNode | null = null
let sfxGain: GainNode | null = null
let currentMusic: AudioBufferSourceNode | null = null
let currentMusicBuffer: AudioBuffer | null = null
let musicMode: 'menu' | 'ingame' | 'none' = 'none'
let lastIngameIdx = -1

// Preloaded buffers
const bufferCache = new Map<string, AudioBuffer>()
const loadingSet = new Set<string>()

function ensureContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    musicGain = ctx.createGain()
    musicGain.gain.value = MUSIC_VOLUME
    musicGain.connect(ctx.destination)
    sfxGain = ctx.createGain()
    sfxGain.gain.value = SFX_VOLUME
    sfxGain.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

async function loadBuffer(url: string): Promise<AudioBuffer | null> {
  if (bufferCache.has(url)) return bufferCache.get(url)!
  if (loadingSet.has(url)) return null
  loadingSet.add(url)
  profLoadStart()
  try {
    const ac = ensureContext()
    const resp = await fetch(url)
    const data = await resp.arrayBuffer()
    const buf = await ac.decodeAudioData(data)
    bufferCache.set(url, buf)
    return buf
  } catch (e) {
    console.warn(`[Audio] Failed to load ${url}:`, e)
    return null
  } finally {
    loadingSet.delete(url)
    profLoadEnd()
  }
}

// ── Music ───────────────────────────────────────────────────

function playBuffer(buf: AudioBuffer, loop: boolean): AudioBufferSourceNode {
  const ac = ensureContext()
  const src = ac.createBufferSource()
  src.buffer = buf
  src.loop = loop
  src.connect(musicGain!)
  src.start()
  return src
}

function fadeOutCurrent(): Promise<void> {
  return new Promise(resolve => {
    if (!currentMusic || !musicGain || !ctx) { resolve(); return }
    const g = musicGain
    const old = currentMusic
    g.gain.setValueAtTime(g.gain.value, ctx.currentTime)
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + CROSSFADE_MS / 1000)
    setTimeout(() => {
      try { old.stop() } catch {}
      g.gain.value = MUSIC_VOLUME
      currentMusic = null
      resolve()
    }, CROSSFADE_MS)
  })
}

export async function playMenuMusic() {
  if (!soundEnabled) return
  if (musicMode === 'menu') return
  musicMode = 'menu'
  // If AudioContext not yet available (no user interaction), just set mode
  // initAudioOnInteraction will start the music when user clicks
  if (!ctx || ctx.state === 'suspended') return
  await fadeOutCurrent()
  const buf = await loadBuffer(MENU_MUSIC)
  if (!buf || musicMode !== 'menu') return
  currentMusic = playBuffer(buf, true)
  currentMusicBuffer = buf
}

// Shuffled playlist for ingame — all tracks including menu theme
const ALL_MUSIC = [MENU_MUSIC, ...INGAME_MUSIC]
let shuffledPlaylist: string[] = []
let playlistIdx = 0

function shufflePlaylist() {
  shuffledPlaylist = [...ALL_MUSIC]
  // Fisher-Yates shuffle
  for (let i = shuffledPlaylist.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffledPlaylist[i], shuffledPlaylist[j]] = [shuffledPlaylist[j], shuffledPlaylist[i]]
  }
  playlistIdx = 0
}

export async function playIngameMusic() {
  if (!soundEnabled) return
  musicMode = 'ingame'
  shufflePlaylist()
  await fadeOutCurrent()
  await playNextTrack()
}

async function playNextTrack() {
  if (musicMode !== 'ingame') return
  if (playlistIdx >= shuffledPlaylist.length) {
    // Reshuffle and start over
    shufflePlaylist()
  }

  const url = shuffledPlaylist[playlistIdx++]
  const buf = await loadBuffer(url)
  if (!buf || musicMode !== 'ingame') return
  currentMusic = playBuffer(buf, false)
  currentMusicBuffer = buf
  // When track ends, play next in shuffled playlist
  currentMusic.onended = () => {
    if (musicMode === 'ingame') playNextTrack()
  }
}

export async function stopMusic() {
  musicMode = 'none'
  await fadeOutCurrent()
}

// ── SFX ─────────────────────────────────────────────────────

// Throttle: prevent same sound type from spamming
const sfxLastPlayed = new Map<string, number>()
const SFX_THROTTLE_MS = 80
const VOICE_THROTTLE_MS = 1500 // voices need longer gap

// Voice-like categories that use longer throttle
const VOICE_CATS = new Set(['select', 'move', 'attack', 'confirm', 'death'])

function getThrottleKey(type: string): string {
  // Extract category: 'marine-select' → 'select', 'explosion' → 'explosion'
  const parts = type.split('-')
  const cat = parts.length >= 2 ? parts[parts.length - 1] : type
  if (cat === 'select') return 'voice-select'
  if (VOICE_CATS.has(cat)) return 'voice-cmd'
  return type // weapon sounds throttle per-type
}

export function playSfx(type: string, x?: number, z?: number) {
  if (!soundEnabled) return
  if (!ctx || !sfxGain) {
    ensureContext()
    if (!ctx) return
  }

  // Throttle
  const now = performance.now()
  const cat = type.split('-').pop() || ''
  const isVoice = VOICE_CATS.has(cat)
  const throttle = isVoice ? VOICE_THROTTLE_MS : SFX_THROTTLE_MS
  const throttleKey = getThrottleKey(type)
  const last = sfxLastPlayed.get(throttleKey) ?? 0
  if (now - last < throttle) return
  sfxLastPlayed.set(throttleKey, now)

  if (!manifestLoaded) { loadManifest(); return }
  const files = sfxRegistry.get(type)
  if (!files || files.length === 0) return
  const url = files[Math.floor(Math.random() * files.length)]

  const buf = bufferCache.get(url)
  if (!buf) {
    loadBuffer(url)
    return
  }

  const src = ctx.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = 0.95 + Math.random() * 0.1
  src.connect(sfxGain!)
  src.start()
}

// ── Preload ─────────────────────────────────────────────────
const PRELOAD_CATEGORIES = ['select', 'move'] // fetch audio data eagerly for these

export async function preloadSfx() {
  ensureContext()
  await loadManifest()
  // Eagerly load select/move sounds so first click isn't silent
  for (const [key, files] of sfxRegistry) {
    const cat = key.split('-').pop() || ''
    if (PRELOAD_CATEGORIES.includes(cat)) {
      for (const url of files) loadBuffer(url)
    }
  }
}

/** Preload ALL sfx buffers (debug/test). Returns count loaded. */
export async function preloadAllSfx(): Promise<number> {
  ensureContext()
  await loadManifest()
  const promises: Promise<AudioBuffer | null>[] = []
  for (const [, files] of sfxRegistry) {
    for (const url of files) {
      if (!bufferCache.has(url)) promises.push(loadBuffer(url))
    }
  }
  const results = await Promise.all(promises)
  return results.filter(Boolean).length
}

/** How many sfx are cached vs total */
export function getSfxCacheStats(): { cached: number; total: number } {
  let total = 0
  for (const [, files] of sfxRegistry) total += files.length
  return { cached: bufferCache.size, total }
}

// ── Volume / enable control ─────────────────────────────────
export function setMusicVolume(v: number) {
  if (musicGain) musicGain.gain.value = v
}
export function setSfxVolume(v: number) {
  if (sfxGain) sfxGain.gain.value = v
}
export function setSoundEnabled(enabled: boolean) {
  soundEnabled = enabled
  if (!enabled) stopMusic()
}

// ── Init on first user interaction ──────────────────────────
let initialized = false
export function initAudioOnInteraction() {
  if (initialized) return
  initialized = true
  ensureContext()
  preloadSfx()
  // Resume music that was requested before interaction
  if (musicMode === 'menu' && !currentMusic && soundEnabled) {
    loadBuffer(MENU_MUSIC).then(buf => {
      if (buf && musicMode === 'menu') {
        currentMusic = playBuffer(buf, true)
      }
    })
  }
}

// Auto-init on click/key
if (typeof window !== 'undefined') {
  const handler = () => {
    initAudioOnInteraction()
    window.removeEventListener('click', handler)
    window.removeEventListener('keydown', handler)
    window.removeEventListener('touchstart', handler)
  }
  window.addEventListener('click', handler, { once: true })
  window.addEventListener('keydown', handler, { once: true })
  window.addEventListener('touchstart', handler, { once: true })
}
