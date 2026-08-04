import { Router, raw } from "express";
import type { webhook } from "@line/bot-sdk";
import { insertMessage, messageExists } from "../store/messageStore.js";
import { getAccountByProvider } from "../store/accountStore.js";
import { isTextMessageEvent, normalizeTextEvent, replySafely, verifyLineSignature } from "../services/line.js";
import { processMessage } from "../services/pipeline.js";

export const lineRouter = Router();

// LINE signature verification needs the exact raw request body, so this
// route parses it as raw bytes instead of using the app-wide JSON parser.
lineRouter.post("/", raw({ type: "*/*" }), async (req, res) => {
  const rawBody = (req.body as Buffer).toString("utf-8");
  const signature = req.header("x-line-signature");

  if (!verifyLineSignature(rawBody, signature)) {
    res.status(401).json({ error: "Invalid LINE signature" });
    return;
  }

  const payload = JSON.parse(rawBody) as webhook.CallbackRequest;
  const account = getAccountByProvider("line");

  for (const event of payload.events) {
    if (!isTextMessageEvent(event)) continue;
    const normalized = normalizeTextEvent(event);
    if (messageExists("line", normalized.externalId)) continue;

    const message = insertMessage({
      source: "line",
      externalId: normalized.externalId,
      accountId: account?.id ?? null,
      sender: normalized.sender,
      subject: null,
      body: normalized.body,
      receivedAt: normalized.receivedAt,
    });

    const detected = await processMessage(message);
    if (detected?.status === "created") {
      const when = new Date(detected.startAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
      await replySafely(normalized.replyToken, `予定表に追加しました:「${detected.title}」${when}`);
    }
  }

  // LINE requires a 200 response promptly; always acknowledge once processed.
  res.status(200).end();
});
