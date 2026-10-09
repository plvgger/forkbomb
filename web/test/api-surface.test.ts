// The API's edges: model listing for OpenAI clients, CORS on /api/v1, and JSON errors for wrong methods and
// unknown paths (Next.js alone answers those with an empty 405 and the site's HTML 404 page).

import { describe, expect, it } from "vitest";
import * as catchAll from "../app/api/[...path]/route";
import * as grant from "../app/api/admin/grant/route";
import * as verify from "../app/api/burns/verify/route";
import * as cron from "../app/api/cron/price/route";
import * as ledger from "../app/api/ledger/route";
import * as price from "../app/api/price/route";
import * as rpc from "../app/api/rpc/route";
import * as token from "../app/api/token/route";
import * as chat from "../app/api/v1/chat/completions/route";
import * as me from "../app/api/v1/me/route";
import * as modelOne from "../app/api/v1/models/[model]/route";
import * as models from "../app/api/v1/models/route";
import * as usage from "../app/api/v1/usage/route";
import * as workspaces from "../app/api/workspaces/route";
import nextConfig from "../next.config.mjs";
import { HEADER_COST, HEADER_REMAINING, HEADER_RESERVED, hostedModel } from "../lib/server/gateway/chat";

const BASE = "https://site.test";
type Handler = (req: Request) => Promise<Response>;
const req = (method: string, path = "/api/x") => new Request(`${BASE}${path}`, { method });

describe("GET /api/v1/models", () => {
  it("lists the hosted model, with or without a key", async () => {
    for (const headers of [{}, { authorization: "Bearer forkbomb_sk_whatever" }] as Record<string, string>[]) {
      const res = await models.GET(new Request(`${BASE}/api/v1/models`, { headers }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      expect(await res.json()).toEqual({
        object: "list",
        data: [{ id: hostedModel(), object: "model", created: expect.any(Number), owned_by: "forkbomb" }],
      });
    }
  });

  it("answers the hosted model by id and 404s any other", async () => {
    const one = (id: string) => modelOne.GET(req("GET", `/api/v1/models/${id}`), { params: Promise.resolve({ model: id }) });
    const ok = await one(hostedModel());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: hostedModel(), object: "model" });
    const missing = await one("gpt-4o");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "model_not_found", type: "invalid_request_error" } });
  });
});

describe("wrong methods", () => {
  const ROUTES: [string, Record<string, unknown>, string[]][] = [
    ["/api/token", token, ["GET"]],
    ["/api/ledger", ledger, ["GET"]],
    ["/api/price", price, ["GET"]],
    ["/api/workspaces", workspaces, ["POST"]],
    ["/api/rpc", rpc, ["POST"]],
    ["/api/burns/verify", verify, ["POST"]],
    ["/api/admin/grant", grant, ["POST"]],
    ["/api/cron/price", cron, ["GET", "POST"]],
    ["/api/v1/chat/completions", chat, ["POST"]],
    ["/api/v1/me", me, ["GET"]],
    ["/api/v1/usage", usage, ["GET"]],
    ["/api/v1/models", models, ["GET"]],
    ["/api/v1/models/[model]", modelOne, ["GET"]],
  ];

  it("get a JSON 405 with an Allow header naming the real methods", async () => {
    for (const [path, mod, served] of ROUTES) {
      const allow = [...served, ...(served.includes("GET") ? ["HEAD"] : []), "OPTIONS"].join(", ");
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => !served.includes(m))) {
        const fn = mod[method] as Handler | undefined;
        expect(fn, `${method} ${path}`).toBeTypeOf("function");
        const res = await fn!(req(method, path));
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get("allow"), `${method} ${path}`).toBe(allow);
        expect(await res.json(), `${method} ${path}`).toMatchObject({
          error: { code: "method_not_allowed", type: "invalid_request_error", message: expect.stringContaining(served[0]!) },
        });
      }
      const options = await (mod.OPTIONS as Handler)(req("OPTIONS", path));
      expect(options.status, `OPTIONS ${path}`).toBe(204);
      expect(options.headers.get("allow"), `OPTIONS ${path}`).toBe(allow);
    }
  });
});

describe("unknown /api paths", () => {
  it("get a JSON 404 for every method", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const res = await (catchAll[method] as Handler)(req(method, "/api/nope"));
      expect(res.status, method).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      expect(await res.json()).toMatchObject({ error: { code: "not_found", type: "invalid_request_error" } });
    }
  });
});

describe("response headers (next.config.mjs)", () => {
  const rules = async () => (await nextConfig.headers()) as { source: string; headers: { key: string; value: string }[] }[];
  const header = (rule: { headers: { key: string; value: string }[] } | undefined, key: string) =>
    rule?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;

  it("lets browser OpenAI clients call /api/v1 with a Bearer key and read the credit headers", async () => {
    const v1 = (await rules()).find((r) => r.source === "/api/v1/:path*");
    expect(header(v1, "Access-Control-Allow-Origin")).toBe("*");
    expect(header(v1, "Access-Control-Allow-Methods")).toMatch(/GET.*POST.*OPTIONS/);
    // "*" never covers Authorization, so it must be named.
    expect(header(v1, "Access-Control-Allow-Headers")).toMatch(/^Authorization, Content-Type, \*$/);
    const exposed = header(v1, "Access-Control-Expose-Headers")?.split(/,\s*/) ?? [];
    for (const h of [HEADER_REMAINING, HEADER_COST, HEADER_RESERVED, "x-request-id", "retry-after"]) expect(exposed).toContain(h);
    expect(header(v1, "Access-Control-Allow-Credentials")).toBeUndefined();
    // Only /api/v1 is cross-origin; the site's other API routes stay same-origin.
    expect((await rules()).filter((r) => r.headers.some((h) => h.key === "Access-Control-Allow-Origin")).map((r) => r.source)).toEqual([
      "/api/v1/:path*",
    ]);
  });

  it("reports (without enforcing yet) a policy that keeps scripts, frames and fetches on this origin", async () => {
    const all = (await rules()).find((r) => r.source === "/:path*");
    const csp = header(all, "Content-Security-Policy-Report-Only") ?? "";
    for (const d of ["default-src 'self'", "connect-src 'self'", "frame-src 'self'", "object-src 'none'", "base-uri 'self'"]) {
      expect(csp).toContain(d);
    }
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline'(;|$)/); // no unsafe-eval outside dev
    expect(csp).not.toContain("frame-ancestors"); // ignored in report-only; enforced in the main policy
    expect(header(all, "Content-Security-Policy")).toContain("frame-ancestors 'self'");
  });
});
