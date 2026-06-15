/** Ambient "mood" palettes for the generative focus display. */

export interface Mood {
  id: string
  name: string
  base: string // background base (dark so colors glow)
  colors: string[] // glowing orb colors
}

export const MOODS: Mood[] = [
  { id: 'aurora', name: 'Aurora', base: '#07111f', colors: ['#3ad1a0', '#4f8cff', '#9b6cff', '#37e0c8'] },
  { id: 'ocean', name: 'Ocean', base: '#04141c', colors: ['#1ec8c8', '#2f8cff', '#1f6f9c', '#7bdff2'] },
  { id: 'sunset', name: 'Sunset', base: '#1a0e16', colors: ['#ff7a59', '#ff4d7d', '#ffd166', '#ff9e7d'] },
  { id: 'forest', name: 'Forest', base: '#0a160e', colors: ['#7bd389', '#3a9d6b', '#d9e88a', '#56c596'] },
  { id: 'lava', name: 'Lava lamp', base: '#160a0a', colors: ['#ff5e3a', '#ff2d55', '#ffb03a', '#ff7a59'] },
  { id: 'lavender', name: 'Lavender', base: '#120c1e', colors: ['#b39cf0', '#8a6cff', '#e0a7ff', '#7d8cff'] }
]

export function moodById(id: string): Mood {
  return MOODS.find((m) => m.id === id) ?? MOODS[0]
}
