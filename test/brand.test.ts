import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, HOME_ENV, HOSTED_KEY_ENV } from "../src/brand.js";
import { resolveHome } from "../src/util.js";
import { tempDir } from "./helpers.js";

function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), ...args], {
      env: { ...process.env, [HOME_ENV]: tempDir("brand-home"), ...env },
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", (code) => done({ code, out }));
  });
}

describe("brand", () => {
  it("is Forkbomb, and env names follow the slug", () => {
    expect(BRAND).toMatchObject({ name: "Forkbomb", slug: "forkbomb", ticker: "FORKBOMB", site: "https://forkbomb.fun" });
    expect(HOSTED_KEY_ENV).toBe("FORKBOMB_API_KEY");
    expect(HOME_ENV).toBe("FORKBOMB_HOME");
  });
});

describe("home dir", () => {
  it("defaults to ~/.forkbomb", () => {
    const home = tempDir("home-default");
    expect(resolveHome({}, home)).toBe(join(home, ".forkbomb"));
    expect(resolveHome({ FORKBOMB_HOME: "  " }, home)).toBe(join(home, ".forkbomb"));
  });

  it("honors FORKBOMB_HOME", () => {
    expect(resolveHome({ FORKBOMB_HOME: "/a" }, tempDir("home-env"))).toBe("/a");
  });
});

describe("cli", () => {
  it("speaks Forkbomb in its help", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^forkbomb: fork a coding agent/);
    expect(r.out).toContain("forkbomb run [repo]");
    expect(r.out).toContain("--forks N");
    expect(r.out).toContain("--fork-timeout S");
    expect(r.out).toContain("--keep-forks");
    expect(r.out).toContain("~/.forkbomb/.env");
    expect(r.out).toContain("burning $FORKBOMB");
    // Fork vocabulary only: no "heads", no "sever".
    expect(r.out).not.toMatch(/\bheads?\b|\bsever(ed)?\b/i);
  });

  it("lists every flag it parses in --help", async () => {
    const src = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");
    const flags = [...src.matchAll(/[\s{]"?([a-z][a-z-]*)"?: \{ type: "(?:string|boolean)"/g)].map((m) => m[1]!);
    expect(flags.length).toBeGreaterThan(25);
    const help = (await cli(["--help"])).out;
    for (const f of new Set(flags)) expect(help, `--${f}`).toContain(`--${f}`);
  });

  it("checks --forks before starting anything", async () => {
    const repo = tempDir("brand-repo");
    const r = await cli(["run", repo, "--task", "t", "--test", "true", "--forks", "65"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("forkbomb: --forks must be between 1 and 64");
  });
});

describe("export", () => {
  const ev = (o: Record<string, unknown>, t: number) => JSON.stringify({ ...o, t });
  const run = [
    ev({ type: "run_start", runId: "r", task: "t", testCmd: "true", forks: 1, rounds: 1, model: "m", engine: "api", effort: "low", mode: "race", repo: ".", forker: "copy", sandbox: true, network: false }, 1),
    ev({ type: "fork", round: 1, parent: "body", forks: ["1.01"], msEach: [1], workspaceBytes: 0, logicalBytes: 0, physicalBytes: 0, forker: "copy" }, 2),
    ev({ type: "fork_start", fork: "1.01", round: 1, parent: "body", strategy: "surgeon", brief: "b" }, 3),
    ev({ type: "run_end", ok: false, ms: 4, costUsd: null, applied: false, patchPath: null, best: null, bestScore: 0 }, 4),
  ];

  it("writes a static replay of a run", async () => {
    const dir = tempDir("export-ok");
    writeFileSync(join(dir, "events.jsonl"), `${run.join("\n")}\n`);
    const out = join(dir, "site");
    const r = await cli(["export", dir, out]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("exported 4 events");
    expect(readFileSync(join(out, "data.js"), "utf8")).toMatch(/^window\.FORKBOMB_EVENTS = \[/);
    for (const f of ["index.html", "app.js", "style.css", "events.jsonl"]) expect(existsSync(join(out, f)), f).toBe(true);
  });

  it("refuses a log the viewer can't play, and writes nothing", async () => {
    const cases: [string, string][] = [
      [ev({ type: "fork_begin", fork: "1.01" }, 3), 'line 3: unknown event type "fork_begin"'],
      [ev({ type: "fork", round: 1, parent: "body", ids: ["1.01"], msEach: [1] }, 3), "line 3: fork event without forks"],
      ["{not json", "line 3 is not JSON"],
    ];
    for (const [bad, msg] of cases) {
      const dir = tempDir("export-bad");
      writeFileSync(join(dir, "events.jsonl"), `${[run[0], run[1], bad].join("\n")}\n`);
      const out = join(dir, "site");
      const r = await cli(["export", dir, out]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(msg);
      expect(existsSync(out)).toBe(false);
    }
  });
});
