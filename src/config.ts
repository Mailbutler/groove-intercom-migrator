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
  INTERCOM_ADMIN_ID: z.string().optional(),
  MIGRATION_SINCE: z.string().optional(),
  MIGRATION_UNTIL: z.string().optional(),
  MIGRATION_PER_PAGE: z.coerce.number().int().min(1).max(250).default(50),
  MIGRATION_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
  MIGRATION_DRY_RUN: z
    .string()
    .optional()
    .transform((value) => value === "1" || value === "true"),
  MIGRATION_MODE: z
    .enum(["intercom-conversation", "contact-note"])
    .default("intercom-conversation"),
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
  logLevel?: "debug" | "info" | "warn" | "error";
}

export function loadConfig(overrides: CliOverrides): MigrationConfig {
  const parsed = schema.parse(process.env);
  const now = new Date();
  const defaultSince = new Date(now);
  defaultSince.setFullYear(defaultSince.getFullYear() - 1);

  const since =
    parseDateInput(overrides.since) ??
    parseDateInput(parsed.MIGRATION_SINCE) ??
    defaultSince;

  const until =
    parseDateInput(overrides.until) ?? parseDateInput(parsed.MIGRATION_UNTIL);

  if (until && since > until) {
    throw new Error("MIGRATION_SINCE cannot be after MIGRATION_UNTIL");
  }

  const perPageOverride =
    overrides.perPage !== undefined
      ? z.number().int().min(1).max(250).parse(overrides.perPage)
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

  return {
    grooveApiBaseUrl: parsed.GROOVE_API_BASE_URL.replace(/\/+$/, ""),
    grooveApiToken: parsed.GROOVE_API_TOKEN,
    intercomApiBaseUrl: parsed.INTERCOM_API_BASE_URL.replace(/\/+$/, ""),
    intercomAccessToken: parsed.INTERCOM_ACCESS_TOKEN,
    intercomAdminId: parsed.INTERCOM_ADMIN_ID,
    since,
    until,
    perPage: perPageOverride ?? parsed.MIGRATION_PER_PAGE,
    concurrency: concurrencyOverride ?? parsed.MIGRATION_CONCURRENCY,
    dryRun: overrides.dryRun ?? parsed.MIGRATION_DRY_RUN ?? false,
    migrationMode: modeOverride ?? parsed.MIGRATION_MODE,
    checkpointFile:
      overrides.checkpointFile ?? parsed.MIGRATION_CHECKPOINT_FILE,
    logLevel: overrides.logLevel ?? parsed.LOG_LEVEL,
  };
}
