/** Focus-mode music channels: streamed stations grouped by vibe + a generated
 *  offline rain channel. (The phase chime now lives in audioFx.ts.) */

export interface Channel {
  id: string
  name: string
  desc: string
  /** 'stream' plays `url` through an <audio> element; 'rain' is generated offline. */
  kind: 'stream' | 'rain'
  url?: string
}

export const CHANNELS: Channel[] = [
  { id: 'lofi', name: 'Lo-fi beats', desc: 'chill study hip-hop', kind: 'stream', url: 'https://stream.laut.fm/lofi' },
  { id: 'piano', name: 'Piano / classical', desc: 'calm instrumental', kind: 'stream', url: 'https://stream.laut.fm/classicalmusic' },
  { id: 'jazz', name: 'Jazz café', desc: 'mellow coffeehouse jazz', kind: 'stream', url: 'https://stream.laut.fm/jazz' },
  { id: 'rain', name: 'Rain (offline)', desc: 'generated rainfall, no internet', kind: 'rain' }
]

export function channelById(id: string): Channel {
  return CHANNELS.find((c) => c.id === id) ?? CHANNELS[0]
}
