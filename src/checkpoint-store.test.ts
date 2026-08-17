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
});
