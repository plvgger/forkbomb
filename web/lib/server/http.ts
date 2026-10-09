// JSON responses and errors for route handlers. Every error uses the OpenAI shape
// {"error":{"message","type","code"}} so the gateway and the site speak one format. No stack traces leak.
// That covers wrong methods (otherMethods) and unknown /api paths (app/api/[...path]). The one exception is the
// platform's own plain-text 413 for bodies over Vercel's 4.5 MB limit, which never reaches a handler.

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "rate_limit_error"
  | "server_error";

const TYPE_BY_STATUS: Record<number, ErrorType> = {
  401: "authentication_error",
  402: "billing_error",
  429: "rate_limit_error",
};

export class ApiError extends Error {
  readonly type: ErrorType;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.type = TYPE_BY_STATUS[status] ?? (status >= 500 ? "server_error" : "invalid_request_error");
  }

  toJSON() {
    return { error: { message: this.message, type: this.type, code: this.code } };
  }
}

export const NO_STORE = "no-store";
/** Public, briefly cached at the edge (ledger, price). */
export const PUBLIC_SHORT = "public, max-age=0, s-maxage=10, stale-while-revalidate=30";

export function json(data: unknown, init: { status?: number; headers?: Record<string, string>; cache?: string } = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": init.cache ?? NO_STORE,
      ...init.headers,
    },
  });
}

/** Turns any thrown value into a JSON error response. Unknown errors are logged and returned as a bare 500. */
export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json(err.toJSON(), { status: err.status, headers: err.headers });
  }
  console.error("[api] unhandled", err);
  return json(new ApiError(500, "internal_error", "Internal error. Try again.").toJSON(), { status: 500 });
}

/** Wraps a route handler so any throw becomes a JSON error (errors are always no-store). */
export function handler<A extends unknown[]>(
  fn: (req: Request, ...rest: A) => Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    try {
      return await fn(req, ...rest);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const METHODS: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
type RouteHandler = (req: Request) => Promise<Response>;

/**
 * Handlers for every method a route doesn't serve: a JSON 405 with an Allow header (Next.js alone answers an empty
 * 405), and an OPTIONS naming the real methods. Spread into the route's exports next to its real handlers:
 * `export const { GET, PUT, PATCH, DELETE, OPTIONS } = otherMethods("POST");`
 */
export function otherMethods<A extends Method>(...allowed: A[]): Record<Exclude<Method, A> | "OPTIONS", RouteHandler> {
  const served: readonly Method[] = allowed;
  const allow = [...served, ...(served.includes("GET") ? ["HEAD"] : []), "OPTIONS"].join(", ");
  const notAllowed: RouteHandler = async (req) =>
    json(new ApiError(405, "method_not_allowed", `${req.method} isn't supported here. Use ${served.join(" or ")}.`).toJSON(), {
      status: 405,
      headers: { Allow: allow },
    });
  const out: Record<string, RouteHandler> = { OPTIONS: async () => new Response(null, { status: 204, headers: { Allow: allow } }) };
  for (const m of METHODS) if (!served.includes(m)) out[m] = notAllowed;
  return out as Record<Exclude<Method, A> | "OPTIONS", RouteHandler>;
}

/** Parse a small JSON object body. Rejects non-objects and bodies over maxBytes. */
export async function readJsonObject(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new ApiError(413, "body_too_large", `Body over ${maxBytes} bytes.`);
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new ApiError(413, "body_too_large", `Body over ${maxBytes} bytes.`);
  }
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Body is not valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_json", "Body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Client IP as Vercel reports it. Only ever stored hashed. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}
