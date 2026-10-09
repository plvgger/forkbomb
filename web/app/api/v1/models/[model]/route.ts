import { hostedModelObject } from "@/lib/server/gateway/chat";
import { ApiError, handler, json, otherMethods, PUBLIC_SHORT } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/models/{model} -> the hosted model object, or 404 model_not_found for any other id.
export const GET = handler(async (_req: Request, ctx: { params: Promise<{ model: string }> }) => {
  const { model } = await ctx.params;
  const hosted = hostedModelObject();
  if (model !== hosted.id) {
    throw new ApiError(404, "model_not_found", `The only model here is ${hosted.id}.`);
  }
  return json(hosted, { cache: PUBLIC_SHORT });
});
export const { POST, PUT, PATCH, DELETE, OPTIONS } = otherMethods("GET");
