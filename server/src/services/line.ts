import { Client, validateSignature, webhook } from "@line/bot-sdk";
import { config } from "../config.js";

export function verifyLineSignature(rawBody: string, signature: string | undefined): boolean {
  if (!config.isLineConfigured() || !signature) return false;
  return validateSignature(rawBody, config.line.channelSecret, signature);
}

function lineClient(): Client {
  return new Client({
    channelAccessToken: config.line.channelAccessToken,
    channelSecret: config.line.channelSecret,
  });
}

export function isTextMessageEvent(
  event: webhook.Event
): event is webhook.MessageEvent & { message: webhook.TextMessageContent } {
  return event.type === "message" && event.message.type === "text";
}

export function senderIdFromEvent(event: webhook.Event): string {
  const source = event.source;
  if (!source) return "unknown";
  if (source.type === "user") return `line-user:${source.userId ?? "unknown"}`;
  if (source.type === "group") return `line-group:${source.groupId ?? "unknown"}`;
  if (source.type === "room") return `line-room:${source.roomId ?? "unknown"}`;
  return "unknown";
}

interface NormalizedLineMessage {
  externalId: string;
  sender: string;
  body: string;
  receivedAt: string;
  replyToken: string | null;
}

export function normalizeTextEvent(
  event: webhook.MessageEvent & { message: webhook.TextMessageContent }
): NormalizedLineMessage {
  return {
    externalId: event.webhookEventId,
    sender: senderIdFromEvent(event),
    body: event.message.text,
    receivedAt: new Date(event.timestamp).toISOString(),
    replyToken: event.replyToken ?? null,
  };
}

/** Best-effort confirmation reply; failures are swallowed so the webhook never fails on this. */
export async function replySafely(replyToken: string | null, text: string): Promise<void> {
  if (!replyToken || !config.isLineConfigured()) return;
  try {
    await lineClient().replyMessage(replyToken, { type: "text", text });
  } catch (err) {
    console.error("Failed to send LINE reply:", err);
  }
}
