import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { MigrationConfig, MigrationMode } from "./types";

function parseBoolFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * Determines whether a migration run should be dry-run (safe, no writes).
 * Defaults to `true` (dry-run) unless the caller has explicitly opted into
 * a live run via `--live`/`MIGRATION_LIVE` or explicitly disabled dry-run
 * via `--dry-run=false`/`MIGRATION_DRY_RUN=false`.
 */
function computeDryRun(
  overrides: CliOverrides,
  parsed: { MIGRATION_DRY_RUN?: string; MIGRATION_LIVE: boolean },
): boolean {
  if (overrides.dryRun !== undefined) {
    return overrides.dryRun;
  }
  if (overrides.live !== undefined) {
    return !overrides.live;
  }
  const envDryRun = parseBoolFlag(parsed.MIGRATION_DRY_RUN);
  if (envDryRun !== undefined) {
    return envDryRun;
  }
  if (parsed.MIGRATION_LIVE) {
    return false;
  }
  return true;
}

function parseDateInput(input: string | undefined): Date | undefined {
  if (!input) {
    return undefined;
  }
  const value = new Date(input);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid date provided: ${input}`);
  }
  return value;
}

const schema = z.object({
  GROOVE_API_BASE_URL: z.string().url().default("https://api.groovehq.com/v1"),
  GROOVE_API_TOKEN: z.string().min(1),
  INTERCOM_API_BASE_URL: z.string().url().default("https://api.intercom.io"),
  INTERCOM_ACCESS_TOKEN: z.string().min(1),
  INTERCOM_FALLBACK_AGENT_ID: z.string().optional(),
  INTERCOM_JIRA_ATTRIBUTE_NAME: z.string().trim().min(1).default("jira_issue_key"),
  JIRA_GROOVE_MAP_FILE: z.string().optional(),
  MIGRATION_SINCE: z.string().optional(),
  MIGRATION_UNTIL: z.string().optional(),
  MIGRATION_PER_PAGE: z.coerce.number().int().min(1).max(50).default(50),
  MIGRATION_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  // Kept as string | undefined (not coerced to boolean) so we can tell
  // "unset" apart from "explicitly false" when computing the safe default.
  MIGRATION_DRY_RUN: z.string().optional(),
  // Migrations write live to Intercom/Groove by default ONLY when this is
  // explicitly set. Absence (e.g. a stray `.env`, or the entrypoint being
  // invoked unexpectedly) now fails safe into dry-run rather than silently
  // performing real writes.
  MIGRATION_LIVE: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  MIGRATION_MODE: z
    .enum(["intercom-conversation", "contact-note"])
    .default("intercom-conversation"),
  MIGRATION_STRICT_AGENT_MAPPING: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  MIGRATION_CHECKPOINT_FILE: z
    .string()
    .default(path.resolve(process.cwd(), "checkpoint.json")),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface CliOverrides {
  since?: string;
  until?: string;
  dryRun?: boolean;
  live?: boolean;
  perPage?: number;
  concurrency?: number;
  checkpointFile?: string;
  mode?: MigrationMode;
  jiraMapFile?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
}

export function loadConfig(overrides: CliOverrides): MigrationConfig {
  const parsed = schema.parse(process.env);

  const since =
    parseDateInput(overrides.since) ??
    parseDateInput(parsed.MIGRATION_SINCE);

  const until =
    parseDateInput(overrides.until) ?? parseDateInput(parsed.MIGRATION_UNTIL);

  if (since && until && since > until) {
    throw new Error("MIGRATION_SINCE cannot be after MIGRATION_UNTIL");
  }

  const perPageOverride =
    overrides.perPage !== undefined
      ? z.number().int().min(1).max(50).parse(overrides.perPage)
      : undefined;
  const concurrencyOverride =
    overrides.concurrency !== undefined
      ? z.number().int().min(1).max(20).parse(overrides.concurrency)
      : undefined;
  const modeOverride =
    overrides.mode !== undefined
      ? z
          .enum(["intercom-conversation", "contact-note"])
          .parse(overrides.mode)
      : undefined;
  const jiraMapFile = overrides.jiraMapFile ?? parsed.JIRA_GROOVE_MAP_FILE;

  return {
    grooveApiBaseUrl: parsed.GROOVE_API_BASE_URL.replace(/\/+$/, ""),
    grooveApiToken: parsed.GROOVE_API_TOKEN,
    intercomApiBaseUrl: parsed.INTERCOM_API_BASE_URL.replace(/\/+$/, ""),
    intercomAccessToken: parsed.INTERCOM_ACCESS_TOKEN,
    intercomFallbackAgentId: parsed.INTERCOM_FALLBACK_AGENT_ID,
    intercomJiraAttributeName: parsed.INTERCOM_JIRA_ATTRIBUTE_NAME,
    jiraMapFile: jiraMapFile ? path.resolve(process.cwd(), jiraMapFile) : undefined,
    since,
    until,
    perPage: perPageOverride ?? parsed.MIGRATION_PER_PAGE,
    concurrency: concurrencyOverride ?? parsed.MIGRATION_CONCURRENCY,
    // Fail safe: dry-run unless the caller explicitly opts into a live run
    // via `--live` / `MIGRATION_LIVE=1`, or explicitly disables dry-run via
    // `--dry-run=false` / `MIGRATION_DRY_RUN=false`. Simply not setting
    // anything (e.g. an unexpected invocation, missing flags) now never
    // performs live writes.
    dryRun: computeDryRun(overrides, parsed),
    migrationMode: modeOverride ?? parsed.MIGRATION_MODE,
    strictAgentMapping: parsed.MIGRATION_STRICT_AGENT_MAPPING ?? false,
    checkpointFile:
      overrides.checkpointFile ?? parsed.MIGRATION_CHECKPOINT_FILE,
    logLevel: overrides.logLevel ?? parsed.LOG_LEVEL,
  };
}
