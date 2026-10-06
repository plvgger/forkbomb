import Link from "next/link";
import { GITHUB_URL, SITE } from "../config";
import { pageMetadata } from "../lib/seo";
import { LegalDoc, type LegalSection } from "../terms/_parts/LegalDoc";

export const metadata = pageMetadata({
  title: "Privacy",
  description:
    "The Forkbomb site sets no cookies and runs no analytics. The CLI runs on your machine and sends nothing to us. Claude traffic goes to Anthropic under their terms.",
  path: "/privacy",
});

const sections: LegalSection[] = [
  {
    id: "website",
    title: "This website",
    body: (
      <>
        <p>The site is static pages and a recorded replay. It collects as little as a website can:</p>
        <ul>
          <li>No cookies. The site does not set any.</li>
          <li>No analytics, tracking pixels, session recording or ad scripts.</li>
          <li>No accounts, forms or sign-ups. There is nothing to submit.</li>
          <li>
            Fonts are served from this site, not loaded from a third-party font service. The replay is a local file
            with its data bundled in, so it makes no outside requests either.
          </li>
        </ul>
        <p>
          The only thing stored in your browser is what a normal page load leaves in its cache. If that ever changes,
          this page changes first.
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
          Links to GitHub, X or any other service take you to that service, and its privacy policy applies there.
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
          <li>It sends nothing to us. There is no Forkbomb server for it to talk to.</li>
          <li>
            Runs, logs, diffs and replays are written to your disk, under <code>~/.forkbomb/runs</code> by default. They
            stay there until you delete them.
          </li>
          <li>
            The live tree view (<code>--ui</code>) is served on <code>127.0.0.1</code>, so only your own machine can
            reach it.
          </li>
          <li>
            <code>forkbomb export</code> writes a static replay folder. It only leaves your machine if you choose to host
            or share it. Check it first: it contains your task, file names, diffs and agent output.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "credentials",
    title: "Your credentials",
    body: (
      <>
        <p>
          With the default engine, heads use your existing Claude Code login. With <code>--engine api</code>, Forkbomb reads
          your Anthropic API key from the environment or from <code>~/.forkbomb/.env</code>. Either way the credential
          stays on your machine and is never sent to us.
        </p>
        <p>
          Heads themselves get a clean environment with no API keys in it, and the sandbox makes common credential
          folders (such as <code>~/.ssh</code>, <code>~/.aws</code> and <code>~/.forkbomb/.env</code>) unreadable to them.
          The full list and the limits are on the{" "}
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
          Each head is a Claude session. To do its work, the agent sends your task and the parts of your code it reads
          to Anthropic, through Claude Code or the Anthropic API. That traffic goes from your machine directly to
          Anthropic. It does not pass through us.
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
            Commands a head runs have no network access beyond loopback. The only outside traffic during a run is the
            model traffic to Anthropic described above.
          </li>
          <li>
            <code>forkbomb canary</code> tells a sandboxed session to try to escape, including a request to{" "}
            <code>example.com</code>. That request is expected to be blocked. If it gets through, the canary fails and
            Forkbomb refuses to run heads.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "token",
    title: "The $FORKBOMB token",
    body: (
      <p>
        The token is not wired into the product. Forkbomb never asks for a wallet, never reads one and never connects to a
        blockchain. On-chain transactions you make are public by design and are outside this notice. See the{" "}
        <Link className="link" href="/token">
          token page
        </Link>
        .
      </p>
    ),
  },
  {
    id: "rights",
    title: "Your choices",
    body: (
      <p>
        We hold no personal data about you, so there is nothing to export or delete on our side. For the server logs
        Vercel keeps, and for data held by Anthropic or GitHub, use those providers&apos; own privacy controls.
      </p>
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
      lede={`What this site and the ${SITE.name} CLI collect. The answer is close to nothing, and here is exactly why.`}
      updated="October 2026"
      related={{ label: "Terms", href: "/terms" }}
      summary={[
        <>The site sets no cookies and runs no analytics or trackers.</>,
        <>The host, Vercel, keeps standard server logs like any web host.</>,
        <>The CLI runs locally and sends nothing to us. No telemetry.</>,
        <>Your Claude login or API key stays on your machine.</>,
        <>Claude traffic goes from your machine to Anthropic, under Anthropic&apos;s terms.</>,
      ]}
      sections={sections}
    />
  );
}
