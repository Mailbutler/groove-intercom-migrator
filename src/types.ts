export type MigrationMode = "intercom-conversation" | "contact-note";

export interface PersonRef {
  id?: string;
  email?: string;
  name?: string;
}

export interface NormalizedAttachment {
  id: string;
  fileName?: string;
  url?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface NormalizedMessage {
  id: string;
  createdAt: Date;
  body: string;
  bodyFormat: "html" | "plain";
  author: PersonRef;
  isAgentMessage: boolean;
  attachments: NormalizedAttachment[];
}

export interface NormalizedConversation {
  id: string;
  subject: string;
  createdAt: Date;
  updatedAt: Date;
  status?: string;
  tags: string[];
  assignee?: PersonRef;
  requester: PersonRef;
  mailbox?: string;
  messages: NormalizedMessage[];
  sourceUrl?: string;
}

export interface GrooveListResponse {
  items: unknown[];
  nextCursor?: string;
  nextPage?: number;
}

export interface GrooveListOptions {
  since?: Date;
  until?: Date;
  page?: number;
  cursor?: string;
  perPage: number;
}

export interface MigrationConfig {
  grooveApiBaseUrl: string;
  grooveApiToken: string;
  intercomApiBaseUrl: string;
  intercomAccessToken: string;
  intercomFallbackAgentId?: string;
  since?: Date;
  until?: Date;
  perPage: number;
  concurrency: number;
  dryRun: boolean;
  migrationMode: MigrationMode;
  strictAgentMapping: boolean;
  checkpointFile: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export interface MigrationCheckpointData {
  version: number;
  cursor?: string;
  page?: number;
  windowUntil?: string;
  migratedConversations: Record<string, string>;
  intercomContactsByEmail: Record<string, string>;
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  startedAt: string;
  updatedAt: string;
}
