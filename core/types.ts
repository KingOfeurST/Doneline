export interface Person {
  id: string
  name: string
  color: string
  emoji: string
  position: number
  created_at: string
}

export interface Goal {
  id: string
  person_id: string
  title: string
  color: string
  archived: number
  shared: number
  created_at: string
}

/** Recurrence rule. `weekly` uses `days` (0=Sun … 6=Sat). */
export interface Recurrence {
  freq: 'daily' | 'weekly'
  days?: number[]
}

export interface Todo {
  id: string
  person_id: string
  title: string
  goal_id: string | null
  notes: string | null
  due_at: string | null // ISO datetime
  completed_at: string | null // ISO datetime, null = open
  position: number
  archived: number
  recurrence: string | null // JSON Recurrence (template) or null
  recur_parent: string | null // template id if this is a generated instance
  created_at: string
}

export interface TodoWithGoal extends Todo {
  goal_title: string | null
  goal_color: string | null
  goal_shared: number | null // 1 if the linked goal is shared (todo needs everyone)
  done_by: string | null // comma-separated person_ids who've completed (mutual todos)
  person_name: string | null
  person_emoji: string | null
}

export interface CalEvent {
  id: string
  person_id: string
  title: string
  location: string | null
  notes: string | null
  starts_at: string // ISO datetime
  ends_at: string // ISO datetime
  all_day: number
  color: string
  shared: number // 1 = shown for everyone in the workspace
  attendees: string | null // comma-separated names, optional
  caldav_uid: string | null
  caldav_etag: string | null
  caldav_url: string | null
  recurrence: string | null // JSON Recurrence (template) or null
  recur_parent: string | null
  source: 'local' | 'caldav'
  created_at: string
}

export interface Setting {
  key: string
  value: string
}

export interface Presence {
  person_id: string
  status: 'focusing' | 'idle'
  phase: 'focus' | 'break' | null
  task_title: string | null
  ends_at: string | null
  updated_at: string
}

export interface Nudge {
  id: string
  from_person: string
  to_person: string
  message: string
  created_at: string
  seen: number
}

export interface FocusInvite {
  id: string
  from_person: string
  to_person: string
  focus_min: number
  break_min: number
  created_at: string
  seen: number
  accepted: number
  started_at: string | null // shared anchor; both clients start from this moment
}
