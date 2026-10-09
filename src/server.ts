import { readFile } from "node:fs/promises";
import { type IncomingMessage, type Server, createServer } from "node:http";
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
 * Only this machine's own names for the server count. A page elsewhere that rebinds its hostname to 127.0.0.1
 * still sends its own name as Host, so it gets nothing.
 */
function trustedHost(req: IncomingMessage, port: number): boolean {
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host ?? "").toLowerCase());
}

/** Browsers mark requests another site's page makes (a <script src>, a fetch) as cross-site. The run's data is never for them. */
function crossSite(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  return site === "cross-site" || site === "same-site";
}

/**
 * Serve the tree view on 127.0.0.1. Live mode streams a run's events over SSE; replay mode hands the browser
 * a finished run's events as JSON for it to replay. Neither is readable from another site: the events are
 * same-origin JSON or SSE (never a script that sets a global, which any page could include), and requests
 * with a foreign Host or a cross-site fetch mark are refused.
 */
export function serve(source: { live: EventBus } | { replay: Stamped[] }, port: number): Promise<{ server: Server; url: string }> {
  let bound = port;
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };
    if (req.method !== "GET") {
      res.writeHead(405, headers).end();
      return;
    }
    if (!trustedHost(req, bound)) {
      res.writeHead(403, headers).end("forbidden");
      return;
    }
    if (path === "/data.js") {
      // Only says where the events are; the events themselves never go out as a script.
      const body = "live" in source ? "window.FORKBOMB_LIVE = true;" : 'window.FORKBOMB_EVENTS_URL = "events.json";';
      res.writeHead(200, { ...headers, "content-type": "text/javascript" }).end(body);
      return;
    }
    if (crossSite(req)) {
      res.writeHead(403, headers).end("forbidden");
      return;
    }
    if (path === "/events.json" && "replay" in source) {
      res.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify(source.replay));
      return;
    }
    if (path === "/events" && "live" in source) {
      res.writeHead(200, { ...headers, "content-type": "text/event-stream", connection: "keep-alive" });
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
      res.writeHead(404, headers).end("not found");
      return;
    }
    const body = await readFile(join(PKG_ROOT, "ui", file));
    res.writeHead(200, { ...headers, "content-type": TYPES[file.split(".").pop()!] ?? "text/plain" }).end(body);
  });

  return new Promise((done, fail) => {
    const tryPort = (p: number, left: number) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && left > 0) tryPort(p + 1, left - 1);
        else fail(err);
      });
      server.listen(p, "127.0.0.1", () => {
        bound = (server.address() as { port: number }).port;
        done({ server, url: `http://127.0.0.1:${bound}/` });
      });
    };
    tryPort(port, 20);
  });
}
