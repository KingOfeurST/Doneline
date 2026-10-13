# Doneline 0.5.0

Adds assistant control through MCP and a local JSON CLI while keeping Doneline's interface.

- 51 MCP tools cover tasks, events, goals, profiles, notes, search, daily/weekly planning, recurrence previews and scoped edits, Trash recovery, backups, and explicit cloud/calendar sync.
- The CLI uses those same MCP tools, with JSON file/stdin input, selected-profile defaults, exact date planning, and ordered batches that return completed results when an operation fails.
- App windows refresh after another process saves locally, including offline and local-only workspaces. Unsaved note drafts remain protected.
- Mutations acknowledge local saving immediately. Stopping a short-lived MCP/CLI process cancels its network work and releases its own sync lease, keeping pending changes durable for the next sync.
- Task/event deletions return Trash IDs. Permanent goal/profile deletion first creates a safety backup. Restoring a backup requires an explicit restore acknowledgement.
- Installed apps include the MCP/CLI bundles and production dependencies. They can use the shipped Electron runtime without a separate Node installation.

The release verifies isolated MCP/CLI CRUD, persistence across process restarts, recovery, bounded recurrence/planning, held-network shutdown, actual app refresh, and packaged assistant tools. Windows, Intel Mac, and Apple Silicon Mac must all pass before publication. Existing cloud and calendar protocol regressions remain part of the checks; live personal iCloud writes are not exercised.

Windows supports automatic updates. Mac requires macOS 14 or newer and manual installation because no Apple Developer signing certificate is configured. Imported Apple Calendar repeat weekdays and bounds remain managed in Apple Calendar.
