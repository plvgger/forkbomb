import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { EventBus, type Stamped } from "../src/events.js";
import { serve } from "../src/server.js";

const EVENTS = [{ type: "run_start", runId: "r", task: "secret task", testCmd: "true", forks: 1, rounds: 1, model: "m", engine: "api", effort: "low", mode: "race", repo: "/private/x", forker: "copy", sandbox: true, network: false, t: 1 }] as unknown as Stamped[];

/** A GET with whatever Host and fetch-metadata headers a browser (or a rebound hostname) would send. */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => {
        body += d.toString();
        if (path === "/events") res.destroy(); // first SSE chunk is enough
      });
      const end = () => done({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body });
      res.on("end", end);
      res.on("close", end);
    });
    req.on("error", fail);
    req.end();
  });
}

describe("replay and live server", () => {
  it("serves a recorded run to its own page only: no events in a script, no foreign Host, no cross-site reads (regression)", async () => {
    const { server, url } = await serve({ replay: EVENTS }, 4400 + Math.floor(Math.random() * 400));
    const port = Number(new URL(url).port);
    try {
      // The script any page could include carries no run data.
      const data = await get(port, "/data.js");
      expect(data.status).toBe(200);
      expect(data.body).not.toContain("secret task");
      expect(data.body).not.toContain("FORKBOMB_EVENTS =");
      // The page itself fetches them as JSON, same-origin.
      const json = await get(port, "/events.json", { "sec-fetch-site": "same-origin" });
      expect(json).toMatchObject({ status: 200, type: "application/json" });
      expect(JSON.parse(json.body)).toEqual(EVENTS);
      expect((await get(port, "/events.json", { host: `localhost:${port}` })).status).toBe(200);
      // DNS rebinding: the request reaches 127.0.0.1 but names another host.
      expect((await get(port, "/events.json", { host: `evil.example:${port}` })).status).toBe(403);
      expect((await get(port, "/", { host: `evil.example:${port}` })).status).toBe(403);
      // Another site's page asking for the data.
      expect((await get(port, "/events.json", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    } finally {
      server.close();
    }
  });

  it("streams a live run only to its own page", async () => {
    const bus = new EventBus();
    bus.emit({ type: "log", level: "info", msg: "hello" });
    const { server, url } = await serve({ live: bus }, 4800 + Math.floor(Math.random() * 400));
    const port = Number(new URL(url).port);
    try {
      const ok = await get(port, "/events");
      expect(ok.status).toBe(200);
      expect(ok.body).toContain("hello");
      expect((await get(port, "/events", { host: `evil.example:${port}` })).status).toBe(403);
      expect((await get(port, "/events", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
