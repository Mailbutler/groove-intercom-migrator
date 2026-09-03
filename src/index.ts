#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { loadConfig } from "./config";
import { createLogger } from "./logger";
import { runMigration } from "./migration-runner";
import { MigrationMode } from "./types";

interface CliArgs {
  since?: string;
  until?: string;
  dryRun?: boolean;
  live?: boolean;
  perPage?: string;
  concurrency?: string;
  checkpointFile?: string;
  mode?: MigrationMode;
  jiraMapFile?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("groove-intercom-migrator")
    .description("Migrate historical Groove conversations to Intercom")
    .option("--since <isoDate>", "Only migrate records updated after this date")
    .option("--until <isoDate>", "Only migrate records updated before this date")
    .option("--dry-run", "Fetch and transform, but do not write to Intercom")
    .option(
      "--live",
      "Perform real writes to Intercom/Groove. Required to disable the default dry-run safety."
    )
    .option("--per-page <number>", "Groove page size override")
    .option("--concurrency <number>", "Number of concurrent conversation migrations")
    .option("--checkpoint-file <path>", "Path to checkpoint file")
    .option(
      "--mode <mode>",
      "Migration mode: intercom-conversation | contact-note"
    )
    .option("--jira-map-file <path>", "JSON map of Groove ticket IDs to Jira issue keys")
    .option("--log-level <level>", "debug | info | warn | error")
    .parse(process.argv);

  const args = program.opts<CliArgs>();
  const config = loadConfig({
    since: args.since,
    until: args.until,
    dryRun: args.dryRun,
    live: args.live,
    perPage: args.perPage ? Number(args.perPage) : undefined,
    concurrency: args.concurrency ? Number(args.concurrency) : undefined,
    checkpointFile: args.checkpointFile,
    mode: args.mode,
    jiraMapFile: args.jiraMapFile,
    logLevel: args.logLevel,
  });

  const logger = createLogger(config.logLevel);
  logger.info(
    {
      since: config.since?.toISOString(),
      until: config.until?.toISOString(),
      perPage: config.perPage,
      concurrency: config.concurrency,
      dryRun: config.dryRun,
      migrationMode: config.migrationMode,
      strictAgentMapping: config.strictAgentMapping,
      jiraMapFile: config.jiraMapFile,
      checkpointFile: config.checkpointFile,
    },
    "Starting migration"
  );

  await runMigration(config, logger);
}

// Only auto-run when this file is executed directly (e.g. `node dist/index.js`
// or the `groove-intercom-migrator` bin). Guards against tooling that
// `require()`s every .js file in a directory (e.g. `node --test dist`)
// accidentally triggering a live migration as an import side-effect.
if (require.main === module) {
  main().catch((error) => {
    // Explicitly fail process to surface migration issues in CI/automation.
    console.error(error);
    process.exitCode = 1;
  });
}
