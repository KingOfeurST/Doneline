# Doneline 0.5.3

Fixes saved notes being hidden when their original profile no longer appears in the app, and makes past notes easier to find while keeping the existing layout.

- Notes from older profiles are discoverable in a separate read-only section, independent of the current profile filter. Reading and copying preserves the original notes.
- The note column includes a date picker, previous/next day controls, a Today button and a saved-date list. Note browsing leaves task and calendar dates unchanged. Every note shows its owner's name.
- Background note updates received while typing or saving are applied after the editor becomes clean and loses focus. Revision checks continue to protect unsaved drafts and reject stale reads.
- The desktop bridge exposes profile-scoped history and older-profile note metadata. The new read-only `list_unassigned_notes` MCP tool brings the assistant tool count to 52.

Verification covers historical partner notes, older-profile notes under an own-profile filter, read-only recovery browsing, focused note refresh, draft preservation, sandboxed IPC, note persistence across restart and the existing planning/calendar/sync regressions. Windows, Intel Mac and Apple Silicon Mac must all pass source and packaged-app checks before publication.

Windows supports automatic updates. Mac requires macOS 14 or newer and manual installation because no Apple Developer signing certificate is configured. After updating a partner's device, select their current profile in Settings → This is me.
