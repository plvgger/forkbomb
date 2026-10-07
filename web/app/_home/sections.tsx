import type { ReactNode } from "react";
import {
  Badge,
  Button,
  CAChip,
  CodeBlock,
  CrtPanel,
  Eyebrow,
  ForkBombHero,
  Glyph,
  Icon,
  Marquee,
  PixelHeading,
  PsTable,
  ReplayFrame,
  Reveal,
  Section,
  Terminal,
  cx,
  type IconName,
  type MarqueeItem,
} from "../components";
import {
  APP_URL,
  BENCH,
  GITHUB_URL,
  INSTALL_SCRIPT,
  ISSUES_URL,
  RUN,
  RUN_END_S,
  RUN_TRANSCRIPT,
  SITE,
  STATUS,
  TEST_COUNT,
  TOKEN_MEMO_PREFIX,
} from "../config";
import { DetonationDiagram } from "./DetonationDiagram";
import { LedgerPeek } from "./LedgerPeek";
import s from "./home.module.css";

const nf = (n: number) => n.toLocaleString("en-US");
const MEMO = `${TOKEN_MEMO_PREFIX}<workspaceId>`;
const POOL_STATUS = STATUS.hostedPoolLive ? "live" : "coming online";

/** Section heading block: eyebrow + pixel h2 + lede. */
function Head({
  id,
  index,
  eyebrow,
  title,
  lede,
  center,
  className,
  children,
}: {
  id: string;
  index?: string;
  eyebrow: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  center?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header className={cx(s.head, center && s.headCenter, className)}>
      <Eyebrow index={index}>{eyebrow}</Eyebrow>
      <PixelHeading as="h2" size="lg" id={id}>
        {title}
      </PixelHeading>
      {lede && <p className="lede">{lede}</p>}
      {children}
    </header>
  );
}

/* ================================================================== */
/* Hero                                                                */
/* ================================================================== */
export function Hero() {
  const facts: { k: string; v: ReactNode }[] = [
    { k: "fork()", v: <>{RUN.forkMsEach} ms</> },
    { k: "forks", v: <>{RUN.forks.length} → 1</> },
    { k: "race", v: <>{RUN.durationS} s</> },
    { k: "vs copy", v: <>{BENCH.speedup}</> },
    { k: "tests", v: <>{TEST_COUNT}</> },
  ];
  return (
    <section className={s.hero} aria-labelledby="hero-title">
      <div className={cx("container", s.heroGrid)}>
        <div className={s.heroCopy}>
          <p className={s.heroPrompt}>
            <span className={s.heroPs1} aria-hidden="true">
              $
            </span>
            <Glyph glow />
            <span className={cx(s.heroCursor, "cursor")} aria-hidden="true" />
          </p>
          <h1 id="hero-title" className={s.heroTitle}>
            <span className={cx(s.heroWord, "crt-glow")} translate="no">
              {SITE.wordmark}
            </span>
            <span className="sr-only">: </span>
            <span className={s.heroPitch}>
              Fork your coding agent. Keep the one that <span className="text-ok">exits&nbsp;0</span>.
            </span>
          </h1>
        </div>

        <p className={s.heroLede}>
          {SITE.name} clones your repo into sandboxed forks in milliseconds and gives each one a different strategy.
          Your test suite judges every patch: the losers get <code>kill -9</code>, the winning patch is yours.
        </p>

        <div className={s.heroVisual}>
          <ForkBombHero />
        </div>

        <div className={s.heroActions}>
          <div className={cx("cluster", s.heroCtas)}>
            <Button href={APP_URL} variant="primary" size="lg" iconRight="arrowRight">
              Open app
            </Button>
            <Button href="/docs" variant="outline" size="lg">
              Read the docs
            </Button>
          </div>
          <div className={s.heroCa}>
            <CAChip />
            <span className={s.heroCaMeta}>
              {SITE.ticker} · Solana · {STATUS.tokenLive ? "live" : "not launched yet"}
            </span>
          </div>
        </div>
      </div>

      <div className="container">
        <dl className={s.facts} aria-label="Real numbers from the recorded run, the benchmark and the test suite">
          {facts.map((f) => (
            <div key={f.k} className={s.fact}>
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
        <p className={s.factsNote}>
          Recorded run {RUN.date} · bench on {BENCH.machine} · {TEST_COUNT} automated tests in the CLI. The fork-tree
          animation is an illustration, not a recording.
        </p>
      </div>
    </section>
  );
}

const HERO_MARQUEE: MarqueeItem[] = [
  { text: SITE.glyph, tone: "hot" },
  "fork()",
  "race",
  "judge",
  { text: "kill -9", tone: "hot" },
  { text: "exit 0", tone: "ok" },
  "clonefile(2)",
  SITE.ticker,
];

export function GlyphMarquee() {
  return <Marquee items={HERO_MARQUEE} speed={46} className={s.marquee} />;
}

/* ================================================================== */
/* 01 Recorded run: ps + transcript + replay                           */
/* ================================================================== */
export function RunSection() {
  const foot: { k: string; v: ReactNode; tone?: "ok" | "signal" }[] = [
    { k: "baseline", v: `${RUN.baseline.passing}/${RUN.baseline.total}` },
    { k: "fork()", v: `${RUN.forkMsEach} ms each` },
    { k: "killed", v: RUN.killed, tone: "signal" },
    {
      k: "exit 0",
      v: `${RUN.winner.id} · ${RUN.winner.passed}/${RUN.winner.total}`,
      tone: "ok",
    },
    { k: "patch", v: `${RUN.patch.lines} lines · ${RUN.patch.files} file` },
    { k: "wall", v: `${RUN.durationS} s` },
  ];
  return (
    <Section id="run" labelledBy="run-h">
      <Head
        id="run-h"
        index="01"
        eyebrow={`Recorded run · ${RUN.date}`}
        title={
          <>
            {RUN.forks.length} forks. {RUN.killed} <span className="hl">killed</span>. 1{" "}
            <span className="hl-ok">exit&nbsp;0</span>.
          </>
        }
        lede={`A real race: ${RUN.engine}, a ${RUN.repo} with ${RUN.baseline.failing} of ${RUN.baseline.total} tests failing. Fork ${RUN.winner.id} (${RUN.winner.strategy}) passed all ${RUN.winner.total} first, so the other ${RUN.killed} were killed.`}
      />

      <div className={s.runGrid}>
        <CrtPanel
          flush
          className={s.psPanel}
          title="ps -ef | grep forkbomb"
          status={
            <Badge tone="ok" dot>
              exit 0
            </Badge>
          }
        >
          <PsTable />
          <dl className={s.psFoot} aria-label="Run summary">
            {foot.map((f) => (
              <div key={f.k} className={cx(s.psFootCell, f.tone === "ok" && s.isOk, f.tone === "signal" && s.isSignal)}>
                <dt>{f.k}</dt>
                <dd>{f.v}</dd>
              </div>
            ))}
          </dl>
        </CrtPanel>

        <Terminal
          className={s.runTerm}
          title={`recorded output · run ${RUN.id}`}
          status={
            <Badge tone="ok" dot>
              {RUN.winner.passed}/{RUN.winner.total}
            </Badge>
          }
          lines={RUN_TRANSCRIPT}
          animate
          ariaLabel="Terminal output from the recorded run, trimmed"
        />
      </div>

      <p className={s.replayNote}>
        <span className={s.replayDot} aria-hidden="true" />
        Replay, straight from the run&apos;s own event log. Every fork has resolved by {RUN_END_S} s.
      </p>
      <ReplayFrame className={cx("crt", s.replay)} title={`forkbomb replay · run ${RUN.id}`} />
    </Section>
  );
}

/* ================================================================== */
/* 02 How a detonation works                                           */
/* ================================================================== */
const STEPS: {
  n: string;
  t: string;
  cmd: string;
  d: ReactNode;
  tone?: "signal" | "ok";
}[] = [
  {
    n: "01",
    t: "Fork",
    cmd: "clonefile(2)",
    d: "Your repo is snapshotted once as pid 1, then cloned into N forks. Blocks are shared until a fork writes, so a fork costs metadata, not a copy.",
  },
  {
    n: "02",
    t: "Race",
    cmd: "--forks N",
    d: "Each fork is a coding agent with its own strategy: surgeon, root-cause, test-driven, rewriter and more. Different approaches fail differently.",
  },
  {
    n: "03",
    t: "Judge",
    cmd: '--test "npm test"',
    d: "When a fork stops, its diff minus any test edits goes onto a fresh clone, and your test command runs there.",
  },
  {
    n: "04",
    t: "Kill",
    cmd: "kill -9",
    tone: "signal",
    d: "Race mode: the first fork to pass wins and the rest are killed mid-run. Best mode lets all finish and keeps the smallest passing diff.",
  },
  {
    n: "05",
    t: "Exit 0",
    cmd: "--apply",
    tone: "ok",
    d: "The winning patch is yours to read and apply. No pass? The best fork seeds the next round, if it beat its parent.",
  },
];

export function HowItWorks() {
  return (
    <Section id="how-it-works" tone="inset" labelledBy="how-h">
      <Head
        id="how-h"
        index="02"
        eyebrow="How a detonation works"
        title={
          <>
            Fork. Race. Judge. Kill. <span className="hl-ok">Exit&nbsp;0.</span>
          </>
        }
        lede="One loop, drawn from the run above. Every step is plain mechanics you can read in the source."
      />
      <Reveal className={s.diagramWrap}>
        <DetonationDiagram />
      </Reveal>
      <ol className={s.steps}>
        {STEPS.map((st) => (
          <li key={st.n} className={cx(s.step, st.tone === "signal" && s.stepSignal, st.tone === "ok" && s.stepOk)}>
            <span className={s.stepN} aria-hidden="true">
              {st.n}
            </span>
            <h3 className={s.stepT}>{st.t}</h3>
            <code className={s.stepCmd}>{st.cmd}</code>
            <p className={s.stepD}>{st.d}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ================================================================== */
/* 03 Burn for compute                                                 */
/* ================================================================== */
const FLOW: {
  icon: IconName;
  t: string;
  d: ReactNode;
  tag?: string;
  tagTone?: "signal" | "warn";
}[] = [
  { icon: "wallet", t: "Your wallet", d: <>holds {SITE.ticker}</> },
  {
    icon: "flame",
    t: "Burn tx",
    d: (
      <>
        with memo <code className={s.flowMemo}>{MEMO}</code>
      </>
    ),
    tag: "Solana",
    tagTone: "signal",
  },
  { icon: "shield", t: "Verified", d: "server reads the burn on-chain" },
  { icon: "chart", t: "USD credit", d: "amount × TWAP at burn time" },
  {
    icon: "cpu",
    t: "Hosted forks",
    d: <code>--engine hosted</code>,
    tag: POOL_STATUS,
    tagTone: "warn",
  },
];

function BurnFlow() {
  return (
    <ol className={s.flow} aria-label="How a burn becomes compute">
      {FLOW.map((f, i) => (
        <li key={f.t} className={s.flowNode}>
          <span className={s.flowIdx} aria-hidden="true">
            {String(i + 1).padStart(2, "0")}
          </span>
          <span className={s.flowIcon} aria-hidden="true">
            <Icon name={f.icon} size={20} />
          </span>
          <span className={s.flowT}>{f.t}</span>
          <span className={s.flowD}>{f.d}</span>
          {f.tag && (
            <Badge tone={f.tagTone} className={s.flowTag}>
              {f.tag}
            </Badge>
          )}
        </li>
      ))}
    </ol>
  );
}

const BURN_STEPS: { t: string; d: ReactNode }[] = [
  {
    t: "Burn",
    d: (
      <>
        Send one burn transaction from your wallet with the memo <code>{MEMO}</code>. Burned tokens are gone for good.
      </>
    ),
  },
  {
    t: "Credit",
    d: "The server reads the burn from Solana and credits your workspace in USD at the token's time-weighted price when the burn lands. A one-tick spike can't be timed.",
  },
  {
    t: "Compute",
    d: (
      <>
        Credit pays for hosted forks: our GPU coding model behind an OpenAI-compatible API that{" "}
        <code>--engine hosted</code> calls. Later: bigger models, more forks per race, warm GPUs.
      </>
    ),
  },
];

const NOPE = ["No refunds", "No transfers", "No buybacks", "No yield", "No revenue share"];

export function BurnForCompute() {
  return (
    <Section id="burn" tone="inset" labelledBy="burn-h">
      <Head
        id="burn-h"
        index="03"
        eyebrow={`${SITE.ticker} utility`}
        title={
          <>
            Burn for <span className="hl">compute</span>.
          </>
        }
        lede={`The token has one job: paying for hosted forks. Burn ${SITE.ticker}, get USD credit at the price when the burn lands, and spend it on ${SITE.name}'s own GPU coding model. Self-hosting stays free.`}
      />

      <Reveal className={s.flowWrap}>
        <BurnFlow />
      </Reveal>

      <div className={s.burnGrid}>
        <div>
          <ol className={s.burnSteps}>
            {BURN_STEPS.map((b, i) => (
              <li key={b.t} className={s.burnStep}>
                <span className={s.burnN} aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <h3 className={s.burnT}>{b.t}</h3>
                  <p className={s.burnD}>{b.d}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className={s.nope}>
            <p className={s.nopeLead}>Credit is used up, not held.</p>
            <ul className={s.nopeList}>
              {NOPE.map((n) => (
                <li key={n}>
                  <span aria-hidden="true">✕</span>
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <CrtPanel
          className={s.statusPanel}
          title="forkbomb status --launch"
          status={
            <Badge tone="signal" pulse>
              {STATUS.tokenLive ? "live" : "pre-launch"}
            </Badge>
          }
        >
          <dl className={s.statusRows}>
            <div className={s.statusRow}>
              <dt>coin</dt>
              <dd>
                <CAChip />
              </dd>
            </div>
            <div className={s.statusRow}>
              <dt>hosted pool</dt>
              <dd>
                <Badge
                  tone={STATUS.hostedPoolLive ? "ok" : "warn"}
                  dot={!STATUS.hostedPoolLive}
                  pulse={STATUS.hostedPoolLive}
                >
                  {POOL_STATUS}
                </Badge>
              </dd>
            </div>
            <div className={s.statusRow}>
              <dt>self-host</dt>
              <dd className={s.statusText}>free · {SITE.license} · no token needed</dd>
            </div>
            <div className={s.statusRow}>
              <dt>app</dt>
              <dd className={s.statusText}>
                {STATUS.appLive ? (STATUS.tokenLive ? "open" : "open · burns at launch") : "opens at launch"}
              </dd>
            </div>
          </dl>
          <LedgerPeek live={STATUS.tokenLive} />
          <div className={cx("cluster", s.statusActions)}>
            <Button href="/token" variant="primary" iconRight="arrowRight">
              How the token works
            </Button>
            <Button href="/burns" variant="outline" icon="flame">
              Burn ledger
            </Button>
          </div>
        </CrtPanel>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 04 Benchmark                                                        */
/* ================================================================== */
function Meter({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; pct: number; win?: boolean }[];
}) {
  return (
    <div className={s.meter}>
      <h3 className={s.meterTitle}>{title}</h3>
      <ul className={s.meterList}>
        {rows.map((r) => (
          <li key={r.label} className={s.meterRow}>
            <span className={s.meterLabel}>{r.label}</span>
            <span className={cx(s.meterValue, r.win && s.meterValueWin)}>{r.value}</span>
            <span className={s.meterTrack} aria-hidden="true">
              <span
                className={cx(s.meterFill, r.win ? s.meterFillWin : s.meterFillLose)}
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
      <div className={s.benchGrid}>
        <div className={s.benchCopy}>
          <Head
            id="bench-h"
            index="04"
            eyebrow="Benchmark"
            title="A fork costs metadata, not a copy."
            lede="On APFS, clonefile shares every data block with pid 1 until a fork writes. The bench command forks the same tree both ways and measures it."
          />
          <div className={s.bigNums}>
            <div className={s.bigNum}>
              <span className={s.bigNumV}>{BENCH.speedup}</span>
              <span className={s.bigNumK}>faster to fork</span>
              <span className={s.bigNumN}>
                {c.perForkMs} ms vs {nf(p.perForkMs)} ms
              </span>
            </div>
            <div className={s.bigNum}>
              <span className={s.bigNumV}>{BENCH.diskSaving}</span>
              <span className={s.bigNumK}>less extra disk</span>
              <span className={s.bigNumN}>
                {c.extraDisk} vs {p.extraDisk}
              </span>
            </div>
          </div>
        </div>

        <CrtPanel className={s.benchPanel} title={`node dist/cli.js bench ./tree --forks ${BENCH.forks}`}>
          <Meter
            title="Time to fork one copy"
            rows={[
              {
                label: "apfs-clonefile",
                value: `${c.perForkMs} ms`,
                pct: (c.perForkMs / p.perForkMs) * 100,
                win: true,
              },
              { label: "plain copy", value: `${nf(p.perForkMs)} ms`, pct: 100 },
            ]}
          />
          <Meter
            title={`Extra disk for ${BENCH.forks} forks`}
            rows={[
              {
                label: "apfs-clonefile",
                value: c.extraDisk,
                pct: (c.extraDiskMB / p.extraDiskMB) * 100,
                win: true,
              },
              { label: "plain copy", value: p.extraDisk, pct: 100 },
            ]}
          />
          <p className={s.benchNote}>
            {BENCH.machine} · {BENCH.workload} · {BENCH.forks} forks. Extra disk is free space before vs after, so other
            activity on the machine shows up as noise.
          </p>
        </CrtPanel>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 05 Engines                                                          */
/* ================================================================== */
type EngineCard = {
  id: string;
  name: string;
  flag: string;
  tag?: { text: string; tone?: "warn" | "neutral" };
  rows: [string, ReactNode][];
  note: ReactNode;
  hot?: boolean;
};

const ENGINE_CARDS: EngineCard[] = [
  {
    id: "claude-code",
    name: "Your Claude plan",
    flag: "--engine claude-code",
    tag: { text: "default" },
    rows: [
      ["Pays with", "Your Claude Pro or Max plan"],
      ["Each fork", "A headless Claude Code session in safe mode: no CLAUDE.md, hooks, plugins or MCP"],
      [
        "Setup",
        <>
          <code>claude auth login</code>, once
        </>,
      ],
    ],
    note: "Forks count against your plan's limits: 8 forks use them about 8× as fast as one session.",
  },
  {
    id: "api",
    name: "Your API key",
    flag: "--engine api",
    rows: [
      ["Pays with", "Pay as you go on the Anthropic API"],
      ["Each fork", "Forkbomb's own tool loop with two tools: bash and a text editor"],
      [
        "Setup",
        <>
          <code>ANTHROPIC_API_KEY</code> in your environment
        </>,
      ],
    ],
    note: "The key stays in Forkbomb's own process. Fork shells get a clean environment without it.",
  },
  {
    id: "hosted",
    name: `Burn ${SITE.ticker}`,
    flag: "--engine hosted",
    tag: {
      text: POOL_STATUS,
      tone: STATUS.hostedPoolLive ? "neutral" : "warn",
    },
    hot: true,
    rows: [
      ["Pays with", `Credit from burning ${SITE.ticker}`],
      ["Each fork", "Forkbomb's GPU coding model over an OpenAI-compatible API"],
      ["Setup", "A workspace API key from the app"],
    ],
    note: STATUS.hostedPoolLive
      ? `The code your forks read is sent to Forkbomb's hosted model.${STATUS.tokenLive ? "" : " Credit opens when the coin launches."}`
      : "The GPU pool isn't provisioned yet. Until it is, run on your Claude plan or an API key.",
  },
];

export function Engines() {
  return (
    <Section id="engines" labelledBy="eng-h" divider>
      <Head
        id="eng-h"
        index="05"
        eyebrow="Engines"
        title="Bring a plan, a key, or burn the coin."
        lede="Pick the engine per race. The judge always runs on your machine, under Forkbomb's own sandbox."
      />
      <div className={s.engines}>
        {ENGINE_CARDS.map((e) => (
          <article key={e.id} className={cx(s.engine, e.hot && s.engineHot)} aria-labelledby={`eng-${e.id}`}>
            <header className={s.engineHead}>
              <div className={s.engineHeadText}>
                <h3 id={`eng-${e.id}`} className={s.engineName}>
                  {e.name}
                </h3>
                <code className={s.engineFlag}>{e.flag}</code>
              </div>
              {e.tag && (
                <Badge tone={e.tag.tone ?? "neutral"} dot={e.tag.tone === "warn"}>
                  {e.tag.text}
                </Badge>
              )}
            </header>
            <dl className={s.engineRows}>
              {e.rows.map(([k, v]) => (
                <div key={k} className={s.engineRow}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className={s.engineNote}>{e.note}</p>
          </article>
        ))}
      </div>
      <p className={s.fine}>
        Forkbomb is an independent open-source project. Not affiliated with Anthropic. Claude and Claude Code are
        Anthropic&apos;s products; you use them under your own account.
      </p>
    </Section>
  );
}

/* ================================================================== */
/* 06 Isolation teaser                                                 */
/* ================================================================== */
const POLICY: { what: string; icon: IconName; rule: ReactNode; tag: string }[] = [
  {
    what: "Writes",
    icon: "shield",
    rule: (
      <>
        Only the fork&apos;s own clone and temp dir. <code>.git</code> is read-only.
      </>
    ),
    tag: "confined",
  },
  {
    what: "Credentials",
    icon: "lock",
    rule: (
      <>
        <code>~/.ssh</code>, <code>~/.aws</code>, <code>~/.config/gh</code> and Keychains are unreadable.
      </>
    ),
    tag: "deny",
  },
  {
    what: "Network",
    icon: "shield",
    rule: (
      <>
        Loopback only. <code>--network</code> opts in.
      </>
    ),
    tag: "deny",
  },
  {
    what: "Environment",
    icon: "key",
    rule: "Clean. No API keys or tokens in a fork's shell.",
    tag: "stripped",
  },
];

export function Isolation() {
  return (
    <Section id="isolation" tone="inset" labelledBy="iso-h">
      <div className={s.isoGrid}>
        <Head
          id="iso-h"
          index="06"
          eyebrow="Isolation"
          title="Every fork runs in a box."
          lede="Each shell command a fork runs goes through macOS Seatbelt. It's a bomb, but a contained one."
        >
          <div className={cx("cluster", s.headActions)}>
            <Button href="/security" variant="outline" iconRight="arrowRight">
              Read the security model
            </Button>
          </div>
        </Head>

        <div className={s.policy}>
          <ul className={s.policyList} aria-label="Sandbox policy for every fork">
            {POLICY.map((p) => (
              <li key={p.what} className={s.policyRow}>
                <span className={s.policyWhat}>
                  <Icon name={p.icon} size={14} />
                  {p.what}
                </span>
                <span className={s.policyRule}>{p.rule}</span>
                <span className={s.policyTag}>{p.tag}</span>
              </li>
            ))}
          </ul>
          <p className={s.policyLimit}>
            <Icon name="warn" size={14} />
            <span>
              Seatbelt is a macOS sandbox, not a VM. Forks can still read most of your filesystem outside the credential
              folders. Run it on code you&apos;d let an agent work on.
            </span>
          </p>
        </div>
      </div>
    </Section>
  );
}

/* ================================================================== */
/* 07 FAQ                                                              */
/* ================================================================== */
const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: `What does ${SITE.ticker} do?`,
    a: (
      <>
        It pays for hosted compute. Burn it with the memo <code>{MEMO}</code>, and your workspace gets USD credit at the
        token&apos;s time-weighted price when the burn lands. The credit runs forks on {SITE.name}&apos;s own GPU coding
        model through <code>--engine hosted</code>. Every burn and the credit it produced is listed on the public burn
        ledger.
      </>
    ),
  },
  {
    q: "Do I need the token?",
    a: `No. ${SITE.name} is ${SITE.license} licensed and self-hosting is free: run it on your Claude plan or your own API key and never touch the coin. The token buys hosted convenience and scale, not permission.`,
  },
  {
    q: "Is the hosted pool live?",
    a: STATUS.hostedPoolLive
      ? STATUS.tokenLive
        ? "Yes. Hosted forks run on the GPU pool and draw down your workspace credit."
        : `The GPU pool is serving. Credit comes from burning ${SITE.ticker}, which opens when the coin launches. Until then the claude-code and api engines work with no token involved.`
      : "Not yet. The GPU pool is coming online and the coin hasn't launched. The claude-code and api engines work today, with no token involved.",
  },
  {
    q: "Can I get my credit back or sell it?",
    a: "No. Credit is consumptive: no refunds, no transfers, no buybacks, no yield, no revenue share. Burn only what you plan to spend on compute.",
  },
  {
    q: "Is it Mac only?",
    a: "Yes, for now. Forking uses APFS clonefile and the sandbox uses Seatbelt, both macOS. Other platforms would need their own fork and sandbox backends. None ship today.",
  },
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
    q: "Can a fork cheat the tests?",
    a: "The judge drops test and test-config edits, applies the patch to a fresh clone, and doesn't count runs where tests went missing. It's designed against common gaming and still being hardened. Review the winning patch like any other change.",
  },
  {
    q: "Does my code leave my machine?",
    a: `${SITE.name} has no telemetry. On the claude-code and api engines, the code your forks read goes to Anthropic's API, as in any Claude Code session. On the hosted engine it goes to ${SITE.name}'s hosted model. The judge always runs locally.`,
  },
];

export function Faq() {
  return (
    <Section id="faq" labelledBy="faq-h">
      <div className={s.faqGrid}>
        <Head
          id="faq-h"
          index="07"
          eyebrow="FAQ"
          title="man forkbomb"
          lede={
            <>
              Straight answers. Something missing?{" "}
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
/* Final CTA band                                                      */
/* ================================================================== */
const CTA_MARQUEE: MarqueeItem[] = [SITE.glyph, "fork()", "kill -9", "exit 0", SITE.ticker];

export function FinalCta() {
  return (
    <section className={s.final} aria-labelledby="cta-h">
      <Marquee items={CTA_MARQUEE} tone="signal" size="lg" speed={34} />
      <div className={cx("container", s.finalInner)}>
        <span className={s.finalGlyph} aria-hidden="true" translate="no">
          {SITE.glyph}
        </span>
        <div className={s.finalCopy}>
          <PixelHeading as="h2" size="display" id="cta-h">
            Light the <span className="hl">fuse</span>.
          </PixelHeading>
          <p className={cx("lede", s.finalLede)}>
            Point {SITE.wordmark} at a failing suite. Watch the forks race. Keep the patch that exits 0.
          </p>
          <div className={cx("cluster", s.finalCtas)}>
            <Button href={APP_URL} variant="primary" size="lg" iconRight="arrowRight">
              Open app
            </Button>
            <Button href="/docs#install" variant="outline" size="lg">
              Install from source
            </Button>
            <Button href={GITHUB_URL} variant="ghost" size="lg" icon="github">
              Source
            </Button>
          </div>
          <p className={s.finalMeta}>{SITE.license} · macOS only · not on npm yet · not affiliated with Anthropic</p>
        </div>
        <CodeBlock
          className={s.finalCode}
          title="Install from source"
          lang="sh"
          code={INSTALL_SCRIPT}
          ariaLabel="Install commands"
        />
      </div>
    </section>
  );
}
