import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  Container,
  CopyButton,
  CrtPanel,
  Glyph,
  HazardStripe,
  Icon,
  type IconName,
  Marquee,
  PixelHeading,
  Prose,
  Section,
  shortAddress,
} from "@/app/components";
import { APP_URL, CONTRACT_ADDRESS, ENGINES, SITE, STATUS, TOKEN_MEMO_PREFIX } from "@/app/config";
import { pageMetadata } from "@/app/lib/seo";
import s from "./token.module.css";

export const metadata = pageMetadata({
  title: "$FORKBOMB",
  description:
    "Burn $FORKBOMB for Forkbomb hosted compute credit, priced in USD at burn time. Self-hosting stays free and MIT. No yield, no buybacks, no revenue share. The token has not launched yet.",
  path: "/token",
});

const CA = CONTRACT_ADDRESS.trim();
const LIVE = STATUS.tokenLive;
const PUMP_URL = LIVE ? `https://pump.fun/coin/${encodeURIComponent(CA)}` : "";
const SOLSCAN_TOKEN_URL = LIVE ? `https://solscan.io/token/${encodeURIComponent(CA)}` : "";

const LOOP: {
  n: string;
  icon: IconName;
  title: string;
  body: string;
  code?: string;
}[] = [
  {
    n: "01",
    icon: "terminal",
    title: "Open a workspace",
    body: STATUS.appLive
      ? "In the app. You get a workspace ID and an API key for the CLI."
      : "In the app, at launch. You get a workspace ID and an API key for the CLI.",
    code: "ws_…",
  },
  {
    n: "02",
    icon: "flame",
    title: `Burn ${SITE.ticker}`,
    body: "From your own wallet, in one transaction, with your workspace ID in the memo.",
    code: `${TOKEN_MEMO_PREFIX}<workspaceId>`,
  },
  {
    n: "03",
    icon: "shield",
    title: "We read it on Solana",
    body: "Finalized, the right mint, a real burn, one matching memo. Then it is priced in USD and credited.",
  },
  {
    n: "04",
    icon: "cpu",
    title: "Spend it on forks",
    body: "The CLI's hosted engine calls our GPU coding model and draws down your credit.",
    code: "--engine hosted",
  },
];

const PRICE_RULES: { k: string; v: string }[] = [
  { k: "unit", v: "Credit is in US dollars, not tokens." },
  { k: "window", v: "15 minutes before your burn to 5 minutes after it." },
  {
    k: "price",
    v: "Anchored to the last sample before the burn (at most 30 minutes old; with none, one taken within 5 seconds after it). The window's time-weighted average and later prices can only lower it.",
  },
  {
    k: "sources",
    v: "Jupiter, with DexScreener as a fallback. A quote far off the last sample needs the other source to agree.",
  },
  {
    k: "fixed",
    v: "The price is set by when the burn landed, not by when you submit it.",
  },
  {
    k: "large",
    v: "A very large single burn is held for a person to check before it credits.",
  },
];

const COMPARE: { case: string; fixed: string; ours: string }[] = [
  {
    case: "Credit per burn",
    fixed: "Set in tokens. A fixed amount of credit per token, whatever the token trades at.",
    ours: "Set in dollars: the burn's value at the time-weighted price when it landed.",
  },
  {
    case: "Token price goes up 10×",
    fixed: "Each burn now costs 10× more for the same credit. Nobody sensible burns.",
    ours: "You burn 10× fewer tokens for the same credit. Still worth using.",
  },
  {
    case: "Token price goes down 10×",
    fixed: "Credit becomes 10× cheaper to farm.",
    ours: "You burn 10× more tokens for the same credit.",
  },
  {
    case: "Burn into a short spike",
    fixed: "Not applicable.",
    ours: "A short spike barely moves the window average, and the lowest price wins.",
  },
];

const BUYS: {
  icon: IconName;
  title: string;
  body: string;
  state: "now" | "later";
}[] = [
  {
    icon: "cpu",
    title: "Hosted coding model",
    body: "Forks run on our GPU coding model through an OpenAI-compatible API. No Claude plan or API key needed.",
    state: "now",
  },
  {
    icon: "fork",
    title: "More forks per race",
    body: "Run wider races than your own machine or plan comfortably handles.",
    state: "later",
  },
  {
    icon: "chart",
    title: "Bigger models",
    body: "Larger hosted models for harder tasks, billed from the same credit.",
    state: "later",
  },
  {
    icon: "flame",
    title: "Warm GPUs",
    body: "Keep the pool warm so the first fork doesn't wait on a cold start.",
    state: "later",
  },
];

const IS: { title: string; body: string }[] = [
  {
    title: "A way to pay for hosted compute",
    body: "Burn it, get USD credit, spend the credit on forks that run on our GPUs.",
  },
  {
    title: "Optional",
    body: "The CLI runs on your Claude plan or your Anthropic API key with no token at all.",
  },
  {
    title: "Checkable",
    body: "Every burn and the credit it produced is on the public ledger, linked to its transaction.",
  },
];

const IS_NOT: { title: string; body: string }[] = [
  {
    title: "Equity or a share",
    body: "No ownership, no votes, no claim on the project or the people behind it.",
  },
  {
    title: "Revenue share or dividends",
    body: "Holding the token pays you nothing.",
  },
  {
    title: "Buybacks",
    body: "We don't buy the token back or support its price.",
  },
  {
    title: "Staking or yield",
    body: "There is nothing to stake and no yield to earn.",
  },
  {
    title: "Transferable or refundable credit",
    body: "Credit stays in the workspace it was burned for, and burns can't be undone.",
  },
  {
    title: "Affiliated with Anthropic",
    body: "Anthropic hasn't reviewed, endorsed or sponsored Forkbomb or the token.",
  },
];

const VERIFY: string[] = [
  "Copy the address from this page and nowhere else. Reach it from the link in the GitHub README, not from a DM or a search ad.",
  "Compare every character, not just the first and last few.",
  "Ignore addresses in DMs, replies, group chats or from “support” accounts.",
  "Burns only count with a memo for your own workspace. Nobody needs your seed phrase or a signature to “activate” credit.",
];

function AddressBox() {
  return (
    <CrtPanel
      as="div"
      title="cat /etc/forkbomb/contract"
      status={
        LIVE ? (
          <Badge tone="ok" dot>
            published
          </Badge>
        ) : (
          <Badge tone="signal" pulse>
            launching
          </Badge>
        )
      }
      className={s.addr}
      bodyClassName={s.addrBody}
    >
      <p className={s.addrLabel} id="ca-label">
        {SITE.ticker} contract address · Solana
      </p>
      {LIVE ? (
        <div className={s.addrRow}>
          <code className={s.addrValue} aria-labelledby="ca-label" translate="no">
            {CA}
          </code>
          <CopyButton text={CA} label="Copy address" copiedLabel="Copied" className={s.addrCopy} />
        </div>
      ) : (
        <div className={s.addrEmpty}>
          <span className={s.addrPlaceholder} aria-hidden="true">
            ????????????????????????????????????????????
          </span>
          <p className={s.addrEmptyText}>
            No address yet. Until one appears here, anything calling itself {SITE.ticker} is not ours.
          </p>
        </div>
      )}
      <div className={s.addrActions}>
        {LIVE ? (
          <>
            <Button href={PUMP_URL} variant="primary" icon="external">
              Trade on pump.fun
            </Button>
            <Button href={SOLSCAN_TOKEN_URL} variant="outline" iconRight="arrowUpRight">
              {shortAddress(CA, 4, 4)} on Solscan
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" disabled aria-describedby="pump-note">
              Trade link at launch
            </Button>
            <span id="pump-note" className={s.addrNote}>
              The link turns on when the address is published.
            </span>
          </>
        )}
      </div>
      <p className={s.addrFoot}>
        <Icon name="lock" size={14} />
        <span>
          Source of truth: this page, <span className="mono">/token</span>
        </span>
      </p>
    </CrtPanel>
  );
}

export default function TokenPage() {
  const hosted = ENGINES.find((e) => e.id === "hosted");
  return (
    <>
      {/* ---------- Hero ---------- */}
      <section className={s.hero} aria-labelledby="token-title">
        <Container>
          <div className={s.heroGrid}>
            <div className={s.heroCopy}>
              <div className="cluster">
                <Badge tone="signal" dot>
                  {SITE.ticker}
                </Badge>
                <span className="label">burn-for-compute · Solana</span>
              </div>
              <PixelHeading as="h1" size="display" glow id="token-title" className={s.heroTitle}>
                Burn it.{" "}
                <br />
                <span className="hl">Get compute.</span>
              </PixelHeading>
              <p className="lede">
                {SITE.ticker} does one thing. You burn it, and the burn&apos;s dollar value becomes credit for{" "}
                {SITE.name}&apos;s hosted GPU coding model. Self-hosting stays free and {SITE.license}. The token buys
                convenience and scale, not permission.
              </p>
              <div className="cluster">
                <Button href="#loop" variant="primary" size="lg" iconRight="arrowRight">
                  How burns work
                </Button>
                <Button href="/burns" variant="outline" size="lg" icon="flame">
                  Burn ledger
                </Button>
              </div>
              <ul className={s.heroFacts} aria-label="Launch status">
                <li>
                  <span>token</span>
                  <b className={LIVE ? s.factOk : s.factHot}>{LIVE ? "live" : "launching"}</b>
                </li>
                <li>
                  <span>hosted pool</span>
                  <b className={STATUS.hostedPoolLive ? s.factOk : s.factWarn}>
                    {STATUS.hostedPoolLive ? "online" : "coming online"}
                  </b>
                </li>
                <li>
                  <span>self-host</span>
                  <b>free · {SITE.license}</b>
                </li>
              </ul>
            </div>
            <div className={s.heroSide}>
              <AddressBox />
              <Callout tone="warn" title="Verify the address only here">
                <ol className={s.verifyList}>
                  {VERIFY.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ol>
              </Callout>
            </div>
          </div>
        </Container>
      </section>

      <Marquee
        items={[
          SITE.glyph,
          { text: "burn", tone: "hot" },
          "price in usd",
          "credit",
          { text: "fork()", tone: "hot" },
          "self-host free",
          "no yield · no buybacks",
        ]}
        speed={48}
      />

      {/* ---------- The loop ---------- */}
      <Section id="loop" labelledBy="loop-h">
        <header className="section-header">
          <p className="eyebrow">
            <span className="eyebrow__index">01</span>
            <span>The loop</span>
          </p>
          <PixelHeading id="loop-h" size="xl">
            Burn, verify, credit, <span className="hl">fork()</span>.
          </PixelHeading>
          <p className="lede">
            One transaction from your wallet. The server reads it from Solana, prices it and credits your workspace. No
            wallet connection is needed to verify a burn: the transaction signature is enough.
          </p>
        </header>

        <div className={s.loopGrid}>
          <ol className={s.steps}>
            {LOOP.map((st) => (
              <li key={st.n} className={s.step}>
                <div className={s.stepHead}>
                  <span className={s.stepN}>{st.n}</span>
                  <Icon name={st.icon} size={20} className={s.stepIcon} />
                </div>
                <h3 className={s.stepTitle}>{st.title}</h3>
                <p className={s.stepBody}>{st.body}</p>
                {st.code && <code className={s.stepCode}>{st.code}</code>}
              </li>
            ))}
          </ol>

          <CrtPanel as="figure" title="anatomy of a burn" className={s.anatomy}>
            <pre className={s.tx} aria-describedby="anatomy-cap">
              <span className={s.txDim}>transaction</span>
              {"\n"}
              <span className={s.txDim}>├─ </span>
              <span className={s.txKey}>spl-token</span> <span className={s.txHot}>burn</span>
              {"\n"}
              <span className={s.txDim}>│ mint </span>
              {LIVE ? shortAddress(CA, 4, 4) : `<${SITE.ticker} mint>`}
              {"\n"}
              <span className={s.txDim}>│ amount </span>
              {"<how much you burn>"}
              {"\n"}
              <span className={s.txDim}>└─ </span>
              <span className={s.txKey}>memo</span>
              {"\n"}
              <span className={s.txDim}> text </span>
              <span className={s.txHot}>{TOKEN_MEMO_PREFIX}</span>
              {"<workspaceId>"}
            </pre>
            <figcaption id="anatomy-cap" className={s.anatomyCap}>
              The shape of a valid burn, not a real transaction. Exactly one memo for {SITE.wordmark}, with nothing else
              in it. A failed or unfinalized transaction credits nothing.
            </figcaption>
          </CrtPanel>
        </div>
      </Section>

      {/* ---------- Pricing ---------- */}
      <Section id="pricing" tone="raised" divider labelledBy="pricing-h">
        <header className="section-header">
          <p className="eyebrow">
            <span className="eyebrow__index">02</span>
            <span>How credit is priced</span>
          </p>
          <PixelHeading id="pricing-h" size="xl">
            Priced in dollars, <span className="hl">at burn time.</span>
          </PixelHeading>
          <p className="lede">
            A burn token with a fixed exchange rate breaks as soon as the price moves. If the token goes up, burning
            costs more than the credit is worth and the utility dies. {SITE.ticker} credit is set in USD from the price
            around the moment your burn landed, so a burn is worth the same at any market cap.
          </p>
        </header>

        <div className={s.priceGrid}>
          <CrtPanel as="div" title="credit = burned × price" className={s.formulaPanel}>
            <pre className={s.formula}>
              <span className={s.txDim}>{"# per burn"}</span>
              {"\n"}
              <span className={s.txKey}>credit_usd</span> = tokens_burned × price
              {"\n\n"}
              <span className={s.txKey}>price</span> = <span className={s.txHot}>min</span>({"\n"}
              {"  last_sample_before(burn),"}
              {"\n"}
              {"  twap(burn − 15m … burn + 5m),"}
              {"\n"}
              {"  first_sample_after(burn)"}
              {"\n"})
            </pre>
            <dl className={s.rules}>
              {PRICE_RULES.map((r) => (
                <div key={r.k}>
                  <dt>{r.k}</dt>
                  <dd>{r.v}</dd>
                </div>
              ))}
            </dl>
          </CrtPanel>

          <div className={s.compare}>
            <div className="table-wrap">
              <table className={`table ${s.compareTable}`}>
                <caption className="sr-only">Fixed-rate burn pricing compared with {SITE.ticker} pricing</caption>
                <thead>
                  <tr>
                    <th scope="col">Case</th>
                    <th scope="col">Fixed-rate burn</th>
                    <th scope="col" className={s.oursHead}>
                      {SITE.ticker}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARE.map((c) => (
                    <tr key={c.case}>
                      <th scope="row">{c.case}</th>
                      <td data-label="Fixed-rate burn">{c.fixed}</td>
                      <td className={s.oursCell} data-label={SITE.ticker}>
                        {c.ours}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className={s.compareNote}>
              Waiting doesn&apos;t help either way: the price is fixed by the block your burn landed in. Every
              burn&apos;s price and credit is public on the{" "}
              <Link href="/burns" className="link">
                ledger
              </Link>
              .
            </p>
          </div>
        </div>
      </Section>

      {/* ---------- What credit buys ---------- */}
      <Section id="buys" labelledBy="buys-h">
        <header className="section-header">
          <p className="eyebrow">
            <span className="eyebrow__index">03</span>
            <span>What credit buys</span>
          </p>
          <PixelHeading id="buys-h" size="xl">
            Compute. <span className="hl">Nothing else.</span>
          </PixelHeading>
          <p className="lede">
            Credit only pays for hosted compute. The hosted pool is{" "}
            {STATUS.hostedPoolLive ? "online" : "not online yet"}; the rest comes after it.
          </p>
        </header>

        <ul className={s.buys}>
          {BUYS.map((b) => {
            const now = b.state === "now";
            return (
              <li key={b.title} className={`${s.buy} ${now ? s.buyNow : ""}`}>
                <div className={s.buyHead}>
                  <Icon name={b.icon} size={20} className={s.buyIcon} />
                  {now ? (
                    STATUS.hostedPoolLive ? (
                      <Badge tone="ok" dot>
                        online
                      </Badge>
                    ) : (
                      <Badge tone="warn" dot>
                        coming online
                      </Badge>
                    )
                  ) : (
                    <Badge>later</Badge>
                  )}
                </div>
                <h3 className={s.buyTitle}>{b.title}</h3>
                <p className={s.buyBody}>{b.body}</p>
              </li>
            );
          })}
        </ul>

        <div className={s.engines}>
          <div className={s.enginesHead}>
            <h3 className={s.enginesTitle}>Three engines. Two of them never touch the token.</h3>
            <p className={s.enginesBody}>
              Self-hosting stays free and {SITE.license}. Pick an engine per run; {hosted ? hosted.name : "hosted"} is
              the only one paid with {SITE.ticker} credit.
            </p>
          </div>
          <div className="table-wrap">
            <table className={`table ${s.engineTable}`}>
              <caption className="sr-only">CLI engines and how each is paid for</caption>
              <thead>
                <tr>
                  <th scope="col">Engine</th>
                  <th scope="col">Flag</th>
                  <th scope="col">Paid with</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {ENGINES.map((e) => (
                  <tr key={e.id}>
                    <th scope="row" className={s.engineName}>
                      {e.name}
                    </th>
                    <td data-label="Flag">
                      <code className="mono">--engine {e.id}</code>
                    </td>
                    <td data-label="Paid with">{e.pays}</td>
                    <td data-label="Status">
                      {e.live ? (
                        <Badge tone="ok" dot>
                          works today
                        </Badge>
                      ) : e.id === "hosted" && STATUS.hostedPoolLive ? (
                        <Badge tone="signal" dot>
                          opens at launch
                        </Badge>
                      ) : (
                        <Badge tone="warn" dot>
                          coming online
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      {/* ---------- Is / is not ---------- */}
      <Section id="what" tone="raised" divider labelledBy="what-h">
        <header className="section-header">
          <p className="eyebrow">
            <span className="eyebrow__index">04</span>
            <span>What it is</span>
          </p>
          <PixelHeading id="what-h" size="xl">
            What {SITE.ticker} is, and <span className="hl">what it isn&apos;t.</span>
          </PixelHeading>
          <p className="lede">
            Credit is used up when you spend it. That is the whole design: a prepaid way to pay for compute, nothing you
            hold for a return.
          </p>
        </header>
        <div className={s.ledger}>
          <div className={s.ledgerCol}>
            <h3 className={s.ledgerTitle}>It is</h3>
            <ul className={s.ledgerList}>
              {IS.map((i) => (
                <li key={i.title} className={s.ledgerItem}>
                  <span className={s.markIs} aria-hidden="true" />
                  <div>
                    <p className={s.itemTitle}>{i.title}</p>
                    <p className={s.itemBody}>{i.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className={s.ledgerCol}>
            <h3 className={s.ledgerTitle}>It is not</h3>
            <ul className={s.ledgerList}>
              {IS_NOT.map((i) => (
                <li key={i.title} className={s.ledgerItem}>
                  <span className={s.markNot} aria-hidden="true" />
                  <div>
                    <p className={s.itemTitle}>{i.title}</p>
                    <p className={s.itemBody}>{i.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <HazardStripe label="read before you buy" />

      {/* ---------- Disclaimer ---------- */}
      <Section id="disclaimer" tone="inset" container="narrow" labelledBy="disclaimer-h">
        <header className="section-header">
          <p className="eyebrow">
            <span className="eyebrow__index">05</span>
            <span>Disclaimer</span>
          </p>
          <PixelHeading id="disclaimer-h" size="lg">
            Read this before you do anything.
          </PixelHeading>
          <p className="lede">Plain language, not marketing. If any of it surprises you, don&apos;t buy the token.</p>
        </header>
        <Prose className={s.legal}>
          <h3>Not an investment</h3>
          <p>
            {SITE.ticker} is a utility token for paying for hosted compute. It isn&apos;t offered as an investment, a
            security, a share, a loan or a deposit. Nothing on this site is an offer to sell or a request to buy
            anything.
          </p>
          <h3>No expectation of profit</h3>
          <p>
            Don&apos;t buy it expecting the price to rise. Nobody promises it will, and nobody is working to make it
            rise: there are no buybacks, no staking and no yield. Its value can go to zero.
          </p>
          <h3>Credit is used up</h3>
          <p>
            Burning is permanent. Credit has no cash value, can&apos;t be withdrawn, refunded or moved to another
            workspace, and only pays for hosted compute. A burn without a valid memo for your workspace credits nothing.
          </p>
          <h3>The hosted service is new</h3>
          <p>
            The hosted pool is {STATUS.hostedPoolLive ? "online but new" : "not online yet"}. Prices per request, models
            and limits may change, and the service may be slow or unavailable. Self-hosting with your own Claude plan or
            API key always works without the token.
          </p>
          <h3>No revenue share, no rights</h3>
          <p>
            Holding {SITE.ticker} gives you no share of revenue, no dividends, no voting rights, no ownership and no
            claim against the project, its contributors or anyone else.
          </p>
          <h3>Not affiliated with Anthropic</h3>
          <p>
            {SITE.name} can run forks on Claude Code or the Anthropic API. Anthropic has not reviewed, endorsed,
            sponsored or partnered with {SITE.name} or {SITE.ticker}. Claude and Anthropic are trademarks of Anthropic.
          </p>
          <h3>Risk</h3>
          <p>
            Tokens are volatile and markets for small tokens are thin. Smart contracts, wallets and exchanges can fail
            or be exploited. Scammers copy names and addresses. Only use money you can afford to lose entirely.
          </p>
          <h3>Do your own research</h3>
          <p>
            Nothing on this site is financial, investment, legal or tax advice. Rules on tokens differ by country, and
            checking yours is on you. Talk to a licensed professional if you need advice.
          </p>
          <p className={s.legalFoot}>
            See also the <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy</Link> pages.
          </p>
        </Prose>
      </Section>

      {/* ---------- Ledger band ---------- */}
      <Section id="ledger" size="sm" labelledBy="ledger-h">
        <div className={s.band}>
          <div className={s.bandCopy}>
            <Glyph glow className={s.bandGlyph} />
            <h2 id="ledger-h" className={s.bandTitle}>
              Every burn, on the record.
            </h2>
            <p className={s.bandText}>
              The public ledger lists each burn, its USD value and the credit it produced, with a link to the
              transaction.
              {LIVE ? "" : " It is empty until launch, and it will never show a made-up row."}
            </p>
          </div>
          <div className="cluster">
            <Button href="/burns" variant="primary" iconRight="arrowRight">
              Open the burn ledger
            </Button>
            <Button href={APP_URL} variant="outline">
              Open app
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
