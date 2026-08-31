import axios, { AxiosError, AxiosInstance } from "axios";
import { Logger } from "pino";
import { NormalizedConversation, PersonRef, MigrationMode } from "./types";
import { buildIntercomNoteBody } from "./transform";

interface IntercomContact {
  id: string;
}

interface ContactCacheStore {
  getCachedContactId(email: string): string | undefined;
  cacheContactId(email: string, intercomContactId: string): void;
}

interface IntercomClientOptions {
  strictAgentMapping: boolean;
  jiraIssueAttributeName: string;
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeGrooveStatus(status?: string): string | undefined {
  if (!status) {
    return undefined;
  }
  const normalized = status.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function mapGrooveStatusToIntercomState(
  grooveStatus?: string
): "open" | "closed" | undefined {
  const normalizedStatus = normalizeGrooveStatus(grooveStatus);
  if (!normalizedStatus) {
    return undefined;
  }
  if (
    normalizedStatus === "closed" ||
    normalizedStatus === "resolved" ||
    normalizedStatus === "solved" ||
    normalizedStatus === "done" ||
    normalizedStatus === "archived"
  ) {
    return "closed";
  }
  if (
    normalizedStatus === "opened" ||
    normalizedStatus === "unread" ||
    normalizedStatus === "open" ||
    normalizedStatus === "pending" ||
    normalizedStatus === "new" ||
    normalizedStatus === "active" ||
    normalizedStatus === "unresolved"
  ) {
    return "open";
  }
  return undefined;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function htmlToPlainText(html: string): string {
  const withLineBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li>/gi, "- ");
  const withoutTags = withLineBreaks.replace(/<[^>]+>/g, "");
  const decoded = decodeHtmlEntities(withoutTags);
  const normalized = decoded
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return normalized.length > 0 ? normalized : "(empty)";
}

function toIntercomBody(message: NormalizedConversation["messages"][number]): string {
  if (message.bodyFormat === "html") {
    return htmlToPlainText(message.body);
  }
  return message.body;
}

function isIntercomUserReplyNotAccepted(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  if (error.response?.status !== 404) {
    return false;
  }
  const requestUrl = error.config?.url;
  if (typeof requestUrl !== "string" || !requestUrl.endsWith("/reply")) {
    return false;
  }
  const requestBody = error.config?.data;
  if (typeof requestBody !== "string") {
    return false;
  }
  return requestBody.includes('"type":"user"');
}

function isIntercomConversationAlreadyAssignedError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  if (error.response?.status !== 422) {
    return false;
  }
  const responseData = error.response?.data as
    | {
        errors?: Array<{ code?: unknown }>;
      }
    | undefined;
  const errors = responseData?.errors;
  if (!Array.isArray(errors)) {
    return false;
  }
  return errors.some(
    (entry) => entry?.code === "conversation_already_assigned_to_assignee"
  );
}

export class IntercomClient {
  private readonly http: AxiosInstance;
  private resolvedAdminId?: string;
  private adminDirectoryLoaded = false;
  private readonly adminIdsByEmail = new Map<string, string>();
  private tagsLoaded = false;
  private readonly tagIdsByName = new Map<string, string>();
  private readonly cachedContacts = new Map<string, string>();
  private readonly inFlightContactResolutions = new Map<
    string,
    Promise<IntercomContact>
  >();

  constructor(
    baseUrl: string,
    accessToken: string,
    private readonly configFallbackAgentId?: string,
    private readonly contactCacheStore?: ContactCacheStore,
    private readonly options: IntercomClientOptions = {
      strictAgentMapping: false,
      jiraIssueAttributeName: "jira_issue_key",
    },
    private readonly logger?: Logger
  ) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });
  }

  async importConversation(
    conversation: NormalizedConversation,
    mode: MigrationMode
  ): Promise<string> {
    const contact = await this.upsertContact(conversation.requester);
    if (mode === "contact-note") {
      return this.createHistoricalNote(contact.id, conversation);
    }
    return this.createIntercomConversation(contact.id, conversation);
  }

  async syncConversationState(
    intercomResourceId: string,
    grooveStatus?: string
  ): Promise<void> {
    if (!intercomResourceId.startsWith("conversation:")) {
      return;
    }

    const intercomConversationId = intercomResourceId.slice("conversation:".length);
    if (!intercomConversationId) {
      return;
    }

    const targetState = mapGrooveStatusToIntercomState(grooveStatus);
    if (!targetState) {
      if (grooveStatus) {
        this.logger?.warn(
          { intercomResourceId, grooveStatus },
          "Skipping state sync because Groove status is unmapped"
        );
      }
      return;
    }

    const currentState = await this.getConversationState(intercomConversationId);
    if (currentState === targetState) {
      return;
    }

    const actingAdminId = await this.resolveAdminId();
    const messageType = targetState === "closed" ? "close" : "open";
    await this.request(
      `POST /conversations/${intercomConversationId}/parts`,
      {
        actingAdminId,
        messageType,
        targetState,
      },
      () =>
        this.http.post(`/conversations/${intercomConversationId}/parts`, {
          type: "admin",
          admin_id: actingAdminId,
          message_type: messageType,
        })
    );
  }

  async syncConversationTags(
    intercomResourceId: string,
    grooveTags: string[]
  ): Promise<void> {
    if (!intercomResourceId.startsWith("conversation:")) {
      return;
    }

    const intercomConversationId = intercomResourceId.slice("conversation:".length);
    if (!intercomConversationId) {
      return;
    }

    const desiredTags = Array.from(
      new Set(grooveTags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))
    );
    if (desiredTags.length === 0) {
      return;
    }

    const existingTags = await this.getConversationTagNames(intercomConversationId);
    const tagsToApply = desiredTags.filter(
      (tag) => !existingTags.has(tag.toLowerCase())
    );
    const actingAdminId = await this.resolveAdminId();
    for (const tag of tagsToApply) {
      const tagId = await this.resolveTagId(tag);
      await this.request(
        `POST /conversations/${intercomConversationId}/tags`,
        { intercomConversationId, tagId, tag, actingAdminId },
        () =>
          this.http.post(`/conversations/${intercomConversationId}/tags`, {
            id: tagId,
            admin_id: actingAdminId,
          })
      );
    }
  }

  async syncConversationJiraIssues(
    intercomResourceId: string,
    jiraIssueKeys: string[]
  ): Promise<void> {
    if (!intercomResourceId.startsWith("conversation:") || jiraIssueKeys.length === 0) {
      return;
    }

    const intercomConversationId = intercomResourceId.slice("conversation:".length);
    if (!intercomConversationId) {
      return;
    }

    await this.updateConversationJiraIssues(intercomConversationId, jiraIssueKeys);
  }

  isConversationNotFoundError(error: unknown, intercomResourceId: string): boolean {
    if (!intercomResourceId.startsWith("conversation:")) {
      return false;
    }
    if (!axios.isAxiosError(error)) {
      return false;
    }
    const intercomConversationId = intercomResourceId.slice("conversation:".length);
    if (!intercomConversationId) {
      return false;
    }
    const status = error.response?.status;
    if (status !== 404) {
      return false;
    }
    const url = error.config?.url;
    if (typeof url !== "string") {
      return false;
    }
    return url === `/conversations/${intercomConversationId}`;
  }

  private async upsertContact(requester: PersonRef): Promise<IntercomContact> {
    if (!requester.email) {
      throw new Error(
        "Conversation requester has no email. Cannot create/search Intercom contact."
      );
    }

    const normalizedEmail = normalizeEmail(requester.email);
    const inFlight = this.inFlightContactResolutions.get(normalizedEmail);
    if (inFlight) {
      return inFlight;
    }

    const resolutionTask = this.resolveContact(requester, normalizedEmail);
    this.inFlightContactResolutions.set(normalizedEmail, resolutionTask);
    try {
      return await resolutionTask;
    } finally {
      this.inFlightContactResolutions.delete(normalizedEmail);
    }
  }

  private async resolveContact(
    requester: PersonRef,
    normalizedEmail: string
  ): Promise<IntercomContact> {
    const inMemoryContactId = this.cachedContacts.get(normalizedEmail);
    if (inMemoryContactId) {
      return { id: inMemoryContactId };
    }

    const checkpointCachedContactId =
      this.contactCacheStore?.getCachedContactId(normalizedEmail);
    if (checkpointCachedContactId) {
      this.cachedContacts.set(normalizedEmail, checkpointCachedContactId);
      return { id: checkpointCachedContactId };
    }

    const searchResponse = await this.request(
      "POST /contacts/search",
      { email: normalizedEmail },
      () =>
        this.http.post("/contacts/search", {
          query: {
            operator: "AND",
            value: [
              {
                field: "email",
                operator: "=",
                value: normalizedEmail,
              },
            ],
          },
        })
    );

    const searchData = searchResponse.data as { data?: Array<{ id?: string }> };
    const existingId = searchData.data?.[0]?.id;
    if (existingId) {
      this.cacheContact(normalizedEmail, existingId);
      return { id: existingId };
    }

    const createResponse = await this.request(
      "POST /contacts",
      { email: normalizedEmail, externalId: requester.id },
      () =>
        this.http.post("/contacts", {
          role: "user",
          email: normalizedEmail,
          name: requester.name ?? normalizedEmail,
          external_id: requester.id,
        })
    );
    const createdId = (createResponse.data as { id?: string }).id;
    if (!createdId) {
      throw new Error("Intercom contact creation did not return an id.");
    }
    this.cacheContact(normalizedEmail, createdId);
    return { id: createdId };
  }

  private cacheContact(normalizedEmail: string, contactId: string): void {
    this.cachedContacts.set(normalizedEmail, contactId);
    this.contactCacheStore?.cacheContactId(normalizedEmail, contactId);
  }

  private async createHistoricalNote(
    contactId: string,
    conversation: NormalizedConversation
  ): Promise<string> {
    const adminId = await this.resolveAdminId();
    const body = buildIntercomNoteBody(conversation);

    const response = await this.request(
      "POST /notes",
      { contactId, adminId, bodyLength: body.length },
      () =>
        this.http.post("/notes", {
          body,
          admin_id: adminId,
          contact_id: contactId,
        })
    );
    const noteId = (response.data as { id?: string }).id;
    if (!noteId) {
      throw new Error("Intercom note creation succeeded but did not return id.");
    }
    return `note:${noteId}`;
  }

  private async createIntercomConversation(
    contactId: string,
    conversation: NormalizedConversation
  ): Promise<string> {
    if (conversation.messages.length === 0) {
      throw new Error(`Conversation ${conversation.id} has no messages to import.`);
    }

    const firstMessageIndex = conversation.messages.findIndex(
      (message) => !message.isInternalNote
    );
    if (firstMessageIndex < 0) {
      throw new Error(
        `Conversation ${conversation.id} has only internal notes and cannot start an Intercom conversation.`
      );
    }

    const firstMessage = conversation.messages[firstMessageIndex];
    const remainingMessages = conversation.messages.filter(
      (_, index) => index !== firstMessageIndex
    );
    const firstMessageBody = toIntercomBody(firstMessage);
    const createResponse = await this.request(
      "POST /conversations",
      {
        fromType: "user",
        messageType: "email",
        contactId,
        subject: conversation.subject,
        bodyLength: firstMessageBody.length,
      },
      () =>
        this.http.post("/conversations", {
          message_type: "email",
          from: { type: "user", id: contactId },
          body: firstMessageBody,
          created_at: toUnixSeconds(firstMessage.createdAt),
          subject: conversation.subject,
        })
    );
    const createPayload = createResponse.data as {
      id?: string | number;
      conversation_id?: string | number;
    };
    const intercomConversationIdRaw =
      createPayload.conversation_id ?? createPayload.id;
    const intercomConversationId =
      typeof intercomConversationIdRaw === "string" ||
      typeof intercomConversationIdRaw === "number"
        ? String(intercomConversationIdRaw)
        : undefined;
    if (!intercomConversationId) {
      throw new Error(
        "Intercom conversation creation did not return conversation_id or id."
      );
    }

    for (const message of remainingMessages) {
      const messageBody = toIntercomBody(message);
      if (message.isAgentMessage) {
        const adminId = await this.resolveAdminIdForAgentEmail(message.author.email);
        const messageType = message.isInternalNote ? "note" : "comment";
        await this.request(
          `POST /conversations/${intercomConversationId}/reply`,
          {
            replyType: message.isInternalNote ? "note" : "admin",
            adminId,
            bodyLength: messageBody.length,
          },
          () =>
            this.http.post(`/conversations/${intercomConversationId}/reply`, {
              message_type: messageType,
              type: "admin",
              admin_id: adminId,
              body: messageBody,
              created_at: toUnixSeconds(message.createdAt),
            })
        );
      } else {
        await this.postUserReply(
          intercomConversationId,
          contactId,
          conversation.requester.email,
          messageBody,
          message.createdAt
        );
      }
    }

    if (conversation.assignee?.email) {
      const assigneeAdminId = await this.resolveAdminIdForAgentEmail(
        conversation.assignee.email
      );
      await this.assignConversationToAdmin(intercomConversationId, assigneeAdminId);
    }

    return `conversation:${intercomConversationId}`;
  }

  private async updateConversationJiraIssues(
    intercomConversationId: string,
    jiraIssueKeys: string[]
  ): Promise<void> {
    const uniqueIssueKeys = Array.from(new Set(jiraIssueKeys)).sort();
    if (uniqueIssueKeys.length === 0) {
      return;
    }

    const attributeName = this.options.jiraIssueAttributeName.trim();
    if (!attributeName) {
      throw new Error("Intercom Jira attribute name cannot be empty.");
    }

    await this.request(
      `PUT /conversations/${intercomConversationId}`,
      { intercomConversationId, attributeName, jiraIssueKeys: uniqueIssueKeys },
      () =>
        this.http.put(`/conversations/${intercomConversationId}`, {
          custom_attributes: {
            [attributeName]: uniqueIssueKeys.join(", "),
          },
        })
    );
  }

  private async assignConversationToAdmin(
    intercomConversationId: string,
    assigneeAdminId: string
  ): Promise<void> {
    const actingAdminId = await this.resolveAdminId();
    try {
      await this.request(
        `POST /conversations/${intercomConversationId}/parts`,
        { actingAdminId, assigneeAdminId },
        () =>
          this.http.post(`/conversations/${intercomConversationId}/parts`, {
            type: "admin",
            admin_id: actingAdminId,
            message_type: "assignment",
            assignee_id: assigneeAdminId,
          })
      );
    } catch (error) {
      if (isIntercomConversationAlreadyAssignedError(error)) {
        this.logger?.debug(
          { intercomConversationId, assigneeAdminId },
          "Skipping assignment because conversation is already assigned to requested assignee"
        );
        return;
      }
      throw error;
    }
  }

  private async resolveAdminId(): Promise<string> {
    if (this.resolvedAdminId) {
      return this.resolvedAdminId;
    }
    if (this.configFallbackAgentId) {
      this.resolvedAdminId = this.configFallbackAgentId;
      return this.resolvedAdminId;
    }

    await this.loadAdminDirectory();
    const adminId = this.adminIdsByEmail.values().next().value as string | undefined;
    if (!adminId) {
      throw new Error(
        "Could not resolve Intercom fallback agent id. Set INTERCOM_FALLBACK_AGENT_ID explicitly."
      );
    }
    this.resolvedAdminId = adminId;
    return adminId;
  }

  private async resolveAdminIdForAgentEmail(email?: string): Promise<string> {
    if (!email) {
      if (this.options.strictAgentMapping) {
        throw new Error(
          "Agent/assignee mapping is strict and source agent email is missing."
        );
      }
      return this.resolveAdminId();
    }

    await this.loadAdminDirectory();
    const mappedAdminId = this.adminIdsByEmail.get(normalizeEmail(email));
    if (mappedAdminId) {
      return mappedAdminId;
    }

    if (this.options.strictAgentMapping) {
      throw new Error(
        `No Intercom admin found for source agent email "${email}" with strict mapping enabled.`
      );
    }
    return this.resolveAdminId();
  }

  private async loadAdminDirectory(): Promise<void> {
    if (this.adminDirectoryLoaded) {
      return;
    }

    const response = await this.request("GET /admins", undefined, () =>
      this.http.get("/admins")
    );
    const data = response.data as {
      admins?: Array<Record<string, unknown>>;
      data?: Array<Record<string, unknown>>;
    };
    const admins = data.admins ?? data.data ?? [];
    for (const admin of admins) {
      const idRaw = admin.id;
      const id =
        typeof idRaw === "string"
          ? idRaw
          : typeof idRaw === "number"
            ? String(idRaw)
            : undefined;
      const emailRaw = admin.email;
      const email =
        typeof emailRaw === "string" && emailRaw.trim().length > 0
          ? normalizeEmail(emailRaw)
          : undefined;
      if (id && email) {
        this.adminIdsByEmail.set(email, id);
      }
    }
    this.adminDirectoryLoaded = true;
  }

  private async getConversationState(
    intercomConversationId: string
  ): Promise<"open" | "closed" | undefined> {
    const response = await this.request(
      `GET /conversations/${intercomConversationId}`,
      { intercomConversationId },
      () => this.http.get(`/conversations/${intercomConversationId}`)
    );
    const data = response.data as Record<string, unknown>;
    const state = data.state ?? data.conversation_state;
    if (state === "open" || state === "closed") {
      return state;
    }
    const openRaw = data.open;
    if (typeof openRaw === "boolean") {
      return openRaw ? "open" : "closed";
    }
    return undefined;
  }

  private async getConversationTagNames(
    intercomConversationId: string
  ): Promise<Set<string>> {
    const response = await this.request(
      `GET /conversations/${intercomConversationId}`,
      { intercomConversationId },
      () => this.http.get(`/conversations/${intercomConversationId}`)
    );
    const data = response.data as Record<string, unknown>;
    const tagSet = new Set<string>();

    const directTags = data.tags;
    if (Array.isArray(directTags)) {
      for (const tagEntry of directTags) {
        const tagName = this.extractTagName(tagEntry);
        if (tagName) {
          tagSet.add(tagName.toLowerCase());
        }
      }
    }

    const nestedTagsContainer = data.conversation_tags as Record<string, unknown>;
    const nestedTags = nestedTagsContainer?.conversation_tags;
    if (Array.isArray(nestedTags)) {
      for (const tagEntry of nestedTags) {
        const tagName = this.extractTagName(tagEntry);
        if (tagName) {
          tagSet.add(tagName.toLowerCase());
        }
      }
    }

    return tagSet;
  }

  private async postUserReply(
    intercomConversationId: string,
    contactId: string,
    requesterEmail: string | undefined,
    body: string,
    createdAt: Date
  ): Promise<void> {
    const payloads: Array<Record<string, unknown>> = [];
    if (requesterEmail && requesterEmail.trim().length > 0) {
      payloads.push({
        message_type: "comment",
        type: "user",
        email: requesterEmail.trim(),
        body,
        created_at: toUnixSeconds(createdAt),
      });
    }
    payloads.push({
      message_type: "comment",
      type: "user",
      intercom_user_id: contactId,
      body,
      created_at: toUnixSeconds(createdAt),
    });

    let lastError: unknown;
    for (const payload of payloads) {
      try {
        await this.request(
          `POST /conversations/${intercomConversationId}/reply`,
          {
            replyType: "user",
            contactId,
            bodyLength: body.length,
            payloadKeys: Object.keys(payload),
          },
          () =>
            this.http.post(`/conversations/${intercomConversationId}/reply`, payload)
        );
        return;
      } catch (error) {
        if (!isIntercomUserReplyNotAccepted(error)) {
          throw error;
        }
        lastError = error;
      }
    }

    throw (
      lastError ??
      new Error(
        `Intercom did not accept user reply payloads for conversation ${intercomConversationId}.`
      )
    );
  }

  private async resolveTagId(tagName: string): Promise<string> {
    const normalizedTagName = tagName.trim().toLowerCase();
    if (!normalizedTagName) {
      throw new Error("Cannot resolve Intercom tag id for an empty tag name.");
    }

    if (!this.tagsLoaded) {
      await this.loadTagsDirectory();
    }

    const existingTagId = this.tagIdsByName.get(normalizedTagName);
    if (existingTagId) {
      return existingTagId;
    }

    const created = await this.request("POST /tags", { tagName }, () =>
      this.http.post("/tags", { name: tagName })
    );
    const createdData = created.data as Record<string, unknown>;
    const createdId = createdData.id;
    if (typeof createdId !== "string" && typeof createdId !== "number") {
      throw new Error(`Intercom tag creation for "${tagName}" did not return an id.`);
    }
    const tagId = String(createdId);
    this.tagIdsByName.set(normalizedTagName, tagId);
    return tagId;
  }

  private async loadTagsDirectory(): Promise<void> {
    const response = await this.request("GET /tags", undefined, () =>
      this.http.get("/tags")
    );
    const data = response.data as Record<string, unknown>;
    const tagsList = data.data;
    if (Array.isArray(tagsList)) {
      for (const tag of tagsList) {
        if (!tag || typeof tag !== "object") {
          continue;
        }
        const source = tag as Record<string, unknown>;
        const rawName = source.name;
        const rawId = source.id;
        if (
          typeof rawName === "string" &&
          rawName.trim().length > 0 &&
          (typeof rawId === "string" || typeof rawId === "number")
        ) {
          this.tagIdsByName.set(rawName.trim().toLowerCase(), String(rawId));
        }
      }
    }
    this.tagsLoaded = true;
  }

  private extractTagName(tagEntry: unknown): string | undefined {
    if (!tagEntry || typeof tagEntry !== "object") {
      return undefined;
    }
    const source = tagEntry as Record<string, unknown>;
    const tagName = source.name;
    if (typeof tagName !== "string") {
      return undefined;
    }
    const normalizedName = tagName.trim();
    return normalizedName.length > 0 ? normalizedName : undefined;
  }

  private async request<T>(
    operation: string,
    context: Record<string, unknown> | undefined,
    fn: () => Promise<{ data: T }>
  ): Promise<{ data: T }> {
    try {
      return await fn();
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        throw error;
      }
      const axiosError = error as AxiosError;
      const requestId = this.pickHeader(
        axiosError.response?.headers,
        "x-request-id"
      );
      const intercomVersion = this.pickHeader(
        axiosError.response?.headers,
        "intercom-version"
      );
      this.logger?.error(
        {
          operation,
          context,
          status: axiosError.response?.status,
          statusText: axiosError.response?.statusText,
          code: axiosError.code,
          requestId,
          intercomVersion,
          responseData: axiosError.response?.data,
        },
        "Intercom API call failed"
      );
      throw error;
    }
  }

  private pickHeader(
    headers: Record<string, unknown> | undefined,
    name: string
  ): string | undefined {
    if (!headers || typeof headers !== "object") {
      return undefined;
    }
    const value = (headers as Record<string, unknown>)[name];
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
      return value[0];
    }
    return undefined;
  }
}
