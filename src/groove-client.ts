import axios, { AxiosInstance } from "axios";
import { GrooveListOptions, GrooveListResponse } from "./types";

function pickArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const objectPayload = payload as Record<string, unknown>;
    const candidates = ["conversations", "data", "results", "items"];
    for (const key of candidates) {
      const value = objectPayload[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  throw new Error("Could not locate conversation array in Groove response.");
}

function pickNextCursor(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const objectPayload = payload as Record<string, unknown>;
  const pagination = objectPayload.pagination as
    | Record<string, unknown>
    | undefined;
  const meta = objectPayload.meta as Record<string, unknown> | undefined;

  const candidates = [
    objectPayload.next_cursor,
    pagination?.next_cursor,
    pagination?.next,
    meta?.next_cursor,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickNextPage(payload: unknown, currentPage: number): number | undefined {
  if (!payload || typeof payload !== "object") {
    return currentPage + 1;
  }
  const objectPayload = payload as Record<string, unknown>;
  const pagination = objectPayload.pagination as
    | Record<string, unknown>
    | undefined;
  const meta = objectPayload.meta as Record<string, unknown> | undefined;
  const valueCandidates = [
    pagination?.next_page,
    objectPayload.next_page,
    meta?.next_page,
  ];

  for (const candidate of valueCandidates) {
    if (typeof candidate === "number") {
      return candidate;
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
      return Number(candidate);
    }
  }
  return currentPage + 1;
}

export class GrooveClient {
  private readonly http: AxiosInstance;

  constructor(baseUrl: string, token: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      timeout: 30_000,
    });
  }

  async listConversations(options: GrooveListOptions): Promise<GrooveListResponse> {
    const params: Record<string, string | number> = {
      per_page: options.perPage,
      page: options.page ?? 1,
      updated_after: options.since.toISOString(),
    };

    if (options.until) {
      params.updated_before = options.until.toISOString();
    }
    if (options.cursor) {
      params.cursor = options.cursor;
      delete params.page;
    }

    const response = await this.http.get("/conversations", {
      params,
    });

    const items = pickArray(response.data);
    const nextCursor = pickNextCursor(response.data);
    const nextPage = pickNextPage(response.data, options.page ?? 1);
    return { items, nextCursor, nextPage };
  }

  async listConversationMessages(conversationId: string): Promise<unknown[]> {
    const response = await this.http.get(`/conversations/${conversationId}/messages`);
    return pickArray(response.data);
  }
}
