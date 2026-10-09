import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, HOME_ENV, HOSTED_KEY_ENV } from "../src/brand.js";
import { makeRunDir, resolveHome, tildify } from "../src/util.js";
import { fakeClaude, tempDir, writeTree } from "./helpers.js";

const CALC = {
  "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
  "math.js": "export const sum = (a, b) => a - b;\n",
  "math.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./math.js";\ntest("sum", () => assert.equal(sum(2, 3), 5));\n',
};

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
    const r = await cli(["--help"], { [HOME_ENV]: "" });
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

  it("checks every option before the canary, a network call or the run folder (regression)", async () => {
    const home = tempDir("brand-val-home");
    const repo = tempDir("brand-repo");
    const cases: Array<[string[], string]> = [
      [["--max-turns", "0"], "--max-turns must be between 1 and 500"],
      [["--fork-timeout", "5"], "--fork-timeout must be between 10 and 86400"],
      [["--concurrency", "abc"], "--concurrency must be between 1 and 64"],
      [["--runs-dir", join(repo, "runs")], "--runs-dir can't be inside the repo"],
    ];
    for (const [args, msg] of cases) {
      // A Claude Code binary that doesn't exist: reaching the engine checks would say so instead.
      const r = await cli(["run", repo, "--task", "t", "--test", "true", "--claude-bin", "/nonexistent/claude", ...args], { [HOME_ENV]: home });
      expect(r.code, msg).toBe(1);
      expect(r.out, msg).toContain(msg);
    }
    expect(existsSync(join(home, "runs"))).toBe(false);
    expect(existsSync(join(repo, "runs"))).toBe(false);
    const runs = tempDir("brand-runs");
    mkdirSync(join(runs, "proj"));
    const inside = await cli(["run", join(runs, "proj"), "--task", "t", "--test", "true", "--runs-dir", runs], { [HOME_ENV]: home });
    expect(inside.out).toContain("the repo can't be inside the runs folder");
  });

  it("prints one command's help for --help or -h, and never runs the command (regression)", async () => {
    for (const [args, line] of [
      [["run", "--help"], "forkbomb run [repo]"],
      [["run", "-h"], "--max-turns N"],
      [["bench", "--help"], "forkbomb bench [dir]"],
      [["replay", "--help"], "forkbomb replay <run-dir"],
      [["export", "--help"], "forkbomb export <run-dir> <out-dir>"],
      [["credits", "--help"], "forkbomb credits"],
      [["canary", "--help"], "forkbomb canary"],
      [["doctor", "--help"], "forkbomb doctor"],
    ] as Array<[string[], string]>) {
      const r = await cli(args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.out, args.join(" ")).toContain(line);
    }
    expect((await cli(["doctor", "--help"])).out).not.toMatch(/^(ok|FAIL)\s/m);
  });

  it("points at the .env file it really reads when FORKBOMB_HOME moves it (regression)", async () => {
    const home = tempDir("brand-env-home");
    const r = await cli(["credits"], { [HOME_ENV]: home, [HOSTED_KEY_ENV]: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${tildify(home)}/.env`);
    expect(r.out).not.toContain("~/.forkbomb/.env");
    expect((await cli(["--help"], { [HOME_ENV]: home })).out).toContain(`in ${tildify(home)}/.env`);
  });

  it("checks the API key before forking anything, and stops on a rejected one (regression)", async () => {
    const api = createServer((_, res) =>
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })),
    );
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    try {
      const home = tempDir("brand-api-home");
      const repo = tempDir("brand-repo");
      writeTree(repo, CALC);
      const r = await cli(["run", repo, "--task", "t", "--test", "node --test", "--engine", "api"], {
        [HOME_ENV]: home,
        ANTHROPIC_API_KEY: "sk-ant-test-invalid-0000",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.address() as { port: number }).port}`,
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain("the Anthropic API rejected your key (401)");
      expect(existsSync(join(home, "runs"))).toBe(false);
    } finally {
      api.close();
    }
  });

  it("Ctrl-C stops every fork and what it started, records the run as interrupted, cleans up and exits 130 (regression)", async () => {
    const home = tempDir("brand-sigint-home");
    // Claude Code sessions that hang in the middle of a tool call, each with a child process of its own.
    const { bin, log } = fakeClaude({ "*": [{ hang: true }] });
    writeFileSync(join(home, "canary.json"), JSON.stringify({ ok: true, version: "9.9.9 (Claude Code)", checks: [] }));
    const repo = tempDir("brand-repo");
    writeTree(repo, CALC);
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "src", "cli.ts"), "run", repo, "--task", "t", "--test", "node --test", "--forks", "2", "--rounds", "1", "--claude-bin", bin],
      { env: { ...process.env, [HOME_ENV]: home }, detached: true },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
    const hangs = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"hang"')).map((l) => JSON.parse(l) as { hang: number; child: number }) : []);
    for (let i = 0; i < 300 && hangs().length < 2; i++) await new Promise((d) => setTimeout(d, 100));
    expect(hangs(), out).toHaveLength(2);

    process.kill(-child.pid!, "SIGINT"); // what a terminal does on Ctrl-C: the whole foreground group
    const code = await exited;
    expect(code, out).toBe(130);
    await new Promise((d) => setTimeout(d, 200));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (const h of hangs()) {
      expect(alive(h.hang), `session ${h.hang}`).toBe(false);
      expect(alive(h.child), `its child ${h.child}`).toBe(false);
    }
    const [runId] = readdirSync(join(home, "runs"));
    const runDir = join(home, "runs", runId!);
    const last = JSON.parse(readFileSync(join(runDir, "events.jsonl"), "utf8").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ type: "run_end", ok: false, interrupted: true });
    expect(readdirSync(join(runDir, "forks"))).toEqual([]);
    expect(existsSync(join(runDir, "tmp"))).toBe(false);
  });
});

describe("run ids", () => {
  it("gives runs started in the same second folders of their own (regression)", async () => {
    const runs = tempDir("brand-runids");
    const d = new Date(2026, 9, 9, 13, 57, 46);
    const ids = await Promise.all([makeRunDir(runs, d), makeRunDir(runs, d), makeRunDir(runs, d)]);
    expect(ids.sort()).toEqual(["20261009-135746", "20261009-135746-2", "20261009-135746-3"]);
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

  it("takes this machine's paths out of a replay meant to be hosted anywhere (regression)", async () => {
    const dir = tempDir("export-paths");
    const runDir = join(dir, "runs", "20261007-053551");
    mkdirSync(runDir, { recursive: true });
    const lines = [
      ev({ type: "run_start", runId: "r", task: "t", testCmd: "node --test", forks: 1, rounds: 1, model: "m", engine: "api", effort: "low", mode: "race", repo: "/Users/someone/code/calc", forker: "copy", sandbox: true, network: false }, 1),
      ev({ type: "baseline", passed: 4, failed: 10, exitCode: 1, score: 0.28, outputTail: `at ${runDir}/body/calc.test.js:27:39\nfrom /Users/someone/.nvm/node` }, 2),
      ev({ type: "run_end", ok: true, ms: 4, costUsd: null, applied: false, patchPath: `${runDir}/winner.patch`, best: null, bestScore: 1 }, 3),
    ];
    writeFileSync(join(runDir, "events.jsonl"), `${lines.join("\n")}\n`);
    const out = join(dir, "site");
    const r = await cli(["export", runDir, out]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/replaced local paths in 3 fields/);
    for (const f of ["events.jsonl", "data.js"]) {
      const text = readFileSync(join(out, f), "utf8");
      expect(text, f).not.toMatch(/\/Users\/|\/home\//);
      expect(text, f).not.toContain(dir);
    }
    const events = readFileSync(join(out, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events[0].repo).toBe("./calc");
    expect(events[1].outputTail).toBe("at <run>/body/calc.test.js:27:39\nfrom ~/.nvm/node");
    expect(events[2].patchPath).toBe("<run>/winner.patch");
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
