#!/usr/bin/env node
import "dotenv/config";
import axios, { AxiosInstance } from "axios";

interface IntercomConversationListResponse {
  data?: Array<{ id?: string | number }>;
  conversations?: Array<{ id?: string | number }>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function toConversationIds(
  payload: IntercomConversationListResponse
): string[] {
  const rows = payload.data ?? payload.conversations ?? [];
  const ids = rows
    .map((row) => row.id)
    .filter((id): id is string | number => id !== undefined && id !== null)
    .map((id) => String(id));
  return Array.from(new Set(ids));
}

async function listConversationIds(http: AxiosInstance): Promise<string[]> {
  const response = await http.get<IntercomConversationListResponse>(
    "/conversations",
    {
      params: { per_page: 50 },
    }
  );
  return toConversationIds(response.data);
}

async function deleteConversation(
  http: AxiosInstance,
  conversationId: string
): Promise<boolean> {
  try {
    await http.delete(`/conversations/${conversationId}`);
    return true;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return true;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const intercomApiBaseUrl = (
    process.env.INTERCOM_API_BASE_URL ?? "https://api.intercom.io"
  ).replace(/\/+$/, "");
  const intercomAccessToken = requireEnv("INTERCOM_ACCESS_TOKEN");

  const http = axios.create({
    baseURL: intercomApiBaseUrl,
    headers: {
      Authorization: `Bearer ${intercomAccessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeout: 30_000,
  });

  let totalDeleted = 0;
  let batch = 0;

  while (true) {
    batch += 1;
    const ids = await listConversationIds(http);
    if (ids.length === 0) {
      break;
    }

    let deletedInBatch = 0;
    for (const id of ids) {
      const deleted = await deleteConversation(http, id);
      if (deleted) {
        deletedInBatch += 1;
      }
    }

    totalDeleted += deletedInBatch;
    console.log(
      `[batch ${batch}] fetched=${ids.length} deleted=${deletedInBatch} totalDeleted=${totalDeleted}`
    );

    if (deletedInBatch === 0) {
      throw new Error(
        "No conversations were deleted in the current batch; aborting to avoid an infinite loop."
      );
    }
  }

  console.log(`Done. Deleted ${totalDeleted} Intercom conversation(s).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
