# Groove → Intercom Migrator

Reusable TypeScript CLI for migrating historical email conversations from Groove to Intercom.

[![CI](https://github.com/Mailbutler/groove-intercom-migrator/actions/workflows/ci.yml/badge.svg)](https://github.com/Mailbutler/groove-intercom-migrator/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Maintained by [Mailbutler](https://www.mailbutler.io/).

> **Status:** This project is provided as-is for migration work. Test against a staging
> workspace and review the operational warnings below before using it with production data.

## What this does

- Fetches Groove tickets/messages (conversation history) in paginated batches.
- Transforms source data into a normalized internal model.
- Imports into Intercom in one of two explicit modes:
  - `intercom-conversation` (default): creates real Intercom conversations plus replies.
  - `contact-note`: creates historical transcript notes on contacts.
- Maps Groove agent/assignee emails to Intercom admins by email match.
- Stores migration progress in a checkpoint file for resumable, idempotent reruns.
- Persists an email→Intercom contact ID cache in the checkpoint to reduce repeated contact searches.
- Uses Groove REST date bounds (`created_since` + `created_before`) for ticket reads, and automatically window-slices by `created_before` when a run would exceed the 10-page REST cap.
- When ticket payloads omit requester details, resolves the requester via Groove `links.customer` and uses that customer email for contact mapping.
- Syncs Intercom conversation open/closed/snoozed state from Groove status and re-applies state sync on already-migrated conversations during reruns.
- Migrates snoozed conversations. Groove has no dedicated snoozed state: snoozed tickets are returned as `state: "closed"` with a non-null `snoozed_until`, which is either an ISO timestamp or the sentinel `SNOOZED_INDEFINITELY`. Tickets with a future wake-up date are snoozed in Intercom until that same date; `SNOOZED_INDEFINITELY` is snoozed 3 months out (Intercom requires a concrete future date); snoozes that already elapsed fall back to the plain open/closed mapping.
- Converts Groove HTML message bodies to readable plain text for Intercom conversation bodies/replies.
- Skips Groove tickets with `status/state = spam`.
- Syncs Groove conversation tags onto Intercom conversations and re-applies on reruns.
- Optionally applies a precomputed Groove ticket → Jira issue map to Intercom conversations.
- Supports dry runs, date windows, and controlled concurrency.

## Why two migration modes?

Intercom workspaces and API entitlements differ. Some teams can import historical conversations directly, while others may prefer/require preserving history as contact notes.

This project does **not** silently fall back between modes: you choose the mode and failures are surfaced.

## Project structure

- `src/index.ts`: CLI entrypoint
- `src/migration-runner.ts`: end-to-end migration orchestration
- `src/groove-client.ts`: Groove API access
- `src/intercom-client.ts`: Intercom API access
- `src/transform.ts`: normalization + transcript rendering
- `src/checkpoint-store.ts`: resumable state store

## Setup

1. Copy `.env.example` to `.env` and set credentials.
2. Install dependencies:

```bash
npm install
```

3. Build:

```bash
npm run build
```

## Usage

### Dry run (recommended first)

```bash
node dist/index.js \
  --since 2025-01-01T00:00:00.000Z \
  --dry-run \
  --mode intercom-conversation
```

### Migrate all-time

```bash
node dist/index.js --mode intercom-conversation
```

### Migrate from a specific start date

```bash
node dist/index.js --since 2025-01-01T00:00:00.000Z --mode intercom-conversation
```

### Use contact notes instead

```bash
node dist/index.js --mode contact-note
```

### Delete all Intercom conversations (cleanup utility)

```bash
npm run build
npm run cleanup:intercom-conversations
```

This permanently deletes all conversations currently returned by the Intercom API.

### Backfill a date window (re-migrate conversations missing later Groove-only replies)

If Groove and Intercom both received live mail for a period (e.g. during cutover), and
agents replied only in Groove, those replies never reach Intercom because the migrator
skips conversations that are already checkpointed as migrated. Worse, mail delivered
directly to Intercom during that overlap creates **Intercom-native conversations that
were never touched by the migrator at all** — they have no checkpoint entry. Use this
script to find and optionally delete every affected Intercom conversation (both kinds)
so a rerun re-imports the whole window fresh from Groove with all messages, status,
tags, and Jira keys.

**1. List conversations created in the affected window (safe, read-only):**

```bash
npm run build
node dist/scripts/backfill-migrated-window.js \
  --since 2026-08-26T00:00:00.000Z \
  --checkpoint-file checkpoint-q3-2026.json
```

In date-window mode (`--since`/`--until`), the script queries Intercom's
`POST /conversations/search` endpoint directly for every conversation created in the
window — it does **not** rely on the checkpoint file to discover matches, so it finds
both previously-migrated conversations and Intercom-native ones. Each match is printed
labelled `[migrated]` (has a checkpoint entry — a Groove id is shown too) or
`[intercom-native]` (no checkpoint entry — created directly in Intercom). The checkpoint
file is still loaded so matched `[migrated]` entries can be cleared on delete. Add
`--until <isoDate>` to bound the upper end of the window.

**2. Delete the matched Intercom conversations and clear their checkpoint entries:**

```bash
node dist/scripts/backfill-migrated-window.js \
  --since 2026-08-26T00:00:00.000Z \
  --checkpoint-file checkpoint-q3-2026.json \
  --delete --yes
```

This permanently deletes every matched Intercom conversation, both `[migrated]` and
`[intercom-native]`. For `[migrated]` matches, it also removes the entry from the
checkpoint file so the migrator treats that Groove ticket as not-yet-migrated.
`[intercom-native]` matches have no checkpoint entry to clear — they simply cease to
exist in Intercom.

**3. Re-run the migrator to backfill from Groove:**

```bash
node dist/index.js \
  --since 2026-08-26T00:00:00.000Z \
  --checkpoint-file checkpoint-q3-2026.json \
  --mode intercom-conversation
```

**Only want to purge a small, specific subset of already-migrated Groove tickets?**

Instead of (or in addition to) `--since`/`--until`, target specific Groove conversation
ids directly with `--groove-ids` (comma-separated) or `--groove-ids-file` (a text file
with one id per line, or a JSON array). This id-list mode is inherently checkpoint-scoped
(it looks up each Groove id's Intercom conversation via the checkpoint file, not via
Intercom search), so it's only useful for conversations the migrator already touched —
it won't find Intercom-native conversations. For those, use date-window mode above.

```bash
# a handful of ids inline
node dist/scripts/backfill-migrated-window.js \
  --groove-ids 48213,48250,48311 \
  --checkpoint-file checkpoint-q3-2026.json

# or a larger list from a file
node dist/scripts/backfill-migrated-window.js \
  --groove-ids-file affected-tickets.txt \
  --checkpoint-file checkpoint-q3-2026.json \
  --delete --yes
```

This only scans/deletes the listed Groove conversations, leaving every other entry in
the checkpoint file untouched. You can combine `--groove-ids`/`--groove-ids-file` with
`--since`/`--until` to further restrict to ids whose Intercom `created_at` also falls in
a window. The script warns if a requested id isn't found in the checkpoint file at all.

Notes:

- Only `intercom-conversation` mode entries (`conversation:<id>`) can be deleted via the
  Intercom API. `contact-note` mode entries (`note:<id>`) are listed but never deleted —
  rerunning the migrator for a note-mode conversation would just append a duplicate note,
  so review those manually.
- Deletion is permanent. Always run the list step first and review the matched
  conversations before adding `--delete --yes`.
- If any matched conversation has had agent activity *inside Intercom* (not just Groove),
  deleting and re-migrating from Groove will lose that Intercom-side activity. Check for
  this before deleting.
- When using id-list mode (`--groove-ids`/`--groove-ids-file`) without `--since`, remember
  that re-running the main migrator afterward still needs its own `--since`/`--until` to
  cover those specific Groove conversations' original dates.

## CLI flags

- `--since <isoDate>`
- `--until <isoDate>`
- `--dry-run` (explicit; also the default — see [Dry-run is the default](#dry-run-is-the-default))
- `--live` (required to perform real writes to Intercom/Groove)
- `--per-page <number>`
- `--concurrency <number>`
- `--checkpoint-file <path>`
- `--mode <intercom-conversation|contact-note>`
- `--jira-map-file <path>`
- `--log-level <debug|info|warn|error>`

Default page size is `50` (Groove REST documented maximum).

### Agent and assignee mapping

- Agent reply authors are mapped by email to Intercom admins for per-message attribution.
- Conversation assignees are mapped by email and applied as Intercom assignment.
- If no email match is found:
  - default behavior: fallback to default admin (`INTERCOM_FALLBACK_AGENT_ID` or first Intercom admin),
  - strict behavior: set `MIGRATION_STRICT_AGENT_MAPPING=true` to fail fast on unmapped or missing agent emails.

### Jira issue mapping

To keep Jira lookup outside the migration itself, provide a precomputed JSON map with `--jira-map-file` or `JIRA_GROOVE_MAP_FILE`.

Object format:

```json
{
  "166126": ["MP-2676"],
  "162956": ["ER-2508"],
  "161765": ["FRONT-5942", "ER-2488", "ER-2487", "ER-2486", "ER-2485"]
}
```

Entry-list format is also supported:

```json
{
  "tickets": [
    {
      "grooveTicketId": "166126",
      "jiraIssueKeys": ["MP-2676"]
    }
  ]
}
```

In `intercom-conversation` mode, mapped issue keys are written to the Intercom conversation custom attribute named by `INTERCOM_JIRA_ATTRIBUTE_NAME` (`jira_issue_key` by default). Existing checkpointed conversations are also re-synced with mapped Jira keys on reruns. In `contact-note` mode, mapped issue keys are included in the historical note body.

## Checkpointing

By default, migration state is written to `./checkpoint.json`. This includes:

- migrated Groove conversation IDs
- cached Intercom contact IDs by normalized email
- pagination cursor/page state
- active `created_before` auto-window boundary
- migrated/skipped/failed counters

If the process stops, rerun with the same checkpoint file to resume.

## Operational recommendations

1. Run dry-run over your target date window first.
2. Run pilot on one mailbox/date slice.
3. Validate counts and transcript samples in Intercom.
4. Run full migration with same checkpoint path.

## Safety

### Dry-run is the default

Migrations are **dry-run by default**. No writes to Intercom/Groove happen unless you
explicitly opt in with `--live` (or `MIGRATION_LIVE=1` in the environment). Passing
`--dry-run` (or `MIGRATION_DRY_RUN=true`) is still supported and always wins if both are
set. This means simply forgetting a flag, or the CLI being invoked unexpectedly, can
never perform a real migration — it fails safe into dry-run. **This is the primary
safeguard against accidental production writes** — see the note on `node --test` below
for why the next safeguard is not sufficient on its own.

Every script in `src/scripts/` and `src/index.ts` also only calls `main()` when the file
is executed directly (`require.main === module`); merely `require()`ing the compiled
module (e.g. from unrelated tooling, or an ESM/CJS interop path) has no side effects.
**This does not protect against `node --test <directory>`** — Node's test runner spawns
each matched `.js` file as its own child process, so `require.main === module` is true
there too. Never run `node --test` against a directory (only against specific
`*.test.js` files or globs); `npm test` is intentionally scoped this way
(`find dist -name '*.test.js' -print0 | xargs -0 node --test`) and must stay that way —
this exact regression (`node --test dist`) is what caused a past incident where dry-run
was also not yet the default, resulting in duplicate live Intercom conversations.

### Never use production credentials for local development or testing

`.env` should hold **sandbox/test-only** credentials for anything other than an
intentional, reviewed production migration run. A misconfigured `npm test`/CI script, an
errant script invocation, or a bug in an unrelated tool can all end up loading `.env` and
calling into the Groove/Intercom clients — real credentials in that file mean real
production side effects. See `.env.example` for the recommended annotations.

### Use a dedicated checkpoint file for anything other than the real migration

The default checkpoint file (`./checkpoint.json`) should be treated as the production
migration's resumable state. For local testing, dry runs against real credentials (if
ever necessary), or one-off experiments, always pass an explicitly different
`--checkpoint-file` (e.g. `--checkpoint-file checkpoint.local-test.json`). This keeps
test activity from ever resuming, colliding with, or silently diverging from the real
migration's progress tracking — and, in the event of an accidental live run, scopes the
blast radius to a checkpoint file that's obviously not the production one.

### If an accidental/duplicate migration happens

`src/scripts/purge-checkpoint-conversations.ts` (`npm run purge:checkpoint-conversations`)
safely deletes exactly the Intercom conversations recorded in a given checkpoint file:

```bash
npm run build
node dist/scripts/purge-checkpoint-conversations.js --checkpoint-file checkpoint.local-test.json
# review the dry-run output, then:
node dist/scripts/purge-checkpoint-conversations.js --checkpoint-file checkpoint.local-test.json --live
```

It requires an explicit `--checkpoint-file` (no implicit default target), verifies each
conversation still exists before deleting, and is dry-run unless `--live` is passed.
Unlike `cleanup:intercom-conversations` (which deletes **every** conversation in the
Intercom inbox — use with extreme caution and only for full-inbox resets), this script is
scoped to the conversation IDs recorded in the checkpoint you point it at.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening
an issue or pull request. By participating, you agree to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

This tool handles support conversations and API credentials. Never commit `.env` files,
tokens, customer data, checkpoint files, or migration maps containing private data.
See [SECURITY.md](SECURITY.md) for reporting a vulnerability.

## Publishing for reuse

To publish internally or publicly:

1. Push `groove-intercom-migrator/` to your GitHub org.
2. Tag releases and publish to npm/GitHub Packages if desired.
3. Encourage adopters to fork and adjust adapter mappings in `src/transform.ts` for Groove tenant-specific field shapes.

## Important API note

Intercom and Groove API payloads can vary by account configuration and API version. The transformer/client are deliberately defensive, but you should validate exact payload compatibility in a staging run and adjust mapping as needed.

This migrator currently uses Groove REST ticket endpoints (`/v1/tickets` and `/v1/tickets/:number/messages`) for historical support mailbox data.
Groove REST limits pagination depth to page 10. For larger exports, use `--per-page 50`, narrower date windows, or Groove GraphQL/data export.
The migrator now auto-shifts to older `created_before` windows when page 10 is reached, so long runs can continue without manual date slicing.
At the end of a run, the completion log includes `autoWindowShiftCount` so you can audit how many windows were needed.
