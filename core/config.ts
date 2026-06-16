import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths.js'

/**
 * Cloud sync configuration. This lives in a plain JSON file OUTSIDE the database
 * (the database is the thing being synced, so its connection settings can't live
 * inside it). Holds the Turso/libSQL workspace URL + auth token.
 */
export interface SyncConfig {
  syncUrl: string
  authToken: string
}

const configFile = () => path.join(dataDir(), 'config.json')

export function getSyncConfig(): SyncConfig | null {
  try {
    const raw = fs.readFileSync(configFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SyncConfig>
    if (parsed.syncUrl && parsed.authToken) {
      return { syncUrl: parsed.syncUrl, authToken: parsed.authToken }
    }
  } catch {
    // no config yet — local-only mode
  }
  return null
}

export function setSyncConfig(cfg: SyncConfig): void {
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2), 'utf8')
}

export function clearSyncConfig(): void {
  try {
    fs.unlinkSync(configFile())
  } catch {
    // already gone
  }
}

/** A single shareable string that bundles the workspace URL + token. */
export function encodeConnectCode(cfg: SyncConfig): string {
  return Buffer.from(JSON.stringify(cfg), 'utf8').toString('base64')
}

export function decodeConnectCode(code: string): SyncConfig | null {
  try {
    // Strip any whitespace/line breaks a messaging app may have inserted.
    const cleaned = code.replace(/\s+/g, '')
    const json = Buffer.from(cleaned, 'base64').toString('utf8')
    const parsed = JSON.parse(json) as Partial<SyncConfig>
    if (parsed.syncUrl && parsed.authToken) {
      return { syncUrl: parsed.syncUrl, authToken: parsed.authToken }
    }
  } catch {
    // not a valid code
  }
  return null
}
