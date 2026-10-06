import { CONTRACT_ADDRESS, GITHUB_URL, REPLAY_URL, STATS } from "./config";
import { CopyButton, Reveal, TerminalReplay } from "./Interactive";
import diffRows from "./diff.json";

const Mark = () => (
  <svg viewBox="0 0 32 32" aria-hidden="true">
    <path d="M16 29V17M16 17C16 11 9 11 6 5M16 17C16 11 23 11 26 5M16 17V4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    <circle cx="6" cy="5" r="2.4" fill="currentColor" />
    <circle cx="16" cy="4" r="2.4" fill="currentColor" />
    <circle cx="26" cy="5" r="2.4" fill="currentColor" />
  </svg>
);

const Check = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const STEPS = [
  { n: "01 · FORK", t: "Clone the repo, many times", p: "Each head gets a full copy of your project in about a millisecond. On a Mac, copies share disk until a head writes, so 16 heads cost megabytes, not gigabytes.", icon: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="19" r="2.5" /><path d="M6 8.5v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-3M12 14.5v2" /></> },
  { n: "02 · RACE", t: "Each head, a different plan", p: "One head makes the smallest possible change. Another rewrites the broken function. Another reads every caller first. Eight copies with one plan fail the same way eight times, so Hydra gives each a different one.", icon: <><path d="M4 20V6M4 6l9 3-4 3 5 2M4 6h10" /><circle cx="19" cy="18" r="2" /></> },
  { n: "03 · JUDGE", t: "Your tests pick the winner", p: "When a head stops, Hydra runs your test command on its work. The first to make the suite pass wins and the rest are cut off. You get the winner's patch, and nothing else ever touches your repo.", icon: <><path d="M12 3v18M5 7h14M7 7l-3 6a3 3 0 0 0 6 0L7 7zM17 7l-3 6a3 3 0 0 0 6 0l-3-6z" /></> },
];

const SEC = [
  ["Writes stay in the clone", "A head can only change files in its own copy. It can't touch your real repo, another head, or your git history."],
  ["Credentials are off-limits", "SSH keys, cloud tokens, keychains, shell history, your Claude config. Heads can't read any of it."],
  ["No network", "Heads work offline. Nothing they touch leaves your machine, so a hijacked prompt has nowhere to send anything."],
  ["Proven, not promised", "hydra canary runs a real agent told to escape and reports what it could and couldn't do. Heads only start when the box holds."],
];

const FAQ = [
  ["What do I need to run it?", "A Mac, a code project with a test command, and Claude Code logged in (any Pro or Max plan) or an Anthropic API key. Install is one command."],
  ["Does it change my code without asking?", "No. Heads work in throwaway copies. You get the winning change as a patch to review. Add --apply if you want it dropped straight into your repo."],
  ["How is this different from asking the agent twice?", "Hydra runs many attempts at once, each with a different strategy, each isolated, and lets your tests pick the winner automatically. You watch it happen and keep only what passes, instead of babysitting one attempt and hoping."],
  ["Is my code or key sent anywhere?", "No. Everything runs on your machine on your own login. Heads have no network access. The only thing that leaves is the normal traffic between Claude Code and Anthropic."],
  ["Do I need the token to use it?", "No. The tool is free and fully open source. The token is a separate community thing and unlocks nothing in the product."],
];

export default function Page() {
  return (
    <>
      <nav className="nav">
        <a className="brand" href="#top">
          <Mark />
          <b>HYDRA</b>
        </a>
        <a className="link" href="#how">How it works</a>
        <a className="link" href="#safe">Isolation</a>
        <a className="link" href="#token">Token</a>
        <a className="link" href={REPLAY_URL} target="_blank" rel="noopener">Live replay</a>
        <a className="ghbtn" href={GITHUB_URL} target="_blank" rel="noopener">GitHub ↗</a>
      </nav>

      <header className="hero" id="top">
        <span className="eyebrow">Open-source coding-agent harness</span>
        <h1>Fork your agent.<br />Let the tests pick the <span className="nowrap accent">survivor.</span></h1>
        <p className="sub">Hydra clones your repo into many sandboxed copies in milliseconds. Each one sends a coding agent at the same bug a different way. Your test suite decides who wins. One survivor, one clean patch.</p>
        <div className="cta">
          <a className="btn btn-primary" href="#how">See how it works</a>
          <a className="btn btn-ghost" href={REPLAY_URL} target="_blank" rel="noopener">Watch a real run ↗</a>
        </div>
        <div className="install" title="Click to copy">
          <code id="install"><span className="prompt">$ </span>npx hydra-heads run --task &quot;fix the failing tests&quot; --test &quot;npm test&quot; --ui</code>
          <CopyButton target="install">COPY</CopyButton>
        </div>

        <Reveal className="viewport">
          <div className="bar">
            <span className="dot" /><span className="dot" /><span className="dot" />
            <span className="label">hydra · live tree</span>
            <span className="live">RECORDED RUN</span>
          </div>
          <div className="frame">
            <iframe src="/replay/index.html?embed=1" title="Hydra run replay" loading="lazy" scrolling="no" />
          </div>
        </Reveal>
        <div className="stats">
          {STATS.map((s) => (
            <div className="s" key={s.k}>
              <div className="v">{s.v}</div>
              <div className="k">{s.k}</div>
            </div>
          ))}
        </div>
      </header>

      <section id="how">
        <div className="wrap">
          <Reveal className="shead">
            <span className="eyebrow">The loop</span>
            <h2>Many tries at once beat one try, polished.</h2>
            <p>A hard bug rarely falls to the first idea. Hydra runs a dozen first ideas in parallel, in isolation, and keeps only the one that actually passes.</p>
          </Reveal>
          <div className="steps">
            {STEPS.map((s) => (
              <Reveal className="step" key={s.n}>
                <span className="n">{s.n}</span>
                <svg className="ic" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">{s.icon}</svg>
                <h3>{s.t}</h3>
                <p>{s.p}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="split">
            <Reveal className="txt">
              <span className="eyebrow">Judged honestly</span>
              <h2 style={{ fontSize: "clamp(24px,3.5vw,32px)", marginTop: 14 }}>A head wins by fixing the code. Not by gaming the test.</h2>
              <p className="muted" style={{ marginTop: 14 }}>Hydra judges a head by the patch it would actually ship. Edits to the tests are thrown away. The patch is applied to a clean copy and your suite runs there, so a head can&apos;t win by deleting a test, hacking a dependency, or printing a fake &quot;all passed.&quot;</p>
              <p className="muted" style={{ marginTop: 14 }}>The winner from the run above fixed the real evaluator: operator precedence, right-associative <code className="mono accent">^</code>, unary minus, decimals, clear errors. 94 lines, one file.</p>
            </Reveal>
            <Reveal className="diffwrap">
              <div className="dh"><span>winner.patch · calc.js</span><span className="accent">14/14 passing</span></div>
              <pre className="mono">
                {(diffRows as [string, string][]).map(([cls, text], i) => (
                  <span key={i} className={cls || undefined}>{text}{"\n"}</span>
                ))}
              </pre>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="safe" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <Reveal className="shead">
            <span className="eyebrow">Isolation</span>
            <h2>Every head is sealed inside its own copy.</h2>
            <p>The agents are capable and they run on your machine, so Hydra boxes each one in. Before the first run it even proves the box holds: it tells a real agent to break out, and only starts if every escape fails.</p>
          </Reveal>
          <div className="sec">
            {SEC.map(([h, p]) => (
              <Reveal className="item" key={h}>
                <h4><Check />{h}</h4>
                <p>{p}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="split rev">
            <Reveal className="termcard">
              <div className="th"><span className="dot" /><span className="dot" /><span className="dot" /></div>
              <TerminalReplay />
            </Reveal>
            <Reveal className="txt">
              <span className="eyebrow">On your own plan</span>
              <h2 style={{ fontSize: "clamp(24px,3.5vw,32px)", marginTop: 14 }}>Runs on your Claude subscription. No API bill.</h2>
              <p className="muted" style={{ marginTop: 14 }}>Hydra drives each head through Claude Code on whatever you&apos;re already logged in with. A Pro or Max plan works with zero API credits. Prefer pay-as-you-go? Point it at an API key instead with one flag.</p>
              <p className="muted" style={{ marginTop: 14 }}>It&apos;s a single command-line tool. It runs on your machine, uses your login, and never phones home. Free and open source, MIT.</p>
              <a className="btn btn-ghost" style={{ marginTop: 22 }} href={GITHUB_URL} target="_blank" rel="noopener">Read the code ↗</a>
            </Reveal>
          </div>
        </div>
      </section>

      <section id="token" className="token">
        <div className="wrap">
          <span className="eyebrow">Community</span>
          <h2 style={{ fontSize: "clamp(26px,4vw,38px)", marginTop: 14 }}>$HYDRA</h2>
          <p className="muted" style={{ maxWidth: "52ch", margin: "16px auto 0" }}>The tool is free and open source and works with no token. $HYDRA is the community coin for the people building and watching it. It isn&apos;t wired into the product and buys you nothing in it.</p>
          <div className="ca">
            <code id="ca">{CONTRACT_ADDRESS || "launching — contract address goes here"}</code>
            <CopyButton target="ca">COPY</CopyButton>
          </div>
          <p className="note">Not an investment and no expectation of profit. The contract address only ever appears on this page. Verify it here before you trust it anywhere else.</p>
        </div>
      </section>

      <section id="faq">
        <div className="wrap">
          <Reveal className="shead" >
            <div style={{ textAlign: "center", margin: "0 auto 40px" }}>
              <span className="eyebrow">Questions</span>
              <h2 style={{ marginTop: 14 }}>Good to know</h2>
            </div>
          </Reveal>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}<span className="plus">+</span></summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <footer>
        <div>HYDRA · MIT licensed · <a href={GITHUB_URL} target="_blank" rel="noopener">GitHub</a> · <a href={REPLAY_URL} target="_blank" rel="noopener">Live replay</a></div>
        <div style={{ marginTop: 10, color: "var(--dim)" }}>Built with Claude. The tool runs locally; nothing here is custodial or financial advice.</div>
      </footer>
    </>
  );
}
