import Link from "next/link";
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  CopyButton,
  Icon,
  PageHeader,
  Prose,
  Section,
  SectionHeader,
  Terminal,
} from "@/app/components";
import { CONTRACT_ADDRESS, GITHUB_URL, SITE } from "@/app/config";
import { pageMetadata } from "@/app/lib/seo";
import s from "./token.module.css";

export const metadata = pageMetadata({
  title: "$HYDRA",
  description:
    "$HYDRA is a community token for Hydra's launch. It is not wired into the product and unlocks nothing. Hydra is free and MIT-licensed. Read the disclaimer before you do anything.",
  path: "/token",
});

const SITE_HOST = (() => {
  try {
    return new URL(SITE.url).host;
  } catch {
    return SITE.url;
  }
})();

const IS: { title: string; body: string }[] = [
  { title: "A community token", body: "Created for Hydra's launch, for people who want to follow it and rally around it." },
  { title: "Optional", body: "You can ignore it completely. Nothing about the tool changes." },
  { title: "Separate from the code", body: "The token lives on a blockchain. Hydra lives in a Git repo. Nothing connects them." },
];

const IS_NOT: { title: string; body: string }[] = [
  { title: "Wired into the product", body: "Hydra has no wallet code, no token checks and no on-chain calls." },
  { title: "A key, license or upgrade", body: "It unlocks nothing. There's no paid tier to unlock. The tool is free and MIT." },
  { title: "A share of anything", body: "No revenue share, no dividends, no equity, no claim on the project or its maintainers." },
  { title: "Affiliated with Anthropic", body: "Anthropic hasn't reviewed, endorsed or sponsored Hydra or $HYDRA." },
  { title: "A promise", body: "No price, roadmap, listing or utility is promised, now or later." },
];

const VERIFY: string[] = [
  `Get the address from this page, on ${SITE_HOST}, and nowhere else.`,
  "Compare every character, not just the first and last few.",
  "Ignore addresses in DMs, replies, group chats or from “support” accounts.",
  "This site never asks you to connect a wallet, sign a message or send funds. Anything that does isn't us.",
];

function AddressBox() {
  const live = CONTRACT_ADDRESS.trim().length > 0;
  return (
    <div className={s.addr} data-state={live ? "live" : "pending"}>
      <div className={s.addrHead}>
        <h3 className={s.addrLabel} id="addr-label">
          Contract address
        </h3>
        {live ? (
          <Badge dot>published</Badge>
        ) : (
          <Badge tone="warn" dot>
            not live yet
          </Badge>
        )}
      </div>

      {live ? (
        <div className={s.addrRow}>
          <code className={s.addrValue}>
            {CONTRACT_ADDRESS}
          </code>
          <CopyButton text={CONTRACT_ADDRESS} label="Copy address" copiedLabel="Copied" className={s.addrCopy} />
        </div>
      ) : (
        <div className={s.addrEmpty}>
          <span className={s.addrPlaceholder} aria-hidden="true">
            ································
          </span>
          <p className={s.addrEmptyText}>
            No address has been published. Until one appears here, any address claiming to be $HYDRA is not ours.
          </p>
        </div>
      )}

      <p className={s.addrFoot}>
        <Icon name="lock" size={14} />
        <span>
          Source of truth: <span className="mono">{SITE_HOST}/token</span>
        </span>
      </p>
    </div>
  );
}

export default function TokenPage() {
  return (
    <>
      <PageHeader
        eyebrow="$HYDRA"
        title="A community token. Not a feature."
        lede="$HYDRA exists for the launch. It isn't wired into Hydra, it unlocks nothing, and the tool works the same whether you ever touch it or not. Hydra is free and MIT-licensed."
        meta={["Not an investment", "Not affiliated with Anthropic", `Hydra is ${SITE.license}`]}
      />

      {/* ---------- Address ---------- */}
      <Section id="address" size="sm" labelledBy="address-h">
        <h2 id="address-h" className="sr-only">
          Contract address
        </h2>
        <div className={s.addrGrid}>
          <AddressBox />
          <div className={s.verify}>
            <Callout tone="warn" title="Verify the address only here">
              <ol className={s.verifyList}>
                {VERIFY.map((v) => (
                  <li key={v}>{v}</li>
                ))}
              </ol>
            </Callout>
          </div>
        </div>
      </Section>

      {/* ---------- Is / is not ---------- */}
      <Section id="what" tone="raised" divider labelledBy="what-h">
        <SectionHeader
          id="what-h"
          eyebrow="What it is"
          title="What $HYDRA is, and what it isn't."
          lede="Short version: it's a community token sitting next to an open-source tool. The tool doesn't know it exists."
        />
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

      {/* ---------- Proof ---------- */}
      <Section id="proof" labelledBy="proof-h">
        <div className="split">
          <SectionHeader
            id="proof-h"
            eyebrow="Check it yourself"
            title="No token code in the tool."
            lede="Hydra's runtime has one dependency: Anthropic's SDK. There's no wallet library, no RPC client and no token check anywhere in the source. Search it."
            className={s.flushHeader}
            actions={
              <>
                <Button href={`${GITHUB_URL}/tree/main/src`} icon="github">
                  Browse the source
                </Button>
                <Button href="/docs#install" variant="ghost" iconRight="arrowRight">
                  Install Hydra
                </Button>
              </>
            }
          />
          <div className="stack">
            <Terminal
              title="hydra · zsh"
              ariaLabel="Searching Hydra's source for wallet or token code returns nothing"
              lines={[
                { tone: "cmd", text: 'grep -rniE "wallet|solana|web3|contract" src/ || echo "no matches"' },
                { tone: "out", text: "no matches" },
              ]}
            />
            <CodeBlock
              title="package.json (dependencies)"
              lang="json"
              copy={false}
              code={`"dependencies": {\n  "@anthropic-ai/sdk": "^0.131.0"\n}`}
            />
          </div>
        </div>
      </Section>

      {/* ---------- Disclaimer ---------- */}
      <Section id="disclaimer" tone="inset" container="narrow" labelledBy="disclaimer-h">
        <SectionHeader
          id="disclaimer-h"
          eyebrow="Disclaimer"
          title="Read this before you do anything."
          lede="Plain language, not marketing. If any of it surprises you, don't buy the token."
        />
        <Prose className={s.legal}>
          <h3>Not an investment</h3>
          <p>
            $HYDRA is a community token. It isn&apos;t offered as an investment, a security, a share, a loan or a
            deposit. Nothing on this site is an offer to sell or a request to buy anything.
          </p>
          <h3>No expectation of profit</h3>
          <p>
            Don&apos;t buy it expecting the price to rise. Nothing here is a promise that it will, or that anyone will work
            to make it rise. Its value can go to zero.
          </p>
          <h3>No revenue share, no rights</h3>
          <p>
            Holding $HYDRA gives you no share of revenue, no dividends, no voting rights, no ownership and no claim against
            the project, its contributors or anyone else. Hydra has no revenue to share: it&apos;s free, MIT-licensed
            software.
          </p>
          <h3>Not affiliated with Anthropic</h3>
          <p>
            Hydra runs heads on Claude Code or the Anthropic API. Anthropic has not reviewed, endorsed, sponsored or
            partnered with Hydra or $HYDRA. Claude and Anthropic are trademarks of Anthropic.
          </p>
          <h3>Risk</h3>
          <p>
            Tokens are volatile and markets for small tokens are thin. Smart contracts, wallets and exchanges can fail or be
            exploited. Scammers copy names and addresses. Only use money you can afford to lose entirely.
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

      {/* ---------- The tool ---------- */}
      <Section id="tool" size="sm" labelledBy="tool-h">
        <div className={s.toolBand}>
          <div>
            <h2 id="tool-h" className="h3">
              Here for the tool?
            </h2>
            <p className={s.toolText}>
              Hydra forks a coding agent into sandboxed heads and lets your tests pick the winner. Free, MIT, no token
              required.
            </p>
          </div>
          <div className="cluster">
            <Button href="/docs" variant="primary" iconRight="arrowRight">
              Read the docs
            </Button>
            <Button href="/" variant="secondary">
              How it works
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
