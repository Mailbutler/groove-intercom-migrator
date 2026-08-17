import axios, { AxiosInstance } from "axios";
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
}

function toUnixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class IntercomClient {
  private readonly http: AxiosInstance;
  private resolvedAdminId?: string;
  private adminDirectoryLoaded = false;
  private readonly adminIdsByEmail = new Map<string, string>();
  private readonly cachedContacts = new Map<string, string>();
  private readonly inFlightContactResolutions = new Map<
    string,
    Promise<IntercomContact>
  >();

  constructor(
    baseUrl: string,
    accessToken: string,
    private readonly configAdminId?: string,
    private readonly contactCacheStore?: ContactCacheStore,
    private readonly options: IntercomClientOptions = { strictAgentMapping: false }
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

    const searchResponse = await this.http.post("/contacts/search", {
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
    });

    const searchData = searchResponse.data as { data?: Array<{ id?: string }> };
    const existingId = searchData.data?.[0]?.id;
    if (existingId) {
      this.cacheContact(normalizedEmail, existingId);
      return { id: existingId };
    }

    const createResponse = await this.http.post("/contacts", {
      role: "user",
      email: normalizedEmail,
      name: requester.name ?? normalizedEmail,
      external_id: requester.id,
    });
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

    const response = await this.http.post("/notes", {
      body,
      admin_id: adminId,
      contact_id: contactId,
    });
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

    const [firstMessage, ...remainingMessages] = conversation.messages;
    const createResponse = await this.http.post("/conversations", {
      from: { type: "contact", id: contactId },
      body: firstMessage.body,
      created_at: toUnixSeconds(firstMessage.createdAt),
      subject: conversation.subject,
    });
    const intercomConversationId = (createResponse.data as { id?: string }).id;
    if (!intercomConversationId) {
      throw new Error("Intercom conversation creation did not return id.");
    }

    for (const message of remainingMessages) {
      if (message.isAgentMessage) {
        const adminId = await this.resolveAdminIdForAgentEmail(message.author.email);
        await this.http.post(`/conversations/${intercomConversationId}/reply`, {
          message_type: "comment",
          type: "admin",
          admin_id: adminId,
          body: message.body,
          created_at: toUnixSeconds(message.createdAt),
        });
      } else {
        await this.http.post(`/conversations/${intercomConversationId}/reply`, {
          message_type: "comment",
          type: "user",
          id: contactId,
          body: message.body,
          created_at: toUnixSeconds(message.createdAt),
        });
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

  private async assignConversationToAdmin(
    intercomConversationId: string,
    assigneeAdminId: string
  ): Promise<void> {
    const actingAdminId = await this.resolveAdminId();
    await this.http.post(`/conversations/${intercomConversationId}/parts`, {
      type: "admin",
      admin_id: actingAdminId,
      message_type: "assignment",
      assignee_id: assigneeAdminId,
    });
  }

  private async resolveAdminId(): Promise<string> {
    if (this.resolvedAdminId) {
      return this.resolvedAdminId;
    }
    if (this.configAdminId) {
      this.resolvedAdminId = this.configAdminId;
      return this.resolvedAdminId;
    }

    await this.loadAdminDirectory();
    const adminId = this.adminIdsByEmail.values().next().value as string | undefined;
    if (!adminId) {
      throw new Error(
        "Could not resolve Intercom admin id. Set INTERCOM_ADMIN_ID explicitly."
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

    const response = await this.http.get("/admins");
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
}
