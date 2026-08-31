import fs from "node:fs";

export type GrooveJiraIssueMap = Map<string, string[]>;

const JIRA_ISSUE_KEY_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/g;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeGrooveTicketId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function normalizeJiraIssueKeys(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const keys = new Set<string>();

  for (const entry of values) {
    if (typeof entry !== "string") {
      continue;
    }
    const matches = entry.toUpperCase().match(JIRA_ISSUE_KEY_PATTERN);
    for (const match of matches ?? []) {
      keys.add(match);
    }
  }

  return Array.from(keys).sort();
}

function readEntryTicketId(entry: Record<string, unknown>): string | undefined {
  return normalizeGrooveTicketId(
    entry.grooveTicketId ??
      entry.groove_ticket_id ??
      entry.grooveId ??
      entry.groove_id ??
      entry.ticketId ??
      entry.ticket_id ??
      entry.id
  );
}

function readEntryIssueKeys(entry: Record<string, unknown>): string[] {
  return normalizeJiraIssueKeys(
    entry.jiraIssueKeys ??
      entry.jira_issue_keys ??
      entry.jiraIssues ??
      entry.jira_issues ??
      entry.issueKeys ??
      entry.issue_keys ??
      entry.keys ??
      entry.jiraIssueKey ??
      entry.jira_issue_key
  );
}

function addMapping(
  mappings: GrooveJiraIssueMap,
  grooveTicketId: string,
  jiraIssueKeys: string[]
): void {
  if (jiraIssueKeys.length === 0) {
    throw new Error(
      `Jira map entry for Groove ticket "${grooveTicketId}" does not contain any Jira issue keys.`
    );
  }

  const existing = mappings.get(grooveTicketId) ?? [];
  mappings.set(grooveTicketId, normalizeJiraIssueKeys([...existing, ...jiraIssueKeys]));
}

export function parseGrooveJiraIssueMap(raw: unknown): GrooveJiraIssueMap {
  const mappings: GrooveJiraIssueMap = new Map();

  if (Array.isArray(raw)) {
    for (const [index, entry] of raw.entries()) {
      const source = asRecord(entry);
      const grooveTicketId = readEntryTicketId(source);
      if (!grooveTicketId) {
        throw new Error(`Jira map entry at index ${index} is missing a Groove ticket id.`);
      }
      addMapping(mappings, grooveTicketId, readEntryIssueKeys(source));
    }
    return mappings;
  }

  const source = asRecord(raw);
  const entries = source.tickets ?? source.mappings;
  if (Array.isArray(entries)) {
    return parseGrooveJiraIssueMap(entries);
  }

  for (const [grooveTicketId, value] of Object.entries(source)) {
    if (grooveTicketId === "tickets" || grooveTicketId === "mappings") {
      continue;
    }
    const normalizedGrooveTicketId = normalizeGrooveTicketId(grooveTicketId);
    if (!normalizedGrooveTicketId) {
      throw new Error(`Jira map contains an invalid Groove ticket id: "${grooveTicketId}".`);
    }
    addMapping(mappings, normalizedGrooveTicketId, normalizeJiraIssueKeys(value));
  }

  return mappings;
}

export function loadGrooveJiraIssueMap(filePath?: string): GrooveJiraIssueMap {
  if (!filePath) {
    return new Map();
  }

  const contents = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(contents) as unknown;
  return parseGrooveJiraIssueMap(parsed);
}
