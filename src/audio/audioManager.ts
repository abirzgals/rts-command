// ─── Audio Manager ──────────────────────────────────────────────
// Music: menu theme + random ingame tracks with crossfade
// SFX: positional one-shot sounds for combat

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

// ── SFX: dynamic file discovery ─────────────────────────────
// Pattern: /sounds/sfx/{key}-{N}.mp3 where N = 1,2,3...
// playSfx('marine-shot') tries marine-shot-1.mp3, marine-shot-2.mp3, etc.
const sfxRegistry = new Map<string, string[]>()
const sfxProbed = new Set<string>() // keys we've already probed

// Unit types that have sounds
const UNIT_NAMES = ['worker', 'marine', 'trooper', 'tank', 'jeep', 'rocket']
// Sound categories per unit
const SOUND_CATEGORIES = ['shot', 'select', 'move', 'attack', 'confirm', 'death']
// Global sounds (not per-unit)
const GLOBAL_SOUNDS = ['explosion', 'rocket-launch']

/** Probe how many numbered files exist for a key (e.g. 'marine-shot' → 1,2,...) */
async function probeFiles(key: string): Promise<string[]> {
  const files: string[] = []
  for (let i = 1; i <= 10; i++) {
    const url = `/sounds/sfx/${key}-${i}.mp3`
    try {
      const resp = await fetch(url, { method: 'HEAD' })
      if (resp.ok) files.push(url)
      else break // stop at first missing
    } catch { break }
  }
  return files
}

/** Get or discover files for a sound key */
async function getSfxFiles(key: string): Promise<string[]> {
  if (sfxRegistry.has(key)) return sfxRegistry.get(key)!
  if (sfxProbed.has(key)) return []
  sfxProbed.add(key)
  const files = await probeFiles(key)
  if (files.length > 0) sfxRegistry.set(key, files)
  return files
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

  const files = sfxRegistry.get(type)
  if (!files || files.length === 0) {
    // Not yet probed — probe in background, play next time
    getSfxFiles(type).then(f => { if (f.length > 0) for (const u of f) loadBuffer(u) })
    return
  }
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
export async function preloadSfx() {
  ensureContext()
  // Probe and preload all unit sounds + global sounds
  const keys: string[] = []
  for (const unit of UNIT_NAMES) {
    for (const cat of SOUND_CATEGORIES) {
      keys.push(`${unit}-${cat}`)
    }
  }
  for (const g of GLOBAL_SOUNDS) keys.push(g)
  // Also probe rocket-launch
  keys.push('rocket-launch')

  // Probe all in parallel
  const results = await Promise.all(keys.map(k => getSfxFiles(k)))
  // Preload all discovered files
  for (const files of results) {
    for (const url of files) loadBuffer(url)
  }
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
