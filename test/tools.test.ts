import { linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/tools.js";
import { tempDir, writeTree } from "./helpers.js";

function ws(): { w: Workspace; root: string } {
  const root = tempDir("ws");
  writeTree(root, { "src/a.js": "const a = 1;\nconst b = 2;\n", "README.md": "hi\n" });
  mkdirSync(join(root, ".git"));
  const w = new Workspace({ root, tmp: `${root}-tmp`, network: false, gitWrite: false }, { bashTimeoutMs: 10_000, maxOutput: 10_000 });
  return { w, root };
}

describe("workspace paths", () => {
  it("maps /workspace, relative and real absolute paths into the clone", () => {
    const { w, root } = ws();
    expect(w.resolve("/workspace/src/a.js")).toBe(join(root, "src/a.js"));
    expect(w.resolve("src/a.js")).toBe(join(root, "src/a.js"));
    expect(w.resolve(join(root, "src/a.js"))).toBe(join(root, "src/a.js"));
    expect(w.resolve("/workspace")).toBe(root);
  });

  it("rejects escapes", () => {
    const { w } = ws();
    for (const p of ["../x", "/workspace/../x", "/etc/passwd", "src/../../x", ""]) expect(() => w.resolve(p)).toThrow();
  });

  it("rejects .git in any letter case", () => {
    const { w } = ws();
    for (const p of [".git/config", "/workspace/.GIT/config", ".Git"]) expect(() => w.resolve(p)).toThrow(/read-only/);
  });

  it("rejects symlinks that lead outside or into .git", () => {
    const { w, root } = ws();
    const outside = tempDir("outside");
    symlinkSync(outside, join(root, "out"));
    symlinkSync(join(root, ".git"), join(root, "g"));
    symlinkSync(join(outside, "missing"), join(root, "dangling"));
    expect(() => w.resolve("out/file")).toThrow(/escapes/);
    expect(() => w.resolve("g/config")).toThrow(/read-only/);
    expect(() => w.resolve("dangling")).toThrow(/broken symlink|escapes/);
  });

  it("allows symlinks that stay inside", () => {
    const { w, root } = ws();
    symlinkSync(join(root, "src"), join(root, "lib"));
    expect(w.resolve("lib/a.js")).toBe(join(root, "src/a.js"));
  });
});

describe("text editor", () => {
  it("views files with line numbers and ranges", async () => {
    const { w } = ws();
    const all = await w.edit({ command: "view", path: "/workspace/src/a.js" });
    expect(all.text).toContain("     1\tconst a = 1;");
    const one = await w.edit({ command: "view", path: "/workspace/src/a.js", view_range: [2, 2] });
    expect(one.text.trim()).toBe("2\tconst b = 2;");
  });

  it("lists directories without .git", async () => {
    const { w } = ws();
    const r = await w.edit({ command: "view", path: "/workspace" });
    expect(r.text).toContain("/workspace/src/a.js");
    expect(r.text).not.toContain(".git");
  });

  it("str_replace needs exactly one match", async () => {
    const { w, root } = ws();
    expect((await w.edit({ command: "str_replace", path: "src/a.js", old_str: "nope", new_str: "x" })).isError).toBe(true);
    expect((await w.edit({ command: "str_replace", path: "src/a.js", old_str: "const", new_str: "let" })).isError).toBe(true);
    const ok = await w.edit({ command: "str_replace", path: "src/a.js", old_str: "const b = 2;", new_str: "const b = 3; // $& stays literal" });
    expect(ok.isError).toBe(false);
    expect(readFileSync(join(root, "src/a.js"), "utf8")).toContain("const b = 3; // $& stays literal");
  });

  it("creates files and inserts lines", async () => {
    const { w, root } = ws();
    await w.edit({ command: "create", path: "/workspace/new/dir/f.txt", file_text: "one\nthree" });
    await w.edit({ command: "insert", path: "new/dir/f.txt", insert_line: 1, insert_text: "two" });
    expect(readFileSync(join(root, "new/dir/f.txt"), "utf8")).toBe("one\ntwo\nthree");
  });

  it("refuses to write through a hard link planted from outside", async () => {
    const { w, root } = ws();
    const outside = join(tempDir("outside"), "victim.txt");
    writeFileSync(outside, "original");
    linkSync(outside, join(root, "link.txt"));
    const r = await w.edit({ command: "create", path: "link.txt", file_text: "pwned" });
    expect(r.isError).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("original");
  });

  it("returns errors instead of throwing on bad input", async () => {
    const { w } = ws();
    expect((await w.edit({ command: "explode", path: "a" })).isError).toBe(true);
    expect((await w.edit({ command: "view" })).isError).toBe(true);
    expect((await w.edit(null)).isError).toBe(true);
  });
});

describe("bash tool", () => {
  it("runs in the workspace root and reports the exit code", async () => {
    const { w } = ws();
    const r = await w.bash({ command: "cat README.md; exit 3" });
    expect(r.text).toContain("hi");
    expect(r.text).toContain("[exit code 3]");
    expect(r.isError).toBe(true);
  });

  it("handles restart and bad input", async () => {
    const { w } = ws();
    expect((await w.bash({ restart: true })).isError).toBe(false);
    expect((await w.bash({})).isError).toBe(true);
  });
});
