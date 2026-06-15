import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Resolve the Doneline data directory. Both the Electron app and the MCP server
 * call this so they always agree on where the database lives.
 *
 * Override with DONELINE_DIR (Electron passes its userData path here so packaged
 * builds and the MCP server share one DB).
 */
export function dataDir(): string {
  const dir = process.env.DONELINE_DIR || path.join(os.homedir(), '.doneline')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function dbPath(): string {
  return process.env.DONELINE_DB || path.join(dataDir(), 'doneline.db')
}
