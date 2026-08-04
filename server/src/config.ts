function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dbPath: process.env.DB_PATH ?? "./data/app.db",

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ??
      "http://localhost:4000/auth/google/callback",
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary",
  },

  line: {
    channelSecret: process.env.LINE_CHANNEL_SECRET ?? "",
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN ?? "",
  },

  // When true, detected schedules are pushed to Google Calendar automatically.
  // When false, they are only surfaced as "pending" for manual confirmation
  // in the UI (POST /api/events/:id/create).
  autoCreateEvents: bool(process.env.AUTO_CREATE_EVENTS, true),

  // Enables POST /api/dev/seed for demoing the pipeline without real
  // Gmail/LINE credentials configured.
  enableDevSeed: bool(process.env.ENABLE_DEV_SEED, true),

  isGoogleConfigured(): boolean {
    return Boolean(this.google.clientId && this.google.clientSecret);
  },

  isLineConfigured(): boolean {
    return Boolean(this.line.channelSecret && this.line.channelAccessToken);
  },
};
