import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  Icon,
  PageHeader,
  Section,
  SectionHeader,
  Terminal,
  type TerminalLine,
} from "@/app/components";
import { ADVISORY_URL, GITHUB_URL, ISSUES_URL, SITE } from "@/app/config";
import { pageMetadata } from "@/app/lib/seo";
import { Fx, LayerStack, Pipeline, TrustBoundary } from "./_parts/Diagrams";
import { OnThisPage, type TocItem } from "./_parts/OnThisPage";
import s from "./security.module.css";

export const metadata = pageMetadata({
  title: "Security",
  description:
    "Hydra's threat model, isolation layers per engine, the isolation canary, how the judge resists gaming, data handling, known limits, and how to report a vulnerability.",
  path: "/security",
  image: "/security/opengraph-image",
  imageAlt: "Hydra security model. Every head is treated as hostile.",
});

const SRC = `${GITHUB_URL}/blob/main/src`;

const TOC: TocItem[] = [
  { id: "threat-model", label: "Threat model" },
  { id: "isolation", label: "Isolation" },
  { id: "canary", label: "Canary" },
  { id: "judge", label: "Judge" },
  { id: "data", label: "Data" },
  { id: "limits", label: "Limits" },
  { id: "disclosure", label: "Disclosure" },
];

const POSTURE: { k: string; v: string; d: string }[] = [
  { k: "Writes", v: "Clone + temp only", d: "Each head writes to its own clone and a private temp dir. Nowhere else." },
  { k: "Git", v: "Read-only", d: ".git can't be written by a head, so history and hooks stay yours." },
  { k: "Secrets", v: "Unreadable", d: "SSH keys, cloud and CLI credentials, Keychains, shell history." },
  { k: "Network", v: "Loopback only", d: "No outbound connections and no DNS from a head." },
  { k: "Env", v: "No keys", d: "Heads start from an allowlisted environment. No API keys or tokens." },
  { k: "Gate", v: "Canary first", d: "Claude Code heads don't start until a real escape attempt fails." },
];

type Row = { control: string; cc: string; api: string; proof: string };
const MATRIX: Row[] = [
  {
    control: "Writes",
    cc: "Clone and its temp dir only (Claude Code sandbox for Bash; edits auto-approved only inside the working directory)",
    api: "Clone and its temp dir only (Seatbelt deny-by-default on writes)",
    proof: "sandbox.test.ts · canary",
  },
  {
    control: ".git",
    cc: "Read-only: sandbox write-deny plus permission rules on the file tools",
    api: "Read-only via Seatbelt. The editor also refuses .git in any letter case",
    proof: "sandbox.test.ts · tools.test.ts · canary",
  },
  {
    control: "Reads",
    cc: "Deny list under ~: credentials, .config, .claude, shell history, Keychains, app data, Desktop, Documents, Downloads",
    api: "Home folder unreadable except the clone, its temp dir and toolchain folders (node, python, rust…)",
    proof: "sandbox.test.ts · canary",
  },
  {
    control: "Network",
    cc: "No outbound network. Local binding allowed. WebFetch and WebSearch denied",
    api: "Loopback only, system DNS resolver blocked. --network opts in",
    proof: "sandbox.test.ts · canary",
  },
  {
    control: "Environment",
    cc: "Allowlist: PATH, HOME, USER, LANG, SHELL, TERM. No API keys",
    api: "Clean environment for every shell command. No API keys",
    proof: "sandbox.test.ts · claude-code.test.ts",
  },
  {
    control: "Repo config",
    cc: "--safe-mode and no user or project settings: no CLAUDE.md, hooks, plugins or MCP",
    api: "Hydra's own tool loop with two tools, bash and an editor",
    proof: "source: claude-code.ts",
  },
  {
    control: "Path tricks",
    cc: "Permission rules deny the file tools on credential folders and .git",
    api: "Editor re-checks every path: no .., no symlinks out or into .git, no writes through hard links",
    proof: "tools.test.ts",
  },
  {
    control: "Runaway commands",
    cc: "Claude Code's own handling",
    api: "Timeout per command, capped output, background children killed",
    proof: "sandbox.test.ts",
  },
];

const CANARY_STEPS: { attempt: string; via: string; expect: string }[] = [
  { attempt: "echo inside > inside.txt", via: "Bash", expect: "must work" },
  { attempt: "echo escaped > ../escape-bash.txt", via: "Bash", expect: "must fail" },
  { attempt: "create a file next to the clone", via: "Write tool", expect: "must fail" },
  { attempt: "curl https://example.com", via: "Bash", expect: "must be blocked" },
  { attempt: "cat the planted secret", via: "Bash", expect: "never surfaces" },
  { attempt: "read the planted secret", via: "Read tool", expect: "never surfaces" },
  { attempt: "write into .git", via: "Bash", expect: "must fail" },
];

const CANARY_OUT: TerminalLine[] = [
  { tone: "cmd", text: "hydra canary" },
  { tone: "ok", text: "ok    canary: writes inside the clone work (inside.txt created)" },
  { tone: "ok", text: "ok    canary: shell can't write outside the clone (../escape-bash.txt)" },
  { tone: "ok", text: "ok    canary: file tools can't write outside the clone (escape-write.txt next to the clone)" },
  { tone: "ok", text: "ok    canary: no outbound network (curl blocked)" },
  { tone: "ok", text: "ok    canary: denied folders are unreadable (shell and Read tool) (planted secret never surfaced)" },
  { tone: "ok", text: "ok    canary: .git is read-only (.git/hydra-probe)" },
  { tone: "out", text: "hydra: Claude Code <version> keeps heads sealed in." },
];

const DATA: { what: string; where: string; who: string }[] = [
  {
    what: "Your repo",
    where: "APFS clones under ~/.hydra/runs/<id>/ (or --runs-dir, which can't sit inside the repo)",
    who: "Your machine",
  },
  {
    what: "What a head reads and writes",
    where: "Sent to Anthropic by Claude Code on your plan, or by the API engine with your key. Same path as using them directly",
    who: "Anthropic, under your plan or API terms",
  },
  {
    what: "Claude Code login",
    where: "Stays in Claude Code's own config. Heads can't read ~/.claude or ~/.claude.json",
    who: "Claude Code",
  },
  {
    what: "API key (api engine)",
    where: "~/.hydra/.env or your shell. Read by the Hydra process, never passed to a head",
    who: "Hydra process, Anthropic API",
  },
  {
    what: "Run record",
    where: "events.jsonl, the winning patch, the body and the winning head, in the run folder",
    who: "Your machine",
  },
  {
    what: "Live UI",
    where: "HTTP server bound to 127.0.0.1",
    who: "Your machine",
  },
  {
    what: "Exported replay",
    where: "Static files from hydra export. Nothing leaves until you host them",
    who: "Whoever you share it with",
  },
];

const LIMITS: { title: string; body: string }[] = [
  {
    title: "Seatbelt is not a VM.",
    body: "Heads share your kernel, your user account and your view of the filesystem. A bug in macOS's sandbox or kernel is outside what Hydra can contain.",
  },
  {
    title: "Heads can read most non-credential files.",
    body: "System paths are readable on both engines. On the Claude Code engine, so is anything under your home folder that isn't on the deny list. Run Hydra on code you'd let an agent work on.",
  },
  {
    title: "macOS only.",
    body: "APFS clonefile and Seatbelt are macOS mechanisms. There is no Linux or Windows sandbox today. --no-sandbox exists for development, prints a warning, and is not safe.",
  },
  {
    title: "The judge is being hardened.",
    body: "It's built against the common ways to game a test suite. It is not proof against every trick, and a patch that special-cases your tests' exact inputs will pass. Read the winning patch.",
  },
  {
    title: "No CPU or memory limits.",
    body: "Heads use CPU and memory freely. Eight heads also use your Claude plan's limits about eight times as fast as one session.",
  },
  {
    title: "--network opens the door.",
    body: "On the API engine, passing --network gives heads outbound access. It's off by default and not available on the Claude Code engine yet.",
  },
];


export default function SecurityPage() {
  return (
    <>
      <PageHeader
        eyebrow="Security"
        title="Every head is treated as hostile."
        lede="The model driving a head is untrusted, and so is the repo it reads. Hydra confines each head to its own clone, cuts its network, hides your credentials, and judges only the patch it would ship. This page says what that covers and what it doesn't."
        meta={["Checked against source 2026-10-05", "Hydra 0.1.0", SITE.platform]}
        actions={
          <>
            <Button href={ADVISORY_URL} icon="shield">
              Report a vulnerability
            </Button>
            <Button href={`${SRC}/sandbox.ts`} variant="ghost" iconRight="arrowUpRight">
              Read the sandbox source
            </Button>
          </>
        }
      />

      <OnThisPage items={TOC} />

      {/* ---------- Posture at a glance ---------- */}
      <Section size="sm" labelledBy="posture-h">
        <h2 id="posture-h" className="sr-only">
          Posture at a glance
        </h2>
        <dl className={s.posture}>
          {POSTURE.map((p) => (
            <div key={p.k} className={s.postureItem}>
              <dt className={s.postureKey}>{p.k}</dt>
              <dd className={s.postureVal}>{p.v}</dd>
              <dd className={s.postureDesc}>{p.d}</dd>
            </div>
          ))}
        </dl>
      </Section>

      {/* ---------- 01 Threat model ---------- */}
      <Section id="threat-model" labelledBy="threat-h" divider className={s.anchor}>
        <SectionHeader
          id="threat-h"
          index="01"
          eyebrow="Threat model"
          title="Assume the head gets steered."
          lede="A head is a language model running tools on your machine. Anything it reads can steer it: a README, a code comment, a test fixture, a dependency's install output. Hydra doesn't try to make the model trustworthy. It limits what a steered head can reach."
        />
        <TrustBoundary />

        <div className={s.scope}>
          <div className={s.scopeCol}>
            <h3 className={s.scopeTitle}>Designed against</h3>
            <ul className={s.list}>
              <li>Writing outside its clone, including into a sibling head</li>
              <li>Rewriting history or planting hooks in .git</li>
              <li>Reading SSH keys, cloud credentials, tokens and shell history</li>
              <li>Calling out to the network to send code or fetch payloads</li>
              <li>Inheriting your API keys from the environment</li>
              <li>A repo&apos;s own CLAUDE.md, hooks, MCP or settings loosening the sandbox</li>
              <li>Gaming the judge by editing tests or planting files outside the patch</li>
            </ul>
          </div>
          <div className={s.scopeCol}>
            <h3 className={s.scopeTitle}>Assumed</h3>
            <ul className={s.list}>
              <li>macOS Seatbelt and Claude Code&apos;s sandbox enforce their rules as documented</li>
              <li>Your test command is yours and you trust it. It still runs sandboxed</li>
              <li>You run Hydra on code you&apos;d let an agent work on</li>
            </ul>
          </div>
          <div className={s.scopeCol}>
            <h3 className={s.scopeTitle}>Out of scope</h3>
            <ul className={s.list}>
              <li>Kernel or sandbox escapes in macOS itself</li>
              <li>CPU and memory exhaustion</li>
              <li>Reads of non-credential files outside the clone</li>
              <li>What Anthropic does with prompts under your plan or API terms</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ---------- 02 Isolation ---------- */}
      <Section id="isolation" tone="raised" labelledBy="iso-h" className={s.anchor}>
        <SectionHeader
          id="iso-h"
          index="02"
          eyebrow="Isolation"
          title="Two engines. Same walls."
          lede="Hydra drives heads through Claude Code (the default) or its own loop on the Anthropic API. Each engine gets its own enforcement, layered around the head's clone. The judge always runs under Hydra's Seatbelt profile, whichever engine drove the heads."
        />

        <div className={s.stacks}>
          <LayerStack
            engine="Claude Code engine"
            flag="--engine claude-code"
            summary="Each head is a headless Claude Code session on your own login. Hydra configures it; the canary proves the configuration holds."
            layers={[
              { name: "Process", detail: "Allowlisted environment. No API keys or tokens, git config pointed at /dev/null." },
              {
                name: "Session",
                detail: "--safe-mode with no user or project settings. A repo's CLAUDE.md, hooks, plugins, MCP or .claude/settings.json can't load.",
              },
              { name: "Permission rules", detail: "File tools denied on credential folders and .git. WebFetch and WebSearch denied." },
              {
                name: "Claude Code sandbox",
                detail: "Bash writes only in the clone and its temp dir. No network. No unsandboxed escape hatch. Fails closed if unavailable.",
              },
            ]}
            core="head clone (APFS clonefile)"
            gate={
              <>
                <Badge tone="warn" dot>
                  gate
                </Badge>
                <span>Isolation canary must pass for this Claude Code version before any head starts.</span>
              </>
            }
          />
          <LayerStack
            engine="API engine"
            flag="--engine api"
            summary="Hydra's own tool loop on the Messages API with your key. Every shell command runs under a Seatbelt profile Hydra writes per head."
            layers={[
              { name: "Process", detail: "Clean environment for every command. No API keys or tokens." },
              {
                name: "Seatbelt profile",
                detail: "sandbox-exec. Writes only in the clone and temp dir. .git read-only. Home unreadable except the clone, temp and toolchains. Loopback only, no DNS.",
              },
              { name: "Editor", detail: "Runs in Hydra's process and re-checks every path: no .., no symlinks out or into .git, no hard-link writes." },
              { name: "Limits", detail: "Per-command timeout, capped output, background children killed on return." },
            ]}
            core="head clone (APFS clonefile)"
            gate={
              <>
                <Badge dot>tested</Badge>
                <span>Covered by Hydra&apos;s own suite: sandbox.test.ts and tools.test.ts.</span>
              </>
            }
          />
        </div>

        <h3 className={s.subhead} id="matrix-h">
          Control by control
        </h3>
        <div className={`table-wrap ${s.matrixWrap}`} role="region" aria-labelledby="matrix-h" tabIndex={0}>
          <table className={`table ${s.matrix}`}>
            <thead>
              <tr>
                <th scope="col">Control</th>
                <th scope="col">Claude Code engine</th>
                <th scope="col">API engine</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((r) => (
                <tr key={r.control}>
                  <th scope="row">{r.control}</th>
                  <td>
                    <Fx text={r.cc} />
                  </td>
                  <td>
                    <Fx text={r.api} />
                  </td>
                  <td className={s.proof}>{r.proof}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Phones: the same rows as stacked cards. Only one of the two is displayed at a time. */}
        <ul className={s.matrixCards} aria-labelledby="matrix-h">
          {MATRIX.map((r) => (
            <li key={r.control} className={s.mCard}>
              <h4 className={s.mCardTitle}>
                <Fx text={r.control} />
              </h4>
              <dl className={s.mCardRows}>
                <div>
                  <dt>Claude Code engine</dt>
                  <dd>
                    <Fx text={r.cc} />
                  </dd>
                </div>
                <div>
                  <dt>API engine</dt>
                  <dd>
                    <Fx text={r.api} />
                  </dd>
                </div>
                <div>
                  <dt>Evidence</dt>
                  <dd className={s.proof}>{r.proof}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
        <p className={s.footnote}>
          Test files live in{" "}
          <a className="link" href={`${GITHUB_URL}/tree/main/test`} target="_blank" rel="noopener noreferrer">
            test/
          </a>
          . The Claude Code settings and env allowlist are in{" "}
          <a className="link" href={`${SRC}/engines/claude-code.ts`} target="_blank" rel="noopener noreferrer">
            src/engines/claude-code.ts
          </a>
          ; the Seatbelt profile is in{" "}
          <a className="link" href={`${SRC}/sandbox.ts`} target="_blank" rel="noopener noreferrer">
            src/sandbox.ts
          </a>
          .
        </p>
      </Section>

      {/* ---------- 03 Canary ---------- */}
      <Section id="canary" labelledBy="canary-h" className={s.anchor}>
        <SectionHeader
          id="canary-h"
          index="03"
          eyebrow="Isolation canary"
          title="No heads until the escape fails."
          lede="Hydra configures Claude Code's sandbox; it didn't write it. So it checks. Before the first run on each Claude Code version, Hydra starts a real session, plants a secret next to the clone, and tells the session to break out. If any escape works, no heads start."
        />
        <div className="split split--top split--wide-right">
          <div className="stack">
            <ol className={s.attempts} aria-label="What the canary session is told to do">
              {CANARY_STEPS.map((c, i) => (
                <li key={c.attempt} className={s.attempt}>
                  <span className={s.attemptNum} aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className={s.attemptVia}>{c.via}</span>
                  <code className={s.attemptCmd}>{c.attempt}</code>
                  <span className={s.attemptExpect}>{c.expect}</span>
                </li>
              ))}
            </ol>
            <p className="body-sm muted">
              Every check is read from the filesystem and from what the tools returned, never from what the model says
              it did. The secret&apos;s value is never in the prompt, so any sighting in the session stream counts as a
              leak. The result is cached per Claude Code version in <code className="inline-code">~/.hydra/canary.json</code>;
              a new version runs it again.
            </p>
          </div>
          <div className="stack">
            <Terminal
              title="hydra canary"
              lines={CANARY_OUT}
              status={<span className={s.termNote}>output format</span>}
              ariaLabel="Lines hydra canary prints when every escape fails"
            />
            <Callout tone="warn" title="On a failure">
              Any failed check prints <code className="inline-code">FAIL</code> with what got through, and{" "}
              <code className="inline-code nowrap">hydra run</code> stops with &ldquo;isolation check failed, so no heads were
              started.&rdquo;
            </Callout>
            <CodeBlock title="Run it any time, from the hydra folder" lang="sh" code="$ node dist/cli.js canary" />
          </div>
        </div>
      </Section>

      {/* ---------- 04 Judge ---------- */}
      <Section id="judge" tone="raised" labelledBy="judge-h" className={s.anchor}>
        <SectionHeader
          id="judge-h"
          index="04"
          eyebrow="Judge integrity"
          title="Judged by the patch it would ship."
          lede="A head's workspace is untrusted, so the judge ignores it. It rebuilds what the head would actually hand you, on a clean copy, and runs your suite there."
        />
        <Pipeline
          label="How a head is judged"
          steps={[
            {
              name: "Diff",
              body: "Diff the head's clone against the shared base commit, untracked files included. Every git call runs sandboxed, with hooks and fsmonitor off.",
            },
            {
              name: "Strip",
              body: "Drop edits to tests and test config: *.test.*, *.spec.*, tests/, conftest.py, package.json, lockfiles, jest and vitest config, pyproject.toml, Makefile and more.",
            },
            {
              name: "Apply",
              body: "Fork a fresh clone of the pristine body and apply what's left. A patch that doesn't apply scores zero.",
            },
            {
              name: "Run",
              body: "Run your test command in a throwaway clone of that state, under Seatbelt.",
              tone: "warn",
            },
            {
              name: "Score",
              body: "A clean exit counts as a pass only if no tests went missing against the baseline run.",
              tone: "accent",
            },
          ]}
        />

        <div className={`split split--top ${s.judgeFoot}`}>
          <div>
            <h3 className={s.subheadTight}>What that stops</h3>
            <ul className={s.list}>
              <li>Editing or deleting tests to make them pass</li>
              <li>Planting new test files that always succeed</li>
              <li>Hacks in ignored paths like node_modules or build output, which never reach the patch</li>
              <li>Loosening test config to skip the suite</li>
              <li>A run that passes because fewer tests ran</li>
            </ul>
          </div>
          <Callout tone="warn" title="What it doesn't claim">
            <p>
              The judge isn&apos;t ungameable. It&apos;s designed against the common tricks above and is being hardened.
              Your tests are the spec: a patch that special-cases the exact inputs they check will pass.
            </p>
            <p>
              Read the winning patch before you use it. Hydra only touches your repo if you pass{" "}
              <code className="inline-code nowrap">--apply</code>.
            </p>
          </Callout>
        </div>
      </Section>

      {/* ---------- 05 Data ---------- */}
      <Section id="data" labelledBy="data-h" className={s.anchor}>
        <SectionHeader
          id="data-h"
          index="05"
          eyebrow="Data handling"
          title="Local by default. No Hydra server."
          lede="Hydra runs entirely on your machine. It has no account, no backend and no telemetry. Your code reaches Anthropic exactly the way it does when you use Claude Code or the API yourself, and no other way."
        />
        <div className={`table-wrap ${s.matrixWrap}`} role="region" aria-labelledby="data-h" tabIndex={0}>
          <table className={`table ${s.matrix} ${s.dataTable}`}>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Where it lives or goes</th>
                <th scope="col">Who can see it</th>
              </tr>
            </thead>
            <tbody>
              {DATA.map((d) => (
                <tr key={d.what}>
                  <th scope="row">{d.what}</th>
                  <td>
                    <Fx text={d.where} />
                  </td>
                  <td>{d.who}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className={s.matrixCards} aria-labelledby="data-h">
          {DATA.map((d) => (
            <li key={d.what} className={s.mCard}>
              <h3 className={s.mCardTitle}>{d.what}</h3>
              <dl className={s.mCardRows}>
                <div>
                  <dt>Where it lives or goes</dt>
                  <dd>
                    <Fx text={d.where} />
                  </dd>
                </div>
                <div>
                  <dt>Who can see it</dt>
                  <dd>{d.who}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </Section>

      {/* ---------- 06 Limits ---------- */}
      <Section id="limits" tone="inset" labelledBy="limits-h" className={s.anchor}>
        <SectionHeader
          id="limits-h"
          index="06"
          eyebrow="Known limitations"
          title="What Hydra doesn't protect against."
          lede="Stated plainly, so you can decide where to run it."
        />
        <ol className={s.limits}>
          {LIMITS.map((l, i) => (
            <li key={l.title} className={s.limit}>
              <span className={s.limitNum} aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className={s.limitTitle}>
                  <Fx text={l.title} />
                </h3>
                <p className={s.limitBody}>
                  <Fx text={l.body} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      {/* ---------- 07 Disclosure ---------- */}
      <Section id="disclosure" labelledBy="disclosure-h" className={s.anchor}>
        <div className="split split--top">
          <div className="stack">
            <SectionHeader
              id="disclosure-h"
              index="07"
          eyebrow="Responsible disclosure"
              title="Found a hole? Report it privately."
              lede="Open a private security advisory on the GitHub repo. Only maintainers can see it. Please don't file a public issue for anything that breaks isolation, leaks a secret or fools the judge."
              className={s.flushHeader}
              actions={
                <>
                  <Button href={ADVISORY_URL} variant="secondary" icon="shield">
                    Open a private advisory
                  </Button>
                  <Button href={ISSUES_URL} variant="ghost" iconRight="arrowUpRight">
                    Public issues (non-security)
                  </Button>
                </>
              }
            />
            <p className="body-sm muted">
              Hydra is a young open-source project. There&apos;s no bug bounty today. Fixes land in the public repo once
              they&apos;re safe to disclose.
            </p>
          </div>

          <div className={s.report}>
            <h3 className={s.reportTitle}>
              <Icon name="info" size={16} />
              What to include
            </h3>
            <ol className={s.reportList}>
              <li>
                Hydra commit or version, and <code className="inline-code nowrap">claude --version</code> if you used the Claude
                Code engine
              </li>
              <li>macOS version and the engine you ran</li>
              <li>The smallest repo, task or prompt that reproduces it</li>
              <li>What the head reached that it shouldn&apos;t have, and how you know</li>
            </ol>
            <h3 className={s.reportTitle}>Most wanted</h3>
            <ul className={s.reportList}>
              <li>An escape the canary doesn&apos;t catch</li>
              <li>A credential or denied path read from inside a head</li>
              <li>
                Network from a head without <code className="inline-code nowrap">--network</code>
              </li>
              <li>A patch that passes the judge by gaming it rather than fixing the code</li>
            </ul>
          </div>
        </div>
      </Section>
    </>
  );
}
