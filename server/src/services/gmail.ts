import { google } from "googleapis";
import { config } from "../config.js";
import { getAccountByProvider, upsertGoogleAccount } from "../store/accountStore.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

export function createOAuthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

export function getAuthUrl(): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
  });
}

export async function handleOAuthCallback(code: string) {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data: profile } = await oauth2.userinfo.get();

  return upsertGoogleAccount({
    label: profile.email ?? "Gmail account",
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? null,
    expiryDate: tokens.expiry_date ?? null,
  });
}

/** Builds an authenticated OAuth2 client for the stored Gmail account, or null if none connected. */
export function getAuthenticatedClient() {
  const account = getAccountByProvider("gmail");
  if (!account || !account.accessToken) return null;

  const client = createOAuthClient();
  client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken ?? undefined,
    expiry_date: account.expiryDate ?? undefined,
  });
  return client;
}

interface NormalizedGmailMessage {
  externalId: string;
  sender: string;
  subject: string | null;
  body: string;
  receivedAt: string;
}

function decodeBody(payload: gmailPayload): string {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  const parts = payload.parts ?? [];
  const plainPart = parts.find((p) => p.mimeType === "text/plain");
  if (plainPart?.body?.data) {
    return Buffer.from(plainPart.body.data, "base64url").toString("utf-8");
  }
  const htmlPart = parts.find((p) => p.mimeType === "text/html");
  if (htmlPart?.body?.data) {
    const html = Buffer.from(htmlPart.body.data, "base64url").toString("utf-8");
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  for (const part of parts) {
    const nested = decodeBody(part);
    if (nested) return nested;
  }
  return "";
}

type gmailPayload = {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: gmailPayload[] | null;
};

function header(headers: { name?: string | null; value?: string | null }[] | undefined, name: string) {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

/** Fetches recent Gmail messages not already known, normalized for storage. */
export async function fetchRecentMessages(maxResults = 20): Promise<NormalizedGmailMessage[]> {
  const client = getAuthenticatedClient();
  if (!client) throw new Error("Gmail account is not connected");

  const gmail = google.gmail({ version: "v1", auth: client });
  const list = await gmail.users.messages.list({
    userId: "me",
    maxResults,
    q: "newer_than:7d",
  });

  const ids = list.data.messages ?? [];
  const results: NormalizedGmailMessage[] = [];

  for (const { id } of ids) {
    if (!id) continue;
    const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = data.payload?.headers ?? [];
    const body = decodeBody((data.payload ?? {}) as gmailPayload) || data.snippet || "";

    results.push({
      externalId: id,
      sender: header(headers, "From") ?? "unknown",
      subject: header(headers, "Subject"),
      body,
      receivedAt: new Date(Number(data.internalDate ?? Date.now())).toISOString(),
    });
  }

  return results;
}
