import { getConfig } from "@/lib/server/config";
import { getBalance } from "@/lib/server/credits";
import { hostedModel } from "@/lib/server/gateway/chat";
import { handler, json } from "@/lib/server/http";
import { authenticate } from "@/lib/server/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/v1/me (Bearer key) -> workspace, spendable credit and current pricing.
// balanceMicroUsd is the exact integer; the *Usd numbers are for display.
export const GET = handler(async (req: Request) => {
  const workspace = await authenticate(req);
  const balance = await getBalance(workspace.id);
  const { pricing } = getConfig();
  return json({
    workspace,
    credits: { balanceMicroUsd: balance, balanceUsd: balance / 1e6 },
    pricing: {
      inputPerMTokUsd: pricing.inputPerMTokMicroUsd / 1e6,
      outputPerMTokUsd: pricing.outputPerMTokMicroUsd / 1e6,
      model: hostedModel(), // the same public name chat completions report; the upstream model stays private
    },
  });
});
