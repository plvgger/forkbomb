import Link from "next/link";
import { GITHUB_URL, SITE, STATUS, TOKEN_MEMO_PREFIX } from "../config";
import { pageMetadata } from "../lib/seo";
import { LegalDoc, type LegalSection } from "./_parts/LegalDoc";

export const metadata = pageMetadata({
  title: "Terms",
  description: `Plain-English terms for the Forkbomb website, the open-source Forkbomb CLI, the hosted engine and ${SITE.ticker} compute credit. The MIT license governs the software. Credit is consumptive, non-refundable and non-transferable.`,
  path: "/terms",
});

const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;

const sections: LegalSection[] = [
  {
    id: "scope",
    title: "What these terms cover",
    body: (
      <>
        <p>These terms cover four things:</p>
        <ul>
          <li>this website;</li>
          <li>
            the Forkbomb command-line tool, published as open source on{" "}
            <a className="link" href={GITHUB_URL}>
              GitHub
            </a>
            ;
          </li>
          <li>the hosted service: workspaces, API keys, the hosted model gateway and the burn verifier;</li>
          <li>compute credit you get by burning {SITE.ticker}.</li>
        </ul>
        <p>
          By using any of them, you agree to these terms. If you don&apos;t agree, don&apos;t use them. This is a draft.
          It will be reviewed by a lawyer before public launch, and the date at the top changes whenever the text does.
        </p>
      </>
    ),
  },
  {
    id: "license",
    title: "The software is MIT licensed",
    body: (
      <>
        <p>
          Forkbomb is released under the{" "}
          <a className="link" href={LICENSE_URL}>
            MIT License
          </a>
          . That license, not this page, governs your use, copying, modification and distribution of the code. Where
          this page and the license disagree about the software, the license wins.
        </p>
        <p>
          In short: you can use Forkbomb for anything, including commercial work, fork it and ship it, as long as the
          copyright notice and license text travel with it. Self-hosting is free. You never need {SITE.ticker}, a wallet or
          a workspace to run the CLI on your own Claude login or API key.
        </p>
      </>
    ),
  },
  {
    id: "as-is",
    title: "Provided as is, without warranty",
    body: (
      <>
        <p>
          Forkbomb is provided &ldquo;as is&rdquo;, without warranty of any kind, express or implied, including fitness
          for a particular purpose and non-infringement. That is the MIT license&apos;s wording and it applies in full.
        </p>
        <p>
          Forkbomb runs AI coding agents that read and write files. The sandbox limits what a fork can do, and its
          limits are written down on the{" "}
          <Link className="link" href="/security">
            security page
          </Link>
          . It is a macOS sandbox, not a virtual machine, and it does not make an agent&apos;s output correct. A passing
          test suite means the patch passed your tests. It does not mean the patch is safe to ship. Review every patch
          before you apply it.
        </p>
        <p>
          To the extent the law allows, the authors and contributors are not liable for any damage, data loss or cost
          that comes from using Forkbomb, the hosted service or this website.
        </p>
      </>
    ),
  },
  {
    id: "responsibility",
    title: "You are responsible for what you run",
    body: (
      <>
        <p>You decide which repository Forkbomb runs on, which task it gets and which test command judges it. That means:</p>
        <ul>
          <li>Run it on code you have the right to modify, and, with the hosted engine, the right to send to a third party.</li>
          <li>Keep backups. Forkbomb works on clones, but your machine and your repository are yours to protect.</li>
          <li>
            Read the winning patch before you apply it. <code>--apply</code> writes it to your repository.
          </li>
          <li>Don&apos;t point it at production systems or secrets you would not hand to an agent.</li>
        </ul>
      </>
    ),
  },
  {
    id: "claude-usage",
    title: "Your Claude and API usage",
    body: (
      <>
        <p>
          With the claude-code and api engines, forks run on your own Claude Code login (a Pro or Max subscription) or
          on your own Anthropic API key. Every fork is a separate agent session, so N forks use roughly N times the usage
          of one.
        </p>
        <ul>
          <li>Usage limits, rate limits and API charges are between you and Anthropic.</li>
          <li>
            Your use of Claude Code and the Anthropic API is governed by Anthropic&apos;s own terms and usage policies.
            Using Forkbomb does not change them.
          </li>
          <li>We never see your Anthropic credentials or your bill, and we can&apos;t refund either.</li>
        </ul>
      </>
    ),
  },
  {
    id: "hosted",
    title: "The hosted service",
    body: (
      <>
        <p>
          The hosted engine runs forks on a model we operate, behind an API at this site.{" "}
          {STATUS.hostedPoolLive
            ? "It is live."
            : "It is not live yet: the GPU pool is coming online, and until it is, requests are refused without charge."}
        </p>
        <ul>
          <li>
            The hosted service is provided as is and as available, with no uptime, latency or quality guarantee. It may
            be slow, change models, be rate limited, or stop.
          </li>
          <li>
            We may change hosted prices, limits and the models offered at any time. Current prices are always returned
            by <code>GET /api/v1/me</code> before you spend anything, and a request is charged at the prices in force
            when it runs.
          </li>
          <li>
            Your API key is shown once. Keep it secret. Anyone with the key can spend the workspace&apos;s credit, and we
            can&apos;t tell them apart from you.
          </li>
          <li>
            Don&apos;t use the hosted service for anything illegal, to attack or overload it, to get around its limits,
            or to generate content that breaks the law where you are.
          </li>
          <li>
            We may suspend a workspace that breaks these terms or threatens the service. Self-hosted use of the CLI is
            never affected.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "credits",
    title: `${SITE.ticker} and compute credit`,
    body: (
      <>
        <p>
          You can burn {SITE.ticker} with a memo naming your workspace (<code>{TOKEN_MEMO_PREFIX}&lt;workspaceId&gt;</code>
          ) to receive compute credit for the hosted service. How burns are verified and priced is documented in the{" "}
          <Link className="link" href="/docs#burn">
            docs
          </Link>
          .
          {STATUS.tokenLive ? "" : ` ${SITE.ticker} has not launched yet, so no credit can be issued today.`}
        </p>
        <p>By burning tokens for credit you accept that:</p>
        <ul>
          <li>
            <strong>Burns are final.</strong> A burn destroys the tokens on chain. Nobody, including us, can reverse it.
            A burn with a wrong or missing memo, to a workspace that doesn&apos;t exist, or of the wrong token may credit
            nothing.
          </li>
          <li>
            <strong>Credit is consumptive.</strong> It exists only to be spent on hosted compute. It is not money, a
            deposit, a stored-value account or a token.
          </li>
          <li>
            <strong>Credit is non-refundable.</strong> It can&apos;t be cashed out, withdrawn or converted back into{" "}
            {SITE.ticker} or anything else, including if the hosted service changes or stops.
          </li>
          <li>
            <strong>Credit is non-transferable.</strong> It stays in the workspace it was issued to and can&apos;t be
            moved, sold or assigned.
          </li>
          <li>
            <strong>Pricing is ours to set.</strong> Credit is valued in USD at the burn&apos;s block time using the
            method in the docs. We may change the credit rate, the method or hosted prices for future burns and requests.
            Burns worth more than a per-burn cap may be held for manual review before anything is credited.
          </li>
          <li>
            <strong>Mistakes can be corrected.</strong> If a burn is credited in error (a bug, a bad price feed, abuse),
            we may reverse or adjust that credit.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "token",
    title: `${SITE.ticker} is not an investment`,
    body: (
      <>
        <p>
          {SITE.ticker} is a utility token: its only function with this project is to be burned for hosted compute
          credit.
        </p>
        <ul>
          <li>
            There is no expectation of profit from holding it. We make no promise about its price, liquidity or
            future.
          </li>
          <li>
            There are no buybacks, no staking, no yield, no dividends and no revenue share. Holding it gives no claim on
            the project, its revenue, its assets or its future work.
          </li>
          <li>Nothing on this site is financial, legal or tax advice. Its price can go to zero.</li>
          <li>
            Buying, holding, selling or burning it is your decision and your risk, under the laws where you live. It is
            not offered where its purchase or use is prohibited, and you must not use the token or credit if that
            applies to you.
          </li>
          <li>Anthropic has no connection to the token.</li>
        </ul>
        <p>
          More on the{" "}
          <Link className="link" href="/token">
            token page
          </Link>
          .
        </p>
      </>
    ),
  },
  {
    id: "anthropic",
    title: "No affiliation with Anthropic",
    body: (
      <p>
        Forkbomb is an independent open-source project. It is not made, endorsed or sponsored by Anthropic.
        &ldquo;Claude&rdquo; and &ldquo;Claude Code&rdquo; are Anthropic&apos;s names, used here only to say what
        Forkbomb works with.
      </p>
    ),
  },
  {
    id: "website",
    title: "Using this website",
    body: (
      <>
        <p>
          The site is information about the project, plus the app and API for the hosted service. Don&apos;t attack it,
          scrape it in a way that degrades it for others, or misrepresent its content as ours when you have changed it.
        </p>
        <p>
          Site text and the Forkbomb name and mark identify this project. You can link to the site and quote it with
          attribution. Forks of the code are welcome under MIT, but please don&apos;t present a fork as the official
          project.
        </p>
        <p>
          The site links to third-party services such as GitHub and Solana explorers, and the burn flow uses your own
          wallet. Their terms apply when you use them, and we don&apos;t control them.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes",
    body: (
      <p>
        These terms may change, especially before launch. The date at the top always shows the latest edit. A change
        doesn&apos;t apply to a burn already credited or a request already charged. Changes to the software license only
        happen through the repository, where every change is public and versioned.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these terms go to the project&apos;s{" "}
        <a className="link" href={`${GITHUB_URL}/issues`}>
          GitHub issues
        </a>
        . For a security problem, including anything that credits what it shouldn&apos;t, follow the reporting steps on
        the{" "}
        <Link className="link" href="/security#disclosure">
          security page
        </Link>{" "}
        instead of opening a public issue.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalDoc
      title="Terms"
      lede={`The rules for this website, the open-source ${SITE.name} CLI, the hosted service and ${SITE.ticker} compute credit. Short, readable, and the MIT license comes first.`}
      updated="October 2026"
      related={{ label: "Privacy notice", href: "/privacy" }}
      summary={[
        <>The MIT license governs the software. Self-hosting is free and never needs the token.</>,
        <>Forkbomb and the hosted service are provided as is, with no warranty. Review every patch before you apply it.</>,
        <>
          Burning {SITE.ticker} buys compute credit. Burns are final; credit is consumptive, non-refundable and
          non-transferable.
        </>,
        <>
          {SITE.ticker} is not an investment: no expectation of profit, no buybacks, no yield, no revenue share. Not
          available where prohibited.
        </>,
        <>We may change hosted prices and limits. Forkbomb is not affiliated with or endorsed by Anthropic.</>,
      ]}
      sections={sections}
    />
  );
}
