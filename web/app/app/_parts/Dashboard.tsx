"use client";

import { useCallback, useEffect, useState } from "react";
import { fmtAgo, fmtMicroUsd, fmtUsd, fmtUtc } from "@/app/burns/format";
import { Button } from "@/app/components/Button";
import { CodeBlock } from "@/app/components/CodeBlock";
import { CopyButton } from "@/app/components/CopyButton";
import { Badge } from "@/app/components/Primitives";
import { CrtPanel, StateBlock } from "@/app/components/Retro";
import { SITE, STATUS } from "@/app/config";
import { getMe, getUsage, type Me, type TokenInfo, type Usage } from "../_lib/api";
import { maskKey, setupSnippet } from "../_lib/snippet";
import s from "../app.module.css";
import { BurnPanel } from "./BurnPanel";

const REFRESH_MS = 30_000;

export function Dashboard({
  apiKey,
  remembered,
  initialMe,
  token,
  tokenError,
  onRemember,
  onSignOut,
}: {
  apiKey: string;
  remembered: boolean;
  initialMe: Me;
  token: TokenInfo | null;
  tokenError: boolean;
  onRemember: (remember: boolean) => void;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<Me>(initialMe);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    const [m, u] = await Promise.allSettled([getMe(apiKey), getUsage(apiKey)]);
    if (m.status === "fulfilled") setMe(m.value);
    if (u.status === "fulfilled") {
      setUsage(u.value);
      setUsageError(null);
    } else {
      setUsageError(u.reason instanceof Error ? u.reason.message : "Couldn't load usage.");
    }
    setNow(Date.now());
  }, [apiKey]);

  useEffect(() => {
    // The default hosted URL is the production site; only print FORKBOMB_HOSTED_URL when this page is elsewhere.
    const here = window.location.origin;
    setOrigin(here === SITE.url.replace(/\/$/, "") ? null : here);
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const ws = me.workspace;
  const totals = usage?.totals;

  return (
    <div className="stack stack-lg">
      <CrtPanel as="section" title={`workspace · ${ws.label || ws.id}`} labelledBy="ws-h">
        <h2 id="ws-h" className="sr-only">
          Workspace
        </h2>
        <dl className={s.kv}>
          <div>
            <dt>Workspace ID</dt>
            <dd>
              <code>{ws.id}</code>
              <CopyButton text={ws.id} iconOnly label="Copy workspace ID" />
            </dd>
          </div>
          <div>
            <dt>Burn memo</dt>
            <dd>
              <code>{(token?.memoPrefix ?? "forkbomb:") + ws.id}</code>
              <CopyButton text={(token?.memoPrefix ?? "forkbomb:") + ws.id} iconOnly label="Copy burn memo" />
            </dd>
          </div>
          <div>
            <dt>API key</dt>
            <dd>
              <code title="Masked. Use Copy to get the full key.">{maskKey(apiKey)}</code>
              <CopyButton text={apiKey} iconOnly label="Copy API key" />
            </dd>
          </div>
          <div>
            <dt>Stored</dt>
            <dd className="cluster">
              <span className={s.muted}>{remembered ? "this device (local storage)" : "this tab only"}</span>
              <Button variant="ghost" size="sm" onClick={() => onRemember(!remembered)}>
                {remembered ? "Forget on close" : "Remember on this device"}
              </Button>
              <Button variant="ghost" size="sm" onClick={onSignOut}>
                Remove key
              </Button>
            </dd>
          </div>
        </dl>
      </CrtPanel>

      <dl className={s.stats} aria-label="Credit">
        <div className={s.statBox}>
          <dt>Credit balance</dt>
          <dd className={`${s.statValue} ${s.statHot}`}>{fmtMicroUsd(me.credits.balanceMicroUsd)}</dd>
        </div>
        <div className={s.statBox}>
          <dt>Credited · all time</dt>
          <dd className={s.statValue}>{totals ? fmtMicroUsd(totals.creditedMicroUsd) : <span className="skeleton" />}</dd>
        </div>
        <div className={s.statBox}>
          <dt>Spent</dt>
          <dd className={s.statValue}>{totals ? fmtMicroUsd(totals.costMicroUsd) : <span className="skeleton" />}</dd>
        </div>
        <div className={s.statBox}>
          <dt>Requests</dt>
          <dd className={s.statValue}>{totals ? totals.requests.toLocaleString("en-US") : <span className="skeleton" />}</dd>
        </div>
      </dl>

      <div className={s.dashGrid}>
        <BurnPanel token={token} tokenError={tokenError} workspaceId={ws.id} onCredited={() => void refresh()} />

        <div className="stack stack-lg">
          <CrtPanel
            as="section"
            title="hosted pool"
            labelledBy="pool-h"
            status={
              STATUS.hostedPoolLive ? (
                <Badge tone="ok" dot>
                  online
                </Badge>
              ) : (
                <Badge tone="warn" dot>
                  coming online
                </Badge>
              )
            }
          >
            <h2 id="pool-h" className={s.panelTitle}>
              Pricing
            </h2>
            <dl className={s.kv}>
              <div>
                <dt>Input</dt>
                <dd>{fmtUsd(me.pricing.inputPerMTokUsd)} / 1M tokens</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>{fmtUsd(me.pricing.outputPerMTokUsd)} / 1M tokens</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>
                  <code>{me.pricing.model}</code>
                </dd>
              </div>
            </dl>
            <p className={s.muted}>
              {STATUS.hostedPoolLive
                ? "Each request reserves its maximum cost, then refunds what it didn't use."
                : "The GPU pool isn't provisioned yet. Hosted requests answer 503 and charge nothing until it is. Credit you add stays in the workspace."}
            </p>
          </CrtPanel>

          <CrtPanel as="section" title="setup" labelledBy="setup-h">
            <h2 id="setup-h" className={s.panelTitle}>
              Point the CLI at this workspace
            </h2>
            <CodeBlock
              lang="sh"
              code={setupSnippet(maskKey(apiKey), origin)}
              copyText={setupSnippet(apiKey, origin)}
              ariaLabel="CLI setup for the hosted engine"
            />
            <p className={s.muted}>The copy button includes the full key. The page shows it masked.</p>
          </CrtPanel>
        </div>
      </div>

      <CrtPanel
        as="section"
        flush
        title="usage"
        labelledBy="usage-h"
        status={<span className={s.muted}>refreshes every 30 s</span>}
      >
        <h2 id="usage-h" className="sr-only">
          Usage, newest first
        </h2>
        {!usage && !usageError && (
          <StateBlock kind="loading" glyph="…" title="Loading usage…" className={s.state} />
        )}
        {usageError && !usage && (
          <StateBlock
            kind="error"
            title="Couldn't load usage"
            className={s.state}
            action={
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          >
            {usageError}
          </StateBlock>
        )}
        {usage && usage.usage.length === 0 && (
          <StateBlock kind="empty" glyph="0 req" title="No hosted requests yet." className={s.state}>
            Run the CLI with <code className="inline-code">--engine hosted</code> and each request shows up here with
            its tokens and cost.
          </StateBlock>
        )}
        {usage && usage.usage.length > 0 && (
          <div className={s.tableWrap}>
            <table className={s.table}>
              <caption className="sr-only">Hosted requests, newest first. {usage.usage.length} shown.</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Model</th>
                  <th scope="col" className={s.num}>
                    Input
                  </th>
                  <th scope="col" className={s.num}>
                    Output
                  </th>
                  <th scope="col" className={s.num}>
                    Cost
                  </th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {usage.usage.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <time dateTime={r.createdAt} title={fmtUtc(r.createdAt)}>
                        {fmtAgo(r.createdAt, now)}
                      </time>
                    </td>
                    <td>{r.model || "—"}</td>
                    <td className={s.num}>{r.inputTokens.toLocaleString("en-US")}</td>
                    <td className={s.num}>{r.outputTokens.toLocaleString("en-US")}</td>
                    <td className={s.num}>{fmtMicroUsd(r.costMicroUsd)}</td>
                    <td>
                      {r.status === "ok" ? (
                        <Badge tone="ok">ok</Badge>
                      ) : (
                        <Badge tone="signal">{r.status}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CrtPanel>
    </div>
  );
}
