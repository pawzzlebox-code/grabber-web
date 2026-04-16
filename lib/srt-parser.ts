export interface Subtitle {
  start: number // microseconds
  end: number // microseconds
  text: string
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

    entries.push({
      start: startMs * 1000, // microseconds
      end: endMs * 1000, // microseconds
      text: subtitleText,
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
