#!/usr/bin/env node
/**
 * Identify (and optionally delete) Intercom conversations created within a
 * given date window, so the window can be re-migrated from Groove from
 * scratch (e.g. to backfill agent replies that only landed in Groove after
 * Intercom went live, AND to remove Intercom-native conversations that were
 * created directly in Intercom during a dual-inbox cutover period and were
 * never touched by the migrator at all).
 *
 * Discovery works two ways:
 *   - Date-window mode (--since/--until): queries Intercom's
 *     `POST /conversations/search` endpoint directly for every conversation
 *     created in the window — this finds BOTH migrator-created conversations
 *     AND Intercom-native ones (e.g. mail Intercom received directly during
 *     the forwarding overlap). It does not depend on the checkpoint file for
 *     discovery, since Intercom-native conversations have no checkpoint
 *     entry at all.
 *   - Id-list mode (--groove-ids/--groove-ids-file): looks up specific Groove
 *     conversation ids in the checkpoint file only (this mode is inherently
 *     checkpoint-scoped, since it targets already-migrated Groove tickets).
 *
 * The checkpoint file is still consulted/updated in date-window mode: any
 * matched Intercom conversation that also has a checkpoint entry (found via
 * a reverse lookup) has that entry cleared on delete, so a subsequent
 * migrator run re-migrates it instead of skipping it as already-migrated.
 * Matched conversations with no checkpoint entry (Intercom-native) are
 * deleted too, but there is nothing to clear.
 *
 * Workflow:
 *   1. List mode (default, safe): shows every matching Intercom conversation,
 *      labelled "migrated" (has a checkpoint entry) or "intercom-native"
 *      (created directly in Intercom, no checkpoint entry).
 *   2. Delete mode (--delete --yes): deletes those Intercom conversations and
 *      clears any corresponding checkpoint entries.
 *
 * Only checkpoint entries created in `intercom-conversation` mode
 * (value format `conversation:<id>`) are cleared automatically.
 * `contact-note` mode entries (`note:<id>`) are never deleted by this
 * script, since Intercom notes are not intended to be revoked this way;
 * re-running the migrator in contact-note mode would just append a
 * duplicate note.
 */
import "dotenv/config";
import fs from "node:fs";
import axios, { AxiosInstance } from "axios";
import { CheckpointStore } from "../checkpoint-store";

interface CliArgs {
  since?: Date;
  until?: Date;
  checkpointFile: string;
  delete: boolean;
  confirmed: boolean;
  grooveIds?: Set<string>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function parseIdList(value: string): string[] {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function parseArgs(argv: string[]): CliArgs {
  let since: Date | undefined;
  let until: Date | undefined;
  let checkpointFile: string | undefined;
  let deleteFlag = false;
  let confirmed = false;
  let grooveIds: Set<string> | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--since": {
        const value = argv[++i];
        since = value ? new Date(value) : undefined;
        break;
      }
      case "--until": {
        const value = argv[++i];
        until = value ? new Date(value) : undefined;
        break;
      }
      case "--checkpoint-file": {
        checkpointFile = argv[++i];
        break;
      }
      case "--delete": {
        deleteFlag = true;
        break;
      }
      case "--yes": {
        confirmed = true;
        break;
      }
      case "--groove-ids": {
        const value = argv[++i];
        if (!value) {
          throw new Error("--groove-ids requires a comma-separated list of Groove ticket ids.");
        }
        grooveIds = new Set([...(grooveIds ?? []), ...parseIdList(value)]);
        break;
      }
      case "--groove-ids-file": {
        const filePath = argv[++i];
        if (!filePath) {
          throw new Error("--groove-ids-file requires a path to a text/JSON file.");
        }
        const raw = fs.readFileSync(filePath, "utf8").trim();
        const idsFromFile = raw.startsWith("[")
          ? (JSON.parse(raw) as unknown[]).map((id) => String(id))
          : raw.split(/\r?\n/).map((line) => line.trim());
        grooveIds = new Set([
          ...(grooveIds ?? []),
          ...idsFromFile.filter((id) => id.length > 0),
        ]);
        break;
      }
      default: {
        throw new Error(`Unrecognized argument: ${arg}`);
      }
    }
  }

  if (since && Number.isNaN(since.getTime())) {
    throw new Error("Invalid --since value.");
  }
  if (until && Number.isNaN(until.getTime())) {
    throw new Error("Invalid --until value.");
  }
  if (!since && !grooveIds) {
    throw new Error(
      "Provide either --since <isoDate> (date-window mode) or --groove-ids/--groove-ids-file " +
        "(explicit id-list mode). Example: --since 2026-08-26T00:00:00.000Z"
    );
  }
  if (!checkpointFile) {
    throw new Error(
      "Missing required --checkpoint-file <path>. Point this at the checkpoint file " +
        "that covers the affected conversations (e.g. checkpoint-q3-2026.json)."
    );
  }

  return {
    since,
    until,
    checkpointFile,
    delete: deleteFlag,
    confirmed,
    grooveIds,
  };
}

function parseResourceId(resourceValue: string): { kind: "conversation" | "note"; id: string } | undefined {
  const [kind, id] = resourceValue.split(":", 2);
  if ((kind === "conversation" || kind === "note") && id) {
    return { kind, id };
  }
  return undefined;
}

interface IntercomConversation {
  id?: string | number;
  created_at?: number;
  updated_at?: number;
}

interface IntercomConversationSearchResponse {
  conversations?: IntercomConversation[];
  pages?: {
    next?: { starting_after?: string } | string;
  };
  total_count?: number;
}

/**
 * Queries Intercom directly for every conversation created in [since, until],
 * independent of the checkpoint file. This is what makes the script able to
 * find Intercom-native conversations (created directly in Intercom, e.g. via
 * the parallel-forwarding overlap) that the migrator never touched and that
 * therefore have no checkpoint entry at all.
 */
async function searchConversationsCreatedInWindow(
  http: AxiosInstance,
  since: Date,
  until?: Date
): Promise<IntercomConversation[]> {
  const sinceSeconds = Math.floor(since.getTime() / 1000);
  const untilSeconds = until ? Math.ceil(until.getTime() / 1000) : undefined;

  const conditions: Array<{ field: string; operator: string; value: number }> = [
    { field: "created_at", operator: ">", value: sinceSeconds - 1 },
  ];
  if (untilSeconds !== undefined) {
    conditions.push({ field: "created_at", operator: "<", value: untilSeconds + 1 });
  }

  const results: IntercomConversation[] = [];
  let startingAfter: string | undefined;

  do {
    const response = await http.post<IntercomConversationSearchResponse>(
      "/conversations/search",
      {
        query:
          conditions.length === 1
            ? conditions[0]
            : { operator: "AND", value: conditions },
        pagination: {
          per_page: 150,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        },
      }
    );

    const page = response.data.conversations ?? [];
    results.push(...page);

    const next = response.data.pages?.next;
    startingAfter = typeof next === "string" ? next : next?.starting_after ?? undefined;

    if (page.length === 0) {
      break;
    }
  } while (startingAfter);

  return results;
}

async function deleteConversation(
  http: AxiosInstance,
  intercomConversationId: string
): Promise<boolean> {
  try {
    await http.delete(`/conversations/${intercomConversationId}`);
    return true;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return true;
    }
    throw error;
  }
}

interface MatchedEntry {
  grooveConversationId?: string;
  kind: "conversation" | "note";
  intercomId: string;
  createdAt?: Date;
  origin: "migrated" | "intercom-native";
}

/** Reverse index over checkpoint entries: intercomConversationId -> grooveConversationId. */
function buildReverseIndex(
  entries: Array<[string, string]>
): Map<string, { grooveConversationId: string; kind: "conversation" | "note" }> {
  const index = new Map<string, { grooveConversationId: string; kind: "conversation" | "note" }>();
  for (const [grooveConversationId, resourceValue] of entries) {
    const resource = parseResourceId(resourceValue);
    if (resource) {
      index.set(resource.id, { grooveConversationId, kind: resource.kind });
    }
  }
  return index;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const intercomApiBaseUrl = (
    process.env.INTERCOM_API_BASE_URL ?? "https://api.intercom.io"
  ).replace(/\/+$/, "");
  const intercomAccessToken = requireEnv("INTERCOM_ACCESS_TOKEN");

  const http = axios.create({
    baseURL: intercomApiBaseUrl,
    headers: {
      Authorization: "Bearer " + intercomAccessToken,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });

  const checkpoint = new CheckpointStore(args.checkpointFile);
  const snapshot = checkpoint.load();
  const entries = Object.entries(snapshot.migratedConversations);
  const reverseIndex = buildReverseIndex(entries);

  console.log(
    `Loaded checkpoint ${args.checkpointFile} with ${entries.length} migrated entr${
      entries.length === 1 ? "y" : "ies"
    } (used to clear entries on delete, not for discovery).`
  );

  const matches: MatchedEntry[] = [];
  const skippedNotes: string[] = [];
  const unresolved: string[] = [];

  if (args.grooveIds) {
    // Id-list mode: inherently checkpoint-scoped, since it targets specific
    // already-migrated Groove tickets by id.
    console.log(
      `Scanning for ${args.grooveIds.size} explicitly listed Groove conversation id(s)` +
        (args.since
          ? `, further restricted to created_at between ${args.since.toISOString()} and ` +
            `${args.until ? args.until.toISOString() : "(no upper bound)"}`
          : "") +
        "..."
    );

    for (const [grooveConversationId, resourceValue] of entries) {
      if (!args.grooveIds.has(grooveConversationId)) {
        continue;
      }

      const resource = parseResourceId(resourceValue);
      if (!resource) {
        unresolved.push(grooveConversationId);
        continue;
      }
      if (resource.kind === "note") {
        skippedNotes.push(grooveConversationId);
        continue;
      }

      let createdAt: Date | undefined;
      if (args.since) {
        try {
          const response = await http.get<IntercomConversation>(
            `/conversations/${resource.id}`
          );
          const createdAtSeconds = response.data.created_at;
          createdAt =
            typeof createdAtSeconds === "number"
              ? new Date(createdAtSeconds * 1000)
              : undefined;
        } catch (error) {
          if (!(axios.isAxiosError(error) && error.response?.status === 404)) {
            throw error;
          }
        }
        if (!createdAt) {
          unresolved.push(grooveConversationId);
          continue;
        }
        if (createdAt < args.since) {
          continue;
        }
        if (args.until && createdAt > args.until) {
          continue;
        }
      }

      matches.push({
        grooveConversationId,
        kind: resource.kind,
        intercomId: resource.id,
        createdAt,
        origin: "migrated",
      });
    }
  } else if (args.since) {
    // Date-window mode: query Intercom directly so both migrator-created AND
    // Intercom-native conversations in the window are found.
    console.log(
      `Searching Intercom directly for conversations created between ${args.since.toISOString()} and ` +
        `${args.until ? args.until.toISOString() : "(no upper bound)"}...`
    );

    const found = await searchConversationsCreatedInWindow(http, args.since, args.until);
    for (const conversation of found) {
      const intercomId = conversation.id !== undefined ? String(conversation.id) : undefined;
      if (!intercomId) {
        continue;
      }
      const createdAt =
        typeof conversation.created_at === "number"
          ? new Date(conversation.created_at * 1000)
          : undefined;

      const reverseMatch = reverseIndex.get(intercomId);
      if (reverseMatch?.kind === "note") {
        // Shouldn't normally happen (notes aren't conversations), but guard anyway.
        skippedNotes.push(reverseMatch.grooveConversationId);
        continue;
      }

      matches.push({
        grooveConversationId: reverseMatch?.grooveConversationId,
        kind: "conversation",
        intercomId,
        createdAt,
        origin: reverseMatch ? "migrated" : "intercom-native",
      });
    }
  }

  matches.sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));

  const migratedMatches = matches.filter((m) => m.origin === "migrated");
  const nativeMatches = matches.filter((m) => m.origin === "intercom-native");

  console.log(`\nMatched ${matches.length} conversation(s) in window:`);
  for (const match of matches) {
    console.log(
      `  [${match.origin}]\tintercomConversationId=${match.intercomId}` +
        `${match.grooveConversationId ? `\tgroove=${match.grooveConversationId}` : ""}` +
        `\tcreatedAt=${match.createdAt?.toISOString() ?? "(unknown)"}`
    );
  }

  if (args.since) {
    console.log(
      `\nOf these: ${migratedMatches.length} have a checkpoint entry (previously migrated from ` +
        `Groove), ${nativeMatches.length} do not (created directly in Intercom, e.g. dual-inbox ` +
        "forwarding)."
    );
  }

  if (skippedNotes.length > 0) {
    console.log(
      `\nSkipped ${skippedNotes.length} contact-note entr${
        skippedNotes.length === 1 ? "y" : "ies"
      } (notes are not deleted by this script): ${skippedNotes.join(", ")}`
    );
  }

  if (unresolved.length > 0) {
    console.log(
      `\nCould not resolve ${unresolved.length} checkpoint entr${
        unresolved.length === 1 ? "y" : "ies"
      } (missing/unparsable resource id, or Intercom 404 — conversation may already be deleted): ${unresolved.join(", ")}`
    );
  }

  if (args.grooveIds) {
    const foundIds = new Set(matches.map((m) => m.grooveConversationId).filter(Boolean));
    const notFound = [...args.grooveIds].filter(
      (id) => !foundIds.has(id) && !unresolved.includes(id) && !skippedNotes.includes(id)
    );
    if (notFound.length > 0) {
      console.log(
        `\nWarning: ${notFound.length} requested Groove id(s) were not found in this ` +
          `checkpoint file at all (check --checkpoint-file, or they may not have been ` +
          `migrated): ${notFound.join(", ")}`
      );
    }
  }

  if (matches.length === 0) {
    console.log("\nNothing to delete. Exiting.");
    return;
  }

  if (!args.delete) {
    console.log(
      "\nDry run only (list mode). Re-run with --delete --yes to permanently delete " +
        "these Intercom conversations and clear their checkpoint entries."
    );
    return;
  }

  if (!args.confirmed) {
    throw new Error(
      "--delete requires --yes to confirm this is a deliberate, permanent, destructive action."
    );
  }

  console.log(`\nDeleting ${matches.length} Intercom conversation(s)...`);
  let deletedCount = 0;
  const deletedGrooveIds: string[] = [];
  for (const match of matches) {
    await deleteConversation(http, match.intercomId);
    if (match.grooveConversationId) {
      checkpoint.unmarkMigrated(match.grooveConversationId);
      deletedGrooveIds.push(match.grooveConversationId);
    }
    deletedCount += 1;
    console.log(
      `  [${deletedCount}/${matches.length}] deleted intercomConversationId=${match.intercomId} ` +
        `(${match.grooveConversationId ? `groove=${match.grooveConversationId}, cleared checkpoint entry` : "intercom-native, no checkpoint entry"})`
    );
  }

  checkpoint.save();

  const reRunHint = args.since
    ? `  node dist/index.js --since ${args.since.toISOString()}` +
      (args.until ? ` --until ${args.until.toISOString()}` : "") +
      ` --checkpoint-file ${args.checkpointFile} --mode intercom-conversation`
    : `  node dist/index.js --checkpoint-file ${args.checkpointFile} --mode intercom-conversation\n` +
      `  (id-list mode does not imply a date window; make sure --since/--until on the main\n` +
      `   migrator run still covers these Groove conversation ids: ${deletedGrooveIds.join(", ")})`;

  console.log(
    `\nDone. Deleted ${deletedCount} Intercom conversation(s) and updated ${args.checkpointFile}.\n` +
      `Re-run the migrator to backfill from Groove, e.g.:\n${reRunHint}`
  );
}

// Only auto-run when executed directly; guards against tooling that
// `require()`s every .js file in a directory (e.g. `node --test dist`)
// accidentally triggering this script's writes/deletes as an import side-effect.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
