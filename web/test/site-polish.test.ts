import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEPTH, EXITED, FORKS, KILLED, NODES, OUTER0, lineageOf } from "../app/components/forkTree";
import { APP_URL, CLI_HOME, CLI_PROBE, NAV_CTA, RUN_TRANSCRIPT, STATUS, TOKEN_MEMO_PREFIX } from "../app/config";
import { BENCH_FLAGS, RUN_FLAGS } from "../app/docs/_parts/content";
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

  it("has no pixel-font buttons", () => {
    expect(read("app/globals.css")).not.toContain("btn--pixel");
    expect(read("app/components/Button.tsx")).not.toContain("pixel");
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

  it("serves recorded run data with no home-directory paths or the pre-rename CLI name", () => {
    for (const f of ["events.jsonl", "data.js", "terminal.log"]) {
      const text = read(`public/replay/${f}`);
      expect(text, f).not.toMatch(/\/Users\/|\/home\/|\.hydra\b|^hydra:/m);
    }
  });

  it("stays chromeless in embed mode", () => {
    expect(html).toMatch(/html\[data-embed\] \.sitenav, html\[data-embed\] \.sitefoot,/);
  });

  it("keeps every element the replay script writes to", () => {
    for (const id of ["status", "elapsed", "cost", "model", "task", "testCmd", "baseline", "tree", "wires", "log", "replayBar"]) {
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
      expect(name, `--${name} is a pre-rename alias`).not.toMatch(/head/);
    }
    expect(RUN_TRANSCRIPT[0]!.text).toContain("--forks 4");
  });
});
