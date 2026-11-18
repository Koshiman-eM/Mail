import { subscribeNotifications } from "@/lib/notifications/bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Server-Sent Events: 新着通知をリアルタイム配信 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      send("ready", { at: new Date().toISOString() });
      const unsub = subscribeNotifications((n) => send("notification", n));
      const ping = setInterval(() => controller.enqueue(encoder.encode(`: ping\n\n`)), 25_000);
      cleanup = () => {
        clearInterval(ping);
        unsub();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
