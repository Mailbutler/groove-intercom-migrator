# Groove → Intercom Migrator

Reusable TypeScript CLI for migrating historical email conversations from Groove to Intercom.

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
- Syncs Intercom conversation open/closed state from Groove status and re-applies state sync on already-migrated conversations during reruns.
- Converts Groove HTML message bodies to readable plain text for Intercom conversation bodies/replies.
- Skips Groove tickets with `status/state = spam`.
- Syncs Groove conversation tags onto Intercom conversations and re-applies on reruns.
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

## CLI flags

- `--since <isoDate>`
- `--until <isoDate>`
- `--dry-run`
- `--per-page <number>`
- `--concurrency <number>`
- `--checkpoint-file <path>`
- `--mode <intercom-conversation|contact-note>`
- `--log-level <debug|info|warn|error>`

Default page size is `50` (Groove REST documented maximum).

### Agent and assignee mapping

- Agent reply authors are mapped by email to Intercom admins for per-message attribution.
- Conversation assignees are mapped by email and applied as Intercom assignment.
- If no email match is found:
  - default behavior: fallback to default admin (`INTERCOM_FALLBACK_AGENT_ID` or first Intercom admin),
  - strict behavior: set `MIGRATION_STRICT_AGENT_MAPPING=true` to fail fast on unmapped or missing agent emails.

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

## Publishing for reuse

To publish internally or publicly:

1. Push `groove-intercom-migrator/` to your GitHub org.
2. Add CI for `npm run typecheck && npm test`.
3. Tag releases and publish to npm/GitHub Packages if desired.
4. Encourage adopters to fork and adjust adapter mappings in `src/transform.ts` for Groove tenant-specific field shapes.

## Important API note

Intercom and Groove API payloads can vary by account configuration and API version. The transformer/client are deliberately defensive, but you should validate exact payload compatibility in a staging run and adjust mapping as needed.

This migrator currently uses Groove REST ticket endpoints (`/v1/tickets` and `/v1/tickets/:number/messages`) for historical support mailbox data.
Groove REST limits pagination depth to page 10. For larger exports, use `--per-page 50`, narrower date windows, or Groove GraphQL/data export.
The migrator now auto-shifts to older `created_before` windows when page 10 is reached, so long runs can continue without manual date slicing.
At the end of a run, the completion log includes `autoWindowShiftCount` so you can audit how many windows were needed.
