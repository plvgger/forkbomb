import { ApiError, handler } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Any /api path no route serves: a JSON 404 in the documented error shape, not the site's HTML 404 page.
// Real routes always win over this catch-all.
const notFound = handler(async () => {
  throw new ApiError(404, "not_found", "No API endpoint here. See /docs#api for the list.");
});

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
