"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/app/components/Button";
import { Badge } from "@/app/components/Primitives";
import { CrtPanel, StateBlock } from "@/app/components/Retro";
import { SITE, STATUS, TOKEN_MEMO_PREFIX } from "@/app/config";
import { fmtAgo, fmtMicroUsd, fmtPrice, fmtTokens, fmtUsd, fmtUtc, short, solscanAccount, solscanTx } from "./format";
import s from "./burns.module.css";

const POLL_MS = 15_000;
const PAGE = 50;

type Burn = {
  signature: string;
  owner: string;
  amountUi: string;
  usdValue: string;
  creditMicroUsd: number;
  blockTime: string;
  status?: string;
};
type Totals = { burnedUi: string; burnedUsd: string; burns: number };
type Ledger = {
  burns: Burn[];
  totals: Totals | null;
  nextCursor: string | null;
};
type Price = {
  priceUsd: string | null;
  sampledAt: string | null;
  source: string | null;
  twapUsd: string | null;
  windowMinutes: number | null;
  samples: number | null;
};

type LedgerState =
  { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; data: Ledger; stale: boolean };
type PriceState = { kind: "loading" } | { kind: "none" } | { kind: "error" } | { kind: "ok"; data: Price };

const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Accepts {burns|items, totals, nextCursor}. Drops rows without a signature. */
function parseLedger(json: unknown): Ledger {
  const o = obj(json);
  if (!o) throw new Error("bad response");
  const rows = Array.isArray(o.burns) ? o.burns : Array.isArray(o.items) ? o.items : null;
  if (!rows) throw new Error("bad response");
  const burns: Burn[] = rows
    .map((r) => obj(r))
    .filter((r): r is Record<string, unknown> => !!r && typeof r.signature === "string" && r.signature.length > 0)
    .map((r) => ({
      signature: str(r.signature),
      owner: str(r.owner),
      amountUi: str(r.amountUi),
      usdValue: str(r.usdValue),
      creditMicroUsd: num(r.creditMicroUsd),
      blockTime: str(r.blockTime),
      status: typeof r.status === "string" ? r.status : undefined,
    }));
  const t = obj(o.totals);
  const totals: Totals | null = t
    ? {
        burnedUi: str(t.burnedUi),
        burnedUsd: str(t.burnedUsd),
        burns: num(t.burns),
      }
    : null;
  return {
    burns,
    totals,
    nextCursor: typeof o.nextCursor === "string" && o.nextCursor ? o.nextCursor : null,
  };
}

/** Accepts {latest:{ts,priceUsd,source}, twap:{priceUsd,windowMinutes,samples}} or {priceUsd, twapUsd, sampledAt}. */
function parsePrice(json: unknown): Price | null {
  const o = obj(json);
  if (!o) return null;
  const latest = obj(o.latest);
  const twap = obj(o.twap);
  const p: Price = {
    priceUsd: str(latest?.priceUsd ?? o.priceUsd) || null,
    sampledAt: str(latest?.ts ?? o.sampledAt) || null,
    source: str(latest?.source) || null,
    twapUsd: str(twap?.priceUsd ?? o.twapUsd) || null,
    windowMinutes: twap && Number.isFinite(num(twap.windowMinutes)) ? num(twap.windowMinutes) : null,
    samples: twap && Number.isFinite(num(twap.samples)) ? num(twap.samples) : null,
  };
  return p.priceUsd || p.twapUsd ? p : null;
}

async function getJson(url: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function errorMessage(body: unknown, status: number): string {
  const e = obj(obj(body)?.error);
  const m = typeof e?.message === "string" ? e.message : "";
  return m ? `${m} (HTTP ${status})` : `The ledger API answered HTTP ${status}.`;
}

export function LedgerLive() {
  const [ledger, setLedger] = useState<LedgerState>({ kind: "loading" });
  const [older, setOlder] = useState<Burn[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [price, setPrice] = useState<PriceState>({ kind: "loading" });
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const inflight = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    const [l, p] = await Promise.allSettled([
      getJson(`/api/ledger?limit=${PAGE}`, ac.signal),
      getJson("/api/price", ac.signal),
    ]);
    if (ac.signal.aborted) return;

    if (l.status === "fulfilled" && l.value.status >= 200 && l.value.status < 300) {
      try {
        const data = parseLedger(l.value.body);
        setLedger({ kind: "ok", data, stale: false });
        setUpdatedAt(Date.now());
      } catch {
        setLedger((prev) =>
          prev.kind === "ok"
            ? { ...prev, stale: true }
            : {
                kind: "error",
                message: "The ledger API sent a response this page can't read.",
              },
        );
      }
    } else {
      const message =
        l.status === "fulfilled" ? errorMessage(l.value.body, l.value.status) : "Couldn't reach the ledger API.";
      // Keep showing the last good data, marked stale, instead of blanking the table.
      setLedger((prev) => (prev.kind === "ok" ? { ...prev, stale: true } : { kind: "error", message }));
    }

    if (p.status === "fulfilled") {
      const { status, body } = p.value;
      if (status >= 200 && status < 300) {
        const data = parsePrice(body);
        setPrice(data ? { kind: "ok", data } : { kind: "none" });
      } else if (status === 404) {
        setPrice({ kind: "none" });
      } else {
        setPrice((prev) => (prev.kind === "ok" ? prev : { kind: "error" }));
      }
    } else {
      setPrice((prev) => (prev.kind === "ok" ? prev : { kind: "error" }));
    }
    setNow(Date.now());
  }, []);

  // Poll every 15 s while the tab is visible; refresh as soon as it becomes visible again.
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
      else setNow(Date.now());
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      inflight.current?.abort();
    };
  }, [refresh]);

  const head = ledger.kind === "ok" ? ledger.data.burns : [];
  const headSigs = new Set(head.map((b) => b.signature));
  const rows = [...head, ...older.filter((b) => !headSigs.has(b.signature))];
  const cursor = olderCursor === undefined ? (ledger.kind === "ok" ? ledger.data.nextCursor : null) : olderCursor;

  async function loadMore() {
    if (!cursor || moreBusy) return;
    setMoreBusy(true);
    setMoreError(false);
    try {
      const ac = new AbortController();
      const r = await getJson(`/api/ledger?limit=${PAGE}&cursor=${encodeURIComponent(cursor)}`, ac.signal);
      if (r.status < 200 || r.status >= 300) throw new Error(String(r.status));
      const page = parseLedger(r.body);
      setOlder((prev) => [...prev, ...page.burns]);
      setOlderCursor(page.nextCursor);
    } catch {
      setMoreError(true);
    } finally {
      setMoreBusy(false);
    }
  }

  const totals = ledger.kind === "ok" ? ledger.data.totals : null;
  const status =
    ledger.kind === "loading" ? (
      <Badge>connecting</Badge>
    ) : ledger.kind === "error" && !STATUS.tokenLive ? (
      // Before launch an unreachable ledger is expected, not an outage.
      <Badge tone="warn" dot>
        {SITE.ticker} launching
      </Badge>
    ) : ledger.kind === "error" ? (
      <Badge tone="signal" dot>
        offline
      </Badge>
    ) : ledger.stale ? (
      <Badge tone="warn" dot>
        stale · retrying
      </Badge>
    ) : (
      <Badge tone="signal" pulse>
        live · 15s
      </Badge>
    );

  return (
    <div className={s.live}>
      {/* ---------- Totals + price ---------- */}
      <div className={s.top}>
        <dl className={s.totals} aria-label="Ledger totals" aria-busy={ledger.kind === "loading" || undefined}>
          <div className={s.total}>
            <dt>Burned · {SITE.ticker}</dt>
            <dd className={s.totalValue}>
              {ledger.kind === "loading" ? <span className="skeleton" /> : totals ? fmtTokens(totals.burnedUi) : "—"}
            </dd>
          </div>
          <div className={s.total}>
            <dt>Burned · USD at burn time</dt>
            <dd className={s.totalValue}>
              {ledger.kind === "loading" ? <span className="skeleton" /> : totals ? fmtUsd(totals.burnedUsd) : "—"}
            </dd>
          </div>
          <div className={s.total}>
            <dt>Burns</dt>
            <dd className={`${s.totalValue} ${s.totalHot}`}>
              {ledger.kind === "loading" ? (
                <span className="skeleton" />
              ) : totals && Number.isFinite(totals.burns) ? (
                totals.burns.toLocaleString("en-US")
              ) : (
                "—"
              )}
            </dd>
          </div>
        </dl>

        <CrtPanel as="section" title="price feed" className={s.price} labelledBy="price-h">
          <h2 id="price-h" className="sr-only">
            Price feed
          </h2>
          {price.kind === "ok" ? (
            <dl className={s.priceList}>
              <div>
                <dt>Last sample</dt>
                <dd>
                  <span className={s.priceValue}>{fmtPrice(price.data.priceUsd)}</span>
                  <span className={s.priceMeta}>
                    {[price.data.source, price.data.sampledAt ? fmtAgo(price.data.sampledAt, now) : ""]
                      .filter(Boolean)
                      .join(" · ") || "—"}
                  </span>
                </dd>
              </div>
              <div>
                <dt>
                  TWAP
                  {price.data.windowMinutes ? ` · ${price.data.windowMinutes} min` : ""}
                </dt>
                <dd>
                  <span className={s.priceValue}>{fmtPrice(price.data.twapUsd)}</span>
                  <span className={s.priceMeta}>
                    {price.data.samples !== null
                      ? `${price.data.samples} sample${price.data.samples === 1 ? "" : "s"}`
                      : price.data.twapUsd
                        ? "time-weighted"
                        : "not enough samples"}
                  </span>
                </dd>
              </div>
            </dl>
          ) : (
            <div className={s.priceEmpty} role="status">
              <span className={s.priceGlyph} aria-hidden="true">
                {price.kind === "loading" ? "…" : price.kind === "error" && STATUS.tokenLive ? "ERR" : "$?"}
              </span>
              <p>
                {price.kind === "loading"
                  ? "Reading the price feed…"
                  : price.kind === "error" && STATUS.tokenLive
                    ? "Price feed offline. Burns are still priced from stored samples."
                    : STATUS.tokenLive
                      ? "No price samples yet."
                      : "No price yet. Sampling starts at launch."}
              </p>
            </div>
          )}
        </CrtPanel>
      </div>

      {/* ---------- Ledger table ---------- */}
      <CrtPanel as="section" flush labelledBy="ledger-h" title="tail -f burns.log" status={status} className={s.panel}>
        <h2 id="ledger-h" className="sr-only">
          Burns, newest first
        </h2>
        {ledger.kind === "loading" && (
          <StateBlock kind="loading" glyph="…" title="Loading…" className={s.state}>
            Reading burns from the ledger API.
          </StateBlock>
        )}
        {ledger.kind === "error" && !STATUS.tokenLive && (
          <StateBlock
            kind="empty"
            glyph="0 burns"
            title="No burns yet. The first one lands at launch."
            className={s.state}
            action={
              <Badge tone="signal" dot>
                {SITE.ticker} launching
              </Badge>
            }
          >
            {SITE.ticker} hasn&apos;t launched, so nothing can be burned yet. The ledger API opens with the token.
            <span className="sr-only">Ledger API status: {ledger.message}</span>
          </StateBlock>
        )}
        {ledger.kind === "error" && STATUS.tokenLive && (
          <StateBlock
            kind="error"
            glyph="ERR"
            title="Ledger offline"
            className={s.state}
            action={
              <Button variant="outline" size="sm" onClick={() => void refresh()}>
                Retry now
              </Button>
            }
          >
            {ledger.message} It retries every 15 seconds. Burns are recorded on Solana either way, so nothing is lost
            while this page can&apos;t read them.
          </StateBlock>
        )}
        {ledger.kind === "ok" && rows.length === 0 && (
          <StateBlock
            kind="empty"
            glyph="0 burns"
            title={STATUS.tokenLive ? "No burns yet." : "No burns yet. The first one lands at launch."}
            className={s.state}
            action={
              <Badge tone="signal" dot>
                {STATUS.tokenLive ? "waiting for the first burn" : `${SITE.ticker} launching`}
              </Badge>
            }
          >
            Every burn with a <code className="inline-code">{TOKEN_MEMO_PREFIX}&lt;workspaceId&gt;</code> memo shows up
            here once it&apos;s verified, with a link to its transaction.
          </StateBlock>
        )}
        {ledger.kind === "ok" && rows.length > 0 && (
          <>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <caption className="sr-only">
                  {SITE.ticker} burns, newest first. {rows.length} shown.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Wallet</th>
                    <th scope="col" className={s.num}>
                      Burned
                    </th>
                    <th scope="col" className={s.num}>
                      USD value
                    </th>
                    <th scope="col" className={s.num}>
                      Credit
                    </th>
                    <th scope="col">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => {
                    const walletUrl = solscanAccount(b.owner);
                    const txUrl = solscanTx(b.signature);
                    const review = b.status === "review";
                    return (
                      <tr key={b.signature}>
                        <td data-label="Time">
                          <time dateTime={b.blockTime} title={fmtUtc(b.blockTime)} className={s.time}>
                            <span>{fmtUtc(b.blockTime)}</span>
                            <span className={s.ago}>{fmtAgo(b.blockTime, now)}</span>
                          </time>
                        </td>
                        <td data-label="Wallet">
                          {walletUrl ? (
                            <a
                              href={walletUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={s.addr}
                              title={b.owner}
                              aria-label={`Wallet ${b.owner} on Solscan`}
                            >
                              {short(b.owner)}
                            </a>
                          ) : (
                            <span className={s.addr}>{b.owner ? short(b.owner) : "—"}</span>
                          )}
                        </td>
                        <td data-label="Burned" className={`${s.num} ${s.burned}`}>
                          {fmtTokens(b.amountUi)}
                        </td>
                        <td data-label="USD value" className={s.num}>
                          {fmtUsd(b.usdValue)}
                        </td>
                        <td data-label="Credit" className={s.num}>
                          {review ? (
                            <Badge tone="warn" dot>
                              held for review
                            </Badge>
                          ) : (
                            <span className={s.credit}>{fmtMicroUsd(b.creditMicroUsd)}</span>
                          )}
                        </td>
                        <td data-label="Tx">
                          {txUrl ? (
                            <a
                              href={txUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={s.tx}
                              aria-label={`Transaction ${b.signature} on Solscan`}
                            >
                              {short(b.signature, 5, 5)}
                              <span aria-hidden="true"> ↗</span>
                            </a>
                          ) : (
                            <span className={s.addr}>{short(b.signature, 5, 5)}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {(cursor || moreError) && (
              <div className={s.more}>
                <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={moreBusy || !cursor}>
                  {moreBusy ? "Loading…" : "Load older burns"}
                </Button>
                {moreError && <span className={s.moreErr}>Couldn&apos;t load older burns. Try again.</span>}
              </div>
            )}
          </>
        )}
      </CrtPanel>

      <p className={s.updated} aria-live="off">
        {updatedAt
          ? `Last read ${fmtAgo(new Date(updatedAt).toISOString(), now)} · refreshes every 15 s while this tab is open`
          : "Refreshes every 15 s while this tab is open"}
      </p>
    </div>
  );
}
