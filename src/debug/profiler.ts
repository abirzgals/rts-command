// ─── Lightweight frame profiler ─────────────────────────────────
// Measures time spent in each system per frame, displays as a tree.

interface ProfileEntry {
  name: string
  depth: number
  start: number
  elapsed: number
}

const entries: ProfileEntry[] = []
const stack: number[] = [] // indices into entries
let frameStart = 0
let frameElapsed = 0

// Rolling averages (smoothed over N frames)
const AVG_FRAMES = 30
const avgMap = new Map<string, number[]>()

export function profilerBeginFrame() {
  entries.length = 0
  stack.length = 0
  frameStart = performance.now()
}

export function profilerEndFrame() {
  frameElapsed = performance.now() - frameStart
  // Update rolling averages
  for (const e of entries) {
    let arr = avgMap.get(e.name)
    if (!arr) { arr = []; avgMap.set(e.name, arr) }
    arr.push(e.elapsed)
    if (arr.length > AVG_FRAMES) arr.shift()
  }
  // Also track total frame
  let fArr = avgMap.get('__frame')
  if (!fArr) { fArr = []; avgMap.set('__frame', fArr) }
  fArr.push(frameElapsed)
  if (fArr.length > AVG_FRAMES) fArr.shift()
}

export function profilerBegin(name: string) {
  const idx = entries.length
  entries.push({ name, depth: stack.length, start: performance.now(), elapsed: 0 })
  stack.push(idx)
}

export function profilerEnd() {
  const idx = stack.pop()
  if (idx !== undefined) {
    entries[idx].elapsed = performance.now() - entries[idx].start
  }
}

function avg(arr: number[] | undefined): number {
  if (!arr || arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

// ── DOM rendering ───────────────────────────────────────────
let profilerDiv: HTMLDivElement | null = null

export function updateProfilerDisplay(visible: boolean) {
  if (!visible) {
    if (profilerDiv) profilerDiv.style.display = 'none'
    return
  }

  if (!profilerDiv) {
    profilerDiv = document.createElement('div')
    profilerDiv.id = 'debug-profiler'
    Object.assign(profilerDiv.style, {
      position: 'absolute',
      top: '44px', left: '8px',
      background: 'rgba(0,0,0,0.85)',
      color: '#ccc',
      padding: '8px 10px',
      borderRadius: '6px',
      fontSize: '11px',
      lineHeight: '1.4',
      zIndex: '30',
      fontFamily: 'monospace',
      pointerEvents: 'none',
      minWidth: '220px',
      whiteSpace: 'pre',
      border: '1px solid #444',
    })
    document.body.appendChild(profilerDiv)
  }
  profilerDiv.style.display = 'block'

  const frameAvg = avg(avgMap.get('__frame'))
  const lines: string[] = [
    `\x1b[1mFrame: ${frameAvg.toFixed(1)}ms (${Math.round(1000 / (frameAvg || 1))} FPS)\x1b[0m`,
  ]

  // Build tree
  for (const e of entries) {
    const a = avg(avgMap.get(e.name))
    if (a < 0.01) continue // skip negligible entries
    const indent = '  '.repeat(e.depth)
    const bar = makeBar(a, frameAvg)
    const ms = a.toFixed(1).padStart(5)
    const pct = frameAvg > 0 ? Math.round(a / frameAvg * 100).toString().padStart(3) : '  0'
    lines.push(`${indent}${bar} ${ms}ms ${pct}% ${e.name}`)
  }

  // Use textContent for performance (no innerHTML reflow)
  profilerDiv.textContent = lines.join('\n')
    .replace(/\x1b\[\d+m/g, '') // strip ANSI (textContent doesn't support)
}

function makeBar(ms: number, total: number): string {
  const maxW = 8
  const filled = total > 0 ? Math.min(maxW, Math.round(ms / total * maxW)) : 0
  return '\u2588'.repeat(filled) + '\u2591'.repeat(maxW - filled)
}
