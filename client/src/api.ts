import type { AccountsResponse, DetectedEvent, UnifiedMessage } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listMessages: () => request<UnifiedMessage[]>("/api/messages"),
  listEvents: () => request<DetectedEvent[]>("/api/events"),
  getAccounts: () => request<AccountsResponse>("/api/accounts"),
  syncGmail: () =>
    request<{ fetched: number; newMessages: number; detectedEvents: number }>("/api/sync/gmail", {
      method: "POST",
    }),
  createEvent: (id: number) => request<DetectedEvent>(`/api/events/${id}/create`, { method: "POST" }),
  dismissEvent: (id: number) => request<DetectedEvent>(`/api/events/${id}/dismiss`, { method: "POST" }),
  seedDemoData: () => request<unknown>("/api/dev/seed", { method: "POST" }),
};
