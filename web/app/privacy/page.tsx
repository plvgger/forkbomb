import Link from "next/link";
import { CLI_HOME, GITHUB_URL, SITE, STATUS, TOKEN_MEMO_PREFIX } from "../config";
import { pageMetadata } from "../lib/seo";
import { LegalDoc, type LegalSection } from "../terms/_parts/LegalDoc";

export const metadata = pageMetadata({
  title: "Privacy",
  description:
    "The Forkbomb site sets no cookies and runs no analytics. The CLI runs on your machine and sends nothing to us. The optional hosted API stores a workspace id, a hashed key, usage counts and public burn records, and no prompts or completions.",
  path: "/privacy",
});

const sections: LegalSection[] = [
  {
    id: "website",
    title: "This website",
    body: (
      <>
        <p>
          The site is pages, a recorded replay, the public burn ledger and the app. It collects as little as it can:
        </p>
        <ul>
          <li>No cookies for tracking. The site does not set any.</li>
          <li>No analytics, tracking pixels, session recording or ad scripts.</li>
          <li>
            Fonts are served from this site, not loaded from a third-party font service. The replay is a local file with
            its data bundled in, so it makes no outside requests either.
          </li>
        </ul>
        <p>
          Your browser may keep small conveniences for you, such as a cached page. If the site ever starts storing
          anything else, this page changes first.
        </p>
      </>
    ),
  },
  {
    id: "hosting",
    title: "Hosting and server logs",
    body: (
      <>
        <p>
          The site is hosted on Vercel. Like any web host, Vercel processes standard request data to serve pages and
          protect the service: IP address, requested URL, time, user agent and referrer. That is handled under
          Vercel&apos;s own privacy policy. We don&apos;t combine it with anything, build profiles from it, or sell it.
        </p>
        <p>
          Links to GitHub, X, Solana explorers or any other service take you to that service, and its privacy policy
          applies there.
        </p>
      </>
    ),
  },
  {
    id: "cli",
    title: "The Forkbomb CLI",
    body: (
      <>
        <p>Forkbomb runs entirely on your Mac. It has no telemetry and no phone-home.</p>
        <ul>
          <li>
            With the claude-code and api engines, it sends nothing to us. It only talks to the hosted API if you choose{" "}
            <code>--engine hosted</code> or run <code>forkbomb credits</code>.
          </li>
          <li>
            Runs, logs, diffs and replays are written to your disk, under <code>{CLI_HOME}/runs</code> by default. They
            stay there until you delete them.
          </li>
          <li>
            The live tree view (<code>--ui</code>) is served on <code>127.0.0.1</code>, so only your own machine can
            reach it.
          </li>
          <li>
            <code>forkbomb export</code> writes a static replay folder. It only leaves your machine if you choose to
            host or share it. Check it first: it contains your task, file names, diffs and agent output.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "hosted",
    title: "The hosted API",
    body: (
      <>
        <p>
          The hosted engine and burn-for-credit are optional.{" "}
          {STATUS.hostedPoolLive ? "" : "The GPU pool is coming online and is not serving requests yet. "}
          When you use them, this is everything the hosted API stores:
        </p>
        <ul>
          <li>
            <strong>Your workspace:</strong> a random id (<code>ws_…</code>), the label you give it, when it was
            created, and its credit balance.
          </li>
          <li>
            <strong>Your API key, hashed:</strong> only an HMAC-SHA256 of the key. The key itself is shown to you once
            and never stored.
          </li>
          <li>
            <strong>Usage counts:</strong> per request, the model, input and output token counts, the cost and whether
            it succeeded. Not what was said.
          </li>
          <li>
            <strong>Burn records:</strong> the transaction signature, your wallet address, the amount, the price, the
            credit and the block time. These are already public on Solana. The public ledger shows them without the
            workspace id.
          </li>
          <li>
            <strong>Hashed IPs:</strong> an HMAC of your IP address, used for rate limits (and recorded once when a
            workspace is created, to stop abuse). Never the IP itself.
          </li>
        </ul>
        <p>
          <strong>We don&apos;t store prompts or completions.</strong> Requests to the hosted model pass through the
          gateway to the GPU that runs the model and back to you. They aren&apos;t written to our database or logs. If
          we ever need to keep request content to deal with abuse, this section will say so before that happens, and
          what is kept and for how long.
        </p>
        <p>
          The model runs on GPUs rented from RunPod. RunPod processes the requests in transit to run the model, under its
          own terms.
        </p>
      </>
    ),
  },
  {
    id: "credentials",
    title: "Your credentials",
    body: (
      <>
        <p>
          With the default engine, forks use your existing Claude Code login. With <code>--engine api</code>, Forkbomb
          reads your Anthropic API key from the environment or from <code>{CLI_HOME}/.env</code>. That credential stays
          on your machine and is never sent to us.
        </p>
        <p>
          With <code>--engine hosted</code>, your Forkbomb API key is sent only to the hosted gateway, in the
          Authorization header, over https.
        </p>
        <p>
          Forks themselves get a clean environment with no API keys in it, and the sandbox makes common credential
          folders (such as <code>~/.ssh</code>, <code>~/.aws</code> and <code>{CLI_HOME}/.env</code>) unreadable to
          them. The full list and the limits are on the{" "}
          <Link className="link" href="/security">
            security page
          </Link>
          .
        </p>
      </>
    ),
  },
  {
    id: "anthropic",
    title: "Traffic to Anthropic",
    body: (
      <>
        <p>
          With the claude-code and api engines, each fork is a Claude session. To do its work, the agent sends your task
          and the parts of your code it reads to Anthropic, through Claude Code or the Anthropic API. That traffic goes
          from your machine directly to Anthropic. It does not pass through us.
        </p>
        <p>
          What Anthropic does with that data is set by Anthropic&apos;s terms and privacy policy, and by your plan or
          API settings. Forkbomb does not change any of it. Forkbomb is not affiliated with Anthropic.
        </p>
      </>
    ),
  },
  {
    id: "network",
    title: "Other network activity",
    body: (
      <>
        <p>Being specific about every outbound connection the tool can make:</p>
        <ul>
          <li>Installing from source fetches the code from GitHub and dependencies from the npm registry.</li>
          <li>
            Commands a fork runs have no network access beyond loopback. The only outside traffic during a run is the
            model traffic, to Anthropic or to the hosted gateway, described above.
          </li>
          <li>
            <code>forkbomb doctor</code> asks the hosted gateway for your balance only if a hosted key is set.
          </li>
          <li>
            <code>forkbomb canary</code> tells a sandboxed session to try to escape, including a request to{" "}
            <code>example.com</code>. That request is expected to be blocked. If it gets through, the canary fails and
            Forkbomb refuses to start any forks.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "token",
    title: `${SITE.ticker} and your wallet`,
    body: (
      <>
        <p>
          The CLI never asks for a wallet, never reads one and never connects to a blockchain. Burns happen in your own
          wallet. The server only reads a burn transaction from Solana when you, or the app, send its signature to be
          verified.
        </p>
        <p>
          A burn&apos;s memo (<code>{TOKEN_MEMO_PREFIX}&lt;workspaceId&gt;</code>) is written on chain, so anyone can
          see which workspace id a wallet burned for. On-chain transactions are public and permanent by design, and
          outside what we can delete. See the{" "}
          <Link className="link" href="/burns">
            burn ledger
          </Link>
          .
        </p>
      </>
    ),
  },
  {
    id: "rights",
    title: "Your choices",
    body: (
      <>
        <p>
          If you only use the CLI on your own Claude login or API key, we hold no personal data about you, so there is
          nothing to export or delete on our side.
        </p>
        <p>
          If you have a hosted workspace, you can ask us to delete it through the project&apos;s GitHub issues
          (don&apos;t post the key). We remove its label and key hash, which also disables the key and any credit left
          on it. Usage and burn records are kept for accounting, and burns stay on Solana regardless. For the server
          logs Vercel keeps, and for data held by Anthropic or GitHub, use those providers&apos; own privacy controls.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes and contact",
    body: (
      <p>
        This is a draft and will be reviewed before launch. The date at the top shows the latest edit. Questions go to
        the project&apos;s{" "}
        <a className="link" href={`${GITHUB_URL}/issues`}>
          GitHub issues
        </a>
        .
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalDoc
      title="Privacy"
      lede={`What this site, the ${SITE.name} CLI and the optional hosted API collect. Close to nothing, and here is exactly what.`}
      updated="October 2026"
      related={{ label: "Terms", href: "/terms" }}
      summary={[
        <>The site sets no tracking cookies and runs no analytics or trackers.</>,
        <>The CLI runs locally and has no telemetry. With the claude-code and api engines it sends nothing to us.</>,
        <>
          The hosted API stores a workspace id, a hashed key, usage counts, public burn records and hashed IPs for rate
          limits.
        </>,
        <>We don&apos;t store prompts or completions.</>,
        <>
          Claude traffic goes from your machine to Anthropic, under Anthropic&apos;s terms. Burns are public on Solana.
        </>,
      ]}
      sections={sections}
    />
  );
}
