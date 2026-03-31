// ─── Audio Manager ──────────────────────────────────────────────
// Music: menu theme + random ingame tracks with crossfade
// SFX: positional one-shot sounds for combat

const MUSIC_VOLUME = 0.5
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
  rifle:    ['/sounds/sfx/rifle-1.mp3', '/sounds/sfx/rifle-2.mp3'],
  tank:     ['/sounds/sfx/tank-shot-1.mp3', '/sounds/sfx/tank-shot-2.mp3'],
  artillery:['/sounds/sfx/artillery.mp3'],
  rocket:   ['/sounds/sfx/rocket-launch.mp3'],
  explosion:['/sounds/sfx/explosion.mp3'],
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
  await fadeOutCurrent()
  const buf = await loadBuffer(MENU_MUSIC)
  if (!buf || musicMode !== 'menu') return
  currentMusic = playBuffer(buf, true)
  currentMusicBuffer = buf
}

export async function playIngameMusic() {
  if (!soundEnabled) return
  musicMode = 'ingame'
  await fadeOutCurrent()
  await playRandomIngame()
}

async function playRandomIngame() {
  if (musicMode !== 'ingame') return
  // Pick a random track different from last
  let idx = Math.floor(Math.random() * INGAME_MUSIC.length)
  if (idx === lastIngameIdx && INGAME_MUSIC.length > 1) {
    idx = (idx + 1) % INGAME_MUSIC.length
  }
  lastIngameIdx = idx

  const buf = await loadBuffer(INGAME_MUSIC[idx])
  if (!buf || musicMode !== 'ingame') return
  currentMusic = playBuffer(buf, false)
  currentMusicBuffer = buf
  // When track ends, play another random one
  currentMusic.onended = () => {
    if (musicMode === 'ingame') playRandomIngame()
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

  // Throttle — voices use longer cooldown
  const now = performance.now()
  const isVoice = type.startsWith('voice-')
  const throttle = isVoice ? VOICE_THROTTLE_MS : SFX_THROTTLE_MS
  // All voice types share one throttle so they don't overlap
  const throttleKey = isVoice ? 'voice' : type
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
}

// Auto-init on click/key
if (typeof window !== 'undefined') {
  const handler = () => {
    initAudioOnInteraction()
    window.removeEventListener('click', handler)
    window.removeEventListener('keydown', handler)
  }
  window.addEventListener('click', handler, { once: true })
  window.addEventListener('keydown', handler, { once: true })
}
