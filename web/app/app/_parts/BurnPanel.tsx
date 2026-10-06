"use client";

import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { fmtMicroUsd, fmtPrice, fmtUsd, short } from "@/app/burns/format";
import { Button } from "@/app/components/Button";
import { Badge, Callout } from "@/app/components/Primitives";
import { CrtPanel } from "@/app/components/Retro";
import { ISSUES_URL, SITE } from "@/app/config";
import {
  estimateCreditMicroUsd,
  formatRaw,
  formatRawGrouped,
  lowerPrice,
  parseScaled,
  parseUiAmount,
  priceIsFresh,
} from "../_lib/amount";
import { ApiFailure, type BurnRecord, getPrice, type Price, type TokenInfo, verifyBurn } from "../_lib/api";
import { shouldRetry, VERIFY_DEADLINE_MS, VERIFY_POLL_MS, verifyCopy } from "../_lib/burnErrors";
import { associatedTokenAccount, buildBurnTransaction } from "../_lib/burnTx";
import { latestBlockhash, solBalanceLamports, tokenBalances } from "../_lib/rpc";
import { dropPending, loadPending, savePending } from "../_lib/session";
import { explorerAccount, explorerTx } from "../_lib/snippet";
import {
  chainOf,
  connectWallet,
  disconnectWallet,
  isUserRejection,
  onAccountsChange,
  signAndSend,
  txVersionFor,
  watchWallets,
} from "../_lib/wallets";
import s from "../app.module.css";

/** A burn needs SOL for the network fee (5,000 lamports base). Warn below this. */
const MIN_FEE_LAMPORTS = 10_000n;
const PRICE_REFRESH_MS = 60_000;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

type Connected = { wallet: Wallet; account: WalletAccount };
type Balances =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; ata: bigint; ataExists: boolean; elsewhere: bigint; sol: bigint }
  | { kind: "error"; message: string };
type Burn =
  | { kind: "idle" }
  | { kind: "building" }
  | { kind: "signing" }
  | { kind: "verifying"; signature: string; title: string; body: string }
  | { kind: "done"; signature: string; record: BurnRecord }
  | { kind: "failed"; signature: string | null; title: string; body: string; canRetry: boolean };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(t);
      resolve();
    });
  });

export function BurnPanel({
  token,
  tokenError,
  workspaceId,
  onCredited,
}: {
  token: TokenInfo | null;
  tokenError: boolean;
  workspaceId: string;
  onCredited: () => void;
}) {
  const ticker = SITE.ticker;
  const open = !!token?.burnsOpen && !!token.mint && token.decimals !== null && !!token.program;
  const cluster = token?.cluster ?? "mainnet";
  const chain = chainOf(cluster);

  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [conn, setConn] = useState<Connected | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Balances>({ kind: "idle" });
  const [price, setPrice] = useState<Price | null>(null);
  const [priceError, setPriceError] = useState(false);
  const [amount, setAmount] = useState("");
  const [burn, setBurn] = useState<Burn>({ kind: "idle" });
  const [manualSig, setManualSig] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const poll = useRef<AbortController | null>(null);

  // ---- wallets ----
  useEffect(() => watchWallets(chain, setWallets), [chain]);

  useEffect(() => {
    if (!conn) return;
    return onAccountsChange(conn.wallet, (accounts) => {
      const next = accounts.find((a) => a.chains.includes(chain));
      setConn(next ? { wallet: conn.wallet, account: next } : null);
    });
  }, [conn, chain]);

  const loadBalances = useCallback(async () => {
    if (!conn || !open) return;
    setBalances({ kind: "loading" });
    try {
      const owner = conn.account.address;
      const ata = await associatedTokenAccount(owner, token!.mint!, token!.program!);
      const [t, sol] = await Promise.all([tokenBalances(owner, token!.mint!, ata), solBalanceLamports(owner)]);
      setBalances({ kind: "ok", ...t, sol });
    } catch (err) {
      setBalances({ kind: "error", message: err instanceof Error ? err.message : "Couldn't read balances." });
    }
  }, [conn, open, token]);

  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  // ---- price ----
  useEffect(() => {
    if (!open) return;
    const read = () =>
      getPrice().then(
        (p) => {
          setPrice(p);
          setPriceError(false);
          setNow(Date.now());
        },
        () => setPriceError(true),
      );
    void read();
    const id = window.setInterval(read, PRICE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [open]);

  // ---- verify poller ----
  // Callbacks change on every parent render; read them through a ref so the poller (and the resume effect) stay stable.
  const after = useRef({ onCredited, loadBalances });
  after.current = { onCredited, loadBalances };

  const startVerify = useCallback(
    async (signature: string) => {
      poll.current?.abort();
      const ac = new AbortController();
      poll.current = ac;
      const deadline = Date.now() + VERIFY_DEADLINE_MS;
      let wait = 0;
      setBurn({ kind: "verifying", signature, title: "Verifying", body: "Reading the burn back from Solana." });
      while (!ac.signal.aborted) {
        if (wait) await sleep(wait, ac.signal);
        if (ac.signal.aborted) return;
        try {
          const record = await verifyBurn(signature);
          if (ac.signal.aborted) return;
          dropPending(signature);
          setBurn({ kind: "done", signature, record });
          after.current.onCredited();
          void after.current.loadBalances();
          return;
        } catch (err) {
          if (ac.signal.aborted) return;
          const code = err instanceof ApiFailure ? err.code : "network";
          const status = err instanceof ApiFailure ? err.status : 0;
          const copy = verifyCopy(code, ticker);
          if (shouldRetry(code, status) && Date.now() < deadline) {
            setBurn({ kind: "verifying", signature, title: copy.title, body: copy.body });
            wait = Math.max(VERIFY_POLL_MS, ((err instanceof ApiFailure && err.retryAfterS) || 0) * 1000);
            continue;
          }
          if (copy.retry) {
            // Out of time, not out of luck: the burn may still finalize. Keep it pending for the next visit.
            setBurn({
              kind: "failed",
              signature,
              title: "Still not credited",
              body: `${copy.body} Stopped checking after 3 minutes. If the burn went through, it is on chain and will verify when you check again.`,
              canRetry: true,
            });
          } else {
            dropPending(signature);
            setBurn({ kind: "failed", signature, title: copy.title, body: copy.body, canRetry: false });
          }
          return;
        }
      }
    },
    [ticker],
  );

  // Resume a burn that was sent but not credited before a reload. Stop polling on unmount.
  useEffect(() => {
    const pending = loadPending(workspaceId);
    const last = pending[pending.length - 1];
    if (last) void startVerify(last.signature);
    return () => poll.current?.abort();
  }, [workspaceId, startVerify]);

  // ---- derived ----
  const decimals = token?.decimals ?? 0;
  const parsed = open ? parseUiAmount(amount, decimals) : null;
  const balance = balances.kind === "ok" ? balances.ata : null;
  const overBalance = parsed?.ok && balance !== null && parsed.raw > balance;
  const lowSol = balances.kind === "ok" && balances.sol < MIN_FEE_LAMPORTS;
  const burnPrice = price ? lowerPrice(price.priceUsd, price.twapUsd) : null;
  const fresh = !!price && priceIsFresh(price.sampledAt, now);
  const estimate =
    parsed?.ok && burnPrice ? estimateCreditMicroUsd(parsed.raw, decimals, burnPrice, token?.creditMultiplier ?? "1") : null;
  const capMicro = token ? parseScaled(token.maxCreditPerBurnUsd, 6) : null;
  const overCap = estimate !== null && capMicro !== null && BigInt(estimate) > capMicro;
  const busy = burn.kind === "building" || burn.kind === "signing" || burn.kind === "verifying";
  const canBurn = open && !!conn && !!parsed?.ok && !overBalance && !lowSol && fresh && !busy && balances.kind === "ok";

  async function connect(wallet: Wallet) {
    setConnectError(null);
    setConnecting(wallet.name);
    try {
      setConn({ wallet, account: await connectWallet(wallet, chain) });
    } catch (err) {
      setConnectError(isUserRejection(err) ? "You declined the connection in your wallet." : errText(err));
    } finally {
      setConnecting(null);
    }
  }

  async function disconnect() {
    if (conn) await disconnectWallet(conn.wallet);
    setConn(null);
    setBalances({ kind: "idle" });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canBurn || !conn || !parsed?.ok || !token) return;
    const version = txVersionFor(conn.wallet);
    if (version === null) {
      setBurn({ kind: "failed", signature: null, title: "Wallet can't send this", body: `${conn.wallet.name} doesn't support legacy or v0 transactions.`, canRetry: false });
      return;
    }
    setBurn({ kind: "building" });
    let tx: Uint8Array;
    try {
      tx = await buildBurnTransaction(
        {
          owner: conn.account.address,
          mint: token.mint!,
          program: token.program!,
          amount: parsed.raw,
          decimals,
          workspaceId,
          memoPrefix: token.memoPrefix,
        },
        await latestBlockhash(),
        version,
      );
    } catch (err) {
      setBurn({ kind: "failed", signature: null, title: "Couldn't build the transaction", body: `${errText(err)} Nothing was sent.`, canRetry: false });
      return;
    }
    setBurn({ kind: "signing" });
    let signature: string;
    try {
      signature = await signAndSend(conn.wallet, conn.account, chain, tx);
    } catch (err) {
      setBurn(
        isUserRejection(err)
          ? { kind: "failed", signature: null, title: "Cancelled", body: "You declined in your wallet. Nothing was burned.", canRetry: false }
          : { kind: "failed", signature: null, title: "The wallet didn't send it", body: `${errText(err)} Nothing was burned.`, canRetry: false },
      );
      return;
    }
    savePending({ signature, workspaceId, at: Date.now() });
    setAmount("");
    void startVerify(signature);
  }

  function checkManual(e: FormEvent) {
    e.preventDefault();
    const sig = manualSig.trim();
    if (!SIG_RE.test(sig)) {
      setBurn({ kind: "failed", signature: null, ...pick(verifyCopy("invalid_signature", ticker)), canRetry: false });
      return;
    }
    savePending({ signature: sig, workspaceId, at: Date.now() });
    setManualSig("");
    void startVerify(sig);
  }

  const statusBadge = !token ? (
    tokenError ? <Badge tone="signal" dot>token info offline</Badge> : <Badge>loading</Badge>
  ) : open ? (
    <Badge tone="ok" dot>
      burns open
    </Badge>
  ) : (
    <Badge tone="signal" dot>
      opens at launch
    </Badge>
  );

  return (
    <CrtPanel as="section" title={`burn ${ticker}`} status={statusBadge} labelledBy="burn-h">
      <div className="stack stack-lg">
        <div className="stack stack-xs">
          <h2 id="burn-h" className={s.panelTitle}>
            Burn for credit
          </h2>
          <p className={s.muted}>
            Connect a Solana wallet, pick an amount, approve one transaction. It burns {ticker} from your wallet and
            carries this workspace&apos;s memo. Burning is permanent.
          </p>
        </div>

        {!open && token && (
          <Callout tone="signal" title="Burns open at launch.">
            {token.mint
              ? `The token mint is set but couldn't be read from Solana right now, so burning is paused. Reload in a minute.`
              : `${ticker} hasn't launched yet. Everything below unlocks when it does. Your workspace and key work now.`}
          </Callout>
        )}
        {tokenError && !token && <Callout tone="warn">Couldn&apos;t load token info. Reload to retry.</Callout>}

        <fieldset className={s.fieldset} disabled={!open}>
          <legend className={s.step}>
            <span className={s.stepN}>1</span> Wallet
          </legend>
          {conn ? (
            <div className={s.walletRow}>
              <span className={s.walletName}>
                {conn.wallet.icon && <img src={conn.wallet.icon} alt="" width={20} height={20} />}
                {conn.wallet.name}
              </span>
              <a
                href={explorerAccount(conn.account.address, cluster)}
                target="_blank"
                rel="noopener noreferrer"
                className={s.mono}
                title={conn.account.address}
              >
                {short(conn.account.address, 4, 4)}
              </a>
              <Button variant="ghost" size="sm" onClick={() => void disconnect()} disabled={busy}>
                Disconnect
              </Button>
            </div>
          ) : wallets.length > 0 ? (
            <div className={s.walletList}>
              {wallets.map((w) => (
                <Button
                  key={w.name}
                  variant="outline"
                  size="sm"
                  onClick={() => void connect(w)}
                  disabled={!open || connecting !== null}
                >
                  {w.icon && <img src={w.icon} alt="" width={16} height={16} className={s.walletIcon} />}
                  {connecting === w.name ? "Connecting…" : w.name}
                </Button>
              ))}
            </div>
          ) : (
            <p className={s.muted}>
              No Solana wallet found in this browser. Install one that supports Wallet Standard (Phantom, Solflare,
              Backpack and most others do), then reload.
            </p>
          )}
          {connectError && (
            <p className={s.error} role="alert">
              {connectError}
            </p>
          )}
          {conn && (
            <dl className={s.kv}>
              <div>
                <dt>{ticker}</dt>
                <dd>
                  {balances.kind === "ok" ? (
                    <span className={s.mono}>{formatRawGrouped(balances.ata, decimals, 4)}</span>
                  ) : balances.kind === "error" ? (
                    <span className={s.error}>{balances.message}</span>
                  ) : (
                    <span className="skeleton" style={{ width: "8ch" }} />
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void loadBalances()} disabled={balances.kind === "loading"}>
                    Refresh
                  </Button>
                </dd>
              </div>
              <div>
                <dt>SOL for fees</dt>
                <dd className={s.mono}>{balances.kind === "ok" ? formatRawGrouped(balances.sol, 9, 6) : "…"}</dd>
              </div>
            </dl>
          )}
          {balances.kind === "ok" && balances.elsewhere > 0n && (
            <p className={s.muted}>
              {formatRawGrouped(balances.elsewhere, decimals, 4)} more {ticker} sits in another token account. Only the
              wallet&apos;s main (associated) account can be burned from here; move it there first.
            </p>
          )}
          {lowSol && <p className={s.error}>This wallet needs a little SOL (about 0.00001) to pay the network fee.</p>}
        </fieldset>

        <form onSubmit={submit} className={s.fieldsetForm}>
          <fieldset className={s.fieldset} disabled={!open || !conn || busy}>
            <legend className={s.step}>
              <span className={s.stepN}>2</span> Amount
            </legend>
            <label className={s.field}>
              <span className={s.fieldLabel}>{ticker} to burn</span>
              <span className={s.inputRow}>
                <input
                  className={s.input}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={(amount.trim() !== "" && parsed && !parsed.ok) || overBalance || undefined}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => balance !== null && setAmount(formatRaw(balance, decimals))}
                  disabled={balance === null || balance === 0n}
                >
                  Max
                </Button>
              </span>
            </label>
            {amount.trim() !== "" && parsed && !parsed.ok && <p className={s.error}>{parsed.error}</p>}
            {overBalance && <p className={s.error}>That&apos;s more than this wallet holds.</p>}

            <div className={s.preview} aria-live="polite">
              {!open ? (
                <span>≈ $— credit · price appears at launch</span>
              ) : priceError && !price ? (
                <span>Price feed offline. Burning is paused until it answers.</span>
              ) : !price ? (
                <span>Reading the price…</span>
              ) : !fresh ? (
                <span>
                  The price feed hasn&apos;t sampled in the last 25 minutes, so a burn now couldn&apos;t be priced.
                  Burning is paused until it does.
                </span>
              ) : (
                <>
                  <span className={s.previewValue}>≈ {estimate !== null ? fmtMicroUsd(estimate) : "$—"} credit</span>
                  <span>
                    at {fmtPrice(burnPrice)} per token now. The final value uses the burn-time price, which can only be
                    lower.
                  </span>
                </>
              )}
            </div>
            {overCap && (
              <Callout tone="warn">
                Burns worth more than {fmtUsd(token?.maxCreditPerBurnUsd)} are held for a manual review before they&apos;re
                credited.
              </Callout>
            )}
          </fieldset>

          <fieldset className={s.fieldset} disabled={!open || !conn || busy}>
            <legend className={s.step}>
              <span className={s.stepN}>3</span> Burn
            </legend>
            <p className={s.muted}>
              Memo <code className="inline-code">{(token?.memoPrefix ?? "forkbomb:") + workspaceId}</code>. Your wallet
              shows the transaction before anything is signed. A burn can&apos;t be undone.
            </p>
            <div>
              <Button type="submit" variant="primary" icon="flame" disabled={!canBurn}>
                {burn.kind === "building"
                  ? "Preparing…"
                  : burn.kind === "signing"
                    ? "Approve in your wallet…"
                    : parsed?.ok
                      ? `Burn ${formatRawGrouped(parsed.raw, decimals)} ${ticker}`
                      : `Burn ${ticker}`}
              </Button>
            </div>
          </fieldset>
        </form>

        <BurnStatus burn={burn} cluster={cluster} onRetry={(sig) => void startVerify(sig)} />

        <details className={s.details}>
          <summary>Burned from another wallet or tool? Check a signature</summary>
          <form className={s.inputRow} onSubmit={checkManual}>
            <input
              className={s.input}
              value={manualSig}
              onChange={(e) => setManualSig(e.target.value)}
              placeholder="Transaction signature"
              autoComplete="off"
              spellCheck={false}
              disabled={!open || busy}
              aria-label="Transaction signature"
            />
            <Button type="submit" variant="outline" size="sm" disabled={!open || busy || !manualSig.trim()}>
              Verify
            </Button>
          </form>
        </details>
      </div>
    </CrtPanel>
  );
}

function BurnStatus({
  burn,
  cluster,
  onRetry,
}: {
  burn: Burn;
  cluster: TokenInfo["cluster"];
  onRetry: (signature: string) => void;
}) {
  if (burn.kind === "idle" || burn.kind === "building" || burn.kind === "signing") return null;
  const sig = burn.signature;
  const link = sig && (
    <a href={explorerTx(sig, cluster)} target="_blank" rel="noopener noreferrer" className={s.mono}>
      {short(sig, 6, 6)} on Solscan ↗
    </a>
  );
  if (burn.kind === "verifying") {
    return (
      <div className={s.status} role="status" aria-live="polite">
        <Badge tone="signal" pulse>
          {burn.title}
        </Badge>
        <p>{burn.body}</p>
        {link}
      </div>
    );
  }
  if (burn.kind === "done") {
    const r = burn.record;
    return (
      <div className={s.status} role="status">
        {r.status === "review" ? (
          <Badge tone="warn" dot>
            held for review
          </Badge>
        ) : (
          <Badge tone="ok" dot>
            {r.status === "already_credited" ? "already credited" : "credited"}
          </Badge>
        )}
        <p>
          {r.status === "review"
            ? `Burned ${r.amountUi} worth ${fmtUsd(r.usdValue)}. Over the per-burn limit, so a human reviews it before it's credited.`
            : `Burned ${r.amountUi} at ${fmtPrice(r.priceUsd)}: ${fmtMicroUsd(r.creditMicroUsd)} credit added.`}
        </p>
        {link}
      </div>
    );
  }
  return (
    <div className={`${s.status} ${s.statusError}`} role="alert">
      <Badge tone="signal" dot>
        {burn.title}
      </Badge>
      <p>
        {burn.body}{" "}
        {/contact|issue/i.test(burn.body) && (
          <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
            Open an issue
          </a>
        )}
      </p>
      {link}
      {burn.canRetry && sig && (
        <div>
          <Button variant="outline" size="sm" onClick={() => onRetry(sig)}>
            Check again
          </Button>
        </div>
      )}
    </div>
  );
}

const pick = (c: { title: string; body: string }) => ({ title: c.title, body: c.body });
const errText = (err: unknown) => (err instanceof Error && err.message ? err.message : "Unknown error.");
