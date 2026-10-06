import { Badge, Button, CAChip, Container, HazardStripe, PixelHeading, Section } from "@/app/components";
import { SITE, STATUS, TOKEN_MEMO_PREFIX } from "@/app/config";
import { pageMetadata } from "@/app/lib/seo";
import { LedgerLive } from "./LedgerLive";
import s from "./burns.module.css";

export const metadata = pageMetadata({
  title: "Burn ledger",
  description: `Every ${SITE.ticker} burn and the compute credit it produced, read from Solana and linked to its transaction. ${
    STATUS.tokenLive ? "" : "No burns yet: the token has not launched."
  }`.trim(),
  path: "/burns",
});

const COLUMNS: { k: string; v: string }[] = [
  { k: "Time", v: "When the burn landed on Solana (block time, UTC)." },
  { k: "Wallet", v: "The wallet that signed the burn. Links to Solscan." },
  { k: "Burned", v: `${SITE.ticker} destroyed by the transaction.` },
  { k: "USD value", v: "Burned amount × the time-weighted price around the burn." },
  { k: "Credit", v: "What the workspace received. Very large burns wait for a person to check them first." },
  { k: "Tx", v: "The transaction itself. Check every number against it." },
];

export default function BurnsPage() {
  return (
    <>
      <section className={s.hero} aria-labelledby="burns-title">
        <Container>
          <div className={s.heroInner}>
            <div className="cluster">
              <Badge tone={STATUS.tokenLive ? "ok" : "signal"} dot>
                {STATUS.tokenLive ? "token live" : "token launching"}
              </Badge>
              <span className="label">public · read from Solana</span>
            </div>
            <PixelHeading as="h1" size="display" glow id="burns-title">
              Burn <span className="hl">ledger</span>
            </PixelHeading>
            <p className="lede">
              Every {SITE.ticker} burn, how much it was worth when it landed and the compute credit it produced. Each row
              links to its transaction, so you don&apos;t have to trust this page. No estimates and no placeholder rows.
            </p>
            <div className={s.heroActions}>
              <Button href="/token#pricing" variant="outline" iconRight="arrowRight">
                How credit is priced
              </Button>
              <CAChip />
            </div>
            <p className={s.memo}>
              <span className={s.memoKey}>memo</span>
              <code translate="no">
                {TOKEN_MEMO_PREFIX}
                <span className={s.memoVar}>&lt;workspaceId&gt;</span>
              </code>
            </p>
          </div>
        </Container>
      </section>

      <HazardStripe size="sm" />

      <Section id="ledger" size="sm" labelledBy="ledger-h">
        <LedgerLive />
        <noscript>
          <p className={s.noscript}>
            This table loads with JavaScript. The same data is at{" "}
            <a href="/api/ledger" className="link">
              /api/ledger
            </a>{" "}
            as JSON.
          </p>
        </noscript>
      </Section>

      <Section id="columns" tone="raised" divider size="sm" labelledBy="columns-h">
        <div className={s.read}>
          <div className={s.readHead}>
            <PixelHeading id="columns-h" size="md">
              Reading a row
            </PixelHeading>
            <p className={s.readText}>
              Burns are permanent and credit can&apos;t be moved or refunded. The raw data is public:{" "}
              <a href="/api/ledger" className="link">
                /api/ledger
              </a>{" "}
              and{" "}
              <a href="/api/price" className="link">
                /api/price
              </a>
              .
            </p>
          </div>
          <dl className={s.cols}>
            {COLUMNS.map((c) => (
              <div key={c.k}>
                <dt>{c.k}</dt>
                <dd>{c.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
    </>
  );
}
