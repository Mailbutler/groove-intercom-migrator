import fs from "node:fs";
import path from "node:path";
import { MigrationCheckpointData } from "./types";

const CHECKPOINT_VERSION = 1;

function createEmptyCheckpoint(now = new Date()): MigrationCheckpointData {
  const iso = now.toISOString();
  return {
    version: CHECKPOINT_VERSION,
    cursor: undefined,
    page: 1,
    windowUntil: undefined,
    migratedConversations: {},
    intercomContactsByEmail: {},
    migratedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    startedAt: iso,
    updatedAt: iso,
  };
}

export class CheckpointStore {
  private data: MigrationCheckpointData;

  constructor(private readonly filePath: string) {
    this.data = createEmptyCheckpoint();
  }

  load(): MigrationCheckpointData {
    if (!fs.existsSync(this.filePath)) {
      this.data = createEmptyCheckpoint();
      return this.data;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as MigrationCheckpointData;
    if (parsed.version !== CHECKPOINT_VERSION) {
      throw new Error(
        `Unsupported checkpoint version ${parsed.version}. Expected ${CHECKPOINT_VERSION}.`
      );
    }
    parsed.intercomContactsByEmail ??= {};
    this.data = parsed;
    return this.data;
  }

  getSnapshot(): MigrationCheckpointData {
    return this.data;
  }

  hasMigrated(grooveConversationId: string): boolean {
    return Boolean(this.data.migratedConversations[grooveConversationId]);
  }

  getMigratedIntercomResourceId(grooveConversationId: string): string | undefined {
    return this.data.migratedConversations[grooveConversationId];
  }

  setMigratedIntercomResourceId(
    grooveConversationId: string,
    intercomResourceId: string
  ): void {
    const existing = this.data.migratedConversations[grooveConversationId];
    if (existing === intercomResourceId) {
      return;
    }
    if (!existing) {
      this.data.migratedCount += 1;
    }
    this.data.migratedConversations[grooveConversationId] = intercomResourceId;
    this.touch();
  }

  markMigrated(grooveConversationId: string, intercomResourceId: string): void {
    this.setMigratedIntercomResourceId(grooveConversationId, intercomResourceId);
  }

  /**
   * Removes a conversation from the migrated map so a subsequent run treats it
   * as not-yet-migrated (used for backfill/re-migration workflows). Returns
   * true if an entry was actually removed.
   */
  unmarkMigrated(grooveConversationId: string): boolean {
    const existing = this.data.migratedConversations[grooveConversationId];
    if (!existing) {
      return false;
    }
    delete this.data.migratedConversations[grooveConversationId];
    this.data.migratedCount = Math.max(0, this.data.migratedCount - 1);
    this.touch();
    return true;
  }

  getCachedIntercomContactId(email: string): string | undefined {
    return this.data.intercomContactsByEmail[email.toLowerCase()];
  }

  cacheIntercomContact(email: string, intercomContactId: string): void {
    const normalizedEmail = email.toLowerCase();
    if (this.data.intercomContactsByEmail[normalizedEmail] === intercomContactId) {
      return;
    }
    this.data.intercomContactsByEmail[normalizedEmail] = intercomContactId;
    this.touch();
  }

  markSkipped(): void {
    this.data.skippedCount += 1;
    this.touch();
  }

  markFailed(): void {
    this.data.failedCount += 1;
    this.touch();
  }

  setPagination(nextCursor?: string, nextPage?: number): void {
    this.data.cursor = nextCursor;
    if (nextPage) {
      this.data.page = nextPage;
    }
    this.touch();
  }

  setWindowUntil(nextWindowUntil?: Date): void {
    this.data.windowUntil = nextWindowUntil?.toISOString();
    this.touch();
  }

  save(): void {
    const folder = path.dirname(this.filePath);
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }

    const tempFilePath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempFilePath, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tempFilePath, this.filePath);
  }

  private touch(): void {
    this.data.updatedAt = new Date().toISOString();
  }
}
