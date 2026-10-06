import Link from "next/link";
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  Container,
  PageHeader,
  ReplayFrame,
  Terminal,
  type CodeLine,
} from "../components";
import { BENCH, GITHUB_URL, INSTALL_SCRIPT, ISSUES_URL as ISSUES, REPLAY_URL, REQUIREMENTS, RUN, RUN_TRANSCRIPT, SITE, TEST_COUNT } from "../config";
import diff from "../diff.json";
import { pageMetadata } from "../lib/seo";
import { DocSection, FlagTable, H3, RefTable, Synopsis } from "./_parts/Blocks";
import {
  BENCH_FLAGS,
  CANARY_CHECKS,
  CANARY_FLAGS,
  DEFAULT_PROTECT,
  DOCTOR_CHECKS,
  EVENTS,
  REPLAY_FLAGS,
  RUN_FLAGS,
  STRATEGIES,
  TEST_FORMATS,
  TOC,
} from "./_parts/content";
import { DocsToc } from "./_parts/DocsToc";
import s from "./docs.module.css";

export const metadata = pageMetadata({
  title: "Docs",
  description:
    "Install Forkbomb from source, run your first race, and look up every command and flag. How forking, judging and isolation work, what a run leaves on disk, and how to fix common problems.",
  path: "/docs",
  image: "/docs/opengraph-image",
  imageAlt: "Forkbomb docs. Install from source, run your first race, and look up every command and flag.",
});

const TONE: Record<string, CodeLine["tone"]> = { fl: "meta", hnk: "hunk", add: "add", del: "del" };
const PATCH_LINES: CodeLine[] = (diff as [string, string][]).map(([tone, text]) => ({ text, tone: TONE[tone] ?? "" }));

const ISSUES_URL = ISSUES;

/** Two-column listing with the comment column aligned. ASCII only, so every glyph is in the mono font. */
function tree(rows: [string, string][]): string {
  const w = Math.max(...rows.map(([p]) => p.length)) + 4;
  return rows.map(([p, c]) => (c ? p.padEnd(w) + c : p)).join("\n");
}

const PHASES = [
  { key: "fork", name: "Fork", line: "clonefile the body into N heads", tone: "neutral" },
  { key: "race", name: "Race", line: "one strategy per head, in parallel", tone: "neutral" },
  { key: "judge", name: "Judge", line: "apply the patch to a fresh clone, run the suite", tone: "warn" },
  { key: "sever", name: "Sever", line: "cut the losers, keep the survivor", tone: "danger" },
  { key: "grow", name: "Grow", line: "no pass: the best head seeds the next round", tone: "neutral" },
] as const;

export default function DocsPage() {
  let n = 0;
  const next = () => ++n;

  return (
    <>
      <PageHeader
        eyebrow="Documentation"
        title="Forkbomb docs"
        lede="Install from source, run your first race, and look up every command and flag. Everything here matches the CLI as it ships today."
        meta={[SITE.platform, `${SITE.license} license`, "Not on npm yet"]}
        actions={
          <>
            <Button href="#install" variant="primary" iconRight="arrowRight">
              Install
            </Button>
            <Button href={GITHUB_URL} icon="github">
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
              lede="Forkbomb forks a coding agent into N sandboxed copies of your repo, called heads. Each head gets a different strategy. Your test suite judges them. One survives, and its patch is the answer."
            >
              <p>
                A single agent run is one draw. When it goes the wrong way, you find out late and start over. Forkbomb takes
                several draws at once, cheaply, and lets the tests you already trust pick the result. Forking uses APFS{" "}
                <code>clonefile(2)</code>, so a head costs metadata, not a copy of your repo.
              </p>
              <dl className={s.facts}>
                <div>
                  <dt>Platform</dt>
                  <dd>macOS on APFS. Sandboxing uses Seatbelt.</dd>
                </div>
                <div>
                  <dt>Engines</dt>
                  <dd>
                    <code>claude-code</code> (default, your Claude plan) or <code>api</code> (API key)
                  </dd>
                </div>
                <div>
                  <dt>Judge</dt>
                  <dd>Your test command, run against each head&apos;s patch in a fresh clone</dd>
                </div>
                <div>
                  <dt>Output</dt>
                  <dd>
                    <code>winner.patch</code>, a full event log, a replayable run
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>Pre-release. Install from source. {TEST_COUNT} automated tests in Forkbomb&apos;s own suite.</dd>
                </div>
                <div>
                  <dt>License</dt>
                  <dd>{SITE.license}</dd>
                </div>
              </dl>
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
                <code>--engine api</code>, you need an <code>ANTHROPIC_API_KEY</code> instead.
              </p>
              <p>
                <code>forkbomb doctor</code> checks all of it:
              </p>
              <RefTable
                caption="What forkbomb doctor checks"
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
              lede="Forkbomb is not published on npm yet. Build it from source."
            >
              <CodeBlock
                title="Install from source"
                lang="sh"
                code={INSTALL_SCRIPT}
                ariaLabel="Install commands"
              />
              <p>
                Optional: run <code>npm link</code> inside the repo to put <code>forkbomb</code> on your PATH. The rest of
                these docs write <code>forkbomb</code>. Without the link, use <code>node dist/cli.js</code> in its place.
              </p>
              <H3 id="install-credentials">Credentials</H3>
              <p>
                For the default engine, log Claude Code in once. Forkbomb uses whatever it is logged in with. For the API
                engine, put the key in <code>~/.forkbomb/.env</code> or export it.
              </p>
              <CodeBlock
                title="Default engine: Claude Code"
                lang="sh"
                code={"$ claude auth login"}
                ariaLabel="Log in to Claude Code"
              />
              <CodeBlock
                title="~/.forkbomb/.env (API engine only)"
                lang="env"
                code={"ANTHROPIC_API_KEY=..."}
                ariaLabel="API key file"
              />
              <Callout tone="info" title="Keys stay on your machine">
                <p>
                  Forkbomb reads credentials locally and never sends them anywhere but Anthropic. Heads themselves run with a
                  clean environment and never see the key.
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
                  <CodeBlock title="Terminal" lang="sh" code={"$ forkbomb doctor"} ariaLabel="Run forkbomb doctor" />
                </li>
                <li>
                  <h3 className={s.stepTitle}>Prove the sandbox holds</h3>
                  <p>
                    Optional. Forkbomb runs the isolation canary on its own before the first run on each Claude Code
                    version. It takes about a minute.
                  </p>
                  <CodeBlock title="Terminal" lang="sh" code={"$ forkbomb canary"} ariaLabel="Run forkbomb canary" />
                </li>
                <li>
                  <h3 className={s.stepTitle}>Race the heads</h3>
                  <p>
                    <code>--task</code> says what to do. <code>--test</code> decides who wins. <code>--ui</code> opens
                    the live tree on <code>127.0.0.1:4317</code>.
                  </p>
                  <CodeBlock
                    title="Terminal"
                    lang="sh"
                    code={'$ forkbomb run ./my-repo --task "fix the failing tests" --test "npm test" --ui'}
                    ariaLabel="Run Forkbomb"
                  />
                </li>
                <li>
                  <h3 className={s.stepTitle}>Review and ship the patch</h3>
                  <p>
                    The survivor&apos;s diff is saved as <code>winner.patch</code> in the run folder. Read it, then apply
                    it. Or pass <code>--apply</code> next time and Forkbomb applies it for you.
                  </p>
                  <CodeBlock
                    title="Terminal"
                    lang="sh"
                    code={"$ git -C ./my-repo apply ~/.forkbomb/runs/<id>/winner.patch"}
                    ariaLabel="Apply the winning patch"
                  />
                </li>
              </ol>

              <H3 id="quickstart-real-run">What a run looks like</H3>
              <p>
                A real run from {RUN.date}: {RUN.engine}, on the {RUN.repo}. The baseline had {RUN.baseline.passing} of{" "}
                {RUN.baseline.total} tests passing. Four heads forked in {RUN.forkMsEach} ms each. Head {RUN.winner.id}{" "}
                ({RUN.winner.strategy}) passed {RUN.winner.passed}/{RUN.winner.total} first, the other{" "}
                {RUN.severed} were severed, and the whole run took {RUN.durationS} s.
              </p>
              <Terminal
                title={`forkbomb run · ${RUN.id}`}
                lines={RUN_TRANSCRIPT}
                status={
                  <Badge tone="accent" dot>
                    survivor {RUN.winner.id}
                  </Badge>
                }
                ariaLabel="Terminal output of a real Forkbomb run"
              />
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
              title="How a run works"
              lede="Five phases. Forkbomb clones your repo once, forks it, races the heads, judges each patch on a clean copy, and keeps one."
            >
              <ol className={s.phases} aria-label="Phases of a run">
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

              <H3 id="phase-fork">1. Fork</H3>
              <p>
                Forkbomb clones your repo once into the <em>body</em>, commits a base snapshot, and forks the body into N
                heads with <code>clonefile(2)</code>. On APFS a clone shares every data block with its parent until a
                head writes, so forking costs metadata, not bytes. Off APFS, Forkbomb falls back to a plain copy.
              </p>
              <RefTable
                caption={`forkbomb bench on a ${BENCH.machine}, ${BENCH.workload}, ${BENCH.heads} heads`}
                head={["Forker", "Per head", "Extra disk"]}
                mono={[0, 1, 2]}
                rows={[
                  ["apfs-clonefile", `${BENCH.clonefile.perHeadMs} ms`, BENCH.clonefile.extraDisk],
                  ["copy", `${BENCH.copy.perHeadMs.toLocaleString("en-US")} ms`, BENCH.copy.extraDisk],
                ]}
              />
              <p className={s.note}>
                forkbomb bench · {BENCH.machine} · {BENCH.workload} · {BENCH.heads} heads. {BENCH.speedup} faster,{" "}
                {BENCH.diskSaving} less disk. Run <code>forkbomb bench ./my-repo</code> to measure your own.
              </p>

              <H3 id="phase-race">2. Race</H3>
              <p>
                Each head is a Claude agent with a shell and a file editor, working in its own clone. Each gets a
                different strategy. Diversity is the point: eight copies with one strategy fail the same way eight times.
                Heads take strategies in this order and wrap around after twelve.
              </p>
              <RefTable
                caption="Head strategies, in assignment order"
                head={["#", "Strategy", "Brief"]}
                mono={[0, 1]}
                rows={STRATEGIES.map((st, i) => [String(i + 1).padStart(2, "0"), st.name, st.brief])}
              />

              <H3 id="phase-judge">3. Judge</H3>
              <p>A head is judged by the patch it would ship, not by the state of its sandbox.</p>
              <ol className={s.numbered}>
                <li>Take the head&apos;s diff against the base snapshot.</li>
                <li>
                  Drop every change to tests and test config (see{" "}
                  <a className="link" href="#protected">
                    protected paths
                  </a>
                  ).
                </li>
                <li>Apply what is left to a fresh clone of the body.</li>
                <li>Run your test command there, under Forkbomb&apos;s own Seatbelt profile.</li>
                <li>Score it. A clean exit only counts as a pass if no tests went missing compared with the baseline.</li>
              </ol>
              <p>
                Hacks to ignored files such as <code>node_modules</code> or build output never reach the fresh clone, so
                they never count. The judge is designed against the common ways an agent games a suite. It is still being
                hardened. Read the winning patch before you ship it.
              </p>

              <H3 id="phase-sever">4. Sever</H3>
              <p>
                In <code>race</code> mode, the first head to pass the full suite wins and the rest are cut mid-thought.
                In <code>best</code> mode, every head finishes and the smallest passing diff wins. Losing clones are
                deleted unless you pass <code>--keep-heads</code>.
              </p>

              <H3 id="phase-grow">5. Grow</H3>
              <p>
                If nobody passes, the best head&apos;s verified state (body plus its patch) becomes the parent of the next
                round, with a note on where it left off. <code>--rounds</code> caps how many times this happens. If the
                last round still has no pass, Forkbomb saves the best partial patch as <code>best.patch</code>.
              </p>
            </DocSection>

            {/* ---------------- Engines ---------------- */}
            <DocSection
              id="engines"
              index={next()}
              title="Engines"
              lede="Forkbomb drives heads one of two ways. Either way, credentials stay on your machine."
            >
              <RefTable
                caption="Engine comparison"
                head={["", "claude-code (default)", "api"]}
                mono={[]}
                rows={[
                  [<strong key="a">Credentials</strong>, <code key="b">claude auth login</code>, <code key="c">ANTHROPIC_API_KEY</code>],
                  [<strong key="a">Billing</strong>, "Your Pro or Max plan, no API credits", "Pay as you go"],
                  [<strong key="a">Default model</strong>, "Your Claude Code default", <code key="c">claude-opus-5-5</code>],
                  [<strong key="a">Shell sandbox</strong>, "Claude Code's sandbox plus Forkbomb's rules", "Forkbomb's Seatbelt profile"],
                  [<strong key="a">--network</strong>, "Not supported yet", "Opt-in"],
                  [<strong key="a">Isolation canary</strong>, "Before the first run on each version", "Not used"],
                ]}
              />

              <H3 id="engine-claude-code">claude-code</H3>
              <p>
                Each head is a headless Claude Code session (<code>claude -p</code>) on whatever Claude Code is logged in
                with. Heads count against your plan&apos;s usage limits, and eight heads use them about eight times as
                fast as one session. Each head runs with:
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
                Forkbomb&apos;s own tool loop on the Messages API, with <code>ANTHROPIC_API_KEY</code>. The default model is{" "}
                <code>claude-opus-5-5</code> at <code>medium</code> effort. Shell commands run under Forkbomb&apos;s Seatbelt
                profile. The text editor runs in Forkbomb&apos;s process and re-checks every path: no <code>..</code>, no
                symlinks out of the clone or into <code>.git</code>, no writing through hard links.
              </p>
            </DocSection>

            {/* ---------------- Isolation ---------------- */}
            <DocSection
              id="isolation"
              index={next()}
              title="Isolation"
              lede="Heads run untrusted agent output on your machine. Forkbomb confines what they can write, read and reach. Here is what holds and what doesn't."
            >
              <div className={s.twoCol}>
                <div className={s.panel}>
                  <h3 className={s.panelTitle}>Enforced</h3>
                  <ul className={s.checklist}>
                    <li>Writes only inside the head&apos;s clone and its private temp dir</li>
                    <li>
                      <code>.git</code> is read-only for heads
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
                    <li>Heads can read most of your filesystem outside the credential folders</li>
                    <li>Heads can use CPU and memory freely</li>
                    <li>Seatbelt is a macOS sandbox, not a VM</li>
                    <li>
                      <code>--no-sandbox</code> removes all of the above
                    </li>
                  </ul>
                </div>
              </div>
              <p>
                Run Forkbomb on code you&apos;d be comfortable letting an agent work on. The judge (git and your test
                command) always runs under Forkbomb&apos;s own Seatbelt profile, whichever engine drove the heads.
              </p>

              <H3 id="isolation-canary">The isolation canary</H3>
              <p>
                With the claude-code engine, Forkbomb doesn&apos;t assume the sandbox holds. Before the first run on each
                Claude Code version, it starts a real session in a throwaway workspace, tells it to escape, and checks
                the results. Heads only start if every escape failed. The result is cached in{" "}
                <code>~/.forkbomb/canary.json</code>. Run it any time with <code>forkbomb canary</code>.
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
              lede="Six commands. forkbomb --help prints the same reference."
            >
              <CodeBlock
                title="forkbomb --help"
                lang="txt"
                code={[
                  'forkbomb run [repo] --task "..." --test "cmd"   race heads on a repo',
                  "forkbomb bench [dir] --heads 16                 clonefile vs copy, measured",
                  "forkbomb replay <run-dir>                       watch a recorded run",
                  "forkbomb export <run-dir> <out-dir>             static replay you can host anywhere",
                  "forkbomb doctor                                 check the machine",
                  "forkbomb canary                                 prove Claude Code heads can't escape",
                ].join("\n")}
                ariaLabel="Command summary"
              />

              <H3 id="cmd-run">forkbomb run</H3>
              <Synopsis>forkbomb run [repo] --task &quot;…&quot; --test &quot;cmd&quot; [options]</Synopsis>
              <p>
                Races heads on a repo. <code>repo</code> defaults to the current directory. Exits 0 when a head passes
                the full suite, 1 otherwise. With <code>--ui</code>, the live view stays up after the run until you press
                Ctrl-C.
              </p>
              <FlagTable flags={RUN_FLAGS} caption="forkbomb run flags" />

              <H3 id="cmd-bench">forkbomb bench</H3>
              <Synopsis>forkbomb bench [dir] [--heads 16] [--no-copy] [--json]</Synopsis>
              <p>
                Forks the same workspace with <code>clonefile</code> and with a plain copy, and prints time and disk for
                each. Extra disk is measured from free space before and after, so other activity on the machine shows up
                as noise.
              </p>
              <FlagTable flags={BENCH_FLAGS} caption="forkbomb bench flags" />

              <H3 id="cmd-replay">forkbomb replay</H3>
              <Synopsis>forkbomb replay &lt;run-dir | events.jsonl&gt; [--port 4317] [--no-open]</Synopsis>
              <p>Serves the tree view for a recorded run on 127.0.0.1 and plays it back from the event log.</p>
              <FlagTable flags={REPLAY_FLAGS} caption="forkbomb replay flags" />

              <H3 id="cmd-export">forkbomb export</H3>
              <Synopsis>forkbomb export &lt;run-dir&gt; &lt;out-dir&gt;</Synopsis>
              <p>
                Writes a static, self-contained replay: <code>index.html</code>, <code>app.js</code>,{" "}
                <code>style.css</code>, <code>data.js</code> and a copy of <code>events.jsonl</code>. Host it anywhere
                that serves static files. The{" "}
                <a className="link" href={REPLAY_URL}>
                  replay on this site
                </a>{" "}
                is built from an export of the run above.
              </p>

              <H3 id="cmd-doctor">forkbomb doctor</H3>
              <Synopsis>forkbomb doctor</Synopsis>
              <p>
                Checks the machine and prints one <code>ok</code> or <code>FAIL</code> line per check, with a hint on
                failures. See{" "}
                <a className="link" href="#requirements">
                  Requirements
                </a>{" "}
                for the full list.
              </p>

              <H3 id="cmd-canary">forkbomb canary</H3>
              <Synopsis>forkbomb canary [--claude-bin PATH] [--model ID]</Synopsis>
              <p>
                Runs the isolation canary against the installed Claude Code and prints each check. Exits 0 only if every
                escape failed.
              </p>
              <FlagTable flags={CANARY_FLAGS} caption="forkbomb canary flags" />
            </DocSection>

            {/* ---------------- Artifacts ---------------- */}
            <DocSection
              id="artifacts"
              index={next()}
              title="Run artifacts"
              lede={
                <>
                  Every run is saved under <code>~/.forkbomb/runs/&lt;id&gt;/</code>, named by start time. Nothing is
                  uploaded.
                </>
              }
            >
              <CodeBlock
                title="~/.forkbomb"
                lang="txt"
                code={tree([
                  ["~/.forkbomb/", ""],
                  ["  .env", "ANTHROPIC_API_KEY=... (api engine, optional)"],
                  ["  canary.json", "last canary result, per Claude Code version"],
                  ["  runs/", ""],
                  [`    ${RUN.id}/`, "one folder per run, YYYYMMDD-HHMMSS"],
                  ["      events.jsonl", "every event in order; replay and export read it"],
                  ["      winner.patch", "the survivor's diff (best.patch if nobody passed)"],
                  ["      body/", "clean clone of your repo plus the base snapshot"],
                  ["      heads/<id>/", "the final head's clone; losers are deleted"],
                  ["      state/<id>/", "body plus the final patch, verified by the judge"],
                ])}
                ariaLabel="Run folder layout"
              />
              <p>
                Pass <code>--keep-heads</code> to keep every head&apos;s clone. Pass <code>--runs-dir</code> to put runs
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
                export all read this file.
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
              lede="The task points the heads. The test command picks the winner. Most bad runs trace back to one of the two."
            >
              <H3 id="writing-task">A good --task</H3>
              <ul>
                <li>
                  <strong>State the outcome, not the method.</strong> Strategies already vary the method across heads.
                </li>
                <li>
                  <strong>Name what you know.</strong> The file, the function, the behaviour that is wrong.
                </li>
                <li>
                  <strong>Say what must not change.</strong> A public API, a file format, a dependency.
                </li>
                <li>
                  <strong>Keep it to one job.</strong> Two unrelated fixes in one task split the heads&apos; attention.
                </li>
              </ul>
              <div className={s.compare}>
                <CodeBlock
                  title="Vague"
                  lang="sh"
                  code={'--task "make the parser better"'}
                  ariaLabel="Vague task example"
                />
                <CodeBlock
                  title="Specific"
                  lang="sh"
                  code={
                    '--task "parseDate in src/date.ts throws on a trailing Z. Parse it as UTC. Keep the signature."'
                  }
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
                  <strong>Fast and deterministic.</strong> It runs once for the baseline and once per judged head. Flaky
                  tests pick random winners.
                </li>
                <li>
                  <strong>Offline.</strong> The judge has no network beyond loopback. Install dependencies before the
                  run; heads can&apos;t install them either.
                </li>
                <li>
                  <strong>Scoped.</strong> Run the tests that matter for the task, not the whole slow suite.
                </li>
              </ul>
              <p>
                Forkbomb reads pass and fail counts from {TEST_FORMATS.slice(0, -1).join(", ")} and{" "}
                {TEST_FORMATS[TEST_FORMATS.length - 1]} output, which gives partial credit and lets the best partial head
                seed the next round. With any other runner, the exit code decides: pass or fail, nothing in between.
              </p>

              <H3 id="protected">Protected paths</H3>
              <p>
                Heads can&apos;t win by editing the tests. By default, changes matching these globs are dropped from
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

            {/* ---------------- Troubleshooting ---------------- */}
            <DocSection
              id="troubleshooting"
              index={next()}
              title="Troubleshooting"
              lede="Each entry starts with the line the CLI prints. Values in angle brackets come from your run."
            >
              <div className={s.issues}>
                <Issue
                  id="ts-not-logged-in"
                  title="Claude Code isn't logged in"
                  msg="forkbomb: Claude Code isn't logged in. Run `claude auth login` with your Claude subscription, then try again."
                >
                  <p>
                    Run <code>claude auth login</code> and sign in with a Pro or Max plan. If <code>claude</code> isn&apos;t
                    on your PATH at all, install Claude Code, point Forkbomb at it with <code>--claude-bin</code>, or use{" "}
                    <code>--engine api</code>.
                  </p>
                </Issue>
                <Issue
                  id="ts-canary"
                  title="Isolation check failed"
                  msg="forkbomb: isolation check failed, so no heads were started. See above."
                >
                  <p>
                    The canary got out somewhere, so Forkbomb refused to start heads. The <code>FAIL</code> lines above the
                    message name each check that broke. This usually follows a Claude Code update. Re-run{" "}
                    <code>forkbomb canary</code>; if it still fails, open an issue with the output. Use{" "}
                    <code>--engine api</code> in the meantime.
                  </p>
                </Issue>
                <Issue
                  id="ts-apfs"
                  title="Not on APFS"
                  msg="FAIL  APFS copy-on-write clones  (~/.forkbomb is not on APFS; Forkbomb will fall back to plain copies)"
                >
                  <p>
                    Forkbomb still runs, but forks are full copies: slower and much larger on disk. Keep{" "}
                    <code>~/.forkbomb</code> (or <code>--runs-dir</code>) on an APFS volume, and the repo on the same volume.
                  </p>
                </Issue>
                <Issue
                  id="ts-already-passes"
                  title="Tests already pass"
                  msg="warn: The test suite already passes. Nothing for the heads to do."
                >
                  <p>
                    The baseline passed, so no heads were started. Check that <code>--test</code> runs the tests that
                    describe the change you want. Write a failing test first, then run Forkbomb.
                  </p>
                </Issue>
                <Issue
                  id="ts-no-pass"
                  title="No head passed"
                  msg="warn: No head passed the whole suite. Best was <head> (<strategy>) at <score>%."
                >
                  <p>
                    The best partial patch is saved as <code>best.patch</code>. Sharpen the task, add rounds with{" "}
                    <code>--rounds</code>, add heads, or raise <code>--max-turns</code> and <code>--head-timeout</code>{" "}
                    if heads ran out of room.
                  </p>
                </Issue>
                <Issue
                  id="ts-no-key"
                  title="No API key"
                  msg="forkbomb: no API key. Set ANTHROPIC_API_KEY, or put ANTHROPIC_API_KEY=... in ~/.forkbomb/.env. Or use --engine claude-code to run on your Claude subscription."
                >
                  <p>
                    Only applies to <code>--engine api</code>. The default engine doesn&apos;t need a key.
                  </p>
                </Issue>
                <Issue
                  id="ts-network"
                  title="--network with Claude Code"
                  msg="forkbomb: --network isn't supported with --engine claude-code yet."
                >
                  <p>
                    Heads on the claude-code engine have no network. Vendor or pre-install what they need, or use{" "}
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
                <Faq q="Does it need API credits?">
                  No. The default engine runs heads on your Claude Code login, so a Pro or Max plan works. Heads count
                  against the plan&apos;s usage limits, and N heads use them roughly N times as fast as one session.
                </Faq>
                <Faq q="Does it run on Linux or Windows?">
                  No. Copy-on-write forking needs APFS and the sandbox is macOS Seatbelt. Off macOS the CLI refuses to
                  start unless you pass <code>--no-sandbox</code>, which removes isolation entirely. Don&apos;t.
                </Faq>
                <Faq q="Does Forkbomb send my code anywhere?">
                  Heads send what any Claude session sends to Anthropic. Forkbomb adds no telemetry and no servers of its
                  own. The live view and replay bind to 127.0.0.1, and runs stay in <code>~/.forkbomb</code>.
                </Faq>
                <Faq q="Can a head game the tests?">
                  The judge is built against the common ways: test edits are dropped, the patch is applied to a fresh
                  clone, ignored files don&apos;t carry over, and runs where tests went missing don&apos;t count as a
                  pass. It isn&apos;t proof against everything and is still being hardened. Read the patch before you
                  ship it.
                </Faq>
                <Faq q="How many heads should I run?">
                  The default is 8. There are twelve strategies, so past twelve heads they repeat. More heads cost more
                  plan usage or API spend; the speed of forking isn&apos;t the limit.
                </Faq>
                <Faq q="Does it work with Python, Go or Rust?">
                  Nothing in Forkbomb is tied to JavaScript. The heads edit files and the judge runs your command. It reads counts
                  from pytest, unittest, go test and cargo test, and falls back to the exit code for anything else.
                </Faq>
                <Faq q="What is $FORKBOMB?">
                  A community token used as a launch vehicle. It is not wired into the product. The CLI never touches a
                  wallet or a chain, and you don&apos;t need the token to use Forkbomb.{" "}
                  <Link className="link" href="/token">
                    More on the token page
                  </Link>
                  .
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
