import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Callout,
  CodeBlock,
  Eyebrow,
  Icon,
  Mark,
  ReplayFrame,
  Reveal,
  RunTree,
  Section,
  SectionHeader,
  Stat,
  StatGrid,
  Terminal,
  cx,
  type CodeLine,
} from "../components";
import {
  BENCH,
  GITHUB_URL,
  INSTALL,
  INSTALL_SCRIPT,
  ISSUES_URL,
  REPLAY_URL,
  REQUIREMENTS,
  RUN,
  RUN_TRANSCRIPT,
  TEST_COUNT,
} from "../config";
import diffRows from "../diff.json";
import { LoopDiagram } from "./LoopDiagram";
import s from "./home.module.css";

const nf = (n: number) => n.toLocaleString("en-US");

/* ================================================================== */
/* Hero                                                                */
/* ================================================================== */
export function Hero() {
  const spec: [string, ReactNode][] = [
    ["Platform", "macOS on APFS"],
    ["Sandbox", "Seatbelt, per head"],
    ["Engines", "Claude Code plan or API key"],
    ["License", "MIT"],
    ["Own suite", `${TEST_COUNT} automated tests`],
    ["Status", "Pre-release. Install from source"],
  ];
  return (
    <Section className={s.hero} labelledBy="hero-title">
      <div className={s.heroTop}>
        <div className={s.heroCopy}>
          <Eyebrow>Open-source CLI · macOS</Eyebrow>
          <h1 id="hero-title" className={cx("display", s.heroTitle)}>
            <span>Fork your agent.</span> <span className={s.heroTitleSoft}>Let the tests pick the survivor.</span>
          </h1>
          <p className={cx("lede", s.heroLede)}>
            Forkbomb clones your repo into sandboxed heads in milliseconds, gives each head a different strategy, and
            keeps the one whose patch passes your test suite.
          </p>
          <div className={cx("cluster", s.heroCtas)}>
            <Button href="/docs#install" variant="primary" size="lg" iconRight="arrowRight">
              Install from source
            </Button>
            <Button href={REPLAY_URL} native size="lg" icon="play">
              Watch a real run
            </Button>
          </div>
        </div>

        <figure className={s.heroRun} aria-labelledby="hero-run-cap">
          <div className={s.heroRunBar}>
            <span className="terminal__dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className={s.heroRunTitle}>forkbomb run · {RUN.id}</span>
            <Badge tone="accent" dot>
              survivor found
            </Badge>
          </div>
          <div className={s.heroRunCmd}>
            <span className="accent" aria-hidden="true">
              ${" "}
            </span>
            {RUN_TRANSCRIPT[0].text}
          </div>
          <div className={s.heroRunBody}>
            <RunTree />
          </div>
          <figcaption id="hero-run-cap" className={s.heroRunFoot}>
            <span>
              <b>{RUN.forkMsEach} ms</b> fork per head
            </span>
            <span>
              <b>{RUN.severed}</b> severed
            </span>
            <span>
              <b>{RUN.durationS} s</b> whole run
            </span>
            <span className={s.heroRunSrc}>recorded {RUN.date}</span>
          </figcaption>
        </figure>
      </div>

      <div className={s.heroBase}>
        <CodeBlock
          className={s.heroCode}
          title="Install from source"
          lang="sh"
          code={INSTALL_SCRIPT}
          ariaLabel="Install commands"
        />
        <dl className={s.spec} aria-label="Forkbomb at a glance">
          {spec.map(([k, v]) => (
            <div key={k} className={s.specRow}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 01 The real run                                                     */
/* ================================================================== */
export function RunSection() {
  const ledger: { k: string; v: ReactNode; note: ReactNode; tone?: "accent" | "danger" }[] = [
    {
      k: "Baseline",
      v: (
        <>
          {RUN.baseline.passing}/{RUN.baseline.total}
        </>
      ),
      note: `${RUN.baseline.failing} tests failing`,
    },
    { k: "Heads", v: RUN.heads.length, note: RUN.heads.map((h) => h.strategy).join(", ") },
    { k: "Fork", v: <>{RUN.forkMsEach}<small>ms</small></>, note: "per head, apfs-clonefile" },
    {
      k: "Survivor",
      v: RUN.winner.id,
      note: `${RUN.winner.strategy} · ${RUN.winner.passed}/${RUN.winner.total} passing`,
      tone: "accent",
    },
    { k: "Severed", v: RUN.severed, note: `cut when ${RUN.winner.id} passed`, tone: "danger" },
    { k: "Patch", v: <>{RUN.patch.lines}<small>lines</small></>, note: `${RUN.patch.files} file changed` },
    { k: "Wall time", v: <>{RUN.durationS}<small>s</small></>, note: "fork to survivor" },
  ];
  return (
    <Section id="run" size="sm" labelledBy="run-h">
      <div className={s.runHead}>
        <SectionHeader
          id="run-h"
          className={s.headerTight}
          index="01"
          eyebrow="Recorded run"
          title={`${RUN.heads.length} heads. 1 survivor. ${RUN.durationS} seconds.`}
          lede={`A real run from ${RUN.date}: ${RUN.engine}, a ${RUN.repo} with ${RUN.baseline.failing} failing tests. Every event in the replay comes from the run's own log.`}
        />
        <Badge tone="neutral" className={s.runBadge}>
          run {RUN.id}
        </Badge>
      </div>

      <ReplayFrame eager title={`Recorded run · ${RUN.date}`} />

      <dl className={s.ledger} aria-label="Run summary">
        {ledger.map((c) => (
            <div key={c.k} className={cx(s.ledgerCell, c.tone === "accent" && s.isAccent, c.tone === "danger" && s.isDanger)}>
              <dt>{c.k}</dt>
              <dd>
                <span className={s.ledgerValue}>{c.v}</span>
                <span className={s.ledgerNote}>{c.note}</span>
              </dd>
            </div>
        ))}
      </dl>
    </Section>
  );
}

/* ================================================================== */
/* 02 How it works                                                     */
/* ================================================================== */
const STEPS: { n: string; t: string; d: ReactNode }[] = [
  {
    n: "01",
    t: "Fork",
    d: (
      <>
        Forkbomb snapshots your repo once, then clones it into N heads with <code>clonefile(2)</code>. Blocks are shared
        until a head writes, so a head costs metadata, not a copy.
      </>
    ),
  },
  {
    n: "02",
    t: "Race",
    d: "Each head is a Claude agent with its own strategy: surgeon, root-cause, test-driven, rewriter and more. Different approaches fail in different ways.",
  },
  {
    n: "03",
    t: "Judge",
    d: "When a head stops, its diff minus any test edits goes onto a fresh clone, and your test command runs there.",
  },
  {
    n: "04",
    t: "Sever",
    d: "In race mode the first head to pass wins and the rest are cut mid-run. In best mode all finish and the smallest passing diff wins.",
  },
  {
    n: "05",
    t: "Grow",
    d: "If no head passes, the best one's verified state seeds the next round, with a note on where it left off.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works" tone="inset" labelledBy="how-h">
      <SectionHeader
        id="how-h"
        index="02"
          eyebrow="How it works"
        title="Fork, race, judge, sever, grow."
        lede="One loop, drawn from the run above. Every step is plain mechanics you can read in the source."
      />
      <Reveal className={s.diagramWrap}>
        <LoopDiagram />
      </Reveal>
      <ol className={s.steps}>
        {STEPS.map((st) => (
          <li key={st.n} className={s.step}>
            <span className={s.stepN} aria-hidden="true">
              {st.n}
            </span>
            <h3 className={s.stepT}>{st.t}</h3>
            <p className={s.stepD}>{st.d}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ================================================================== */
/* 03 Benchmark                                                        */
/* ================================================================== */
function BarGroup({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; pct: number; strong?: boolean }[];
}) {
  return (
    <div className={s.barGroup}>
      <h3 className={s.barTitle}>{title}</h3>
      <ul className={s.barList}>
        {rows.map((r) => (
          <li key={r.label} className={s.barRow}>
            <span className={s.barLabel}>{r.label}</span>
            <span className={s.barValue}>{r.value}</span>
            <span className={s.barTrack} aria-hidden="true">
              <span
                className={cx(s.barFill, r.strong ? s.barFillStrong : s.barFillMuted)}
                style={{ ["--pct" as string]: `${r.pct}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Benchmark() {
  const c = BENCH.clonefile;
  const p = BENCH.copy;
  return (
    <Section id="benchmark" labelledBy="bench-h">
      <div className={cx("split split--top", s.benchSplit)}>
        <div>
          <SectionHeader
            id="bench-h"
            index="03"
          eyebrow="Benchmark"
            title="A head costs metadata, not a copy."
            lede="On APFS, clonefile shares every data block with the parent until a head writes. forkbomb bench forks the same workspace both ways and measures it."
          />
          <StatGrid cols={2}>
            <Stat value={BENCH.speedup} label="faster to fork a head" note={`${c.perHeadMs} ms vs ${nf(p.perHeadMs)} ms`} />
            <Stat value={BENCH.diskSaving} label="less extra disk" note={`${c.extraDisk} vs ${p.extraDisk}`} />
          </StatGrid>
          <CodeBlock
            className="mt-6"
            lang="sh"
            title="Measure your own repo"
            code="$ node dist/cli.js bench ./my-repo --heads 16"
          />
        </div>

        <figure className={s.benchCard}>
          <BarGroup
            title="Time to fork one head"
            rows={[
              { label: "apfs-clonefile", value: `${c.perHeadMs} ms`, pct: (c.perHeadMs / p.perHeadMs) * 100, strong: true },
              { label: "plain copy", value: `${nf(p.perHeadMs)} ms`, pct: 100 },
            ]}
          />
          <BarGroup
            title={`Extra disk for ${BENCH.heads} heads`}
            rows={[
              { label: "apfs-clonefile", value: c.extraDisk, pct: (c.extraDiskMB / p.extraDiskMB) * 100, strong: true },
              { label: "plain copy", value: p.extraDisk, pct: 100 },
            ]}
          />
          <figcaption className={s.benchNote}>
            forkbomb bench · {BENCH.machine} · {BENCH.workload} · {BENCH.heads} heads. Extra disk is measured from free
            space before and after, so other activity on the machine shows up as noise.
          </figcaption>
        </figure>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 04 Judge                                                            */
/* ================================================================== */
const TONE: Record<string, CodeLine["tone"]> = { fl: "meta", hnk: "hunk", add: "add", del: "del" };
const DIFF_LINES: CodeLine[] = (diffRows as [string, string][]).map(([t, text]) => ({ text, tone: TONE[t] ?? "" }));

export function Judge() {
  const pipeline = [
    "Take the head's diff against the base snapshot.",
    "Drop every change to tests and test config.",
    "Apply what is left to a fresh clone of the body.",
    "Run your test command there, under Forkbomb's own Seatbelt profile.",
    "If tests went missing, it is not a pass.",
  ];
  return (
    <Section id="judge" tone="inset" labelledBy="judge-h">
      <div className="split split--top split--wide-right">
        <div>
          <SectionHeader
            id="judge-h"
            className={s.headerTight}
            index="04"
          eyebrow="Judge"
            title="Judged by the patch it would ship."
            lede="A head's workspace is not trusted. Only its patch is, and only after it passes on a clean copy."
          />
          <ol className={s.pipeline}>
            {pipeline.map((p, i) => (
              <li key={p}>
                <span className={s.pipeN} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{p}</span>
              </li>
            ))}
          </ol>
          <p className={s.fine}>
            Edits to ignored files like <code>node_modules</code> or build output never reach the judge. The judge is
            designed against the common ways to game a suite and is still being hardened. Read the patch before you
            merge it.
          </p>
        </div>

        <Reveal className={s.judgePanel}>
          <div className={s.judgeBar}>
            <span className={s.judgeWho}>
              <span className={s.judgeLabel}>judge</span>
              head {RUN.winner.id} · {RUN.winner.strategy}
            </span>
            <Badge tone="accent" dot>
              {RUN.winner.passed}/{RUN.winner.total} passing
            </Badge>
          </div>
          <ol className={s.judgeTrace} aria-label="What the judge ran">
            <li>patch applied to fresh clone</li>
            <li>test edits dropped</li>
            <li>
              <code>{RUN.testCmd}</code>
            </li>
          </ol>
          <CodeBlock
            title="calc.js · excerpt of the winning patch"
            lang="diff"
            lines={DIFF_LINES}
            maxHeight={520}
            ariaLabel="Excerpt of the winning patch"
            more={{
              href: REPLAY_URL,
              label: "Full patch in the replay",
              note: `${RUN.patch.lines} lines · ${RUN.patch.files} file`,
            }}
          />
        </Reveal>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 05 Isolation                                                        */
/* ================================================================== */
const POLICY: { what: string; rule: ReactNode; tag: string }[] = [
  { what: "Writes", rule: <>Only the head&apos;s own clone and temp dir. <code>.git</code> is read-only.</>, tag: "confined" },
  { what: "Credentials", rule: <><code>~/.ssh</code>, <code>~/.aws</code>, <code>~/.config/gh</code>, Keychains are unreadable.</>, tag: "deny" },
  { what: "Network", rule: <>Loopback only. <code>--network</code> opts in, API engine only.</>, tag: "deny" },
  { what: "Environment", rule: "Clean. No API keys or tokens in a head's shell.", tag: "stripped" },
];

export function Isolation() {
  return (
    <Section id="isolation" labelledBy="iso-h">
      <div className="split split--top">
        <SectionHeader
          id="iso-h"
          className={s.headerFlush}
          index="05"
          eyebrow="Isolation"
          title="Every head runs in a box."
          lede="Each shell command a head runs goes through macOS Seatbelt. Claude Code heads also run in Claude Code's own sandbox, in safe mode, with no user or project settings."
          actions={
            <Button href="/security" iconRight="arrowRight">
              Read the security model
            </Button>
          }
        />

        <div className="stack">
          <div className={s.policy}>
            <p className={s.policyHead} aria-hidden="true">
              <span>Resource</span>
              <span>Rule for every head</span>
            </p>
            <ul className={s.policyList} aria-label="Head sandbox policy">
              {POLICY.map((p) => (
                <li key={p.what} className={s.policyRow}>
                  <span className={s.policyWhat}>
                    <Icon name={p.what === "Credentials" ? "lock" : "shield"} size={14} />
                    {p.what}
                  </span>
                  <span className={s.policyRule}>
                    <span>{p.rule}</span>
                    <span className={s.policyTag}>{p.tag}</span>
                  </span>
                </li>
              ))}
            </ul>
            <div className={s.policyCanary}>
              <code>
                <span className="accent" aria-hidden="true">
                  ${" "}
                </span>
                forkbomb canary
              </code>
              <span>Runs a real session told to escape. Claude Code heads only start if every escape fails.</span>
            </div>
          </div>
          <Callout tone="warn" title="Limits, stated plainly">
            <p>
              Seatbelt is a macOS sandbox, not a VM. Heads can still read most of your filesystem outside the credential
              folders, and use CPU and memory freely. Run Forkbomb on code you would let an agent work on.
            </p>
          </Callout>
        </div>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 06 Engines                                                          */
/* ================================================================== */
type EngineRow = [string, ReactNode];
const ENGINES: { flag: string; name: string; tag?: string; rows: EngineRow[]; note?: string }[] = [
  {
    flag: "--engine claude-code",
    name: "Your Claude plan",
    tag: "default",
    rows: [
      ["Pays with", "Your Claude Pro or Max plan. No API credits."],
      ["Setup", <><code>claude auth login</code>, once.</>],
      ["Each head", "A headless Claude Code session in safe mode: no CLAUDE.md, hooks, plugins or MCP."],
      ["Sandbox", "Claude Code's Bash sandbox, deny rules on credential folders and .git, plus the isolation canary."],
      ["Model", <>Your Claude Code default, or <code>--model</code>.</>],
    ],
    note: "Heads count against your plan's usage limits. Eight heads use them about eight times as fast as one session.",
  },
  {
    flag: "--engine api",
    name: "An Anthropic API key",
    rows: [
      ["Pays with", "Pay as you go on the Messages API."],
      ["Setup", <><code>ANTHROPIC_API_KEY</code> in <code>~/.forkbomb/.env</code>, or exported.</>],
      ["Each head", "Forkbomb's own tool loop with two tools: bash and a text editor."],
      ["Sandbox", "Forkbomb's Seatbelt profile for every shell command. The editor re-checks every path."],
      ["Model", <><code>claude-opus-5-5</code> at medium effort, or <code>--model</code>.</>],
    ],
    note: "The key stays in Forkbomb's own process. Head shells get a clean environment without it.",
  },
];

export function Engines() {
  return (
    <Section id="engines" labelledBy="eng-h" divider>
      <SectionHeader
        id="eng-h"
        index="06"
          eyebrow="Engines"
        title="Runs on your Claude plan, or an API key."
        lede="Pick the engine per run. Either way, credentials stay on your machine and the judge runs under Forkbomb's own sandbox."
      />
      <div className={s.engines}>
        {ENGINES.map((e) => (
          <article key={e.flag} className={s.engine} aria-labelledby={`eng-${e.flag.split(" ")[1]}`}>
            <header className={s.engineHead}>
              <div>
                <h3 id={`eng-${e.flag.split(" ")[1]}`} className={s.engineName}>
                  {e.name}
                </h3>
                <code className={s.engineFlag}>{e.flag}</code>
              </div>
              {e.tag && <Badge>{e.tag}</Badge>}
            </header>
            <dl className={s.engineRows}>
              {e.rows.map(([k, v]) => (
                <div key={k} className={s.engineRow}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {e.note && <p className={s.engineNote}>{e.note}</p>}
          </article>
        ))}
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 07 Quickstart                                                       */
/* ================================================================== */
export function Quickstart() {
  return (
    <Section id="quickstart" tone="inset" labelledBy="qs-h">
      <div className="split split--top">
        <div>
          <SectionHeader
            id="qs-h"
            className={s.headerTight}
            index="07"
          eyebrow="Quickstart"
            title="Three commands to your first run."
            lede="Forkbomb is not on npm yet. Build it from source."
          />
          <ol className={s.qsSteps}>
            {INSTALL.map((st, i) => (
              <li key={st.label} className={s.qsStep}>
                <CodeBlock lang="sh" title={`${i + 1}  ${st.label}`} code={st.lines.join("\n")} ariaLabel={st.label} />
              </li>
            ))}
          </ol>
          <div className="cluster mt-8">
            <Button href="/docs#install" iconRight="arrowRight">
              Full install guide
            </Button>
          </div>
        </div>

        <div className={s.qsTerm}>
          <Terminal
            title={`recorded output · run ${RUN.id}`}
            status={
              <Badge tone="accent" dot>
                {RUN.winner.passed}/{RUN.winner.total}
              </Badge>
            }
            lines={RUN_TRANSCRIPT}
            animate
            ariaLabel="Terminal output from the recorded run"
          />
          <p className={s.fine}>
            Output from the recorded run, trimmed. Examples write <code>forkbomb</code> for <code>node dist/cli.js</code>.
          </p>
          <div className={s.reqs}>
            <h3 className={s.reqsTitle}>Requirements</h3>
            <ul>
              {REQUIREMENTS.map((r) => (
                <li key={r}>
                  <Icon name="check" size={14} />
                  {r}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 08 FAQ                                                              */
/* ================================================================== */
const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "Is it on npm?",
    a: (
      <>
        Not yet. Clone the repo, run <code>npm install</code> and <code>npm run build</code>, then{" "}
        <code>node dist/cli.js doctor</code> to check the machine.
      </>
    ),
  },
  {
    q: "Is it Mac only?",
    a: "Yes, for now. Forking uses APFS clonefile and the sandbox uses Seatbelt, both macOS. Other platforms would need their own fork and sandbox backends. None ship today.",
  },
  {
    q: "Do I need the $FORKBOMB token?",
    a: "No. The token is a community launch vehicle and is not wired into the product. Forkbomb is MIT licensed and runs without it.",
  },
  {
    q: "What does a run cost?",
    a: "Forkbomb itself is free. On the Claude Code engine, heads use your plan's usage limits, and N heads use them about N times as fast. On the API engine you pay for tokens as usual.",
  },
  {
    q: "Can a head cheat the tests?",
    a: "The judge drops test and test-config edits, applies the patch to a fresh clone, and does not count runs where tests went missing. It is designed against common gaming and is still being hardened. Review the winning patch like any other change.",
  },
  {
    q: "Does my code leave my machine?",
    a: "Forkbomb has no telemetry and no server of its own. The heads are Claude sessions, so the code they read goes to Anthropic's API, as it would in any Claude Code session. Heads get no network beyond loopback and no credentials.",
  },
  {
    q: "How mature is it?",
    a: `Early. Pre-release, macOS only, not on npm. Forkbomb's own suite has ${TEST_COUNT} automated tests, and every run is saved with its full event log so you can replay exactly what happened.`,
  },
];

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-h">
      <div className={s.faqGrid}>
        <SectionHeader
          id="faq-h"
          className={s.headerFlush}
          index="08"
          eyebrow="FAQ"
          title="Straight answers."
          lede={
            <>
              Something missing?{" "}
              <a className="link" href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
                Open an issue
              </a>
              .
            </>
          }
        />
        <div className={s.faq}>
          {FAQ.map((f) => (
            <details key={f.q} className={s.faqItem}>
              <summary className={s.faqQ}>
                <h3>{f.q}</h3>
                <span className={s.faqIcon} aria-hidden="true" />
              </summary>
              <div className={s.faqA}>
                <p>{f.a}</p>
              </div>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* Final CTA                                                           */
/* ================================================================== */
export function FinalCta() {
  return (
    <Section size="sm" labelledBy="cta-h">
      <div className={s.cta}>
        <Mark className={s.ctaMark} size={36} />
        <h2 id="cta-h" className={cx("h1", s.ctaTitle)}>
          Stop betting on one attempt.
        </h2>
        <p className={cx("lede", s.ctaLede)}>
          Point Forkbomb at a failing suite. Watch {RUN.heads.length} strategies race. Keep the patch that passes.
        </p>
        <div className={cx("cluster", s.ctaActions)}>
          <Button href="/docs" variant="primary" size="lg" iconRight="arrowRight">
            Read the docs
          </Button>
          <Button href={GITHUB_URL} size="lg" icon="github">
            View the source
          </Button>
        </div>
        <p className={s.ctaMeta}>MIT · macOS · install from source</p>
      </div>
    </Section>
  );
}
