import assert from "node:assert/strict";
import test from "node:test";
import { AxiosError } from "axios";
import { IntercomClient } from "./intercom-client";

interface IntercomClientTestHarness {
  http: {
    post(
      url: string,
      payload: Record<string, unknown>
    ): Promise<{ data: unknown }>;
  };
  postUserReply(
    intercomConversationId: string,
    contactId: string,
    requesterEmail: string | undefined,
    body: string,
    createdAt: Date
  ): Promise<void>;
}

function createHarness(): IntercomClientTestHarness {
  return new IntercomClient(
    "https://api.intercom.io",
    "test-token"
  ) as unknown as IntercomClientTestHarness;
}

function userNotFoundError(
  url: string,
  payload: Record<string, unknown>
): AxiosError {
  return new AxiosError(
    "User Not Found",
    "ERR_BAD_REQUEST",
    { url, data: JSON.stringify(payload) } as never,
    undefined,
    {
      status: 404,
      statusText: "Not Found",
      headers: {},
      config: {} as never,
      data: {
        type: "error.list",
        errors: [{ code: "not_found", message: "User Not Found" }],
      },
    }
  );
}

test("IntercomClient posts user replies with the known contact ID first", async () => {
  const client = createHarness();
  const payloads: Array<Record<string, unknown>> = [];
  client.http.post = async (_url, payload) => {
    payloads.push(payload);
    return { data: {} };
  };

  await client.postUserReply(
    "conversation-1",
    "contact-1",
    "customer@example.com",
    "Hello",
    new Date("2026-09-02T09:00:00Z")
  );

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.intercom_user_id, "contact-1");
  assert.equal(payloads[0]?.email, undefined);
});

test("IntercomClient falls back to email when the contact ID is rejected", async () => {
  const client = createHarness();
  const payloads: Array<Record<string, unknown>> = [];
  client.http.post = async (url, payload) => {
    payloads.push(payload);
    if (payloads.length === 1) {
      throw userNotFoundError(url, payload);
    }
    return { data: {} };
  };

  await client.postUserReply(
    "conversation-1",
    "contact-1",
    "customer@example.com",
    "Hello",
    new Date("2026-09-02T09:00:00Z")
  );

  assert.equal(payloads.length, 2);
  assert.equal(payloads[1]?.email, "customer@example.com");
  assert.equal(payloads[1]?.intercom_user_id, undefined);
});
