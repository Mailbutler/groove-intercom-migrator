import axios, { AxiosError, AxiosInstance } from "axios";
import { GrooveListOptions, GrooveListResponse, PersonRef } from "./types";

const GROOVE_MAX_PAGE = 10;
const GROOVE_PAGE_LIMIT_PATTERN = /cannot query for pages past page 10/i;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function pickArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const objectPayload = payload as Record<string, unknown>;
    const candidates = [
      "conversations",
      "tickets",
      "messages",
      "ticket_messages",
      "data",
      "results",
      "items",
    ];
    for (const key of candidates) {
      const value = objectPayload[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  throw new Error("Could not locate array payload in Groove response.");
}

function pickErrorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const source = payload as Record<string, unknown>;
  const error = source.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return undefined;
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

function pickNextPage(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
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
  return undefined;
}

function pickRetryAfterMs(error: AxiosError): number | undefined {
  const raw = error.response?.headers?.["retry-after"];
  if (typeof raw === "string" && /^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw * 1000;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function pickString(
  source: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!source) {
    return undefined;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickIdentifier(
  source: Record<string, unknown> | undefined,
  keys: string[]
): string | undefined {
  if (!source) {
    return undefined;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class GrooveClient {
  private readonly http: AxiosInstance;
  private readonly maxRetries = 4;

  constructor(baseUrl: string, token: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
      timeout: 60_000,
    });
  }

  async listConversations(options: GrooveListOptions): Promise<GrooveListResponse> {
    if ((options.page ?? 1) > GROOVE_MAX_PAGE) {
      throw new Error(
        `Groove REST API supports up to page ${GROOVE_MAX_PAGE}. ` +
          "Use --per-page 50 and narrow --since/--until window, or use Groove GraphQL/data export for larger history."
      );
    }

    const params: Record<string, string | number> = {
      per_page: options.perPage,
      page: options.page ?? 1,
    };
    if (options.since) {
      params.created_since = options.since.toISOString();
    }
    if (options.until) {
      params.created_before = options.until.toISOString();
    }

    const response = await this.requestWithRetry(() =>
      this.http.get("/tickets", {
        params,
      })
    );

    const items = pickArray(response.data);
    const nextCursor = pickNextCursor(response.data);
    const nextPage = pickNextPage(response.data);
    return { items, nextCursor, nextPage };
  }

  async listConversationMessages(conversationId: string): Promise<unknown[]> {
    const response = await this.requestWithRetry(() =>
      this.http.get(`/tickets/${conversationId}/messages`)
    );
    return pickArray(response.data);
  }

  async getCustomerByHref(customerHref: string): Promise<PersonRef> {
    const response = await this.requestWithRetry(() =>
      this.http.get(customerHref)
    );
    const payload = asRecord(response.data);
    const customer = asRecord(payload?.customer) ?? payload;
    return {
      id: pickIdentifier(customer, ["id", "uuid", "number"]),
      email: pickString(customer, ["email", "mail"]),
      name: pickString(customer, ["name", "full_name", "first_name"]),
    };
  }

  private async requestWithRetry<T>(
    request: () => Promise<{ data: T }>
  ): Promise<{ data: T }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request();
      } catch (error) {
        if (!axios.isAxiosError(error)) {
          throw error;
        }

        const status = error.response?.status;
        const apiMessage = pickErrorMessage(error.response?.data);

        if (
          status === 429 &&
          apiMessage &&
          GROOVE_PAGE_LIMIT_PATTERN.test(apiMessage)
        ) {
          throw new Error(
            `Groove REST pagination limit reached: ${apiMessage} ` +
              "Use --per-page 50 and narrower date windows, or switch to Groove GraphQL/data export."
          );
        }

        if (!status || !RETRYABLE_STATUS_CODES.has(status) || attempt >= this.maxRetries) {
          throw error;
        }

        const retryAfterMs = pickRetryAfterMs(error);
        const backoffMs = Math.min(30_000, 1_000 * 2 ** attempt);
        await sleep(retryAfterMs ?? backoffMs);
      }
    }
  }
}
