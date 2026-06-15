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
  created_at: string
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
  created_at: string
}

export interface TodoWithGoal extends Todo {
  goal_title: string | null
  goal_color: string | null
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
  attendees: string | null // comma-separated names, optional
  caldav_uid: string | null
  caldav_etag: string | null
  caldav_url: string | null
  source: 'local' | 'caldav'
  created_at: string
}

export interface Setting {
  key: string
  value: string
}
