import {
  NormalizedAttachment,
  NormalizedConversation,
  NormalizedMessage,
  PersonRef,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickIdentifier(
  source: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function pickDate(source: Record<string, unknown>, keys: string[]): Date | undefined {
  const value = pickString(source, keys);
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function pickObject(
  source: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = source[key];
    if (value && typeof value === "object") {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function parsePersonFromHref(href: string): PersonRef {
  const normalizedHref = href.trim();
  const person: PersonRef = {};
  const matchedId = normalizedHref.match(/\/(agents|customers)\/([^/?#]+)/i);
  if (!matchedId) {
    return person;
  }
  const rawIdentifier = decodeURIComponent(matchedId[2] ?? "").trim();
  if (!rawIdentifier) {
    return person;
  }
  person.id = rawIdentifier;
  if (rawIdentifier.includes("@")) {
    person.email = rawIdentifier;
    person.name = rawIdentifier;
  }
  return person;
}

function normalizePerson(input: unknown): PersonRef {
  if (typeof input === "string" && input.trim().length > 0) {
    return parsePersonFromHref(input);
  }
  const source = asRecord(input);
  const href = pickString(source, ["href"]);
  const hrefPerson = href ? parsePersonFromHref(href) : {};
  return {
    id:
      pickIdentifier(source, ["id", "uuid", "external_id", "number"]) ??
      hrefPerson.id,
    email: pickString(source, ["email", "mail"]) ?? hrefPerson.email,
    name: pickString(source, ["name", "full_name", "display_name"]) ?? hrefPerson.name,
  };
}

function normalizeAttachments(input: unknown): NormalizedAttachment[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((attachment, index) => {
      const source = asRecord(attachment);
      const id =
        pickIdentifier(source, ["id", "uuid", "number"]) ??
        pickString(source, ["url", "download_url"]) ??
        `attachment-${index}`;
      const sizeRaw = source.size ?? source.file_size;
      const sizeBytes =
        typeof sizeRaw === "number"
          ? sizeRaw
          : typeof sizeRaw === "string" && /^\d+$/.test(sizeRaw)
            ? Number(sizeRaw)
            : undefined;

      return {
        id,
        fileName: pickString(source, ["filename", "file_name", "name"]),
        url: pickString(source, ["url", "download_url"]),
        contentType: pickString(source, ["content_type", "mime_type"]),
        sizeBytes,
      };
    })
    .filter((item) => Boolean(item.id));
}

function normalizeMessage(rawMessage: unknown): NormalizedMessage {
  const source = asRecord(rawMessage);
  const id = pickIdentifier(source, ["id", "uuid", "number"]) ?? cryptoRandomId("msg");
  const createdAt =
    pickDate(source, ["created_at", "sent_at", "timestamp", "date"]) ?? new Date(0);
  const htmlBody = pickString(source, ["body_html", "body", "html_body"]);
  const textBody = pickString(source, ["body_text", "text", "plain_body"]);
  const body = htmlBody ?? textBody ?? "(empty)";
  const bodyFormat = htmlBody ? "html" : "plain";

  const links = asRecord(source.links);
  const authorSource =
    source.author ?? source.sender ?? source.user ?? links.author;
  const author = normalizePerson(authorSource);
  const role = pickString(asRecord(authorSource), ["role", "type", "kind"])?.toLowerCase();
  const authorHref = pickString(asRecord(authorSource), ["href"])?.toLowerCase();
  const conversationType = pickString(source, ["conversation_type"])?.toLowerCase();
  const messageType = pickString(source, ["message_type", "type", "kind"])?.toLowerCase();
  const isInternalNote =
    source.note === true ||
    source.internal === true ||
    source.private === true ||
    conversationType === "internal" ||
    messageType === "note";
  const isAgentMessage =
    isInternalNote ||
    role === "agent" ||
    role === "admin" ||
    role === "teammate" ||
    Boolean(source.agent_response) ||
    Boolean(authorHref?.includes("/agents/"));

  return {
    id,
    createdAt,
    body,
    bodyFormat,
    author,
    isAgentMessage,
    isInternalNote,
    attachments: normalizeAttachments(source.attachments),
  };
}

function cryptoRandomId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

export function normalizeConversation(
  rawConversation: unknown,
  rawMessages: unknown[]
): NormalizedConversation {
  const source = asRecord(rawConversation);

  const id = pickIdentifier(source, ["id", "uuid", "number"]) ?? cryptoRandomId("conv");
  const createdAt =
    pickDate(source, ["created_at", "started_at", "opened_at"]) ?? new Date(0);
  const updatedAt =
    pickDate(source, ["updated_at", "last_message_at", "closed_at"]) ?? createdAt;

  const tagsRaw = source.tags;
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
        .map((tag) =>
          typeof tag === "string" ? tag : pickString(asRecord(tag), ["name", "id"])
        )
        .filter((tag): tag is string => Boolean(tag))
    : [];

  const requesterSource =
    source.customer ?? source.requester ?? source.user ?? source.sender;
  const links = asRecord(source.links);
  const assigneeSource = pickObject(source, [
    "assignee",
    "assigned_agent",
    "assigned_user",
    "assigned_to",
    "owner",
  ]) ?? links.assignee;

  const conversation: NormalizedConversation = {
    id,
    subject: pickString(source, ["subject", "title"]) ?? "(no subject)",
    createdAt,
    updatedAt,
    status: pickString(source, ["status", "state"]),
    tags,
    jiraIssueKeys: [],
    assignee: normalizePerson(assigneeSource),
    requester: normalizePerson(requesterSource),
    mailbox: pickString(asRecord(source.mailbox), ["name", "id"]),
    messages: rawMessages.map(normalizeMessage).sort((a, b) => {
      return a.createdAt.getTime() - b.createdAt.getTime();
    }),
    sourceUrl: pickString(source, ["link", "url", "html_url", "permalink"]),
  };

  if (!conversation.requester.email && conversation.messages.length > 0) {
    const firstCustomerMessage = conversation.messages.find(
      (message) => !message.isAgentMessage && Boolean(message.author.email)
    );
    if (firstCustomerMessage?.author.email) {
      conversation.requester.email = firstCustomerMessage.author.email;
      conversation.requester.name ??= firstCustomerMessage.author.name;
    }
  }

  return conversation;
}

export function buildIntercomNoteBody(conversation: NormalizedConversation): string {
  const header = [
    "<h2>Historical conversation migrated from Groove</h2>",
    `<p><strong>Groove ID:</strong> ${escapeHtml(conversation.id)}</p>`,
    `<p><strong>Subject:</strong> ${escapeHtml(conversation.subject)}</p>`,
    `<p><strong>Status:</strong> ${escapeHtml(conversation.status ?? "unknown")}</p>`,
    conversation.jiraIssueKeys.length > 0
      ? `<p><strong>Jira issues:</strong> ${escapeHtml(
          conversation.jiraIssueKeys.join(", ")
        )}</p>`
      : "",
    `<p><strong>Created:</strong> ${conversation.createdAt.toISOString()}</p>`,
    `<p><strong>Updated:</strong> ${conversation.updatedAt.toISOString()}</p>`,
    conversation.sourceUrl
      ? `<p><strong>Source URL:</strong> <a href="${escapeAttribute(
          conversation.sourceUrl
        )}">${escapeHtml(conversation.sourceUrl)}</a></p>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const messageBlocks = conversation.messages.map((message, index) => {
    const authorLabel = message.isInternalNote
      ? "Internal note"
      : message.isAgentMessage
        ? "Agent"
        : "Customer";
    const authorName = message.author.name ?? message.author.email ?? "Unknown";
    const attachmentLines = message.attachments
      .map((attachment) => {
        const label = attachment.fileName ?? attachment.id;
        const href = attachment.url
          ? ` <a href="${escapeAttribute(attachment.url)}">${escapeHtml(label)}</a>`
          : ` ${escapeHtml(label)}`;
        return `<li>${href}</li>`;
      })
      .join("");

    const body =
      message.bodyFormat === "html"
        ? message.body
        : `<pre>${escapeHtml(message.body)}</pre>`;

    return [
      `<hr />`,
      `<p><strong>#${index + 1} ${authorLabel}</strong> (${escapeHtml(
        authorName
      )}) at ${message.createdAt.toISOString()}</p>`,
      body,
      attachmentLines ? `<ul>${attachmentLines}</ul>` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return [header, ...messageBlocks].join("\n");
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(input: string): string {
  return escapeHtml(input);
}
