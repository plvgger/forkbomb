import Link from "next/link";
import { GITHUB_URL, SITE } from "../config";
import { pageMetadata } from "../lib/seo";
import { LegalDoc, type LegalSection } from "./_parts/LegalDoc";

export const metadata = pageMetadata({
  title: "Terms",
  description:
    "Plain-English terms for the Hydra website and the open-source Hydra CLI. The MIT license governs the software. The $HYDRA token is separate from the product.",
  path: "/terms",
});

const LICENSE_URL = `${GITHUB_URL}/blob/main/LICENSE`;

const sections: LegalSection[] = [
  {
    id: "scope",
    title: "What these terms cover",
    body: (
      <>
        <p>
          These terms cover two things: this website, and the Hydra command-line tool published as open source on{" "}
          <a className="link" href={GITHUB_URL}>
            GitHub
          </a>
          . By using either, you agree to them. If you don&apos;t agree, don&apos;t use them.
        </p>
        <p>
          This is a draft. It will be reviewed before public launch, and the date at the top changes whenever the text
          does.
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
          Hydra is released under the{" "}
          <a className="link" href={LICENSE_URL}>
            MIT License
          </a>
          . That license, not this page, governs your use, copying, modification and distribution of the code. Where
          this page and the license disagree about the software, the license wins.
        </p>
        <p>
          In short: you can use Hydra for anything, including commercial work, fork it and ship it, as long as the
          copyright notice and license text travel with it.
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
          Hydra is provided &ldquo;as is&rdquo;, without warranty of any kind, express or implied, including fitness for
          a particular purpose and non-infringement. That is the MIT license&apos;s wording and it applies in full.
        </p>
        <p>
          Hydra runs AI coding agents that read and write files. The sandbox limits what a head can do, and its limits
          are written down on the{" "}
          <Link className="link" href="/security">
            security page
          </Link>
          . It is a macOS sandbox, not a virtual machine, and it does not make an agent&apos;s output correct. A
          passing test suite means the patch passed your tests. It does not mean the patch is safe to ship. Review every
          patch before you apply it.
        </p>
        <p>
          To the extent the law allows, the authors and contributors are not liable for any damage, data loss or cost
          that comes from using Hydra or this website.
        </p>
      </>
    ),
  },
  {
    id: "responsibility",
    title: "You are responsible for what you run",
    body: (
      <>
        <p>You decide which repository Hydra runs on, which task it gets and which test command judges it. That means:</p>
        <ul>
          <li>Run it on code you have the right to modify.</li>
          <li>Keep backups. Hydra works on clones, but your machine and your repository are yours to protect.</li>
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
          Heads run on your own Claude Code login (a Pro or Max subscription) or on your own Anthropic API key. Every
          head is a separate agent session, so N heads use roughly N times the usage of one.
        </p>
        <ul>
          <li>Usage limits, rate limits and API charges are between you and Anthropic.</li>
          <li>
            Your use of Claude Code and the Anthropic API is governed by Anthropic&apos;s own terms and usage policies.
            Using Hydra does not change them.
          </li>
          <li>We never see your credentials or your bill, and we can&apos;t refund either.</li>
        </ul>
      </>
    ),
  },
  {
    id: "anthropic",
    title: "No affiliation with Anthropic",
    body: (
      <p>
        Hydra is an independent open-source project. It is not made, endorsed or sponsored by Anthropic. &ldquo;Claude&rdquo;
        and &ldquo;Claude Code&rdquo; are Anthropic&apos;s names, used here only to say what Hydra works with.
      </p>
    ),
  },
  {
    id: "token",
    title: "The $HYDRA token is separate",
    body: (
      <>
        <p>
          A community token, $HYDRA, exists as a launch vehicle for the project. It is not part of the software. Hydra
          does not need it, read it or check for it, and nothing in the product is gated behind it.
        </p>
        <ul>
          <li>The token is not an investment, a security, equity, or a claim on any revenue, asset or future work.</li>
          <li>Nothing on this site is financial advice. Its price can go to zero.</li>
          <li>Buying, holding or selling it is your decision and your risk, under the laws where you live.</li>
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
    id: "website",
    title: "Using this website",
    body: (
      <>
        <p>
          The site is information about the project. Don&apos;t attack it, scrape it in a way that degrades it for
          others, or misrepresent its content as ours when you have changed it.
        </p>
        <p>
          Site text and the Hydra name and mark identify this project. You can link to the site and quote it with
          attribution. Forks of the code are welcome under MIT, but please don&apos;t present a fork as the official
          project.
        </p>
        <p>
          The site links to third-party services such as GitHub. Their terms apply when you use them, and we
          don&apos;t control them.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes",
    body: (
      <p>
        These terms may change, especially before launch. The date at the top always shows the latest edit. Changes
        to the software license only happen through the repository, where every change is public and versioned.
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
        . For a security problem, follow the reporting steps on the{" "}
        <Link className="link" href="/security">
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
      lede={`The rules for this website and for ${SITE.name}, the open-source CLI. Short, readable, and the MIT license comes first.`}
      updated="October 2026"
      related={{ label: "Privacy notice", href: "/privacy" }}
      summary={[
        <>The MIT license governs the software. This page does not override it.</>,
        <>Hydra is provided as is, with no warranty. Review every patch before you apply it.</>,
        <>You are responsible for what you run it on, and for your own Claude or API usage and costs.</>,
        <>Hydra is independent. It is not affiliated with or endorsed by Anthropic.</>,
        <>The $HYDRA token is separate from the product and is not an investment.</>,
      ]}
      sections={sections}
    />
  );
}
