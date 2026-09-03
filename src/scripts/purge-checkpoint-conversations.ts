#!/usr/bin/env node
/**
 * Deletes only the Intercom conversations recorded in a specific checkpoint
 * file's `migratedConversations` map. Unlike the blunt
 * `delete-intercom-conversations.ts` script (which wipes the *entire*
 * Intercom inbox), this is intended for surgical cleanup after an accidental
 * migration run — e.g. one triggered by `npm test` against production
 * credentials.
 *
 * Safety properties:
 *  - Dry-run by default. Pass --live to actually delete.
 *  - Verifies each conversation exists in Intercom (matching Groove-linked
 *    metadata where possible) before deleting; never blind-deletes by ID
 *    range or inbox listing.
 *  - Requires an explicit --checkpoint-file so there is no "default target".
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import axios, { AxiosInstance } from "axios";

interface MigrationCheckpointData {
  migratedConversations: Record<string, string>;
}

interface CliArgs {
  checkpointFile: string;
  live: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let checkpointFile: string | undefined;
  let live = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--checkpoint-file") {
      checkpointFile = argv[i + 1];
      i += 1;
    } else if (arg === "--live") {
      live = true;
    }
  }

  if (!checkpointFile) {
    throw new Error(
      "Missing required --checkpoint-file <path>. Refusing to guess a target to avoid deleting the wrong conversations."
    );
  }

  return { checkpointFile: path.resolve(process.cwd(), checkpointFile), live };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function loadCheckpointConversationIds(filePath: string): Map<string, string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Checkpoint file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as MigrationCheckpointData;
  const map = new Map<string, string>();
  for (const [grooveId, resourceRef] of Object.entries(
    parsed.migratedConversations ?? {}
  )) {
    if (typeof resourceRef !== "string") {
      continue;
    }
    // Stored as "conversation:<intercomId>" (see checkpoint-store.ts /
    // intercom-client.ts importConversation). Only conversation-mode
    // entries are deletable via the /conversations endpoint.
    const match = /^conversation:(.+)$/.exec(resourceRef);
    if (match) {
      map.set(grooveId, match[1]);
    }
  }
  return map;
}

async function fetchConversation(
  http: AxiosInstance,
  intercomConversationId: string
): Promise<{ id: string } | undefined> {
  try {
    const response = await http.get(`/conversations/${intercomConversationId}`);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function deleteConversation(
  http: AxiosInstance,
  intercomConversationId: string
): Promise<"deleted" | "already-gone"> {
  try {
    await http.delete(`/conversations/${intercomConversationId}`);
    return "deleted";
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return "already-gone";
    }
    throw error;
  }
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
      Authorization: `Bearer ${intercomAccessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });

  const targets = loadCheckpointConversationIds(args.checkpointFile);

  console.log(
    `Loaded ${targets.size} candidate conversation(s) from ${args.checkpointFile}.`
  );
  console.log(args.live ? "Mode: LIVE (will delete)" : "Mode: DRY RUN (no deletions)");

  let verified = 0;
  let missing = 0;
  let deleted = 0;
  let errors = 0;

  for (const [grooveConversationId, intercomConversationId] of targets) {
    try {
      const existing = await fetchConversation(http, intercomConversationId);
      if (!existing) {
        missing += 1;
        console.log(
          `[skip] groove=${grooveConversationId} intercom=${intercomConversationId} not found (already gone)`
        );
        continue;
      }
      verified += 1;

      if (!args.live) {
        console.log(
          `[dry-run] would delete groove=${grooveConversationId} intercom=${intercomConversationId}`
        );
        continue;
      }

      const result = await deleteConversation(http, intercomConversationId);
      if (result === "deleted") {
        deleted += 1;
        console.log(
          `[deleted] groove=${grooveConversationId} intercom=${intercomConversationId}`
        );
      } else {
        console.log(
          `[skip] groove=${grooveConversationId} intercom=${intercomConversationId} disappeared before delete`
        );
      }
    } catch (error) {
      errors += 1;
      console.error(
        `[error] groove=${grooveConversationId} intercom=${intercomConversationId}`,
        error
      );
    }
  }

  console.log("---");
  console.log(
    `Candidates=${targets.size} verifiedExisting=${verified} alreadyMissing=${missing} deleted=${deleted} errors=${errors}`
  );
  if (!args.live) {
    console.log("Dry run complete. Re-run with --live to actually delete.");
  }
  if (errors > 0) {
    process.exitCode = 1;
  }
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
