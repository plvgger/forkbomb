import { chatCompletions } from "@/lib/server/gateway/chat";
import { handler } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Must equal ROUTE_MAX_DURATION_S in lib/server/gateway/chat.ts (Next.js needs a literal here; a test checks).
 * The gateway gives up 20s before this, so a timed-out call still settles its reservation.
 */
export const maxDuration = 300;

// POST /api/v1/chat/completions (Bearer key): OpenAI Chat Completions, metered against workspace credit.
// Streaming (stream: true) and tool calling pass through. The model is always the hosted one.
export const POST = handler((req: Request) => chatCompletions(req));
