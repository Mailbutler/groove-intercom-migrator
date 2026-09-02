import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CheckpointStore } from "./checkpoint-store";

test("CheckpointStore saves and loads migrated IDs", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
  const checkpointFile = path.join(folder, "checkpoint.json");
  const store = new CheckpointStore(checkpointFile);

  store.load();
  store.markMigrated("g_1", "i_1");
  store.cacheIntercomContact("customer@example.com", "contact_123");
  store.setWindowUntil(new Date("2026-08-01T00:00:00.000Z"));
  store.setPagination("cursor_2", 3);
  store.save();

  const loaded = new CheckpointStore(checkpointFile).load();
  assert.equal(loaded.migratedConversations.g_1, "i_1");
  assert.equal(
    loaded.intercomContactsByEmail["customer@example.com"],
    "contact_123"
  );
  assert.equal(loaded.cursor, "cursor_2");
  assert.equal(loaded.page, 3);
  assert.equal(loaded.windowUntil, "2026-08-01T00:00:00.000Z");
});

test("CheckpointStore unmarkMigrated clears an entry and decrements the count", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
  const checkpointFile = path.join(folder, "checkpoint.json");
  const store = new CheckpointStore(checkpointFile);

  store.load();
  store.markMigrated("g_1", "conversation:i_1");
  store.markMigrated("g_2", "conversation:i_2");
  assert.equal(store.getSnapshot().migratedCount, 2);

  const removed = store.unmarkMigrated("g_1");
  assert.equal(removed, true);
  assert.equal(store.hasMigrated("g_1"), false);
  assert.equal(store.hasMigrated("g_2"), true);
  assert.equal(store.getSnapshot().migratedCount, 1);

  const removedAgain = store.unmarkMigrated("g_1");
  assert.equal(removedAgain, false);
  assert.equal(store.getSnapshot().migratedCount, 1);
});
