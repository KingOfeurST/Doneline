import type {
  Person,
  Goal,
  Todo,
  TodoWithGoal,
  CalEvent,
  CalDavConfig,
  NotifPrefs,
  Presence,
  FocusInvite
} from '../../core/index.js'

// Re-export the entity types so the renderer can import them from one place.
export type {
  Person,
  Goal,
  Todo,
  TodoWithGoal,
  CalEvent,
  CalDavConfig,
  NotifPrefs,
  Recurrence,
  Presence,
  FocusInvite
} from '../../core/index.js'

export interface SafeCalDavConfig {
  serverUrl: string
  username: string
  calendarName?: string
}

export interface CalendarInfo {
  url: string
  name: string
}

export interface SyncResult {
  pulled: number
  pushed: number
  calendar: string
  person: string
}

export interface WorkspaceStatus {
  cloud: boolean
  syncUrl: string | null
}

/** The surface exposed on `window.doneline` by the preload bridge. */
export interface DonelineAPI {
  today(): Promise<string>

  people: {
    list(): Promise<Person[]>
    create(input: { name: string; color?: string; emoji?: string }): Promise<Person>
    update(id: string, patch: Partial<Pick<Person, 'name' | 'color' | 'emoji'>>): Promise<Person | undefined>
    remove(id: string): Promise<void>
  }

  goals: {
    list(opts?: { includeArchived?: boolean; personId?: string }): Promise<Goal[]>
    create(input: { title: string; color?: string; person_id?: string; shared?: boolean }): Promise<Goal>
    update(id: string, patch: Partial<Pick<Goal, 'title' | 'color' | 'archived'>>): Promise<Goal | undefined>
    remove(id: string): Promise<void>
  }

  todos: {
    list(opts?: { includeCompleted?: boolean; personId?: string }): Promise<TodoWithGoal[]>
    today(day?: string, personId?: string): Promise<TodoWithGoal[]>
    archived(personId?: string): Promise<TodoWithGoal[]>
    create(input: { title: string; person_id?: string; goal_id?: string | null; notes?: string | null; due_at?: string | null; recurrence?: string | null }): Promise<TodoWithGoal>
    update(id: string, patch: Partial<Pick<Todo, 'title' | 'goal_id' | 'notes' | 'due_at' | 'position' | 'person_id'>>): Promise<TodoWithGoal | undefined>
    toggle(id: string, done?: boolean): Promise<TodoWithGoal | undefined>
    remove(id: string): Promise<void>
  }

  events: {
    list(opts?: { from?: string; to?: string; personId?: string }): Promise<CalEvent[]>
    day(day?: string, personId?: string): Promise<CalEvent[]>
    create(input: {
      title: string
      starts_at: string
      ends_at: string
      person_id?: string
      all_day?: boolean
      location?: string | null
      notes?: string | null
      color?: string
      attendees?: string | null
      recurrence?: string | null
    }): Promise<CalEvent>
    update(id: string, patch: Partial<Omit<CalEvent, 'id' | 'created_at'>>): Promise<CalEvent | undefined>
    remove(id: string): Promise<void>
  }

  /** Generate recurring instances, archive yesterday's done todos, purge old ones. */
  maintenance(): Promise<{ archived: number; purged: number }>

  /** Toggle the OS window fullscreen; resolves to the new fullscreen state. */
  toggleFullscreen(): Promise<boolean>

  presence: {
    /** This device's profile id (defaults to the primary profile). */
    getSelf(): Promise<string>
    setSelf(personId: string): Promise<boolean>
    list(): Promise<Presence[]>
    update(p: {
      status: 'focusing' | 'idle'
      phase?: 'focus' | 'break' | null
      task_title?: string | null
      ends_at?: string | null
    }): Promise<boolean>
    nudge(toPerson: string, message: string): Promise<boolean>
    invite(toPerson: string, focusMin: number, breakMin: number): Promise<boolean>
    pendingInvites(): Promise<FocusInvite[]>
    markInviteSeen(id: string): Promise<boolean>
    acceptInvite(id: string): Promise<boolean>
    /** Host starts the shared session; resolves to the shared start timestamp. */
    startInvite(id: string): Promise<string>
    activeInvite(): Promise<FocusInvite | null>
  }

  caldav: {
    getConfig(personId: string): Promise<SafeCalDavConfig | null>
    setConfig(personId: string, cfg: CalDavConfig): Promise<boolean>
    clear(personId: string): Promise<boolean>
    test(cfg: CalDavConfig): Promise<CalendarInfo[]>
    sync(personId: string): Promise<SyncResult>
  }

  workspace: {
    status(): Promise<WorkspaceStatus>
    myCode(): Promise<string | null>
    connect(input: { code?: string; syncUrl?: string; authToken?: string }): Promise<{ cloud: boolean; syncUrl: string; code: string }>
    disconnect(): Promise<{ cloud: boolean }>
    sync(): Promise<{ synced: boolean }>
    /** Subscribe to background-sync updates. Returns an unsubscribe function. */
    onChanged(cb: () => void): () => void
  }

  notifications: {
    get(): Promise<NotifPrefs>
    set(prefs: NotifPrefs): Promise<boolean>
    test(): Promise<boolean>
  }
}
