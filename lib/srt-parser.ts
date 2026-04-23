export type SubtitleStyle = 'bold' | 'italic' | 'normal'

export interface Subtitle {
  start: number // microseconds
  end: number // microseconds
  text: string
  style?: SubtitleStyle
}

// Strip whole-cue inline style tags and return the cue's style + plain text.
// We only handle <b>…</b> and <i>…</i> wrapping the entire cue — mixed inline
// styling is out of scope. Matches the output format from tools/style_srt.py,
// which tags every cue by speaker role (main = bold, others = italic).
function extractStyle(raw: string): { text: string; style: SubtitleStyle } {
  const trimmed = raw.trim()
  const boldMatch = /^<b>([\s\S]*)<\/b>$/i.exec(trimmed)
  if (boldMatch) return { text: boldMatch[1].trim(), style: 'bold' }
  const italicMatch = /^<i>([\s\S]*)<\/i>$/i.exec(trimmed)
  if (italicMatch) return { text: italicMatch[1].trim(), style: 'italic' }
  return { text: trimmed, style: 'normal' }
}

// Parses standard SRT format into subtitle entries with timestamps in microseconds.
// SRT timestamps are "HH:MM:SS,mmm --> HH:MM:SS,mmm"
export function parseSrt(text: string): Subtitle[] {
  const entries: Subtitle[] = []
  if (!text || !text.trim()) return entries

  // Split on blank lines — each block is one cue
  const blocks = text.replace(/\r\n/g, '\n').trim().split(/\n\n+/)

  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim().length > 0)
    if (lines.length < 2) continue

    // Find the line with " --> " in it (skip optional index line at the top)
    const timingLineIdx = lines.findIndex(l => l.includes('-->'))
    if (timingLineIdx === -1) continue

    const timing = lines[timingLineIdx]
    const match = timing.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/)
    if (!match) continue

    const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = match
    const startMs = (parseInt(h1) * 3600 + parseInt(m1) * 60 + parseInt(s1)) * 1000 + parseInt(ms1.padEnd(3, '0').slice(0, 3))
    const endMs = (parseInt(h2) * 3600 + parseInt(m2) * 60 + parseInt(s2)) * 1000 + parseInt(ms2.padEnd(3, '0').slice(0, 3))

    const subtitleText = lines.slice(timingLineIdx + 1).join('\n').trim()
    if (!subtitleText) continue

    const { text, style } = extractStyle(subtitleText)
    if (!text) continue

    entries.push({
      start: startMs * 1000, // microseconds
      end: endMs * 1000, // microseconds
      text,
      style,
    })
  }

  return entries
}

// Find the active subtitle at a given timestamp (microseconds).
// Returns null if no subtitle is active.
export function findActiveSubtitle(subs: Subtitle[], timestampUs: number): Subtitle | null {
  for (const sub of subs) {
    if (timestampUs >= sub.start && timestampUs <= sub.end) return sub
  }
  return null
}

/**
 * Split long cues into shorter sequential chunks, Netflix-style.
 * Groq often returns 20+ word cues spanning 5+ seconds; showing the whole
 * block at once is unreadable. This splits into chunks of ~maxWords words,
 * dividing the original cue's time range proportionally.
 *
 * Example: a 6-second cue with 24 words → 3 sub-cues of 8 words × 2 seconds each.
 */
export function splitLongCues(subs: Subtitle[], maxWords = 8): Subtitle[] {
  const out: Subtitle[] = []
  for (const sub of subs) {
    const words = sub.text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean)
    if (words.length <= maxWords) {
      out.push(sub)
      continue
    }
    const totalChunks = Math.ceil(words.length / maxWords)
    const cueDur = sub.end - sub.start
    const chunkDur = cueDur / totalChunks
    for (let i = 0; i < totalChunks; i++) {
      const chunkWords = words.slice(i * maxWords, (i + 1) * maxWords)
      const chunkStart = sub.start + Math.round(chunkDur * i)
      // Last chunk inherits the original cue's end timestamp to avoid rounding drift
      const chunkEnd = i === totalChunks - 1
        ? sub.end
        : sub.start + Math.round(chunkDur * (i + 1))
      out.push({
        start: chunkStart,
        end: chunkEnd,
        text: chunkWords.join(' '),
        style: sub.style,
      })
    }
  }
  return out
}
