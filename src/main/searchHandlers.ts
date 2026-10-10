import type { IpcMain } from 'electron'
import { searchWorkspace, type SearchInput } from '../../core/search.js'

/** Read-only search never contacts the network or changes recurring rules. */
export function registerSearchHandlers(ipc: Pick<IpcMain, 'handle'>): void {
  ipc.handle('search:query', (_event, input: SearchInput) => searchWorkspace(input))
}
