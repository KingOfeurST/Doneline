import type { DonelineAPI } from '../../shared/api'

declare global {
  interface Window {
    doneline: DonelineAPI
  }
}

export {}
