import { hostedModelObject } from "@/lib/server/gateway/chat";
import { handler, json, otherMethods, PUBLIC_SHORT } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/models -> {object:"list", data:[{id, object:"model", created, owned_by}]}: the one hosted model.
// No key needed: OpenAI clients list models before (and to check) a key. The upstream model stays private.
export const GET = handler(async () => json({ object: "list", data: [hostedModelObject()] }, { cache: PUBLIC_SHORT }));
export const { POST, PUT, PATCH, DELETE, OPTIONS } = otherMethods("GET");
