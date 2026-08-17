import pLimit from "p-limit";
import { Logger } from "pino";
import { CheckpointStore } from "./checkpoint-store";
import { GrooveClient } from "./groove-client";
import { IntercomClient } from "./intercom-client";
import { MigrationConfig } from "./types";
import { normalizeConversation } from "./transform";

function extractConversationId(rawConversation: unknown): string {
  if (!rawConversation || typeof rawConversation !== "object") {
    throw new Error("Invalid Groove conversation payload (not an object).");
  }
  const source = rawConversation as Record<string, unknown>;
  const id = source.id ?? source.uuid;
  if (!id || (typeof id !== "string" && typeof id !== "number")) {
    throw new Error("Groove conversation does not contain id/uuid.");
  }
  return String(id);
}

export async function runMigration(
  config: MigrationConfig,
  logger: Logger
): Promise<void> {
  const grooveClient = new GrooveClient(config.grooveApiBaseUrl, config.grooveApiToken);
  const checkpoint = new CheckpointStore(config.checkpointFile);
  const snapshot = checkpoint.load();
  const intercomClient = new IntercomClient(
    config.intercomApiBaseUrl,
    config.intercomAccessToken,
    config.intercomAdminId,
    {
      getCachedContactId: (email) => checkpoint.getCachedIntercomContactId(email),
      cacheContactId: (email, intercomContactId) =>
        checkpoint.cacheIntercomContact(email, intercomContactId),
    }
  );

  logger.info(
    {
      checkpointFile: config.checkpointFile,
      migratedCount: snapshot.migratedCount,
      failedCount: snapshot.failedCount,
      skippedCount: snapshot.skippedCount,
      cachedContactCount: Object.keys(snapshot.intercomContactsByEmail).length,
    },
    "Loaded checkpoint"
  );

  const limiter = pLimit(config.concurrency);
  let page = snapshot.page ?? 1;
  let cursor = snapshot.cursor;
  let hasMore = true;

  while (hasMore) {
    const listResponse = await grooveClient.listConversations({
      since: config.since,
      until: config.until,
      page,
      cursor,
      perPage: config.perPage,
    });

    if (listResponse.items.length === 0) {
      logger.info("No more conversations returned by Groove.");
      break;
    }

    logger.info(
      {
        batchSize: listResponse.items.length,
        page,
        cursor,
      },
      "Processing batch"
    );

    const tasks = listResponse.items.map((rawConversation) =>
      limiter(async () => {
        const grooveConversationId = extractConversationId(rawConversation);

        if (checkpoint.hasMigrated(grooveConversationId)) {
          checkpoint.markSkipped();
          return;
        }

        try {
          const rawMessages =
            ((rawConversation as Record<string, unknown>).messages as unknown[]) ??
            (await grooveClient.listConversationMessages(grooveConversationId));

          const conversation = normalizeConversation(rawConversation, rawMessages);
          if (config.dryRun) {
            logger.info(
              {
                grooveConversationId,
                requester: conversation.requester.email,
                messageCount: conversation.messages.length,
              },
              "Dry run: validated conversation for migration"
            );
            checkpoint.markSkipped();
            return;
          }

          const targetResource = await intercomClient.importConversation(
            conversation,
            config.migrationMode
          );
          checkpoint.markMigrated(grooveConversationId, targetResource);
          logger.info(
            { grooveConversationId, targetResource },
            "Migrated conversation successfully"
          );
        } catch (error) {
          checkpoint.markFailed();
          logger.error(
            {
              grooveConversationId,
              err: error,
            },
            "Failed to migrate conversation"
          );
        }
      })
    );

    await Promise.all(tasks);

    cursor = listResponse.nextCursor;
    page = listResponse.nextPage ?? page + 1;
    checkpoint.setPagination(cursor, page);
    checkpoint.save();

    hasMore = Boolean(cursor) || listResponse.items.length >= config.perPage;
  }

  checkpoint.save();
  const finalSnapshot = checkpoint.getSnapshot();
  logger.info(
    {
      migratedCount: finalSnapshot.migratedCount,
      skippedCount: finalSnapshot.skippedCount,
      failedCount: finalSnapshot.failedCount,
      updatedAt: finalSnapshot.updatedAt,
    },
    "Migration run completed"
  );
}
