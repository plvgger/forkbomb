import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventLog } from "../src/events.js";

describe("forkbomb.fun", () => {
  it("states a true floor for the CLI suite's size", () => {
    const config = readFileSync(join(process.cwd(), "web", "app", "config.ts"), "utf8");
    const stated = Number(/^export const TEST_COUNT = (\d+);/m.exec(config)?.[1]);
    // A fresh `vitest list` of this suite, outside the running worker.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST")));
    const r = spawnSync(process.execPath, [join("node_modules", "vitest", "vitest.mjs"), "list", "--json"], {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const tests = JSON.parse(r.stdout) as unknown[];
    expect(tests.length).toBeGreaterThan(50);
    // Shown as "<TEST_COUNT>+": never more than the suite has, a round number, and raised once the suite outgrows it.
    expect(stated % 10, "web/app/config.ts TEST_COUNT is a round floor").toBe(0);
    expect(tests.length, "web/app/config.ts TEST_COUNT").toBeGreaterThanOrEqual(stated);
    expect(tests.length - stated, "raise web/app/config.ts TEST_COUNT").toBeLessThan(50);
  });
});

describe("README", () => {
  it("shows only images that are in the repo", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    const refs = [
      ...[...readme.matchAll(/\bsrc="([^"]+)"/g)].map((m) => m[1]!),
      ...[...readme.matchAll(/\bsrcset="([^"]+)"/g)].flatMap((m) => m[1]!.split(",").map((s) => s.trim().split(/\s+/)[0]!)),
      ...[...readme.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]!),
    ];
    const local = refs.filter((r) => !/^[a-z]+:/i.test(r));
    expect(local).toContain("docs/assets/demo.gif"); // the hero
    for (const r of local) expect(existsSync(join(process.cwd(), r)), r).toBe(true);
  });
});

describe("published run logs", () => {
  const load = (p: string) => parseEventLog(readFileSync(join(process.cwd(), p), "utf8"));

  it("parse in the current schema and carry no local paths", () => {
    for (const p of ["web/public/replay/events.jsonl", "docs/runs/20261007-015122/events.jsonl"]) {
      expect(readFileSync(join(process.cwd(), p), "utf8"), p).not.toMatch(/\/Users\/|\/home\//);
      expect(load(p).length, p).toBeGreaterThan(20);
    }
  });

  it("back the hosted race the README cites", () => {
    const ev = load("docs/runs/20261007-015122/events.jsonl");
    const start = ev.find((e) => e.type === "run_start");
    const winner = ev.find((e) => e.type === "winner");
    const judge = ev.find((e) => e.type === "judge" && e.score === 1);
    const end = ev.find((e) => e.type === "run_end");
    expect(start).toMatchObject({ engine: "hosted", forks: 4, mode: "race", repo: "./examples/calc" });
    expect(winner).toMatchObject({ fork: "1.03", diffLines: 92, filesChanged: 1 });
    expect(judge).toMatchObject({ fork: "1.03", passed: 14, failed: 0 });
    expect(ev.filter((e) => e.type === "kill")).toHaveLength(3);
    expect(end?.type === "run_end" && end.costUsd?.toFixed(2)).toBe("0.06");
    expect(end?.type === "run_end" && Math.round(end.ms / 1000)).toBe(273); // 4 min 33 s
    expect(readFileSync(join(process.cwd(), "docs/runs/20261007-015122/winner.patch"), "utf8")).toBe(winner?.type === "winner" ? winner.patch : "");
  });
});
