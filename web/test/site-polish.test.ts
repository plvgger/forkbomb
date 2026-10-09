import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEPTH, EXITED, FORKS, KILLED, NODES, OUTER0, lineageOf } from "../app/components/forkTree";
import { APP_URL, CLI_HOME, CLI_PROBE, NAV_CTA, RUN, RUN_TRANSCRIPT, SITE, STATUS, TOKEN_MEMO_PREFIX } from "../app/config";
import { BENCH_FLAGS, EVENTS, RUN_FLAGS } from "../app/docs/_parts/content";
import { BRAND } from "../lib/server/config";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** A file in the CLI package next to web/. */
const readCli = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("hero fork-bomb counters", () => {
  it("counts 126 forks, 120 kills and exactly one exit 0", () => {
    expect(FORKS).toBe(126);
    expect(KILLED).toBe(120);
    expect(EXITED).toBe(1);
  });

  it("leaves only the survivor's parents unaccounted: fork() = SIGKILL + parents + exit 0", () => {
    for (const leaf of [OUTER0, OUTER0 + 26, NODES.length - 1]) {
      const lineage = lineageOf(leaf); // pid 1 + DEPTH - 1 parents + the survivor
      expect(lineage.size).toBe(DEPTH + 1);
      const parents = lineage.size - 2;
      expect(KILLED + parents + EXITED).toBe(FORKS);
    }
  });
});

describe("app status", () => {
  it("marks /app live and points both nav CTAs at it", () => {
    expect(STATUS.appLive).toBe(true);
    expect(APP_URL).toBe("/app");
    expect(NAV_CTA.app.href).toBe(APP_URL);
    expect(NAV_CTA.wallet.href).toBe(APP_URL);
  });

  it("offers a wallet only once burns are open; until then the second CTA promises what /app gives", () => {
    expect(NAV_CTA.wallet).toMatchObject(
      STATUS.tokenLive ? { label: "Connect wallet", icon: "wallet" } : { label: "Get an API key", icon: "key" },
    );
  });
});

describe("type", () => {
  it("loads one pixel face", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toContain("Pixelify_Sans");
    expect(layout).not.toMatch(/Tiny5/);
    expect(read("app/globals.css")).toMatch(/--font-wordmark:\s*var\(--font-pixel\)/);
  });

  it("turns ligatures off on every element, past `font:` shorthands", () => {
    expect(read("app/globals.css")).toMatch(
      /\*, ::before, ::after \{\s*font-variant-ligatures: no-common-ligatures no-discretionary-ligatures !important;/,
    );
  });

  it("never sets numbers in the pixel face", () => {
    const numeric: [string, string][] = [
      ["app/globals.css", ".stat__value"],
      ["app/components/ForkBombHero.module.css", ".stat b"],
      ["app/_home/home.module.css", ".fact dd"],
      ["app/_home/home.module.css", ".peekStats dd"],
      ["app/_home/home.module.css", ".bigNumV"],
      ["app/_home/home.module.css", ".meterValue"],
      ["app/burns/burns.module.css", ".totalValue"],
      ["app/docs/docs.module.css", ".flowNum"],
      ["app/token/token.module.css", ".stepN"],
    ];
    for (const [file, selector] of numeric) {
      const css = read(file);
      const at = css.indexOf(`${selector} {`);
      expect(at, `${selector} in ${file}`).toBeGreaterThanOrEqual(0);
      const rule = css.slice(at, css.indexOf("}", at));
      expect(rule, `${selector} in ${file}`).toContain("var(--font-mono)");
      expect(rule, `${selector} in ${file}`).not.toContain("--font-pixel");
    }
  });

  it("never sets the ticker or the hazard tape's small caps in the pixel face (its B reads as G)", () => {
    const css = read("app/globals.css");
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(rule(".ticker")).toContain("var(--font-mono)");
    expect(rule(".hazard__label")).toContain("var(--font-mono)");
    expect(rule(".hazard__label")).not.toContain("--font-pixel");
  });

  it("has no pixel-font buttons", () => {
    expect(read("app/globals.css")).not.toContain("btn--pixel");
    expect(read("app/components/Button.tsx")).not.toContain("pixel");
  });
});

describe("contrast", () => {
  // Regression: killed forks were dimmed with opacity (text at 2.67:1), and touch screens showed heading anchors
  // at half opacity (2.14:1).
  it("dims killed forks without opacity, and shows touch anchors at full --text-3", () => {
    const css = read("app/globals.css");
    const cut = [...css.matchAll(/\.run-tree__item--cut[^{]*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(cut.length).toBeGreaterThan(0);
    for (const body of cut) expect(body).not.toMatch(/opacity/);
    expect(read("app/docs/docs.module.css")).toMatch(/@media \(hover: none\) \{ \.anchor \{ opacity: 1; \} \}/);
  });
});

describe("standalone /replay page", () => {
  const html = read("public/replay/index.html");

  it("has the site's nav links and a footer", () => {
    for (const href of ["/", "/docs", "/burns", "/security", "/token", "/app"]) {
      expect(html).toContain(`<a href="${href}">`);
    }
    expect(html).toContain('class="sitenav"');
    expect(html).toContain('class="sitefoot"');
  });

  it("serves recorded run data with no home-directory paths", () => {
    for (const f of ["events.jsonl", "data.js"]) expect(read(`public/replay/${f}`), f).not.toMatch(/\/Users\/|\/home\//);
  });

  it("ships the recorded run in the current event schema", () => {
    const fromJsonl = read("public/replay/events.jsonl")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const data = read("public/replay/data.js");
    const prefix = "window.FORKBOMB_EVENTS = ";
    expect(data.startsWith(prefix)).toBe(true);
    const fromData = JSON.parse(data.slice(prefix.length).replace(/;\s*$/, "")) as Record<string, unknown>[];
    expect(fromData).toEqual(fromJsonl);

    const documented = new Set(EVENTS.map((e) => e.type));
    const perFork = new Set(["fork_start", "tool", "note", "fork_done", "judging", "judge", "kill", "winner"]);
    for (const e of fromData) {
      const type = String(e.type);
      expect(documented.has(type), `undocumented event type ${type}`).toBe(true);
      expect(Object.keys(e), type).not.toContain("head");
      expect(Object.keys(e), type).not.toContain("heads");
      if (perFork.has(type)) expect(typeof e.fork, type).toBe("string");
    }
    const start = fromData.find((e) => e.type === "run_start");
    const fork = fromData.find((e) => e.type === "fork");
    expect(start?.forks).toBe(RUN.forks.length);
    expect(fork?.forks).toEqual(RUN.forks.map((f) => f.id));
    const kills = fromData.filter((e) => e.type === "kill");
    expect(kills).toHaveLength(RUN.killed);
    const winner = fromData.find((e) => e.type === "winner");
    expect(winner?.fork).toBe(RUN.winner.id);
    const done = fromData.filter((e) => e.type === "fork_done").map((e) => e.reason);
    expect(done.filter((r) => r === "killed")).toHaveLength(RUN.killed);
  });

  it("replay script and host page agree on the globals and the ready message", () => {
    const app = read("public/replay/app.js");
    expect(app).toContain("window.FORKBOMB_EVENTS");
    expect(app).toContain('"forkbomb:replay-ready"');
    expect(read("app/components/ReplayReady.tsx")).toContain('"forkbomb:replay-ready"');
  });

  // Regression: relative og:image/og:url, which Facebook, LinkedIn and Slack drop, on the most-shared page.
  it("uses absolute share URLs on the site's origin", () => {
    const tag = (re: RegExp) => re.exec(html)?.[1];
    expect(tag(/<link rel="canonical" href="([^"]+)">/)).toBe(`${SITE.url}/replay`);
    expect(tag(/<meta property="og:url" content="([^"]+)">/)).toBe(`${SITE.url}/replay`);
    expect(tag(/<meta property="og:image" content="([^"]+)">/)).toBe(`${SITE.url}/opengraph-image`);
    expect(tag(/<meta name="twitter:image" content="([^"]+)">/)).toBe(`${SITE.url}/twitter-image`);
  });

  it("stays chromeless in embed mode", () => {
    expect(html).toMatch(/html\[data-embed\] \.sitenav, html\[data-embed\] \.sitefoot,/);
  });

  it("keeps every element the replay script writes to", () => {
    for (const id of ["status", "elapsed", "cost", "costUnit", "model", "task", "testCmd", "baseline", "tree", "wires", "log", "replayBar"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });
});

describe("site matches the CLI", () => {
  it("prints the burn memo prefix the server verifies", () => {
    expect(TOKEN_MEMO_PREFIX).toBe(`${BRAND.slug}:`);
  });

  it("names the CLI's home dir and canary probe file", () => {
    const brand = readCli("src/brand.ts");
    const slug = /slug: "([a-z0-9]+)"/.exec(brand)?.[1];
    expect(slug).toBe(BRAND.slug);
    expect(CLI_HOME).toBe(`~/.${slug}`);
    expect(readCli("src/engines/canary.ts")).toContain(`"${CLI_PROBE}"`);
  });

  it("documents only flags the CLI parses, under their current names", () => {
    const cli = readCli("src/cli.ts");
    const names = [...RUN_FLAGS, ...BENCH_FLAGS]
      .map((f) => /--([a-z][a-z-]*)/.exec(f.flag)?.[1])
      .filter((n): n is string => Boolean(n));
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      expect(cli, `--${name}`).toMatch(new RegExp(`(^|\\s)"?${name}"?: \\{ type:`, "m"));
    }
    expect(RUN_TRANSCRIPT[0]!.text).toContain("--forks 4");
  });

  it("documents every event type the CLI writes, and no others", () => {
    const types = [...readCli("src/events.ts").matchAll(/type: "([a-z_]+)"/g)].map((m) => m[1]);
    expect(types.length).toBeGreaterThan(10);
    expect(EVENTS.map((e) => e.type).sort()).toEqual([...new Set(types)].sort());
  });
});
