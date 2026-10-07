import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type SandboxSpec, runSandboxed } from "../src/sandbox.js";
import { tempDir } from "./helpers.js";

function spec(root: string, extra: Partial<SandboxSpec> = {}): SandboxSpec {
  return { root, tmp: join(root, "..", `${root.split("/").pop()}-tmp`), network: false, gitWrite: false, ...extra };
}
const run = (cmd: string, s: SandboxSpec, timeoutMs = 20_000) => runSandboxed(cmd, s, { timeoutMs, maxOutput: 10_000 });

describe("sandbox", () => {
  it("lets a fork write inside its own clone", async () => {
    const root = tempDir("sb");
    const r = await run("echo hello > inside.txt && cat inside.txt", spec(root));
    expect(r.code).toBe(0);
    expect(r.output.trim()).toBe("hello");
  });

  it("blocks writes outside the clone, including a sibling fork", async () => {
    const root = tempDir("sb");
    const sibling = tempDir("sb-sibling");
    const r = await run(`echo pwned > ${JSON.stringify(join(sibling, "x"))}; echo pwned > ../escape.txt; echo done`, spec(root));
    expect(r.output).toMatch(/Operation not permitted/);
    expect(existsSync(join(sibling, "x"))).toBe(false);
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  });

  it("makes .git read-only for forks but not for the judge", async () => {
    const root = tempDir("sb");
    mkdirSync(join(root, ".git"));
    const fork = await run("echo x > .git/config", spec(root));
    expect(fork.code).not.toBe(0);
    expect(existsSync(join(root, ".git", "config"))).toBe(false);
    const judge = await run("echo x > .git/config", spec(root, { gitWrite: true }));
    expect(judge.code).toBe(0);
  });

  it("cuts outbound network but keeps loopback", async () => {
    const root = tempDir("sb");
    const server = createServer((_, res) => res.end("local-ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const out = await run("curl -sS -m 5 https://example.com -o /dev/null && echo NET_OK || echo NET_BLOCKED", spec(root));
      expect(out.output).toContain("NET_BLOCKED");
      const local = await run(`curl -sS -m 5 http://127.0.0.1:${port}/`, spec(root));
      expect(local.output).toContain("local-ok");
    } finally {
      server.close();
    }
  });

  it("does not leak API keys into a fork's environment", async () => {
    const root = tempDir("sb");
    process.env.ANTHROPIC_API_KEY = "sk-test-should-not-leak";
    try {
      const r = await run("env", spec(root));
      expect(r.output).not.toContain("sk-test-should-not-leak");
      expect(r.output).not.toMatch(/ANTHROPIC/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("can't read a sibling fork or anything else under home, but can read its own clone", async () => {
    const root = tempDir("sb");
    const sibling = tempDir("sb-sibling");
    writeFileSync(join(sibling, "secret.txt"), "sibling-data");
    writeFileSync(join(root, "mine.txt"), "own-data");
    const r = await run(`cat mine.txt; cat ${JSON.stringify(join(sibling, "secret.txt"))} 2>&1; ls ~/Desktop >/dev/null 2>&1 && echo LISTED || echo NOLIST`, spec(root));
    expect(r.output).toContain("own-data");
    expect(r.output).not.toContain("sibling-data");
    expect(r.output).toContain("NOLIST");
  });

  it("blocks the system DNS resolver socket", async () => {
    const root = tempDir("sb");
    const r = await run(
      `python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.connect('/var/run/mDNSResponder'); print('CONN' + 'ECTED')" 2>&1 || echo BLOCKED`,
      spec(root),
    );
    expect(r.output).not.toContain("CONNECTED");
  });

  it("still runs real toolchains: node, python, git and a loopback server", async () => {
    const root = tempDir("sb");
    writeFileSync(join(root, "t.test.mjs"), 'import { test } from "node:test";\nimport http from "node:http";\ntest("loop", async () => { const s = http.createServer((q, r) => r.end("ok")); await new Promise((d) => s.listen(0, "127.0.0.1", d)); const res = await fetch(`http://127.0.0.1:${s.address().port}/`); s.close(); if ((await res.text()) !== "ok") throw new Error("bad"); });\n');
    const r = await run("node --test 2>&1 | tail -8; python3 -c 'print(40+2)'; git init -q . && git add -A && echo GIT_OK", spec(root, { gitWrite: true }));
    expect(r.output).toMatch(/pass 1/);
    expect(r.output).toContain("42");
    expect(r.output).toContain("GIT_OK");
  });

  it("denies reads of credential folders", async () => {
    const root = tempDir("sb");
    const r = await run("ls ~/.ssh >/dev/null 2>&1 && echo READ || echo DENIED", spec(root));
    expect(r.output).toContain("DENIED");
  });

  it("kills a command at its timeout, background children included", async () => {
    const root = tempDir("sb");
    const t0 = performance.now();
    const r = await run("(sleep 30; echo late > late.txt) & sleep 30", spec(root), 800);
    expect(r.timedOut).toBe(true);
    expect(performance.now() - t0).toBeLessThan(5000);
    await new Promise((d) => setTimeout(d, 300));
    expect(existsSync(join(root, "late.txt"))).toBe(false);
  });

  it("returns promptly when a command leaves a background process holding the pipe", async () => {
    const root = tempDir("sb");
    const t0 = performance.now();
    const r = await run("sleep 30 & echo started", spec(root), 20_000);
    expect(r.output).toContain("started");
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("caps runaway output", async () => {
    const root = tempDir("sb");
    const r = await runSandboxed("yes forkbomb | head -c 2000000", spec(root), { timeoutMs: 20_000, maxOutput: 5000 });
    expect(r.output.length).toBeLessThan(5200);
    expect(r.output).toMatch(/omitted|dropped/);
  });

  it("aborts on signal", async () => {
    const root = tempDir("sb");
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const r = await runSandboxed("sleep 30", spec(root), { timeoutMs: 20_000, maxOutput: 1000, signal: ctl.signal });
    expect(r.aborted).toBe(true);
  });

  it("handles paths with spaces and quotes", async () => {
    const root = tempDir('sb with "quotes" and spaces');
    writeFileSync(join(root, "a.txt"), "x");
    const r = await run("echo y >> a.txt && cat a.txt", spec(root));
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("xy\n");
  });
});
