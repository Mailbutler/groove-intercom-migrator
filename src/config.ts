import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { MigrationConfig, MigrationMode } from "./types";

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
  MIGRATION_DRY_RUN: z
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
    dryRun: overrides.dryRun ?? parsed.MIGRATION_DRY_RUN ?? false,
    migrationMode: modeOverride ?? parsed.MIGRATION_MODE,
    strictAgentMapping: parsed.MIGRATION_STRICT_AGENT_MAPPING ?? false,
    checkpointFile:
      overrides.checkpointFile ?? parsed.MIGRATION_CHECKPOINT_FILE,
    logLevel: overrides.logLevel ?? parsed.LOG_LEVEL,
  };
}
