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
  perPage?: string;
  concurrency?: string;
  checkpointFile?: string;
  mode?: MigrationMode;
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
    .option("--per-page <number>", "Groove page size override")
    .option("--concurrency <number>", "Number of concurrent conversation migrations")
    .option("--checkpoint-file <path>", "Path to checkpoint file")
    .option(
      "--mode <mode>",
      "Migration mode: intercom-conversation | contact-note"
    )
    .option("--log-level <level>", "debug | info | warn | error")
    .parse(process.argv);

  const args = program.opts<CliArgs>();
  const config = loadConfig({
    since: args.since,
    until: args.until,
    dryRun: args.dryRun,
    perPage: args.perPage ? Number(args.perPage) : undefined,
    concurrency: args.concurrency ? Number(args.concurrency) : undefined,
    checkpointFile: args.checkpointFile,
    mode: args.mode,
    logLevel: args.logLevel,
  });

  const logger = createLogger(config.logLevel);
  logger.info(
    {
      since: config.since.toISOString(),
      until: config.until?.toISOString(),
      perPage: config.perPage,
      concurrency: config.concurrency,
      dryRun: config.dryRun,
      migrationMode: config.migrationMode,
      strictAgentMapping: config.strictAgentMapping,
      checkpointFile: config.checkpointFile,
    },
    "Starting migration"
  );

  await runMigration(config, logger);
}

main().catch((error) => {
  // Explicitly fail process to surface migration issues in CI/automation.
  console.error(error);
  process.exitCode = 1;
});
