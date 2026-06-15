/** Soft pastel palette used for goals and events. */
export const PALETTE = [
  { name: 'Mint', value: '#2f7a4d', tint: '#dff3e6' },
  { name: 'Rose', value: '#9c4a4a', tint: '#f7e3e3' },
  { name: 'Sky', value: '#2f6f9c', tint: '#dceefb' },
  { name: 'Plum', value: '#7a4a8c', tint: '#efe3f6' },
  { name: 'Amber', value: '#9c7a2f', tint: '#f6efda' },
  { name: 'Teal', value: '#2f8c8c', tint: '#dcf3f3' }
]

/** Lighten a hex color into its soft card tint. Falls back to a generic wash. */
export function tintFor(hex: string): string {
  const found = PALETTE.find((p) => p.value.toLowerCase() === hex.toLowerCase())
  if (found) return found.tint
  return hexToTint(hex)
}

function hexToTint(hex: string): string {
  const m = hex.replace('#', '')
  if (m.length !== 6) return '#eef4f8'
  const r = parseInt(m.slice(0, 2), 16)
  const g = parseInt(m.slice(2, 4), 16)
  const b = parseInt(m.slice(4, 6), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * 0.82)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}
