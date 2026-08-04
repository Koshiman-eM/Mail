import { Router } from "express";
import { config } from "../config.js";
import { insertMessage } from "../store/messageStore.js";
import { processMessage } from "../services/pipeline.js";

export const devRouter = Router();

const SAMPLE_MESSAGES: Array<{
  source: "gmail" | "line";
  sender: string;
  subject: string | null;
  body: string;
}> = [
  {
    source: "gmail",
    sender: "yamada@example.com",
    subject: "来週の定例ミーティングについて",
    body: "お疲れ様です。来週の8月12日 15時から定例ミーティングを行います。場所：会議室B\nご確認よろしくお願いします。",
  },
  {
    source: "line",
    sender: "line-user:demo",
    subject: null,
    body: "明日の19時に渋谷で飲み会やるよ！",
  },
  {
    source: "gmail",
    sender: "newsletter@example.com",
    subject: "週刊ニュースレター",
    body: "今週のおすすめ記事をお届けします。日時の指定はありません。",
  },
];

// Lets the app be demoed end-to-end (unified inbox + schedule detection)
// without real Gmail/LINE credentials configured. Disabled via
// ENABLE_DEV_SEED=false.
devRouter.post("/seed", async (_req, res) => {
  if (!config.enableDevSeed) {
    res.status(403).json({ error: "Dev seed is disabled (ENABLE_DEV_SEED=false)" });
    return;
  }

  const results = [];
  for (const sample of SAMPLE_MESSAGES) {
    const message = insertMessage({
      source: sample.source,
      externalId: `seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      accountId: null,
      sender: sample.sender,
      subject: sample.subject,
      body: sample.body,
      receivedAt: new Date().toISOString(),
    });
    const event = await processMessage(message);
    results.push({ message, event });
  }

  res.json(results);
});
