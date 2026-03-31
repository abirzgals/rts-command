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

// ── SFX pools ───────────────────────────────────────────────
const SFX_FILES: Record<string, string[]> = {
  // Per-unit weapon sounds
  'marine-shot':  ['/sounds/sfx/marine-shot-1.mp3', '/sounds/sfx/marine-shot-2.mp3'],
  'trooper-shot': ['/sounds/sfx/trooper-shot-1.mp3'],
  'jeep-shot':    ['/sounds/sfx/jeep-shot-1.mp3'],
  'tank-shot':    ['/sounds/sfx/tank-shot-1.mp3'],
  'artillery':    ['/sounds/sfx/artillery.mp3'],
  'rocket-launch':['/sounds/sfx/rocket-launch.mp3'],
  'explosion':    ['/sounds/sfx/explosion.mp3'],
  // Unit voice lines
  'voice-select':  ['/sounds/sfx/voice-select-1.mp3', '/sounds/sfx/voice-select-2.mp3'],
  'voice-move':    ['/sounds/sfx/voice-move-1.mp3', '/sounds/sfx/voice-move-2.mp3', '/sounds/sfx/voice-move-3.mp3'],
  'voice-attack':  ['/sounds/sfx/voice-attack-1.mp3', '/sounds/sfx/voice-attack-2.mp3'],
  'voice-confirm': ['/sounds/sfx/voice-confirm-1.mp3', '/sounds/sfx/voice-confirm-2.mp3'],
  'voice-death':   ['/sounds/sfx/voice-death-1.mp3', '/sounds/sfx/voice-death-2.mp3', '/sounds/sfx/voice-death-3.mp3'],
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

export function playSfx(type: string, x?: number, z?: number) {
  if (!soundEnabled) return
  if (!ctx || !sfxGain) {
    // First interaction hasn't happened yet — queue for later
    ensureContext()
    if (!ctx) return
  }

  // Throttle — voices use longer cooldown, split into select vs command
  const now = performance.now()
  const isVoice = type.startsWith('voice-')
  const throttle = isVoice ? VOICE_THROTTLE_MS : SFX_THROTTLE_MS
  // Select voice has its own throttle, command voices (move/attack/confirm/death) share one
  const throttleKey = isVoice
    ? (type === 'voice-select' ? 'voice-select' : 'voice-cmd')
    : type
  const last = sfxLastPlayed.get(throttleKey) ?? 0
  if (now - last < throttle) return
  sfxLastPlayed.set(throttleKey, now)

  const files = SFX_FILES[type]
  if (!files || files.length === 0) return
  const url = files[Math.floor(Math.random() * files.length)]

  const buf = bufferCache.get(url)
  if (!buf) {
    // Load in background for next time
    loadBuffer(url)
    return
  }

  const src = ctx.createBufferSource()
  src.buffer = buf
  // Slight pitch variation for variety
  src.playbackRate.value = 0.95 + Math.random() * 0.1
  src.connect(sfxGain!)
  src.start()
}

// ── Preload ─────────────────────────────────────────────────
export function preloadSfx() {
  ensureContext()
  for (const files of Object.values(SFX_FILES)) {
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
