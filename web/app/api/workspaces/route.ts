import { handler, json, readJsonObject, clientIp } from "@/lib/server/http";
import { hashIp } from "@/lib/server/keys";
import { enforce } from "@/lib/server/ratelimit";
import { burnMemo, createWorkspace, parseLabel } from "@/lib/server/workspaces";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/workspaces {label?} -> {workspace, apiKey, burnMemo}. The key is shown once and never again.
export const POST = handler(async (req: Request) => {
  const ipHash = hashIp(clientIp(req));
  await enforce("workspace_create", ipHash);
  const body = await readJsonObject(req);
  const label = parseLabel(body.label);
  const { workspace, apiKey } = await createWorkspace({ label, ipHash });
  return json({ workspace, apiKey, burnMemo: burnMemo(workspace.id) }, { status: 201 });
});
