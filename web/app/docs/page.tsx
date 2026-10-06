import Link from "next/link";
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  CAChip,
  Callout,
  CodeBlock,
  Container,
  CrtPanel,
  Glyph,
  HazardStripe,
  PageHeader,
  PsTable,
  ReplayFrame,
  Terminal,
  type CodeLine,
  type TerminalLine,
} from "../components";
import {
  APP_URL,
  BENCH,
  CLI_LEGACY_HOME,
  GITHUB_URL,
  INSTALL_SCRIPT,
  ISSUES_URL,
  REPLAY_URL,
  REQUIREMENTS,
  RUN,
  RUN_TRANSCRIPT,
  SITE,
  STATUS,
  TEST_COUNT,
  TOKEN_MEMO_PREFIX,
} from "../config";
import diff from "../diff.json";
import { pageMetadata } from "../lib/seo";
import { DocSection, Endpoint, ErrorTable, FlagTable, Flow, H3, RefTable, Synopsis } from "./_parts/Blocks";
import {
  API_BASE,
  BENCH_FLAGS,
  BIN,
  CANARY_CHECKS,
  CANARY_FLAGS,
  CREDITS_FLAGS,
  DEFAULT_PROTECT,
  DOCTOR_CHECKS,
  EVENTS,
  GATEWAY_ERRORS,
  HOME,
  HOSTED_MODEL,
  KEY_ENV,
  KEY_PREFIX,
  MEMO,
  REPLAY_FLAGS,
  RUN_FLAGS,
  STRATEGIES,
  TEST_FORMATS,
  TOC,
  URL_ENV,
  VERIFY_ERRORS,
} from "./_parts/content";
import { DocsToc } from "./_parts/DocsToc";
import s from "./docs.module.css";

export const metadata = pageMetadata({
  title: "Docs",
  description:
    "Install Forkbomb from source, run your first race, and look up every command and flag. How forking, judging and isolation work, the hosted engine, burning $FORKBOMB for compute credit, and the API reference.",
  path: "/docs",
  image: "/docs/opengraph-image",
  imageAlt: "forkbomb docs. Install from source, run your first race, and look up every command and flag.",
});

const TONE: Record<string, CodeLine["tone"]> = { fl: "meta", hnk: "hunk", add: "add", del: "del" };
const PATCH_LINES: CodeLine[] = (diff as [string, string][]).map(([tone, text]) => ({ text, tone: TONE[tone] ?? "" }));

const POOL = STATUS.hostedPoolLive ? "Hosted pool: live" : "Hosted pool: coming online";

/** Two-column listing with the comment column aligned. ASCII only, so every glyph is in the mono font. */
function tree(rows: [string, string][]): string {
  const w = Math.max(...rows.map(([p]) => p.length)) + 4;
  return rows.map(([p, c]) => (c ? p.padEnd(w) + c : p)).join("\n");
}

const GLOSSARY: { term: string; means: string }[] = [
  { term: "pid 1", means: "The parent: a clean clone of your repo plus a base snapshot. Every fork copies it." },
  { term: "fork", means: "One agent in its own copy-on-write clone, with its own strategy. IDs look like 1.01, 1.02." },
  { term: "race", means: "One run of the CLI: fork, let the forks work, judge, keep one." },
  { term: "kill -9", means: "A losing fork is stopped mid-thought and its clone is deleted." },
  { term: "exit 0", means: "The fork whose patch passed your whole suite. Its patch is the answer." },
];

const PHASES = [
  { key: "fork", name: "fork()", line: "clonefile pid 1 into N forks", tone: "signal" },
  { key: "race", name: "Race", line: "one strategy per fork, in parallel", tone: "neutral" },
  { key: "judge", name: "Judge", line: "apply the patch to a fresh clone, run the suite", tone: "warn" },
  { key: "kill", name: "kill -9", line: "kill the losers, the passing fork exits 0", tone: "signal" },
  { key: "refork", name: "Re-fork", line: "no pass: the best fork becomes the next parent", tone: "neutral" },
] as const;

const CREDITS_OUT: TerminalLine[] = [
  { tone: "cmd", text: `${BIN} credits` },
  { tone: "out", text: "workspace  <label> (ws_…)" },
  { tone: "out", text: "credit     $<balance>" },
  { tone: "out", text: "pricing    $<in> / 1M input tokens · $<out> / 1M output tokens · model <model>" },
  { tone: "signal", text: `top up     burn ${SITE.ticker} at ${SITE.url}${APP_URL}` },
];

const ERROR_SHAPE = `{
  "error": {
    "message": "Insufficient credits: this request needs up to $<max cost> and the workspace has $<balance> remaining. Burn tokens to add credit.",
    "type": "billing_error",
    "code": "insufficient_credits"
  }
}`;

export default function DocsPage() {
  let n = 0;
  const next = () => ++n;

  return (
    <>
      <PageHeader
        eyebrow="Documentation"
        title={
          <>
            <span className="text-signal">man</span> {BIN}
          </>
        }
        lede="Install from source, run your first race, and look up every command and flag. Then the hosted engine, burning for compute, and the API. Everything here matches the CLI and the server code as they are today."
        meta={[SITE.platform, `${SITE.license} license`, "Not on npm yet", POOL]}
        actions={
          <>
            <Button href="#install" variant="primary" iconRight="arrowRight">
              Install
            </Button>
            <Button href={GITHUB_URL} icon="github" variant="outline">
              Source on GitHub
            </Button>
          </>
        }
      />

      <Container>
        <div className={s.layout}>
          <DocsToc items={TOC} issuesUrl={ISSUES_URL} />

          <article className={s.doc}>
            {/* ---------------- Overview ---------------- */}
            <DocSection
              id="overview"
              index={next()}
              title="Overview"
              lede="Forkbomb forks a coding agent into N sandboxed copies of your repo. Each fork tries a different strategy. Your test suite judges them. The losers are killed, the passing fork exits 0, and its patch is yours."
            >
              <p>
                A single agent run is one draw. When it goes the wrong way, you find out late and start over. Forkbomb
                takes several draws at once, cheaply, and lets the tests you already trust pick the result. Forking uses
                APFS <code>clonefile(2)</code>, so a fork costs metadata, not a copy of your repo. The name is the joke;{" "}
                <Glyph className={s.glyphInline} /> is the classic shell fork bomb. This one stops at the number of forks
                you ask for.
              </p>
              <dl className={s.facts}>
                <div>
                  <dt>Platform</dt>
                  <dd>macOS on APFS. Sandboxing uses Seatbelt.</dd>
                </div>
                <div>
                  <dt>Engines</dt>
                  <dd>
                    <code>claude-code</code> (default, your Claude plan), <code>api</code> (API key) or{" "}
                    <code>hosted</code> ({STATUS.hostedPoolLive ? "live" : "coming online"})
                  </dd>
                </div>
                <div>
                  <dt>Judge</dt>
                  <dd>Your test command, run against each fork&apos;s patch in a fresh clone</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>
                    <code>winner.patch</code>, a full event log, a replayable run
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>Pre-release. Install from source. {TEST_COUNT} automated tests in the CLI&apos;s own suite.</dd>
                </div>
                <div>
                  <dt>License</dt>
                  <dd>{SITE.license}. Self-hosting is free and always will be.</dd>
                </div>
              </dl>

              <CrtPanel title={`man 7 ${BIN} · vocabulary`} flush className={s.glossary}>
                <dl className={s.glossaryList}>
                  {GLOSSARY.map((g) => (
                    <div key={g.term}>
                      <dt className={g.term === "exit 0" ? s.termOk : g.term === "kill -9" ? s.termKill : undefined}>
                        {g.term}
                      </dt>
                      <dd>{g.means}</dd>
                    </div>
                  ))}
                </dl>
              </CrtPanel>
            </DocSection>

            {/* ---------------- Requirements ---------------- */}
            <DocSection
              id="requirements"
              index={next()}
              title="Requirements"
              lede="Forkbomb runs on macOS only today. Copy-on-write forking needs APFS and the sandbox is macOS Seatbelt. There is no Linux or Windows build."
            >
              <ul className={s.checklist}>
                {REQUIREMENTS.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              <p>
                Xcode Command Line Tools provide <code>clang</code>, which compiles a one-file clone helper on first run.
                For the default engine, Claude Code must be installed and logged in with a Pro or Max plan. For{" "}
                <code>--engine api</code>, you need an <code>ANTHROPIC_API_KEY</code> instead. For{" "}
                <code>--engine hosted</code>, you need a <code>{KEY_ENV}</code> and credit (see{" "}
                <a className="link" href="#hosted">
                  Hosted engine
                </a>
                ).
              </p>
              <p>
                <code>{BIN} doctor</code> checks all of it:
              </p>
              <RefTable
                caption={`What ${BIN} doctor checks`}
                head={["Check", "What it verifies", "If it fails"]}
                mono={[]}
                rows={DOCTOR_CHECKS.map((c) => [
                  <strong key="c">{c.check}</strong>,
                  c.verifies,
                  c.cmd ? <code key="f">{c.fix}</code> : c.fix,
                ])}
              />
            </DocSection>

            {/* ---------------- Install ---------------- */}
            <DocSection
              id="install"
              index={next()}
              title="Install"
              lede="Forkbomb is not published on npm yet. Build it from source. Any package on npm that claims to be Forkbomb is not this project."
            >
              <CodeBlock title="Install from source" lang="sh" code={INSTALL_SCRIPT} ariaLabel="Install commands" />
              <Callout tone="signal" title={`${BIN} <cmd> means node dist/cli.js <cmd>`}>
                <p>
                  These docs write commands as <code className="inline-code">{BIN} &lt;cmd&gt;</code>. Run{" "}
                  <code className="inline-code">npm link</code> in the repo folder to put{" "}
                  <code className="inline-code">{BIN}</code> on your PATH, or run{" "}
                  <code className="inline-code">node dist/cli.js &lt;cmd&gt;</code> from the repo folder without
                  linking. Installs from before the rename kept their files in{" "}
                  <code className="inline-code">{CLI_LEGACY_HOME}</code>; the CLI still reads it until{" "}
                  <code className="inline-code">{HOME}</code> exists, and those builds print{" "}
                  <code className="inline-code">hydra:</code> in their messages.
                </p>
              </Callout>
              <H3 id="install-credentials">Credentials</H3>
              <p>
                For the default engine, log Claude Code in once. Forkbomb uses whatever it is logged in with. For the
                API or hosted engine, put the key in <code>{HOME}/.env</code> or export it.
              </p>
              <CodeBlock
                title="Default engine: Claude Code"
                lang="sh"
                code={"$ claude auth login"}
                ariaLabel="Log in to Claude Code"
              />
              <CodeBlock
                title={`${HOME}/.env (api and hosted engines only)`}
                lang="env"
                code={`ANTHROPIC_API_KEY=...        # --engine api\n${KEY_ENV}=${KEY_PREFIX}...   # --engine hosted`}
                ariaLabel="Key file"
              />
              <Callout tone="info" title="Keys stay on your machine">
                <p>
                  The Anthropic key goes only to Anthropic, and the hosted key only to the hosted gateway. Forks run with
                  a clean environment and never see either key.
                </p>
              </Callout>
            </DocSection>

            {/* ---------------- Quickstart ---------------- */}
            <DocSection
              id="quickstart"
              index={next()}
              title="Quickstart"
              lede="Four commands from a fresh build to a verified patch. Point Forkbomb at a repo with a failing test suite."
            >
              <ol className={s.steps}>
                <li>
                  <h3 className={s.stepTitle}>Check the machine</h3>
                  <CodeBlock title="Terminal" lang="sh" code={`$ ${BIN} doctor`} ariaLabel={`Run ${BIN} doctor`} />
                </li>
                <li>
                  <h3 className={s.stepTitle}>Prove the sandbox holds</h3>
                  <p>
                    Optional. Forkbomb runs the isolation canary on its own before the first run on each Claude Code
                    version. It takes about a minute.
                  </p>
                  <CodeBlock title="Terminal" lang="sh" code={`$ ${BIN} canary`} ariaLabel={`Run ${BIN} canary`} />
                </li>
                <li>
                  <h3 className={s.stepTitle}>Start the race</h3>
                  <p>
                    <code>--task</code> says what to do. <code>--test</code> decides who exits 0. <code>--ui</code>{" "}
                    opens the live process tree on <code>127.0.0.1:4317</code>.
                  </p>
                  <CodeBlock
                    title="Terminal"
                    lang="sh"
                    code={`$ ${BIN} run ./my-repo --task "fix the failing tests" --test "npm test" --ui`}
                    ariaLabel="Start a race"
                  />
                </li>
                <li>
                  <h3 className={s.stepTitle}>Review and ship the patch</h3>
                  <p>
                    The passing fork&apos;s diff is saved as <code>winner.patch</code> in the run folder. Read it, then
                    apply it. Or pass <code>--apply</code> next time and Forkbomb applies it for you.
                  </p>
                  <CodeBlock
                    title="Terminal"
                    lang="sh"
                    code={`$ git -C ./my-repo apply ${HOME}/runs/<id>/winner.patch`}
                    ariaLabel="Apply the winning patch"
                  />
                </li>
              </ol>

              <H3 id="quickstart-real-run">What a race looks like</H3>
              <p>
                A real run from {RUN.date}: {RUN.engine}, on the {RUN.repo}. The baseline had {RUN.baseline.passing} of{" "}
                {RUN.baseline.total} tests passing. Four forks were made in {RUN.forkMsEach} ms each. Fork{" "}
                {RUN.winner.id} ({RUN.winner.strategy}) passed {RUN.winner.passed}/{RUN.winner.total} first, the other{" "}
                {RUN.severed} were killed, and the whole race took {RUN.durationS} s.
              </p>
              <Terminal
                title={`${BIN} run · ${RUN.id}`}
                lines={RUN_TRANSCRIPT}
                status={
                  <Badge tone="ok" dot>
                    exit 0 · {RUN.winner.id}
                  </Badge>
                }
                ariaLabel="Terminal output of a real run"
              />
              <CrtPanel title={`ps -o pid,strategy,stat · run ${RUN.id}`} flush>
                <PsTable />
              </CrtPanel>
              <p className={s.after}>
                <a className="link" href={REPLAY_URL}>
                  Open the full replay of this run
                </a>
              </p>
            </DocSection>

            {/* ---------------- How it works ---------------- */}
            <DocSection
              id="how-it-works"
              index={next()}
              title="How a race works"
              lede="Five phases. Forkbomb clones your repo once into pid 1, forks it, lets the forks race, judges each patch on a clean copy, and keeps one."
            >
              <ol className={s.phases} aria-label="Phases of a race">
                {PHASES.map((p, i) => (
                  <li key={p.key} className={s.phase} data-tone={p.tone}>
                    <span className={s.phaseIdx} aria-hidden="true">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <a className={s.phaseName} href={`#phase-${p.key}`}>
                      {p.name}
                    </a>
                    <span className={s.phaseLine}>{p.line}</span>
                  </li>
                ))}
              </ol>

              <ReplayFrame className={s.replay} />

              <H3 id="phase-fork">1. fork()</H3>
              <p>
                Forkbomb clones your repo once into <em>pid 1</em>, commits a base snapshot, and forks pid 1 into N
                copies with <code>clonefile(2)</code>. On APFS a clone shares every data block with its parent until a
                fork writes, so forking costs metadata, not bytes. Off APFS, Forkbomb falls back to a plain copy.
              </p>
              <RefTable
                caption={`${BIN} bench on a ${BENCH.machine}, ${BENCH.workload}, ${BENCH.heads} forks`}
                head={["Forker", "Per fork", "Extra disk"]}
                mono={[0, 1, 2]}
                rows={[
                  ["apfs-clonefile", `${BENCH.clonefile.perHeadMs} ms`, BENCH.clonefile.extraDisk],
                  ["copy", `${BENCH.copy.perHeadMs.toLocaleString("en-US")} ms`, BENCH.copy.extraDisk],
                ]}
              />
              <p className={s.note}>
                {BIN} bench · {BENCH.machine} · {BENCH.workload} · {BENCH.heads} forks. {BENCH.speedup} faster,{" "}
                {BENCH.diskSaving} less disk. Run <code>{BIN} bench ./my-repo</code> to measure your own.
              </p>

              <H3 id="phase-race">2. Race</H3>
              <p>
                Each fork is an agent with a shell and a file editor, working in its own clone. Each gets a different
                strategy. Diversity is the point: eight copies with one strategy fail the same way eight times. Forks take
                strategies in this order and wrap around after twelve.
              </p>
              <RefTable
                caption="Fork strategies, in assignment order"
                head={["#", "Strategy", "Brief"]}
                mono={[0, 1]}
                rows={STRATEGIES.map((st, i) => [String(i + 1).padStart(2, "0"), st.name, st.brief])}
              />

              <H3 id="phase-judge">3. Judge</H3>
              <p>A fork is judged by the patch it would ship, not by the state of its sandbox.</p>
              <ol className={s.numbered}>
                <li>Take the fork&apos;s diff against the base snapshot.</li>
                <li>
                  Drop every change to tests and test config (see{" "}
                  <a className="link" href="#protected">
                    protected paths
                  </a>
                  ).
                </li>
                <li>Apply what is left to a fresh clone of pid 1.</li>
                <li>Run your test command there, under Forkbomb&apos;s own Seatbelt profile.</li>
                <li>Score it. A clean exit only counts as a pass if no tests went missing compared with the baseline.</li>
              </ol>
              <p>
                Hacks to ignored files such as <code>node_modules</code> or build output never reach the fresh clone, so
                they never count. The judge is designed against the common ways an agent games a suite. It is still being
                hardened. Read the winning patch before you ship it.
              </p>

              <H3 id="phase-kill">4. kill -9</H3>
              <p>
                In <code>race</code> mode, the first fork to pass the full suite exits 0 and the rest are killed
                mid-thought. In <code>best</code> mode, every fork finishes and the smallest passing diff wins. Killed
                forks&apos; clones are deleted unless you pass <code>--keep-forks</code>.
              </p>

              <H3 id="phase-refork">5. Re-fork</H3>
              <p>
                If nobody passes, the best fork&apos;s verified state (pid 1 plus its patch) becomes the parent of the
                next round, with a note on where it left off. <code>--rounds</code> caps how many times this happens. If
                the last round still has no pass, Forkbomb saves the best partial patch as <code>best.patch</code>.
              </p>
            </DocSection>

            {/* ---------------- Engines ---------------- */}
            <DocSection
              id="engines"
              index={next()}
              title="Engines"
              lede="Three ways to drive the forks. Whichever you pick, tools run on your Mac inside the sandbox, and credentials stay on your machine."
            >
              <RefTable
                caption="Engine comparison"
                head={["", "claude-code (default)", "api", "hosted"]}
                mono={[]}
                rows={[
                  [
                    <strong key="a">Credentials</strong>,
                    <code key="b">claude auth login</code>,
                    <code key="c">ANTHROPIC_API_KEY</code>,
                    <code key="d">{KEY_ENV}</code>,
                  ],
                  [<strong key="a">Billing</strong>, "Your Pro or Max plan", "Pay as you go, with Anthropic", `Credit from burning ${SITE.ticker}`],
                  [<strong key="a">Model</strong>, "Your Claude Code default", <code key="c">claude-opus-5-5</code>, "Forkbomb's GPU coding model"],
                  [<strong key="a">Shell sandbox</strong>, "Claude Code's sandbox plus Forkbomb's rules", "Forkbomb's Seatbelt profile", "Forkbomb's Seatbelt profile"],
                  [<strong key="a">--network</strong>, "Not supported yet", "Opt-in", "Opt-in"],
                  [<strong key="a">Isolation canary</strong>, "Before the first run on each version", "Not used", "Not used"],
                  [
                    <strong key="a">Status</strong>,
                    "Live",
                    "Live",
                    STATUS.hostedPoolLive ? "Live" : <span key="d" className={s.soon}>Coming online</span>,
                  ],
                ]}
              />

              <H3 id="engine-claude-code">claude-code</H3>
              <p>
                Each fork is a headless Claude Code session (<code>claude -p</code>) on whatever Claude Code is logged in
                with. Forks count against your plan&apos;s usage limits, and eight forks use them about eight times as
                fast as one session. Each fork runs with:
              </p>
              <ul>
                <li>
                  <code>--safe-mode</code>: no CLAUDE.md, hooks, plugins or MCP.
                </li>
                <li>
                  No user or project settings, so a repo&apos;s own <code>.claude/settings.json</code> can&apos;t loosen
                  anything.
                </li>
                <li>
                  Claude Code&apos;s sandbox for Bash: writes stay in the clone, no network, credential folders
                  unreadable, no unsandboxed escape hatch.
                </li>
                <li>
                  Permission rules that deny the file tools on credential folders and <code>.git</code>.
                </li>
                <li>No API keys in its environment.</li>
              </ul>

              <H3 id="engine-api">api</H3>
              <p>
                Forkbomb&apos;s own tool loop on the Messages API, with <code>ANTHROPIC_API_KEY</code>. The default model
                is <code>claude-opus-5-5</code> at <code>medium</code> effort. Shell commands run under Forkbomb&apos;s
                Seatbelt profile. The text editor runs in Forkbomb&apos;s process and re-checks every path: no{" "}
                <code>..</code>, no symlinks out of the clone or into <code>.git</code>, no writing through hard links.
              </p>

              <H3 id="engine-hosted">hosted</H3>
              <p>
                The same tool loop and the same sandbox as <code>api</code>, but the model is Forkbomb&apos;s own GPU
                coding model behind an OpenAI-compatible gateway, paid with credit from burning {SITE.ticker}. Details in{" "}
                <a className="link" href="#hosted">
                  Hosted engine
                </a>
                .
              </p>
            </DocSection>

            {/* ---------------- Hosted engine ---------------- */}
            <DocSection
              id="hosted"
              index={next()}
              title="Hosted engine"
              lede={
                <>
                  <code>--engine hosted</code> runs forks on Forkbomb&apos;s GPU coding model instead of Claude. The
                  model only talks. Every tool call still runs on your Mac, in the same sandbox as the api engine.
                </>
              }
            >
              <CrtPanel
                title="status · hosted pool"
                status={
                  STATUS.hostedPoolLive ? (
                    <Badge tone="ok" dot>
                      live
                    </Badge>
                  ) : (
                    <Badge tone="signal" dot pulse>
                      coming online
                    </Badge>
                  )
                }
              >
                <p className={s.statusText}>
                  {STATUS.hostedPoolLive ? (
                    "The hosted GPU pool is live."
                  ) : (
                    <>
                      The GPU pool is not provisioned yet. Until it is, the gateway answers{" "}
                      <code>503 upstream_unavailable</code>, charges nothing, and the CLI tells you to use{" "}
                      <code>--engine api</code> or <code>--engine claude-code</code>. This section documents how it will
                      work so you can wire it up ahead of time.
                    </>
                  )}
                </p>
              </CrtPanel>

              <H3 id="hosted-setup">Set it up</H3>
              <Flow
                label="Hosted engine setup"
                steps={[
                  {
                    title: "Create a workspace",
                    body: (
                      <p>
                        In the{" "}
                        <Link className="link" href={APP_URL}>
                          app
                        </Link>{" "}
                        (opens at launch). You get a workspace id, an API key that starts with <code>{KEY_PREFIX}</code>,
                        and your burn memo. The key is shown once. Only a hash of it is stored.
                      </p>
                    ),
                  },
                  {
                    title: "Add credit",
                    body: (
                      <p>
                        Burn {SITE.ticker} with your workspace memo. See{" "}
                        <a className="link" href="#burn">
                          Burn for compute
                        </a>
                        .
                      </p>
                    ),
                  },
                  {
                    title: "Give the CLI the key",
                    body: (
                      <CodeBlock
                        title={`${HOME}/.env`}
                        lang="env"
                        code={`${KEY_ENV}=${KEY_PREFIX}...`}
                        ariaLabel="Hosted key in the env file"
                      />
                    ),
                  },
                  {
                    title: "Check the balance, then race",
                    body: (
                      <CodeBlock
                        title="Terminal"
                        lang="sh"
                        code={`$ ${BIN} credits\n$ ${BIN} run ./my-repo --task "fix the failing tests" --test "npm test" --engine hosted`}
                        ariaLabel="Check credit and start a hosted race"
                      />
                    ),
                  },
                ]}
              />
              <p>
                <code>--model</code> is ignored with this engine: the gateway picks the model. Before it makes a single
                fork, the CLI asks the gateway for your balance and stops if it is zero.
              </p>

              <H3 id="hosted-url">Base URL</H3>
              <p>
                The CLI talks to <code>{API_BASE}</code>. Set <code>{URL_ENV}</code> to point it somewhere else, for
                example a gateway you run yourself. The URL must be <code>https</code> (plain <code>http</code> only for
                localhost) and must not carry credentials. Redirects are refused, so the key can&apos;t be bounced to
                another host.
              </p>

              <H3 id="hosted-credits">Credits and pricing</H3>
              <p>
                Hosted compute is priced per million input tokens and per million output tokens, in USD. The current
                prices come back from <code>GET /api/v1/me</code> and <code>{BIN} credits</code> prints them. Prices are
                not final until the pool is live.
              </p>
              <ul>
                <li>
                  Each request first reserves the most it could cost: the estimated input plus <code>max_tokens</code>.
                </li>
                <li>When the model answers, the real cost is charged and the rest of the reservation is returned.</li>
                <li>A request that fails upstream is charged nothing.</li>
                <li>The balance can&apos;t go below zero. The database refuses it.</li>
              </ul>
              <Terminal
                title={`${BIN} credits`}
                lines={CREDITS_OUT}
                flat
                status={<span className={s.termNote}>output format</span>}
                ariaLabel={`Lines ${BIN} credits prints`}
              />
              <FlagTable flags={CREDITS_FLAGS} caption={`${BIN} credits flags`} />

              <H3 id="hosted-402">Out of credit (402)</H3>
              <p>
                When a request would cost more than the balance, the gateway answers <code>402 insufficient_credits</code>{" "}
                and charges nothing. In a race, the fork that got the 402 stops with &ldquo;out of credit: burn{" "}
                {SITE.ticker} to top up&rdquo;. The forks share one balance, so no other fork makes another model call
                after that. Forks that stopped are still judged on what they changed so far, so a fork that already
                passed can still exit 0.
              </p>
              <p>
                <code>429</code> and <code>5xx</code> answers (except <code>503</code>) are retried up to four times with
                backoff, honoring <code>Retry-After</code>. <code>401</code>, <code>402</code> and <code>503</code> are
                not retried.
              </p>
            </DocSection>

            {/* ---------------- Isolation ---------------- */}
            <DocSection
              id="isolation"
              index={next()}
              title="Isolation"
              lede="Forks run untrusted agent output on your machine. Forkbomb confines what they can write, read and reach. Here is what holds and what doesn't."
            >
              <div className={s.twoCol}>
                <div className={s.panel}>
                  <h3 className={s.panelTitle}>Enforced</h3>
                  <ul className={s.checklist}>
                    <li>Writes only inside the fork&apos;s clone and its private temp dir</li>
                    <li>
                      <code>.git</code> is read-only for forks
                    </li>
                    <li>
                      Credential folders unreadable (<code>~/.ssh</code>, <code>~/.aws</code>, <code>~/.config/gh</code>,
                      Keychains)
                    </li>
                    <li>No network beyond loopback</li>
                    <li>Clean environment: no API keys or tokens</li>
                    <li>Command timeouts, capped output, background processes killed</li>
                  </ul>
                </div>
                <div className={s.panel}>
                  <h3 className={s.panelTitle}>Not enforced</h3>
                  <ul className={s.crosslist}>
                    <li>Forks can read most of your filesystem outside the credential folders</li>
                    <li>Forks can use CPU and memory freely</li>
                    <li>Seatbelt is a macOS sandbox, not a VM</li>
                    <li>
                      <code>--no-sandbox</code> removes all of the above
                    </li>
                  </ul>
                </div>
              </div>
              <p>
                Run Forkbomb on code you&apos;d be comfortable letting an agent work on. The judge (git and your test
                command) always runs under Forkbomb&apos;s own Seatbelt profile, whichever engine drove the forks. With
                the hosted engine, the gateway only sends model tokens back; it never runs anything on your machine.
              </p>

              <H3 id="isolation-canary">The isolation canary</H3>
              <p>
                With the claude-code engine, Forkbomb doesn&apos;t assume the sandbox holds. Before the first run on each
                Claude Code version, it starts a real session in a throwaway workspace, tells it to escape, and checks the
                results. Forks only start if every escape failed. The result is cached in <code>{HOME}/canary.json</code>
                . Run it any time with <code>{BIN} canary</code>.
              </p>
              <RefTable
                caption="Isolation canary checks"
                head={["Check", "Probe"]}
                mono={[]}
                rows={CANARY_CHECKS.map((c) => [<strong key="n">{c.name}</strong>, c.probe])}
              />
              <p className={s.after}>
                <Link className="link" href="/security">
                  Read the full security model
                </Link>
              </p>
            </DocSection>

            {/* ---------------- Commands ---------------- */}
            <DocSection
              id="commands"
              index={next()}
              title="Commands"
              lede={
                <>
                  Seven commands. <code>{BIN} --help</code> prints the same reference. Until the npm release, type{" "}
                  <code>node dist/cli.js</code> in place of <code>{BIN}</code>.
                </>
              }
            >
              <CodeBlock
                title={`${BIN} --help`}
                lang="txt"
                code={[
                  `${BIN} run [repo] --task "..." --test "cmd"   race forks on a repo`,
                  `${BIN} bench [dir] --forks 16                 clonefile vs copy, measured`,
                  `${BIN} replay <run-dir>                       watch a recorded run`,
                  `${BIN} export <run-dir> <out-dir>             static replay you can host anywhere`,
                  `${BIN} doctor                                 check the machine`,
                  `${BIN} credits                                hosted credit balance and pricing`,
                  `${BIN} canary                                 prove Claude Code forks can't escape`,
                ].join("\n")}
                ariaLabel="Command summary"
              />

              <H3 id="cmd-run">{BIN} run</H3>
              <Synopsis>
                {BIN} run [repo] --task &quot;…&quot; --test &quot;cmd&quot; [options]
              </Synopsis>
              <p>
                Starts a race on a repo. <code>repo</code> defaults to the current directory. Exits 0 when a fork passes
                the full suite, 1 otherwise. With <code>--ui</code>, the live view stays up after the run until you press
                Ctrl-C.
              </p>
              <FlagTable flags={RUN_FLAGS} caption={`${BIN} run flags`} />

              <H3 id="cmd-bench">{BIN} bench</H3>
              <Synopsis>{BIN} bench [dir] [--forks 16] [--no-copy] [--json]</Synopsis>
              <p>
                Forks the same workspace with <code>clonefile</code> and with a plain copy, and prints time and disk for
                each. Extra disk is measured from free space before and after, so other activity on the machine shows up
                as noise.
              </p>
              <FlagTable flags={BENCH_FLAGS} caption={`${BIN} bench flags`} />

              <H3 id="cmd-replay">{BIN} replay</H3>
              <Synopsis>{BIN} replay &lt;run-dir | events.jsonl&gt; [--port 4317] [--no-open]</Synopsis>
              <p>Serves the tree view for a recorded run on 127.0.0.1 and plays it back from the event log.</p>
              <FlagTable flags={REPLAY_FLAGS} caption={`${BIN} replay flags`} />

              <H3 id="cmd-export">{BIN} export</H3>
              <Synopsis>{BIN} export &lt;run-dir&gt; &lt;out-dir&gt;</Synopsis>
              <p>
                Writes a static, self-contained replay: <code>index.html</code>, <code>app.js</code>,{" "}
                <code>style.css</code>, <code>data.js</code> and a copy of <code>events.jsonl</code>. Host it anywhere
                that serves static files. The{" "}
                <a className="link" href={REPLAY_URL}>
                  replay on this site
                </a>{" "}
                is built from an export of the run above.
              </p>

              <H3 id="cmd-doctor">{BIN} doctor</H3>
              <Synopsis>{BIN} doctor</Synopsis>
              <p>
                Checks the machine and prints one <code>ok</code>, <code>info</code> or <code>FAIL</code> line per check,
                with a hint on failures. See{" "}
                <a className="link" href="#requirements">
                  Requirements
                </a>{" "}
                for the full list.
              </p>

              <H3 id="cmd-credits">{BIN} credits</H3>
              <Synopsis>{BIN} credits [--json]</Synopsis>
              <p>
                Asks the hosted gateway for your workspace, balance and pricing, using <code>{KEY_ENV}</code>. Exits
                with a hint if no key is set. See{" "}
                <a className="link" href="#hosted-credits">
                  Credits and pricing
                </a>
                .
              </p>

              <H3 id="cmd-canary">{BIN} canary</H3>
              <Synopsis>{BIN} canary [--claude-bin PATH] [--model ID]</Synopsis>
              <p>
                Runs the isolation canary against the installed Claude Code and prints each check. Exits 0 only if every
                escape failed.
              </p>
              <FlagTable flags={CANARY_FLAGS} caption={`${BIN} canary flags`} />
            </DocSection>

            {/* ---------------- Artifacts ---------------- */}
            <DocSection
              id="artifacts"
              index={next()}
              title="Run artifacts"
              lede={
                <>
                  Every run is saved under <code>{HOME}/runs/&lt;id&gt;/</code>, named by start time. Nothing is
                  uploaded. (The folder keeps its pre-rename name.)
                </>
              }
            >
              <CodeBlock
                title={HOME}
                lang="txt"
                code={tree([
                  [`${HOME}/`, ""],
                  ["  .env", `ANTHROPIC_API_KEY / ${KEY_ENV} (optional)`],
                  ["  canary.json", "last canary result, per Claude Code version"],
                  ["  runs/", ""],
                  [`    ${RUN.id}/`, "one folder per run, YYYYMMDD-HHMMSS"],
                  ["      events.jsonl", "every event in order; replay and export read it"],
                  ["      winner.patch", "the passing fork's diff (best.patch if none passed)"],
                  ["      body/", "pid 1: clean clone of your repo plus the base snapshot"],
                  ["      heads/<id>/", "the final fork's clone; killed forks are deleted"],
                  ["      state/<id>/", "pid 1 plus the final patch, verified by the judge"],
                ])}
                ariaLabel="Run folder layout"
              />
              <p>
                Pass <code>--keep-forks</code> to keep every fork&apos;s clone. Pass <code>--runs-dir</code> to put runs
                somewhere else, as long as it is outside the repo.
              </p>

              <H3 id="artifacts-patch">winner.patch</H3>
              <p>
                A plain git diff against your repo. Test and test-config edits are already stripped. This is the start
                of the {RUN.patch.lines}-line patch from the run above:
              </p>
              <CodeBlock
                title="winner.patch"
                lang="diff"
                lines={PATCH_LINES}
                maxHeight={360}
                ariaLabel="Excerpt of a real winning patch"
                more={{
                  href: REPLAY_URL,
                  label: "Full patch in the replay",
                  note: `${RUN.patch.lines} lines · ${RUN.patch.files} file`,
                }}
              />

              <H3 id="artifacts-events">events.jsonl</H3>
              <p>
                One JSON object per line, each stamped with the time since the run started. The live view, replay and
                export all read this file. Event names predate the rename: a fork is a <code>head</code>, a kill is a{" "}
                <code>sever</code>.
              </p>
              <RefTable
                caption="Event types in events.jsonl"
                head={["Type", "Carries"]}
                mono={[0]}
                rows={EVENTS.map((e) => [e.type, e.meaning])}
              />
            </DocSection>

            {/* ---------------- Task and test ---------------- */}
            <DocSection
              id="task-and-test"
              index={next()}
              title="Writing --task and --test"
              lede="The task points the forks. The test command picks the one that exits 0. Most bad runs trace back to one of the two."
            >
              <H3 id="writing-task">A good --task</H3>
              <ul>
                <li>
                  <strong>State the outcome, not the method.</strong> Strategies already vary the method across forks.
                </li>
                <li>
                  <strong>Name what you know.</strong> The file, the function, the behaviour that is wrong.
                </li>
                <li>
                  <strong>Say what must not change.</strong> A public API, a file format, a dependency.
                </li>
                <li>
                  <strong>Keep it to one job.</strong> Two unrelated fixes in one task split the forks&apos; attention.
                </li>
              </ul>
              <div className={s.compare}>
                <CodeBlock title="Vague" lang="sh" code={'--task "make the parser better"'} ariaLabel="Vague task example" />
                <CodeBlock
                  title="Specific"
                  lang="sh"
                  code={'--task "parseDate in src/date.ts throws on a trailing Z. Parse it as UTC. Keep the signature."'}
                  ariaLabel="Specific task example"
                />
              </div>

              <H3 id="writing-test">A good --test</H3>
              <ul>
                <li>
                  <strong>It must fail now.</strong> Forkbomb runs it on the untouched repo first. If it already passes,
                  there is nothing to race for and the run stops.
                </li>
                <li>
                  <strong>Fast and deterministic.</strong> It runs once for the baseline and once per judged fork. Flaky
                  tests pick random winners.
                </li>
                <li>
                  <strong>Offline.</strong> The judge has no network beyond loopback. Install dependencies before the
                  run; forks can&apos;t install them either.
                </li>
                <li>
                  <strong>Scoped.</strong> Run the tests that matter for the task, not the whole slow suite.
                </li>
              </ul>
              <p>
                Forkbomb reads pass and fail counts from {TEST_FORMATS.slice(0, -1).join(", ")} and{" "}
                {TEST_FORMATS[TEST_FORMATS.length - 1]} output, which gives partial credit and lets the best partial fork
                seed the next round. With any other runner, the exit code decides: pass or fail, nothing in between.
              </p>

              <H3 id="protected">Protected paths</H3>
              <p>
                Forks can&apos;t win by editing the tests. By default, changes matching these globs are dropped from
                every patch before it is judged. Add more with <code>--protect</code>; turn the defaults off with{" "}
                <code>--no-default-protect</code>.
              </p>
              <CodeBlock
                title="Default protected globs"
                lang="txt"
                code={DEFAULT_PROTECT.join("\n")}
                maxHeight={280}
                ariaLabel="Default protected globs"
              />
            </DocSection>

            <HazardStripe label={`${SITE.ticker} · burn zone`} className={s.hazard} />

            {/* ---------------- Burn for compute ---------------- */}
            <DocSection
              id="burn"
              index={next()}
              title="Burn for compute"
              lede={`Burning ${SITE.ticker} is how you pay for hosted compute. The server reads your burn from Solana, prices it in USD at the time of the burn, and credits your workspace. Self-hosting never needs the token.`}
            >
              <div className={s.launchRow}>
                <CAChip />
                <span className={s.launchNote}>
                  {STATUS.tokenLive
                    ? `Burns are verified against this mint only.`
                    : `${SITE.ticker} has not launched. Until it does, POST /api/burns/verify answers 503 not_configured and nothing can be credited.`}
                </span>
              </div>

              <Flow
                label="How a burn becomes credit"
                steps={[
                  {
                    title: "Create a workspace",
                    body: (
                      <p>
                        In the{" "}
                        <Link className="link" href={APP_URL}>
                          app
                        </Link>
                        . It gives you a workspace id like <code>ws_…</code>, an API key (shown once) and your memo:{" "}
                        <code>{MEMO}</code>.
                      </p>
                    ),
                  },
                  {
                    title: "Burn from your wallet",
                    body: (
                      <p>
                        One Solana transaction that burns {SITE.ticker} (an SPL <code>burn</code> or{" "}
                        <code>burnChecked</code>, Token or Token-2022 program) and carries exactly one memo,{" "}
                        <code>{MEMO}</code>, with nothing else in it. The app builds this transaction for you.
                      </p>
                    ),
                  },
                  {
                    title: "Verify",
                    body: (
                      <p>
                        The app sends the transaction signature to <code>POST /api/burns/verify</code>. You can call it
                        yourself with any signature; it is safe to repeat.
                      </p>
                    ),
                  },
                  {
                    title: "Credit lands",
                    body: (
                      <p>
                        Once the transaction is finalized and checks out, the workspace is credited and the burn shows up
                        on the{" "}
                        <Link className="link" href="/burns">
                          public ledger
                        </Link>
                        .
                      </p>
                    ),
                  },
                ]}
              />

              <H3 id="burn-checks">What the verifier checks</H3>
              <p>Everything is read back from the chain. Nothing you send besides the signature is trusted.</p>
              <ol className={s.numbered}>
                <li>The transaction exists on mainnet, is finalized, and did not fail.</li>
                <li>
                  It burns the {SITE.ticker} mint, in a top-level or inner instruction. Burns of any other token
                  don&apos;t count.
                </li>
                <li>Each burned token account&apos;s balance fell by exactly the amount burned.</li>
                <li>
                  There is exactly one memo starting with <code>{TOKEN_MEMO_PREFIX}</code>, and it is exactly{" "}
                  <code>{MEMO}</code>.
                </li>
                <li>The workspace in the memo exists.</li>
                <li>There is a price for the burn&apos;s block time (next section).</li>
              </ol>

              <H3 id="burn-pricing">How a burn is priced</H3>
              <p>
                The server samples the token&apos;s USD price every 5 minutes (Jupiter, with DexScreener as a fallback).
                For a burn at block time <em>T</em>, the price is the <strong>lowest</strong> of three numbers:
              </p>
              <ul>
                <li>
                  the time-weighted average price from <em>T</em> − 15 min to <em>T</em> + 5 min,
                </li>
                <li>
                  the first sample at or after <em>T</em>,
                </li>
                <li>
                  the last sample at or before <em>T</em>.
                </li>
              </ul>
              <p>
                USD value = tokens burned × that price. Credit is the USD value at the credit rate, which is 1.0 by
                default: one dollar of burned value buys one dollar of compute credit, rounded down to the micro-dollar.
                Pricing uses the burn&apos;s own block time, so verifying later changes nothing, and taking the lowest of
                three numbers means a short price spike can&apos;t be farmed. A burn with fewer than two samples in its
                window is rejected as <code>too_old_for_price</code>, unless it is under 10 minutes old; then the price
                is the lower of the latest sample and a live quote.
              </p>

              <H3 id="burn-idempotent">Verified once, credited once</H3>
              <p>
                The transaction signature is the key. Verifying the same signature again returns the stored record with
                status <code>already_credited</code>. Two verifies racing each other still credit once. A single burn
                worth more than a per-burn cap is recorded with status <code>review</code> (HTTP 202) and credits
                nothing until a person checks it.
              </p>

              <H3 id="burn-credit">What credit is, and isn&apos;t</H3>
              <div className={s.twoCol}>
                <div className={s.panel}>
                  <h4 className={s.panelTitle}>Credit is</h4>
                  <ul className={s.checklist}>
                    <li>Prepaid hosted compute, in USD</li>
                    <li>Spent per token by the hosted gateway</li>
                    <li>Tied to one workspace</li>
                    <li>Never below zero</li>
                  </ul>
                </div>
                <div className={s.panel}>
                  <h4 className={s.panelTitle}>Credit is not</h4>
                  <ul className={s.crosslist}>
                    <li>Refundable or withdrawable</li>
                    <li>Transferable to another workspace</li>
                    <li>Backed by buybacks, yield or revenue share</li>
                    <li>Needed to self-host. The CLI stays free and MIT</li>
                  </ul>
                </div>
              </div>
              <p>
                The full terms are on the{" "}
                <Link className="link" href="/terms#credits">
                  terms page
                </Link>
                .
              </p>

              <H3 id="burn-ledger">The public ledger</H3>
              <p>
                Every verified burn is public on{" "}
                <Link className="link" href="/burns">
                  /burns
                </Link>{" "}
                and from <code>GET /api/ledger</code>: signature, wallet, amount, price, USD value, credit and block time.
                Workspace ids are left out. Every row can be checked on Solana with its signature.
              </p>
            </DocSection>

            {/* ---------------- API reference ---------------- */}
            <DocSection
              id="api"
              index={next()}
              title="API reference"
              lede="The hosted gateway and the burn endpoints. JSON in, JSON out. The gateway speaks the OpenAI Chat Completions format, so any OpenAI-compatible client works with a base URL change."
            >
              <dl className={s.facts}>
                <div>
                  <dt>Gateway base URL</dt>
                  <dd>
                    <code>{API_BASE}</code>
                  </dd>
                </div>
                <div>
                  <dt>Auth</dt>
                  <dd>
                    <code>Authorization: Bearer {KEY_PREFIX}…</code> on <code>/api/v1/*</code>
                  </dd>
                </div>
                <div>
                  <dt>Errors</dt>
                  <dd>
                    OpenAI shape: <code>{"{error:{message,type,code}}"}</code>
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{STATUS.tokenLive ? POOL : `${POOL}. Burns open at token launch.`}</dd>
                </div>
              </dl>
              <CodeBlock title="Error body (402 example)" lang="json" code={ERROR_SHAPE} ariaLabel="Error response shape" />

              <Endpoint
                id="api-chat"
                method="POST"
                path="/api/v1/chat/completions"
                auth="Bearer key"
                summary="OpenAI-compatible chat completions on Forkbomb's GPU model. This is what --engine hosted calls."
              >
                <ul>
                  <li>
                    <code>model</code> is ignored; responses say <code>{HOSTED_MODEL}</code>.
                  </li>
                  <li>
                    <code>messages</code>, <code>tools</code>, <code>tool_choice</code>, <code>temperature</code>,{" "}
                    <code>stop</code>, <code>seed</code>, <code>response_format</code> and the other common fields pass
                    through.
                  </li>
                  <li>
                    <code>max_tokens</code> defaults to 8,192 and is capped at 32,768. Body up to 4 MB, 2,048 messages.
                  </li>
                  <li>
                    <code>stream: true</code> works, with <code>stream_options.include_usage</code>. A stream stops the
                    GPU when you disconnect and bills only what was streamed.
                  </li>
                  <li>
                    Every answer carries <code>x-request-cost-usd</code> and <code>x-credits-remaining-usd</code>
                    (streams send them in a final comment line).
                  </li>
                </ul>
                <CodeBlock
                  title="curl"
                  lang="sh"
                  code={`$ curl ${API_BASE}/chat/completions \\\n    -H "Authorization: Bearer $${KEY_ENV}" \\\n    -H "Content-Type: application/json" \\\n    -d '{"model":"${HOSTED_MODEL}","messages":[{"role":"user","content":"hello"}]}'`}
                  ariaLabel="Call chat completions with curl"
                />
                <ErrorTable caption="Chat completions errors" rows={GATEWAY_ERRORS} />
              </Endpoint>

              <Endpoint
                id="api-me"
                method="GET"
                path="/api/v1/me"
                auth="Bearer key"
                summary="Your workspace, spendable balance and current pricing. forkbomb credits prints this."
              >
                <CodeBlock
                  title="200"
                  lang="json"
                  code={`{
  "workspace": { "id": "ws_…", "label": "…", "createdAt": "…" },
  "credits": { "balanceMicroUsd": <integer>, "balanceUsd": <number> },
  "pricing": { "inputPerMTokUsd": <number>, "outputPerMTokUsd": <number>, "model": "…" }
}`}
                  ariaLabel="Response shape of /api/v1/me"
                />
                <p className={s.note}>
                  <code>balanceMicroUsd</code> is the exact integer. The <code>Usd</code> numbers are for display.
                </p>
              </Endpoint>

              <Endpoint
                id="api-verify"
                method="POST"
                path="/api/burns/verify"
                auth="Public, rate limited"
                summary="Verify a burn by its signature and credit the workspace named in its memo. Idempotent."
              >
                <CodeBlock
                  title="Request and response"
                  lang="json"
                  code={`// request
{ "signature": "<base58 transaction signature>" }

// 200 credited or already_credited · 202 held for review
{
  "burn": {
    "signature": "…", "workspaceId": "ws_…", "owner": "<wallet>", "mint": "…",
    "amountUi": "…", "priceUsd": "…", "usdValue": "…", "creditMicroUsd": <integer>,
    "slot": <integer>, "blockTime": "…", "verifiedAt": "…",
    "status": "credited" | "already_credited" | "review"
  }
}`}
                  ariaLabel="Request and response of /api/burns/verify"
                />
                <ErrorTable caption="Burn verify errors" rows={VERIFY_ERRORS} />
              </Endpoint>

              <Endpoint
                id="api-ledger"
                method="GET"
                path="/api/ledger"
                auth="Public"
                summary="Every verified burn, newest first, with totals. Workspace ids are left out."
              >
                <Synopsis>GET /api/ledger?limit=50&amp;cursor=&lt;nextCursor&gt;</Synopsis>
                <CodeBlock
                  title="200"
                  lang="json"
                  code={`{
  "burns": [
    { "signature": "…", "owner": "<wallet>", "mint": "…", "decimals": <integer>,
      "amountUi": "…", "priceUsd": "…", "usdValue": "…", "creditMicroUsd": <integer>,
      "slot": <integer>, "blockTime": "…", "status": "credited" | "review" }
  ],
  "totals": { "burnedUi": "…", "burnedUsd": "…", "burns": <integer>, "creditedMicroUsd": <integer> },
  "nextCursor": "…" | null
}`}
                  ariaLabel="Response shape of /api/ledger"
                />
                <p className={s.note}>
                  <code>limit</code> is 1 to 100, default 50. Amounts and prices are decimal strings, so nothing is lost
                  to floating point.
                </p>
              </Endpoint>

              <Endpoint
                id="api-price"
                method="GET"
                path="/api/price"
                auth="Public"
                summary="The latest price sample and the 15-minute time-weighted average. All fields are null before launch."
              >
                <CodeBlock
                  title="200"
                  lang="json"
                  code={`{
  "mint": "…" | null,
  "latest": { "ts": "…", "priceUsd": "…", "source": "jupiter" | "dexscreener" } | null,
  "twap": { "windowMinutes": 15, "priceUsd": "…", "samples": <integer> } | null
}`}
                  ariaLabel="Response shape of /api/price"
                />
              </Endpoint>

              <Endpoint
                id="api-workspaces"
                method="POST"
                path="/api/workspaces"
                auth="Public, rate limited"
                summary="Create a workspace. The app calls this for you. The API key is in this response and nowhere else, ever."
              >
                <CodeBlock
                  title="Request and 201 response"
                  lang="json"
                  code={`// request (label optional, up to 64 characters)
{ "label": "my laptop" }

// 201
{ "workspace": { "id": "ws_…", "label": "my laptop", "createdAt": "…" },
  "apiKey": "${KEY_PREFIX}…",
  "burnMemo": "${TOKEN_MEMO_PREFIX}ws_…" }`}
                  ariaLabel="Request and response of /api/workspaces"
                />
              </Endpoint>
            </DocSection>

            {/* ---------------- Troubleshooting ---------------- */}
            <DocSection
              id="troubleshooting"
              index={next()}
              title="Troubleshooting"
              lede="Each entry starts with the line the CLI prints. Values in angle brackets come from your run. Pre-rename builds print hydra: where these say forkbomb:."
            >
              <div className={s.issues}>
                <Issue
                  id="ts-not-logged-in"
                  title="Claude Code isn't logged in"
                  msg={`${BIN}: Claude Code isn't logged in. Run \`claude auth login\` with your Claude subscription, then try again.`}
                >
                  <p>
                    Run <code>claude auth login</code> and sign in with a Pro or Max plan. If <code>claude</code>{" "}
                    isn&apos;t on your PATH at all, install Claude Code, point Forkbomb at it with{" "}
                    <code>--claude-bin</code>, or use <code>--engine api</code>.
                  </p>
                </Issue>
                <Issue
                  id="ts-canary"
                  title="Isolation check failed"
                  msg={`${BIN}: isolation check failed, so no forks were started. See above.`}
                >
                  <p>
                    The canary got out somewhere, so Forkbomb refused to start any forks. The <code>FAIL</code> lines
                    above the message name each check that broke. This usually follows a Claude Code update. Re-run{" "}
                    <code>{BIN} canary</code>; if it still fails, open an issue with the output. Use{" "}
                    <code>--engine api</code> in the meantime.
                  </p>
                </Issue>
                <Issue
                  id="ts-apfs"
                  title="Not on APFS"
                  msg={`FAIL  APFS copy-on-write clones  (${HOME} is not on APFS; ${BIN} will fall back to plain copies)`}
                >
                  <p>
                    Forkbomb still runs, but forks are full copies: slower and much larger on disk. Keep{" "}
                    <code>{HOME}</code> (or <code>--runs-dir</code>) on an APFS volume, and the repo on the same volume.
                  </p>
                </Issue>
                <Issue
                  id="ts-already-passes"
                  title="Tests already pass"
                  msg="warn: The test suite already passes. Nothing for the heads to do."
                >
                  <p>
                    The baseline passed, so no forks were made. Check that <code>--test</code> runs the tests that
                    describe the change you want. Write a failing test first, then start the race.
                  </p>
                </Issue>
                <Issue
                  id="ts-no-pass"
                  title="No fork passed"
                  msg="warn: No head passed the whole suite. Best was <head> (<strategy>) at <score>%."
                >
                  <p>
                    Nobody exited 0. The best partial patch is saved as <code>best.patch</code>. Sharpen the task, add
                    rounds with <code>--rounds</code>, add forks, or raise <code>--max-turns</code> and{" "}
                    <code>--fork-timeout</code> if forks ran out of room.
                  </p>
                </Issue>
                <Issue
                  id="ts-no-key"
                  title="No API key"
                  msg={`${BIN}: no API key. Set ANTHROPIC_API_KEY, or put ANTHROPIC_API_KEY=... in ${HOME}/.env. Or use --engine claude-code to run on your Claude subscription.`}
                >
                  <p>
                    Only applies to <code>--engine api</code>. The default engine doesn&apos;t need a key.
                  </p>
                </Issue>
                <Issue
                  id="ts-no-hosted-key"
                  title="No hosted key"
                  msg={`${BIN}: no hosted API key. Create a workspace at ${SITE.url}${APP_URL}, then set ${KEY_ENV} or put ${KEY_ENV}=... in ${HOME}/.env.`}
                >
                  <p>
                    Only applies to <code>--engine hosted</code> and <code>{BIN} credits</code>. The key is shown once
                    when you create a workspace. If you lost it, create a new workspace.
                  </p>
                </Issue>
                <Issue
                  id="ts-out-of-credit"
                  title="Out of hosted credit"
                  msg={`${BIN}: no hosted credit left. Burn ${SITE.ticker} to top up at ${SITE.url}${APP_URL}`}
                >
                  <p>
                    Burn {SITE.ticker} with your workspace memo, wait for the verify to land, and check with{" "}
                    <code>{BIN} credits</code>. Or switch to <code>--engine api</code> or <code>--engine claude-code</code>
                    , which never need credit.
                  </p>
                </Issue>
                <Issue
                  id="ts-pool"
                  title="Hosted pool not provisioned"
                  msg={`${BIN}: the hosted pool is not provisioned yet (upstream_unavailable: …). Use --engine api or --engine claude-code for now.`}
                >
                  <p>
                    Expected while the pool is coming online. Nothing was charged. Use one of the other engines.
                  </p>
                </Issue>
                <Issue
                  id="ts-network"
                  title="--network with Claude Code"
                  msg={`${BIN}: --network isn't supported with --engine claude-code yet.`}
                >
                  <p>
                    Forks on the claude-code engine have no network. Vendor or pre-install what they need, or use{" "}
                    <code>--engine api --network</code>.
                  </p>
                </Issue>
              </div>
            </DocSection>

            {/* ---------------- FAQ ---------------- */}
            <DocSection id="faq" index={next()} title="FAQ">
              <div className={s.faq}>
                <Faq q="Is Forkbomb on npm?">
                  Not yet. Build it from source as shown in{" "}
                  <a className="link" href="#install">
                    Install
                  </a>
                  . There is no published package under any name, so don&apos;t install one that claims to be Forkbomb.
                </Faq>
                <Faq q="Do I need the token to use it?">
                  No. Self-hosting is free and MIT: the claude-code and api engines never touch a wallet or a chain.
                  {` ${SITE.ticker}`} only buys credit for the optional hosted engine.
                </Faq>
                <Faq q="Does it need API credits?">
                  No. The default engine runs forks on your Claude Code login, so a Pro or Max plan works. Forks count
                  against the plan&apos;s usage limits, and N forks use them roughly N times as fast as one session.
                </Faq>
                <Faq q="Does it run on Linux or Windows?">
                  No. Copy-on-write forking needs APFS and the sandbox is macOS Seatbelt. Off macOS the CLI refuses to
                  start unless you pass <code>--no-sandbox</code>, which removes isolation entirely. Don&apos;t.
                </Faq>
                <Faq q="Does Forkbomb send my code anywhere?">
                  With claude-code or api, forks send what any Claude session sends to Anthropic, and nothing reaches us.
                  With hosted, the model&apos;s prompts go through the Forkbomb gateway to the GPU that runs the model;
                  we don&apos;t store prompts or completions. There is no telemetry either way. The live view and replay bind to 127.0.0.1, and runs
                  stay in <code>{HOME}</code>.
                </Faq>
                <Faq q="Can a fork game the tests?">
                  The judge is built against the common ways: test edits are dropped, the patch is applied to a fresh
                  clone, ignored files don&apos;t carry over, and runs where tests went missing don&apos;t count as a
                  pass. It isn&apos;t proof against everything and is still being hardened. Read the patch before you
                  ship it.
                </Faq>
                <Faq q="How many forks should I run?">
                  The default is 8. There are twelve strategies, so past twelve forks they repeat. More forks cost more
                  plan usage, API spend or credit; the speed of forking isn&apos;t the limit.
                </Faq>
                <Faq q="Does it work with Python, Go or Rust?">
                  Nothing in Forkbomb is tied to JavaScript. The forks edit files and the judge runs your command. It
                  reads counts from pytest, unittest, go test and cargo test, and falls back to the exit code for
                  anything else.
                </Faq>
                <Faq q="Is it affiliated with Anthropic?">
                  No. Forkbomb is an independent open-source project. It drives Claude Code and the Anthropic API on your
                  own account; it isn&apos;t made or endorsed by Anthropic.
                </Faq>
              </div>
              <Callout tone="info" title="Something missing or wrong?">
                <p>
                  Open an issue on{" "}
                  <a className="link" href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
                    GitHub
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  . Docs bugs are bugs.
                </p>
              </Callout>
            </DocSection>
          </article>
        </div>
      </Container>
    </>
  );
}

function Issue({ id, title, msg, children }: { id: string; title: string; msg: string; children: ReactNode }) {
  return (
    <div className={s.issue}>
      <H3 id={id}>{title}</H3>
      <CodeBlock code={msg} copy={false} className={s.msg} ariaLabel={`CLI output: ${title}`} />
      {children}
    </div>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className={s.faqItem}>
      <summary className={s.faqQ}>
        <h3 className={s.faqTitle}>{q}</h3>
        <svg className={s.faqIcon} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </summary>
      <div className={s.faqA}>
        <p>{children}</p>
      </div>
    </details>
  );
}
