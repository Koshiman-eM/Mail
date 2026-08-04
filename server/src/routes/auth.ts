import { Router } from "express";
import { config } from "../config.js";
import { getAuthUrl, handleOAuthCallback } from "../services/gmail.js";

export const authRouter = Router();

authRouter.get("/google", (_req, res) => {
  if (!config.isGoogleConfigured()) {
    res.status(400).json({ error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET is not configured" });
    return;
  }
  res.redirect(getAuthUrl());
});

authRouter.get("/google/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  if (!code) {
    res.status(400).json({ error: "Missing authorization code" });
    return;
  }
  try {
    const account = await handleOAuthCallback(code);
    res.redirect(`/settings?connected=gmail&account=${encodeURIComponent(account.label)}`);
  } catch (err) {
    console.error("Google OAuth callback failed:", err);
    res.status(500).json({ error: "Failed to complete Google OAuth flow" });
  }
});
