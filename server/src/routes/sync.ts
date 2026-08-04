import { Router } from "express";
import { fetchRecentMessages } from "../services/gmail.js";
import { getAccountByProvider } from "../store/accountStore.js";
import { insertMessage, messageExists } from "../store/messageStore.js";
import { processMessage } from "../services/pipeline.js";

export const syncRouter = Router();

syncRouter.post("/gmail", async (_req, res) => {
  try {
    const account = getAccountByProvider("gmail");
    const fetched = await fetchRecentMessages();

    let created = 0;
    let detectedEvents = 0;
    for (const item of fetched) {
      if (messageExists("gmail", item.externalId)) continue;
      const message = insertMessage({
        source: "gmail",
        externalId: item.externalId,
        accountId: account?.id ?? null,
        sender: item.sender,
        subject: item.subject,
        body: item.body,
        receivedAt: item.receivedAt,
      });
      created += 1;
      const detected = await processMessage(message);
      if (detected) detectedEvents += 1;
    }

    res.json({ fetched: fetched.length, newMessages: created, detectedEvents });
  } catch (err) {
    console.error("Gmail sync failed:", err);
    const message = err instanceof Error ? err.message : "Gmail sync failed";
    res.status(400).json({ error: message });
  }
});
