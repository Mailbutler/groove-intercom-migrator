import assert from "node:assert/strict";
import test from "node:test";
import { buildIntercomNoteBody, normalizeConversation } from "./transform";

test("normalizeConversation maps core Groove fields", () => {
  const rawConversation = {
    id: "conv_1",
    subject: "Payment issue",
    created_at: "2025-01-10T10:00:00.000Z",
    updated_at: "2025-01-10T12:00:00.000Z",
    status: "closed",
    customer: {
      email: "customer@example.com",
      name: "Customer Name",
    },
    tags: ["billing", "urgent"],
  };

  const rawMessages = [
    {
      id: "m1",
      created_at: "2025-01-10T10:00:00.000Z",
      body_text: "Hello!",
      sender: {
        email: "customer@example.com",
        name: "Customer Name",
        role: "customer",
      },
    },
  ];

  const normalized = normalizeConversation(rawConversation, rawMessages);
  assert.equal(normalized.id, "conv_1");
  assert.equal(normalized.subject, "Payment issue");
  assert.equal(normalized.requester.email, "customer@example.com");
  assert.equal(normalized.messages.length, 1);
  assert.equal(normalized.messages[0].body, "Hello!");
  assert.deepEqual(normalized.tags, ["billing", "urgent"]);
});

test("buildIntercomNoteBody includes migration header and messages", () => {
  const conversation = normalizeConversation(
    {
      id: "conv_2",
      subject: "Shipping",
      created_at: "2025-02-01T00:00:00.000Z",
      updated_at: "2025-02-01T00:10:00.000Z",
      customer: { email: "a@example.com" },
    },
    [
      {
        id: "m1",
        created_at: "2025-02-01T00:00:00.000Z",
        body_text: "Where is my order?",
        sender: { email: "a@example.com", role: "customer" },
      },
      {
        id: "m2",
        created_at: "2025-02-01T00:05:00.000Z",
        body_text: "We are checking this now.",
        sender: { email: "agent@example.com", role: "agent" },
      },
    ]
  );

  const noteBody = buildIntercomNoteBody(conversation);
  assert.match(noteBody, /Historical conversation migrated from Groove/);
  assert.match(noteBody, /Where is my order\?/);
  assert.match(noteBody, /We are checking this now\./);
});

test("normalizeConversation uses numeric ticket number as id", () => {
  const normalized = normalizeConversation(
    {
      number: 12345,
      subject: "Ticket from Groove",
      created_at: "2025-02-01T00:00:00.000Z",
      updated_at: "2025-02-01T00:10:00.000Z",
      customer: { email: "customer@example.com" },
    },
    []
  );

  assert.equal(normalized.id, "12345");
});
