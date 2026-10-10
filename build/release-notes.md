# Doneline 0.4.0

Keeps Doneline's existing interface and adds the approved planning and data recovery features.

- Automatic daily backups, manual backups, and restore with a safety copy. Backups are kept separately for each workspace; current Apple Calendar connections are preserved.
- Deleted tasks and events go to a local 30-day Trash, with Restore and immediate Undo, including reviewed date-range removal.
- Tasks and notes save immediately to local SQLite. A durable queue retries cloud sync in the background, with Saved locally / Syncing / Synced status. Previously connected workspaces reopen offline.
- Today, Overdue, Upcoming, and No date task groups with counts and quick rescheduling. Completing personal or shared tasks still updates immediately and rolls back if saving fails.
- Recurring events show their actual dates before saving. Edit one occurrence, this and future occurrences, or the whole series, preserving earlier dates and exclusions. Imported Apple Calendar series support these scopes for details and times; change their repeat schedule in Apple Calendar.
- Ctrl+K on Windows or Cmd+K on Mac searches tasks, events, goals, and notes and opens the exact result, including historical notes.
- Stable recurring occurrence identities prevent duplicate generation across devices. Independently deleted recurring dates remain deleted when offline devices reconnect, and Undo restores only the selected date. Sync retries after a lost acknowledgement do not replay older writes.

The release workflow verifies core regressions, actual Electron IPC and Chromium UI, MCP, packaged native SQLite, and app startup on Windows x64, Intel Mac, and Apple Silicon Mac before publishing all installers together. Automated cloud and calendar checks use isolated protocol fixtures; live Turso and iCloud accounts are not exercised.

Windows supports automatic updates. Mac downloads require macOS 14 or newer. This release is unsigned because no Apple Developer certificate is available, so Mac updates open the download page and require manual installation.
