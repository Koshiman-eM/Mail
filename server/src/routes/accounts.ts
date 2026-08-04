import { Router } from "express";
import { config } from "../config.js";
import { listAccounts } from "../store/accountStore.js";

export const accountsRouter = Router();

accountsRouter.get("/", (_req, res) => {
  const accounts = listAccounts().map((a) => ({
    id: a.id,
    provider: a.provider,
    label: a.label,
    createdAt: a.createdAt,
  }));

  res.json({
    accounts,
    line: {
      configured: config.isLineConfigured(),
      // The LINE bot itself has no OAuth "connect" step; once the channel
      // secret/access token are set, it's ready to receive the webhook.
      ready: config.isLineConfigured(),
    },
    google: {
      configured: config.isGoogleConfigured(),
      connected: accounts.some((a) => a.provider === "gmail"),
    },
  });
});
