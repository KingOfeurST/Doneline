# Working with Doneline

When the user asks to view, plan, add, change, complete, or remove their Doneline
items, perform the action through the Doneline MCP tools. If those tools are not
loaded in this session, the same tools are available through the local CLI:

```powershell
node out/mcp/cli.cjs status
node out/mcp/cli.cjs tools TOOL_NAME
node out/mcp/cli.cjs call TOOL_NAME --input REQUEST_FILE.json
```

The built entrypoints are `out/mcp/server.cjs` and `out/mcp/cli.cjs`. Build them
with `npm run build:mcp` when missing or after changing their source. Use absolute
paths outside this repository (this Windows checkout is `C:\dev\Doneline`).
The default data directory is `~/.doneline`, the
same as the desktop app; `--data-dir` chooses a separate workspace.

- Read `status` to establish the current profile, date, timezone, database, and
  sync state. Default writes to the selected profile. Resolve named people and
  items using `list_people` and `search`; use exact returned IDs.
- Use `plan_day` or `plan_week` to inspect scheduled work, overdue and undated
  tasks, events and goals. Use `preview_recurrence` to check the actual weekday
  dates and inclusive bounds before creating a recurring schedule.
- Add or edit tasks, goals and events through their tools. Event edits support
  `scope: occurrence`, `future`, or `series`. Imported Apple Calendar repeat
  weekdays and bounds are managed in Apple Calendar.
- Append notes with `append_note`. Read a note before replacing its full body
  with `set_note`. Use `delete_note` only for requested clearing.
- Task/event deletion moves items to Trash; retain the returned `trash_id` for
  Undo with `restore_trash`. Range removal must first obtain a preview and pass
  its exact `expected_ids`. An authorized, unambiguous removal request does not
  need another confirmation just to execute the reviewed matches.
- Goal/profile deletion permanently removes dependent records. The tools create
  safety backups. Only use their destructive actions when the user has requested
  that target and scope. Backup restore requires `confirm_restore: true` after
  the user has requested restoring the chosen backup.
- The CLI accepts JSON files or UTF-8 stdin. Prefer `--input` for Windows strings
  with quotes, newlines, or Unicode. Batch input is an array of
  `{ "tool": "add_todo", "args": { ... } }`; batches stop on a failure and return
  completed results. They are not atomic and must not be retried blindly.
- Confirm successful writes from `ok`/`isError` and `local_receipt`, then read the
  resulting item when needed. State whether work is saved locally or synced.
  `sync_workspace` explicitly flushes the cloud queue; calendar sync is separate.
- Never expose workspace tokens, calendar passwords, or connect codes. Send
  nudges or other messages only when the user explicitly requests them.

For development verification, use temporary `DONELINE_DIR` and `DONELINE_DB`
paths. Do not run CRUD tests against the user's normal data. Standard checks are
`npm run typecheck`, `npm test`, `npm run test:mcp`, and `npm run build`.
