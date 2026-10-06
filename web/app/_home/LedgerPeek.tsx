"use client";

import { useEffect, useState } from "react";
import { StateBlock } from "../components";
import { SITE } from "../config";
import s from "./home.module.css";

/*
 * Live totals from the public burn ledger (GET /api/ledger).
 * Before launch (`live` false) it never fetches and shows the honest empty state.
 * After launch: loading -> totals, or the designed empty / error state. Never placeholder numbers.
 */

type Totals = { burns: number; burnedUi: number; burnedUsd: number };
type State = { kind: "loading" } | { kind: "error" } | { kind: "ok"; totals: Totals };

const num = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

function parse(body: unknown): Totals | null {
  if (!body || typeof body !== "object") return null;
  const t = (body as { totals?: Record<string, unknown> }).totals;
  if (!t || typeof t !== "object") return null;
  const totals = { burns: num(t.burns), burnedUi: num(t.burnedUi), burnedUsd: num(t.burnedUsd) };
  return Number.isFinite(totals.burns) ? totals : null;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function LedgerPeek({ live }: { live: boolean }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!live) return;
    const ac = new AbortController();
    fetch("/api/ledger?limit=1", { signal: ac.signal, headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        const totals = parse(body);
        setState(totals ? { kind: "ok", totals } : { kind: "error" });
      })
      .catch(() => {
        if (!ac.signal.aborted) setState({ kind: "error" });
      });
    return () => ac.abort();
  }, [live]);

  if (!live) {
    return (
      <StateBlock className={s.peekState} kind="empty" glyph="0 burns" title="Ledger opens at launch.">
        <p>
          {SITE.ticker} isn&apos;t live yet. Every burn will be listed with its transaction and the credit it
          produced.
        </p>
      </StateBlock>
    );
  }

  if (state.kind === "loading") {
    return <StateBlock className={s.peekState} kind="loading" title="Reading the ledger" />;
  }

  if (state.kind === "error") {
    return (
      <StateBlock className={s.peekState} kind="error" title="Ledger unavailable right now.">
        <p>Couldn&apos;t reach the ledger API. Burns are still on Solana; the full ledger may load.</p>
      </StateBlock>
    );
  }

  const t = state.totals;
  if (t.burns === 0) {
    return (
      <StateBlock className={s.peekState} kind="empty" glyph="0 burns" title="No burns yet.">
        <p>The first verified burn will show up here.</p>
      </StateBlock>
    );
  }

  return (
    <div className={s.peek}>
      <dl className={s.peekStats}>
        <div>
          <dt>burns</dt>
          <dd>{t.burns.toLocaleString("en-US")}</dd>
        </div>
        <div>
          <dt>{SITE.ticker} burned</dt>
          <dd>{Number.isFinite(t.burnedUi) ? compact.format(t.burnedUi) : "-"}</dd>
        </div>
        <div>
          <dt>USD at burn</dt>
          <dd>{Number.isFinite(t.burnedUsd) ? usd.format(t.burnedUsd) : "-"}</dd>
        </div>
      </dl>
    </div>
  );
}
