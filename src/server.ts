import { readFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import type { EventBus, Stamped } from "./events.js";
import { PKG_ROOT } from "./util.js";

const UI_FILES: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const TYPES: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css" };

/**
 * Serve the tree view. Live mode streams a run's events over SSE; replay mode
 * hands the browser a finished run's events and lets it replay them.
 */
export function serve(source: { live: EventBus } | { replay: Stamped[] }, port: number): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (path === "/data.js") {
      const body = "live" in source ? "window.FORKBOMB_LIVE = true;" : `window.FORKBOMB_EVENTS = ${JSON.stringify(source.replay)};`;
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(body);
      return;
    }
    if (path === "/events" && "live" in source) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const send = (e: Stamped) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of source.live.history) send(e);
      const off = source.live.on(send);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        off();
        clearInterval(ping);
      });
      return;
    }
    const file = UI_FILES[path];
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(join(PKG_ROOT, "ui", file));
    res.writeHead(200, { "content-type": TYPES[file.split(".").pop()!] ?? "text/plain", "cache-control": "no-store" }).end(body);
  });

  return new Promise((done, fail) => {
    const tryPort = (p: number, left: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && left > 0) tryPort(p + 1, left - 1);
        else fail(err);
      });
      server.listen(p, "127.0.0.1", () => done({ server, url: `http://127.0.0.1:${p}/` }));
    };
    tryPort(port, 20);
  });
}
