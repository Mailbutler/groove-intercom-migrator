#!/usr/bin/env node
/**
 * Merge several checkpoint files into a single one, so a migration that was
 * originally run in separate slices (e.g. per quarter/half-year, each with its
 * own checkpoint file) can subsequently be re-run over the full period from
 * one checkpoint.
 *
 * This matters because the Groove -> Intercom mapping lives ONLY in the
 * checkpoint's `migratedConversations` map; there is no Intercom-side dedup.
 * Running the migrator over a window without the checkpoint entries for that
 * window would re-import every conversation and create duplicates. Merging
 * first gives the runner the full mapping, so already-migrated conversations
 * take the cheap sync-only path (state/snooze/tags/Jira) instead.
 *
 * Inputs are never modified: the merged result is written to a new file.
 *
 * Conflicts: if the same Groove conversation id was migrated in more than one
 * input file, it exists twice in Intercom. The merged file can only reference
 * one of them, so `--prefer` decides which input wins. The losing Intercom
 * conversation is left untouched in Intercom and is reported so it can be
 * cleaned up (see `cleanup:intercom-conversations`).
 *
 * Pagination (`cursor`/`page`/`windowUntil`) is intentionally reset in the
 * merged file: the inputs' resume positions describe different windows and are
 * meaningless once combined. A reset means the next run walks its window from
 * the start, which is exactly what a state-reconciliation re-run needs.
 *
 * Usage:
 *   npm run checkpoints:merge -- --out checkpoint-all.json checkpoint-q1-2025.json checkpoint-q2-2025.json
 *   npm run checkpoints:merge -- --out merged.json --prefer checkpoint-q3-2026.json checkpoint-*.json
 *   npm run checkpoints:merge -- --out merged.json --dry-run checkpoint-*.json
 */
import fs from "node:fs";
import path from "node:path";
import { MigrationCheckpointData } from "../types";

const CHECKPOINT_VERSION = 1;

interface MergeOptions {
  inputFiles: string[];
  outFile: string;
  preferFiles: string[];
  dryRun: boolean;
  force: boolean;
}

interface ConversationConflict {
  grooveConversationId: string;
  keptIntercomResourceId: string;
  keptFrom: string;
  droppedIntercomResourceId: string;
  droppedFrom: string;
}

function printUsage(): void {
  console.log(
    `Usage: npm run checkpoints:merge -- --out <file> [options] <checkpoint...>

Options:
  --out <file>        Path of the merged checkpoint file to write (required).
  --prefer <file>     Input file whose ids win on conflict. Repeatable; earlier
                      --prefer entries outrank later ones. Defaults to the last
                      input file that contains the conflicting id.
  --dry-run           Report the merge result without writing the output file.
  --force             Overwrite the output file if it already exists.
  -h, --help          Show this help.`
  );
}

function parseArgs(argv: string[]): MergeOptions {
  const inputFiles: string[] = [];
  const preferFiles: string[] = [];
  let outFile: string | undefined;
  let dryRun = false;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      case "--out": {
        outFile = argv[index + 1];
        index += 1;
        if (!outFile) {
          throw new Error("--out requires a file path.");
        }
        break;
      }
      case "--prefer": {
        const preferred = argv[index + 1];
        index += 1;
        if (!preferred) {
          throw new Error("--prefer requires a file path.");
        }
        preferFiles.push(path.resolve(preferred));
        break;
      }
      default: {
        if (arg.startsWith("-")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        inputFiles.push(path.resolve(arg));
        break;
      }
    }
  }

  if (!outFile) {
    throw new Error("Missing required --out <file>.");
  }
  if (inputFiles.length < 2) {
    throw new Error("Provide at least two checkpoint files to merge.");
  }

  const resolvedOut = path.resolve(outFile);
  if (inputFiles.includes(resolvedOut)) {
    throw new Error(
      `Refusing to write the merged checkpoint over an input file: ${resolvedOut}`
    );
  }

  const unknownPrefer = preferFiles.filter((file) => !inputFiles.includes(file));
  if (unknownPrefer.length > 0) {
    throw new Error(
      `--prefer files must also be listed as inputs: ${unknownPrefer.join(", ")}`
    );
  }

  return { inputFiles, outFile: resolvedOut, preferFiles, dryRun, force };
}

function readCheckpoint(filePath: string): MigrationCheckpointData {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Checkpoint file not found: ${filePath}`);
  }

  const parsed = JSON.parse(
    fs.readFileSync(filePath, "utf8")
  ) as MigrationCheckpointData;
  if (parsed.version !== CHECKPOINT_VERSION) {
    throw new Error(
      `Unsupported checkpoint version ${parsed.version} in ${filePath}. Expected ${CHECKPOINT_VERSION}.`
    );
  }
  return parsed;
}

/**
 * Lower rank wins. Files named via --prefer rank in the order they were given;
 * everything else keeps "last input wins" as the default.
 */
function buildPreferenceRank(options: MergeOptions): Map<string, number> {
  const rank = new Map<string, number>();
  options.preferFiles.forEach((file, index) => {
    rank.set(file, index);
  });

  const base = options.preferFiles.length;
  options.inputFiles.forEach((file, index) => {
    if (!rank.has(file)) {
      rank.set(file, base + (options.inputFiles.length - index));
    }
  });
  return rank;
}

function mergeCheckpoints(options: MergeOptions): {
  merged: MigrationCheckpointData;
  conflicts: ConversationConflict[];
  contactConflicts: number;
} {
  const rank = buildPreferenceRank(options);
  const conversationSources = new Map<string, string>();
  const contactSources = new Map<string, string>();
  const conflicts: ConversationConflict[] = [];
  let contactConflicts = 0;

  const now = new Date().toISOString();
  const merged: MigrationCheckpointData = {
    version: CHECKPOINT_VERSION,
    cursor: undefined,
    page: 1,
    windowUntil: undefined,
    migratedConversations: {},
    intercomContactsByEmail: {},
    migratedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    startedAt: now,
    updatedAt: now,
  };

  let earliestStartedAt: string | undefined;

  for (const filePath of options.inputFiles) {
    const data = readCheckpoint(filePath);
    const label = path.basename(filePath);

    merged.skippedCount += data.skippedCount ?? 0;
    merged.failedCount += data.failedCount ?? 0;

    if (data.startedAt && (!earliestStartedAt || data.startedAt < earliestStartedAt)) {
      earliestStartedAt = data.startedAt;
    }

    for (const [grooveConversationId, intercomResourceId] of Object.entries(
      data.migratedConversations ?? {}
    )) {
      const existingSource = conversationSources.get(grooveConversationId);
      if (!existingSource) {
        merged.migratedConversations[grooveConversationId] = intercomResourceId;
        conversationSources.set(grooveConversationId, filePath);
        continue;
      }

      const existingResourceId =
        merged.migratedConversations[grooveConversationId];
      if (existingResourceId === intercomResourceId) {
        continue;
      }

      const incomingWins =
        (rank.get(filePath) ?? Number.MAX_SAFE_INTEGER) <
        (rank.get(existingSource) ?? Number.MAX_SAFE_INTEGER);

      if (incomingWins) {
        merged.migratedConversations[grooveConversationId] = intercomResourceId;
        conversationSources.set(grooveConversationId, filePath);
        conflicts.push({
          grooveConversationId,
          keptIntercomResourceId: intercomResourceId,
          keptFrom: label,
          droppedIntercomResourceId: existingResourceId,
          droppedFrom: path.basename(existingSource),
        });
      } else {
        conflicts.push({
          grooveConversationId,
          keptIntercomResourceId: existingResourceId,
          keptFrom: path.basename(existingSource),
          droppedIntercomResourceId: intercomResourceId,
          droppedFrom: label,
        });
      }
    }

    for (const [email, contactId] of Object.entries(
      data.intercomContactsByEmail ?? {}
    )) {
      const normalizedEmail = email.toLowerCase();
      const existingSource = contactSources.get(normalizedEmail);
      if (!existingSource) {
        merged.intercomContactsByEmail[normalizedEmail] = contactId;
        contactSources.set(normalizedEmail, filePath);
        continue;
      }

      if (merged.intercomContactsByEmail[normalizedEmail] === contactId) {
        continue;
      }

      contactConflicts += 1;
      const incomingWins =
        (rank.get(filePath) ?? Number.MAX_SAFE_INTEGER) <
        (rank.get(existingSource) ?? Number.MAX_SAFE_INTEGER);
      if (incomingWins) {
        merged.intercomContactsByEmail[normalizedEmail] = contactId;
        contactSources.set(normalizedEmail, filePath);
      }
    }
  }

  merged.migratedCount = Object.keys(merged.migratedConversations).length;
  merged.startedAt = earliestStartedAt ?? now;
  return { merged, conflicts, contactConflicts };
}

function writeCheckpoint(filePath: string, data: MigrationCheckpointData): void {
  const folder = path.dirname(filePath);
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }

  const tempFilePath = `${filePath}.tmp`;
  fs.writeFileSync(tempFilePath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempFilePath, filePath);
}

function main(): void {
  let options: MergeOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}\n`);
    printUsage();
    process.exit(1);
    return;
  }

  if (!options.dryRun && !options.force && fs.existsSync(options.outFile)) {
    console.error(
      `Error: ${options.outFile} already exists. Pass --force to overwrite.`
    );
    process.exit(1);
    return;
  }

  const { merged, conflicts, contactConflicts } = mergeCheckpoints(options);

  for (const filePath of options.inputFiles) {
    const data = readCheckpoint(filePath);
    console.log(
      `  ${path.basename(filePath).padEnd(32)} conversations=${String(
        Object.keys(data.migratedConversations ?? {}).length
      ).padStart(6)} contacts=${String(
        Object.keys(data.intercomContactsByEmail ?? {}).length
      ).padStart(6)}`
    );
  }

  console.log(
    `\nMerged: conversations=${merged.migratedCount} contacts=${
      Object.keys(merged.intercomContactsByEmail).length
    } skipped=${merged.skippedCount} failed=${merged.failedCount}`
  );

  if (conflicts.length > 0) {
    console.log(
      `\n${conflicts.length} conversation id conflict(s) — these Groove tickets were migrated more than once, so a duplicate exists in Intercom:`
    );
    for (const conflict of conflicts) {
      console.log(
        `  groove ${conflict.grooveConversationId}: kept ${conflict.keptIntercomResourceId} (${conflict.keptFrom}), dropped ${conflict.droppedIntercomResourceId} (${conflict.droppedFrom})`
      );
    }
    console.log(
      "\nThe dropped Intercom conversations are no longer referenced by the merged checkpoint and will not be reconciled by future runs. Delete them in Intercom (see cleanup:intercom-conversations) if they are unwanted duplicates."
    );
  }

  if (contactConflicts > 0) {
    console.log(
      `\n${contactConflicts} contact email conflict(s) resolved by preference order.`
    );
  }

  if (options.dryRun) {
    console.log("\nDry run: no file written.");
    return;
  }

  writeCheckpoint(options.outFile, merged);
  console.log(`\nWrote ${options.outFile}. Input files were left unchanged.`);
}

// Only auto-run when executed directly; guards against tooling that
// `require()`s every .js file in a directory (e.g. `node --test dist`)
// accidentally triggering this script's writes as an import side-effect.
if (require.main === module) {
  main();
}
