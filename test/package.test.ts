import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND } from "../src/brand.js";

const root = process.cwd();
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8")) as Record<string, unknown>;
const pkg = readJson("package.json") as {
  bin: Record<string, string>;
  engines: Record<string, string>;
  os: string[];
  scripts: Record<string, string>;
  repository: { url: string };
  homepage: string;
  bugs: { url: string };
  publishConfig: { access: string };
};

/**
 * What `npm pack` puts in the tarball, from the files on disk. --ignore-scripts skips the prepack build, so dist/
 * is whatever was last built (scripts/check-package.sh packs and installs a real build).
 */
function packed(): string[] {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  const [tarball] = JSON.parse(r.stdout) as { files: { path: string }[] }[];
  return tarball!.files.map((f) => f.path);
}

/** Every file under a repo folder, relative to the repo root. */
function filesIn(dir: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .map((f) => `${dir}/${f}`)
    .filter((f) => statSync(join(root, f)).isFile());
}

describe("npm package", () => {
  it("ships only the built CLI, the clone helper's source, the UI, README and LICENSE", () => {
    const files = packed();
    for (const f of files) expect(f).toMatch(/^(dist\/.+\.js|native\/[^/]+|ui\/[^/]+|README\.md|LICENSE|package\.json)$/);
    expect(files).toEqual(expect.arrayContaining(["README.md", "LICENSE", "package.json"]));
    // Examples, sources, tests, the site and source maps (whose sources aren't shipped) stay out.
    expect(files.filter((f) => /^(examples|src|test|web|docs|ops|scripts)\/|\.map$/.test(f))).toEqual([]);
  });

  it("includes every file the CLI reads from its own folder at runtime", () => {
    const dirs = new Set<string>();
    for (const f of filesIn("src").filter((f) => f.endsWith(".ts"))) {
      for (const line of readFileSync(join(root, f), "utf8").split("\n")) {
        if (!line.includes("PKG_ROOT") || /^import |export const PKG_ROOT/.test(line)) continue;
        // A new way of reaching into the package would slip past this check, so it has to be this one.
        const m = /join\(PKG_ROOT, "([^"]+)"/.exec(line);
        expect(m, `${f}: ${line.trim()}`).not.toBeNull();
        dirs.add(m![1]!);
      }
    }
    expect([...dirs].sort()).toEqual(["native", "ui"]);
    const files = packed();
    for (const dir of dirs) expect(files).toEqual(expect.arrayContaining(filesIn(dir)));
  });

  // scripts/check-package.sh checks that the build's chmod reaches the tarball: an installed copy can't show it,
  // because npm install marks a bin executable whatever its packed mode.
  it("installs a forkbomb bin: the build of src/cli.ts, with a node shebang", () => {
    expect(pkg.bin).toEqual({ [BRAND.slug]: "dist/cli.js" });
    const ts = readJson("tsconfig.json") as { compilerOptions: { rootDir: string; outDir: string } };
    expect(ts.compilerOptions).toMatchObject({ rootDir: "src", outDir: "dist" });
    expect(readFileSync(join(root, "src", "cli.ts"), "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
    // A pack always builds from an empty dist/, so a deleted source file can't leave its old build in the tarball.
    expect(pkg.scripts.prepack).toBe("rm -rf dist && npm run build");
  });

  it("is for macOS on Node 22+, and says where the project lives", () => {
    expect(pkg.os).toEqual(["darwin"]);
    expect(pkg.engines).toEqual({ node: ">=22" });
    expect(pkg.homepage).toBe(BRAND.site);
    expect(pkg.repository.url).toBe("git+https://github.com/plvgger/forkbomb.git");
    expect(pkg.bugs.url).toBe("https://github.com/plvgger/forkbomb/issues");
    expect(pkg.publishConfig.access).toBe("public");
  });
});
