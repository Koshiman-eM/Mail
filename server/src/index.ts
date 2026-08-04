import express from "express";
import cors from "cors";
import "./db.js"; // ensures schema is created before routes are registered
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { lineRouter } from "./routes/line.js";
import { messagesRouter } from "./routes/messages.js";
import { eventsRouter } from "./routes/events.js";
import { accountsRouter } from "./routes/accounts.js";
import { syncRouter } from "./routes/sync.js";
import { devRouter } from "./routes/dev.js";

const app = express();

app.use(cors());

// The LINE webhook needs the raw request body for signature verification,
// so it's mounted before the JSON body parser and parses its own body.
app.use("/webhook/line", lineRouter);

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/auth", authRouter);
app.use("/api/messages", messagesRouter);
app.use("/api/events", eventsRouter);
app.use("/api/accounts", accountsRouter);
app.use("/api/sync", syncRouter);
app.use("/api/dev", devRouter);

app.listen(config.port, () => {
  console.log(`Server listening on http://localhost:${config.port}`);
  if (!config.isGoogleConfigured()) {
    console.warn("GOOGLE_CLIENT_ID/SECRET not set - Gmail sync & Calendar creation are disabled.");
  }
  if (!config.isLineConfigured()) {
    console.warn("LINE_CHANNEL_SECRET/ACCESS_TOKEN not set - LINE webhook will reject all events.");
  }
});
