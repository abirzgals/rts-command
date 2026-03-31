// ─── Lightweight frame profiler ─────────────────────────────────
// Measures time spent in each system per frame, displays as a tree.

import type { WebGLRenderer } from 'three'

interface ProfileEntry {
  name: string
  depth: number
  start: number
  elapsed: number
}

let rendererRef: WebGLRenderer | null = null
export function setProfilerRenderer(r: WebGLRenderer) { rendererRef = r }

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
  const fps = Math.round(1000 / (frameAvg || 1))
  const fpsColor = fps >= 30 ? '#4c4' : fps >= 15 ? '#fa0' : '#f44'
  const lines: string[] = []

  // Group entries by depth — collapse fast groups, expand slow ones
  const SLOW_THRESHOLD = 1.0 // ms — show children only if parent > this
  let i = 0
  while (i < entries.length) {
    const e = entries[i]
    const a = avg(avgMap.get(e.name))

    if (e.depth === 0) {
      // Top-level group
      const ms = a.toFixed(1).padStart(6)
      const pct = frameAvg > 0 ? Math.round(a / frameAvg * 100).toString().padStart(3) : '  0'
      const bar = makeBar(a, frameAvg)
      const isSlow = a >= SLOW_THRESHOLD

      if (isSlow) {
        lines.push(`${bar} ${ms}ms ${pct}% ${e.name}`)
        // Show children
        let j = i + 1
        while (j < entries.length && entries[j].depth > 0) {
          const child = entries[j]
          const ca = avg(avgMap.get(child.name))
          if (ca >= 0.05) {
            const cms = ca.toFixed(1).padStart(6)
            const cpct = frameAvg > 0 ? Math.round(ca / frameAvg * 100).toString().padStart(3) : '  0'
            const hot = ca >= SLOW_THRESHOLD ? ' !' : ''
            lines.push(`  ${cms}ms ${cpct}% ${child.name}${hot}`)
          }
          j++
        }
        i = j
      } else {
        // Collapsed — single line
        lines.push(`${bar} ${ms}ms ${pct}% ${e.name}`)
        // Skip children
        let j = i + 1
        while (j < entries.length && entries[j].depth > 0) j++
        i = j
      }
    } else {
      i++
    }
  }

  // GPU stats
  let gpuLine = ''
  if (rendererRef) {
    const info = rendererRef.info
    const draws = info.render.calls
    const tris = info.render.triangles
    const geos = info.memory.geometries
    const texs = info.memory.textures
    const programs = info.programs?.length ?? 0
    gpuLine = `<span style="color:#aaa">GPU: ${draws} draws, ${(tris/1000).toFixed(0)}K tris, ${geos} geos, ${texs} tex, ${programs} shaders</span>\n`
  }

  profilerDiv.innerHTML =
    `<span style="color:${fpsColor};font-weight:bold">Frame: ${frameAvg.toFixed(1)}ms (${fps} FPS)</span>\n` +
    gpuLine +
    lines.join('\n')
}

function makeBar(ms: number, total: number): string {
  const maxW = 8
  const filled = total > 0 ? Math.min(maxW, Math.round(ms / total * maxW)) : 0
  return '\u2588'.repeat(filled) + '\u2591'.repeat(maxW - filled)
}
