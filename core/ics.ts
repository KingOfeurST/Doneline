/**
 * Minimal iCalendar (RFC 5545) helpers — just enough to round-trip the VEVENT
 * fields Doneline cares about. Not a full implementation.
 */

export interface ParsedEvent {
  uid: string
  summary: string
  location?: string
  description?: string
  start: string // ISO datetime
  end: string // ISO datetime
  allDay: boolean
}

function unfold(ics: string): string[] {
  // RFC 5545 line folding: a CRLF followed by space/tab continues the line.
  const raw = ics.replace(/\r\n/g, '\n').split('\n')
  const lines: string[] = []
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1)
    } else {
      lines.push(line)
    }
  }
  return lines
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;')
}

/** Parse an ICS date/time value into ISO. Handles UTC (Z), floating, and DATE. */
function parseDate(value: string, isDateOnly: boolean): { iso: string; allDay: boolean } {
  if (isDateOnly || /^\d{8}$/.test(value)) {
    const y = value.slice(0, 4)
    const m = value.slice(4, 6)
    const d = value.slice(6, 8)
    return { iso: `${y}-${m}-${d}T00:00:00`, allDay: true }
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/)
  if (!m) return { iso: new Date(value).toISOString(), allDay: false }
  const [, y, mo, d, h, mi, s, z] = m
  if (z) {
    return { iso: new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).toISOString(), allDay: false }
  }
  // Floating/local time — treat as local.
  return { iso: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).toISOString(), allDay: false }
}

export function parseICS(ics: string): ParsedEvent | null {
  const lines = unfold(ics)
  const ev: Partial<ParsedEvent> & { allDay?: boolean } = {}
  let inEvent = false
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; continue }
    if (line === 'END:VEVENT') break
    if (!inEvent) continue
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const left = line.slice(0, idx)
    const value = line.slice(idx + 1)
    const [name] = left.split(';')
    const isDateOnly = /VALUE=DATE(;|$)/.test(left) && !/DATE-TIME/.test(left)
    switch (name) {
      case 'UID': ev.uid = value; break
      case 'SUMMARY': ev.summary = unescapeText(value); break
      case 'LOCATION': ev.location = unescapeText(value); break
      case 'DESCRIPTION': ev.description = unescapeText(value); break
      case 'DTSTART': {
        const { iso, allDay } = parseDate(value, isDateOnly)
        ev.start = iso
        ev.allDay = allDay
        break
      }
      case 'DTEND': {
        const { iso } = parseDate(value, isDateOnly)
        ev.end = iso
        break
      }
    }
  }
  if (!ev.uid || !ev.summary || !ev.start) return null
  return {
    uid: ev.uid,
    summary: ev.summary,
    location: ev.location,
    description: ev.description,
    start: ev.start,
    end: ev.end || ev.start,
    allDay: !!ev.allDay
  }
}

function fmtUtc(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

export function buildICS(input: {
  uid: string
  summary: string
  location?: string | null
  description?: string | null
  start: string
  end: string
  allDay: boolean
}): string {
  const now = fmtUtc(new Date().toISOString())
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Doneline//EN', 'BEGIN:VEVENT']
  lines.push(`UID:${input.uid}`)
  lines.push(`DTSTAMP:${now}`)
  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${fmtDate(input.start)}`)
    lines.push(`DTEND;VALUE=DATE:${fmtDate(input.end)}`)
  } else {
    lines.push(`DTSTART:${fmtUtc(input.start)}`)
    lines.push(`DTEND:${fmtUtc(input.end)}`)
  }
  lines.push(`SUMMARY:${escapeText(input.summary)}`)
  if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`)
  if (input.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n')
}
