import pLimit from "p-limit";
import { Logger } from "pino";
import { CheckpointStore } from "./checkpoint-store";
import { GrooveClient } from "./groove-client";
import { IntercomClient } from "./intercom-client";
import { loadGrooveJiraIssueMap } from "./jira-map";
import { MigrationConfig } from "./types";
import { normalizeConversation } from "./transform";

const GROOVE_REST_MAX_PAGE = 10;

function extractConversationId(rawConversation: unknown): string {
  if (!rawConversation || typeof rawConversation !== "object") {
    throw new Error("Invalid Groove conversation payload (not an object).");
  }
  const source = rawConversation as Record<string, unknown>;
  const id = source.id ?? source.uuid ?? source.number;
  if (!id || (typeof id !== "string" && typeof id !== "number")) {
    throw new Error("Groove conversation does not contain id/uuid/number.");
  }
  return String(id);
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isWithinDateWindow(
  rawConversation: unknown,
  since?: Date,
  until?: Date
): boolean {
  if (!rawConversation || typeof rawConversation !== "object") {
    return false;
  }
  const source = rawConversation as Record<string, unknown>;
  const updatedAt =
    parseDate(source.updated_at) ??
    parseDate(source.last_message_at) ??
    parseDate(source.created_at);
  if (!updatedAt) {
    return true;
  }
  if (since && updatedAt < since) {
    return false;
  }
  if (until && updatedAt > until) {
    return false;
  }
  return true;
}

function extractWindowBoundaryDate(rawConversation: unknown): Date | undefined {
  if (!rawConversation || typeof rawConversation !== "object") {
    return undefined;
  }
  const source = rawConversation as Record<string, unknown>;
  return (
    parseDate(source.created_at) ??
    parseDate(source.updated_at) ??
    parseDate(source.last_message_at)
  );
}

function extractCustomerHref(rawConversation: unknown): string | undefined {
  const source = asObject(rawConversation);
  const links = asObject(source?.links);
  const customerLink = asObject(links?.customer);
  const customerHref = customerLink?.href;
  if (typeof customerHref !== "string" || customerHref.trim().length === 0) {
    return undefined;
  }
  return customerHref;
}

function extractGrooveConversationStatus(rawConversation: unknown): string | undefined {
  const source = asObject(rawConversation);
  const status = source?.status ?? source?.state;
  if (typeof status === "string") {
    const normalizedStatus = status.trim();
    if (normalizedStatus.length > 0) {
      return normalizedStatus;
    }
  }

  const closedFlag = source?.closed;
  if (typeof closedFlag === "boolean") {
    return closedFlag ? "closed" : "open";
  }

  if (
    parseDate(source?.closed_at) ||
    parseDate(source?.resolved_at) ||
    parseDate(source?.closedAt) ||
    parseDate(source?.resolvedAt)
  ) {
    return "closed";
  }

  return undefined;
}

function isSpamConversationStatus(status?: string): boolean {
  return typeof status === "string" && status.trim().toLowerCase() === "spam";
}

function extractGrooveConversationTags(rawConversation: unknown): string[] {
  const source = asObject(rawConversation);
  const tagsRaw = source?.tags;
  if (!Array.isArray(tagsRaw)) {
    return [];
  }
  return tagsRaw
    .map((tag) => {
      if (typeof tag === "string") {
        return tag;
      }
      if (tag && typeof tag === "object") {
        const tagSource = tag as Record<string, unknown>;
        const tagName = tagSource.name ?? tagSource.id;
        if (typeof tagName === "string") {
          return tagName;
        }
      }
      return "";
    })
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export async function runMigration(
  config: MigrationConfig,
  logger: Logger
): Promise<void> {
  const grooveClient = new GrooveClient(config.grooveApiBaseUrl, config.grooveApiToken);
  const checkpoint = new CheckpointStore(config.checkpointFile);
  const snapshot = checkpoint.load();
  const grooveJiraIssueMap = loadGrooveJiraIssueMap(config.jiraMapFile);
  const intercomClient = new IntercomClient(
    config.intercomApiBaseUrl,
    config.intercomAccessToken,
    config.intercomFallbackAgentId,
    {
      getCachedContactId: (email) => checkpoint.getCachedIntercomContactId(email),
      cacheContactId: (email, intercomContactId) =>
        checkpoint.cacheIntercomContact(email, intercomContactId),
    },
    {
      strictAgentMapping: config.strictAgentMapping,
      jiraIssueAttributeName: config.intercomJiraAttributeName,
    },
    logger
  );

  logger.info(
    {
      checkpointFile: config.checkpointFile,
      migratedCount: snapshot.migratedCount,
      failedCount: snapshot.failedCount,
      skippedCount: snapshot.skippedCount,
      cachedContactCount: Object.keys(snapshot.intercomContactsByEmail).length,
      jiraMappedTicketCount: grooveJiraIssueMap.size,
    },
    "Loaded checkpoint"
  );

  const limiter = pLimit(config.concurrency);
  let page = snapshot.page ?? 1;
  let cursor = snapshot.cursor;
  let windowUntil = parseDate(snapshot.windowUntil) ?? config.until;
  let autoWindowShiftCount = 0;
  let retriedFromInitialWindow = false;

  if (page > GROOVE_REST_MAX_PAGE) {
    logger.warn(
      {
        checkpointPage: page,
        maxPage: GROOVE_REST_MAX_PAGE,
      },
      "Checkpoint page exceeds Groove REST limit; resetting pagination to page 1."
    );
    page = 1;
    cursor = undefined;
    checkpoint.setWindowUntil(windowUntil);
    checkpoint.setPagination(undefined, 1);
    checkpoint.save();
  }

  let hasMore = true;

  while (hasMore) {
    const listResponse = await grooveClient.listConversations({
      since: config.since,
      until: windowUntil,
      page,
      cursor,
      perPage: config.perPage,
    });

    if (listResponse.items.length === 0) {
      if (
        !retriedFromInitialWindow &&
        (cursor !== undefined || page !== 1 || snapshot.windowUntil !== undefined)
      ) {
        logger.warn(
          {
            checkpointPage: page,
            checkpointCursor: cursor,
            checkpointWindowUntil: snapshot.windowUntil,
            resetWindowUntil: config.until?.toISOString(),
          },
          "Checkpoint pagination appears exhausted; resetting to initial window for full re-scan."
        );
        retriedFromInitialWindow = true;
        cursor = undefined;
        page = 1;
        windowUntil = config.until;
        checkpoint.setWindowUntil(windowUntil);
        checkpoint.setPagination(undefined, 1);
        checkpoint.save();
        continue;
      }
      logger.info("No more conversations returned by Groove.");
      break;
    }

    logger.info(
      {
        batchSize: listResponse.items.length,
        page,
        cursor,
        windowUntil: windowUntil?.toISOString(),
      },
      "Processing batch"
    );

    let oldestBatchDate: Date | undefined;
    const tasks = listResponse.items.map((rawConversation) =>
      (() => {
        const boundaryDate = extractWindowBoundaryDate(rawConversation);
        if (boundaryDate && (!oldestBatchDate || boundaryDate < oldestBatchDate)) {
          oldestBatchDate = boundaryDate;
        }

        return limiter(async () => {
          const grooveConversationId = extractConversationId(rawConversation);

          if (!isWithinDateWindow(rawConversation, config.since, config.until)) {
            checkpoint.markSkipped();
            return;
          }

          try {
            const grooveStatus = extractGrooveConversationStatus(rawConversation);
            if (isSpamConversationStatus(grooveStatus)) {
              checkpoint.markSkipped();
              logger.debug(
                { grooveConversationId, grooveStatus },
                "Skipping Groove conversation with spam status"
              );
              return;
            }

            const existingIntercomResourceId =
              checkpoint.getMigratedIntercomResourceId(grooveConversationId);
            if (existingIntercomResourceId) {
              if (!config.dryRun) {
                let staleConversationMapping = false;
                try {
                  await intercomClient.syncConversationState(
                    existingIntercomResourceId,
                    grooveStatus
                  );
                  await intercomClient.syncConversationTags(
                    existingIntercomResourceId,
                    extractGrooveConversationTags(rawConversation)
                  );
                  await intercomClient.syncConversationJiraIssues(
                    existingIntercomResourceId,
                    grooveJiraIssueMap.get(grooveConversationId) ?? []
                  );
                } catch (error) {
                  if (
                    !intercomClient.isConversationNotFoundError(
                      error,
                      existingIntercomResourceId
                    )
                  ) {
                    throw error;
                  }
                  staleConversationMapping = true;
                  logger.warn(
                    {
                      grooveConversationId,
                      staleIntercomResourceId: existingIntercomResourceId,
                    },
                    "Checkpoint conversation id not found in Intercom; recreating conversation."
                  );
                }
                if (!staleConversationMapping) {
                  checkpoint.markSkipped();
                  return;
                }
              } else {
                checkpoint.markSkipped();
                return;
              }
            }

            const rawMessages =
              await grooveClient.listConversationMessages(grooveConversationId);
            const inlineMessages = (rawConversation as Record<string, unknown>)
              .messages as unknown[] | undefined;
            const normalizedRawMessages =
              rawMessages.length > 0 ? rawMessages : (inlineMessages ?? []);

            const conversation = normalizeConversation(
              rawConversation,
              normalizedRawMessages
            );
            conversation.jiraIssueKeys =
              grooveJiraIssueMap.get(grooveConversationId) ?? [];
            if (!conversation.requester.email) {
              const customerHref = extractCustomerHref(rawConversation);
              if (customerHref) {
                const customerProfile =
                  await grooveClient.getCustomerByHref(customerHref);
                if (customerProfile.email) {
                  conversation.requester.email = customerProfile.email;
                  conversation.requester.id ??= customerProfile.id;
                  conversation.requester.name ??= customerProfile.name;
                }
              }
            }
            if (!conversation.requester.email) {
              const customerHref = extractCustomerHref(rawConversation);
              logger.warn(
                {
                  grooveConversationId,
                  customerHref,
                  normalizedRequester: conversation.requester,
                },
                "Requester email missing after normalization"
              );
            }
            if (config.dryRun) {
              logger.info(
                {
                  grooveConversationId,
                  requester: conversation.requester.email,
                  messageCount: conversation.messages.length,
                  jiraIssueKeys: conversation.jiraIssueKeys,
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
            checkpoint.setMigratedIntercomResourceId(
              grooveConversationId,
              targetResource
            );
            await intercomClient.syncConversationState(
              targetResource,
              grooveStatus ?? conversation.status
            );
            await intercomClient.syncConversationTags(targetResource, conversation.tags);
            await intercomClient.syncConversationJiraIssues(
              targetResource,
              conversation.jiraIssueKeys
            );
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
        });
      })()
    );

    await Promise.all(tasks);

    const reachedRestPageLimit =
      !listResponse.nextCursor &&
      page >= GROOVE_REST_MAX_PAGE &&
      listResponse.items.length >= config.perPage;

    if (reachedRestPageLimit) {
      if (!oldestBatchDate) {
        throw new Error(
          "Reached Groove REST page limit but could not determine an oldest ticket date for auto-windowing."
        );
      }

      let nextWindowUntilMs = oldestBatchDate.getTime() - 1;
      if (windowUntil && nextWindowUntilMs >= windowUntil.getTime()) {
        nextWindowUntilMs = windowUntil.getTime() - 1;
      }

      if (config.since && nextWindowUntilMs < config.since.getTime()) {
        logger.info(
          { nextWindowUntil: new Date(nextWindowUntilMs).toISOString() },
          "Reached lower date boundary after auto-windowing."
        );
        break;
      }

      const nextWindowUntil = new Date(nextWindowUntilMs);
      logger.warn(
        {
          page,
          perPage: config.perPage,
          currentWindowUntil: windowUntil?.toISOString(),
          nextWindowUntil: nextWindowUntil.toISOString(),
        },
        "Reached Groove REST page limit; shifting to an older created_before window."
      );

      windowUntil = nextWindowUntil;
      autoWindowShiftCount += 1;
      cursor = undefined;
      page = 1;
      checkpoint.setWindowUntil(windowUntil);
      checkpoint.setPagination(undefined, 1);
      checkpoint.save();
      continue;
    }

    cursor = listResponse.nextCursor;
    page = listResponse.nextPage ?? page + 1;
    checkpoint.setWindowUntil(windowUntil);
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
      autoWindowShiftCount,
      updatedAt: finalSnapshot.updatedAt,
    },
    "Migration run completed"
  );
}
