import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND, HOME_ENV, HOSTED_KEY_ENV, brandEnv, legacyEnvInUse } from "../src/brand.js";
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
    expect(BRAND).toMatchObject({ name: "Forkbomb", slug: "forkbomb", ticker: "FORKBOMB" });
    expect(HOSTED_KEY_ENV).toBe("FORKBOMB_API_KEY");
    expect(HOME_ENV).toBe("FORKBOMB_HOME");
  });

  it("reads a new env name first and falls back to the pre-rename one", () => {
    expect(brandEnv(HOSTED_KEY_ENV, {})).toBeUndefined();
    expect(brandEnv(HOSTED_KEY_ENV, { HYDRA_API_KEY: "old" })).toBe("old");
    expect(brandEnv(HOSTED_KEY_ENV, { HYDRA_API_KEY: "old", FORKBOMB_API_KEY: "new" })).toBe("new");
    expect(brandEnv(HOSTED_KEY_ENV, { HYDRA_API_KEY: "old", FORKBOMB_API_KEY: " " })).toBe("old");
  });

  it("names the old env vars still in use, and only those", () => {
    expect(legacyEnvInUse({})).toEqual([]);
    expect(legacyEnvInUse({ HYDRA_API_KEY: "k", HYDRA_HOME: "/x", FORKBOMB_HOME: "/y" })).toEqual(["HYDRA_API_KEY -> FORKBOMB_API_KEY"]);
  });
});

describe("home dir", () => {
  it("defaults to ~/.forkbomb", () => {
    const home = tempDir("home-default");
    expect(resolveHome({}, home)).toEqual({ dir: join(home, ".forkbomb"), legacy: null });
  });

  it("uses an existing ~/.hydra only while ~/.forkbomb doesn't exist, and says to move it", () => {
    const home = tempDir("home-legacy");
    mkdirSync(join(home, ".hydra"));
    expect(resolveHome({}, home)).toEqual({ dir: join(home, ".hydra"), legacy: "using legacy ~/.hydra; move it to ~/.forkbomb" });
    mkdirSync(join(home, ".forkbomb"));
    expect(resolveHome({}, home)).toEqual({ dir: join(home, ".forkbomb"), legacy: null });
  });

  it("honors FORKBOMB_HOME, then the deprecated HYDRA_HOME", () => {
    const home = tempDir("home-env");
    mkdirSync(join(home, ".hydra"));
    expect(resolveHome({ FORKBOMB_HOME: "/a", HYDRA_HOME: "/b" }, home)).toEqual({ dir: "/a", legacy: null });
    expect(resolveHome({ HYDRA_HOME: "/b" }, home)).toEqual({ dir: "/b", legacy: "HYDRA_HOME is deprecated; rename it to FORKBOMB_HOME" });
  });
});

describe("cli", () => {
  it("speaks Forkbomb in its help", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^forkbomb: fork a coding agent/);
    expect(r.out).toContain("forkbomb run [repo]");
    expect(r.out).toContain("--forks N");
    expect(r.out).toContain("~/.forkbomb/.env");
    expect(r.out).toContain("burning $FORKBOMB");
    // The old names show up only in the closing compatibility note (and the site URL until the final domain).
    const [main, compat] = r.out.split("The old --heads");
    expect(compat).toMatch(/HYDRA_\* env names still work/);
    expect(main!.replaceAll(BRAND.site, "<site>")).not.toMatch(/hydra|\bheads?\b|sever|surviv/i);
  });

  it("still accepts the pre-rename --heads flag", async () => {
    const repo = tempDir("brand-repo");
    const r = await cli(["run", repo, "--task", "t", "--test", "true", "--heads", "0"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("forkbomb: --forks must be between 1 and 64");
  });
});
