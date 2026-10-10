Notes now finish saving before Doneline quits or installs an update. Previously, quitting could close the database before the editor sent its final changes. If saving fails, Doneline keeps the editor open and shows the error so you can retry.

Unsaved drafts remain on this device and can be recovered after reopening, including when the first note load fails. Save confirmations are checked before a draft is discarded.

This release also includes the earlier instant todo completion and remaining count. Failed saves restore the task and show an error.

Recurring tasks and events now respect the selected weekdays and inclusive Repeat from / Repeat until dates. Calendar → Remove items previews matching events and due todos between two dates before deleting them. Deleted occurrences stay removed; the repeat rule continues on other dates. Repeating events lets you edit or remove a complete local rule.

This update also fixes calendar day and DST boundaries, all-day and overlapping events, recurrence edits, deleted-event resurrection, sync retries, profile-switch races, shared completion history, daily-note saving and focus timers.

The release is gated on regression tests, Electron UI/IPC tests, note save/quit/reopen checks, MCP checks, native database checks and actual packaged-app startup on Windows x64, Intel Mac and Apple Silicon Mac. Live iCloud/Turso accounts are not part of automated tests.

Windows installations can download the update automatically; Settings → Check for updates is also available.

Mac downloads are supplied separately for Apple Silicon (`arm64`, M-series) and Intel (`x64`). Requires macOS 14 or newer. These builds are unsigned because no Apple Developer certificate is configured: automatic installation on Mac is unavailable. Quit Doneline and replace the app in Applications using the appropriate DMG. If macOS blocks the app, after placing this release in Applications run `xattr -cr /Applications/Doneline.app`. The new app checks for future releases and provides a download link.
