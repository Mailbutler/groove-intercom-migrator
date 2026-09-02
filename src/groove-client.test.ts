import assert from "node:assert/strict";
import test from "node:test";
import { AxiosError } from "axios";
import { GrooveClient } from "./groove-client";

function createClient(): GrooveClient {
  return new GrooveClient("https://api.groovehq.com/v1", "test-token");
}

/**
 * Replaces the underlying axios `get` so the retry loop can be exercised
 * without real HTTP.
 */
function stubGet(
  client: GrooveClient,
  handler: () => Promise<{ data: unknown }>
): void {
  (client as unknown as { http: { get: unknown } }).http.get = handler;
}

test("GrooveClient retries network timeouts that carry no HTTP response", async () => {
  const client = createClient();
  let attempts = 0;

  stubGet(client, async () => {
    attempts += 1;
    if (attempts < 3) {
      // A timeout produces an AxiosError with no `response` at all.
      throw new AxiosError("timeout of 60000ms exceeded", "ECONNABORTED");
    }
    return { data: { tickets: [{ id: "1" }] } };
  });

  const result = await client.listConversations({ page: 1, perPage: 50 });

  assert.equal(attempts, 3);
  assert.equal(result.items.length, 1);
});

test("GrooveClient retries dropped connections", async () => {
  const client = createClient();
  let attempts = 0;

  stubGet(client, async () => {
    attempts += 1;
    if (attempts < 2) {
      throw new AxiosError("socket hang up", "ECONNRESET");
    }
    return { data: { tickets: [] } };
  });

  await client.listConversations({ page: 1, perPage: 50 });

  assert.equal(attempts, 2);
});

test("GrooveClient does not retry non-retryable HTTP errors", async () => {
  const client = createClient();
  let attempts = 0;

  stubGet(client, async () => {
    attempts += 1;
    throw new AxiosError("bad request", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 400,
      data: {},
    } as never);
  });

  await assert.rejects(() => client.listConversations({ page: 1, perPage: 50 }));
  assert.equal(attempts, 1, "a 400 must fail immediately");
});
