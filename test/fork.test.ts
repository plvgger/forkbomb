import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bench } from "../src/bench.js";
import { ApfsForker, CopyForker, canClone } from "../src/fork/forker.js";
import { tempDir, writeTree } from "./helpers.js";

describe("forkers", () => {
  it("clones a tree with clonefile, and heads are independent", async () => {
    const src = tempDir("src");
    writeTree(src, { "a.txt": "A", "deep/b.txt": "B" });
    const out = tempDir("out");
    expect(await canClone(src, out)).toBe(true);
    const f = await ApfsForker.create();
    const res = await f.fork(src, [join(out, "h1"), join(out, "h2")]);
    expect(res).toHaveLength(2);
    for (const r of res) expect(r.ms).toBeGreaterThanOrEqual(0);
    writeFileSync(join(out, "h1", "a.txt"), "changed");
    expect(readFileSync(join(src, "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(out, "h2", "a.txt"), "utf8")).toBe("A");
    expect(readFileSync(join(out, "h2", "deep/b.txt"), "utf8")).toBe("B");
  });

  it("errors clearly when a destination already exists", async () => {
    const src = tempDir("src");
    const out = tempDir("out");
    const f = await ApfsForker.create();
    await expect(f.fork(src, [out])).rejects.toThrow(/clonefile failed/);
  });

  it("copy forker produces the same tree", async () => {
    const src = tempDir("src");
    writeTree(src, { "a.txt": "A" });
    const out = tempDir("out");
    await new CopyForker().fork(src, [join(out, "h1")]);
    expect(readFileSync(join(out, "h1", "a.txt"), "utf8")).toBe("A");
  });

  it("bench reports clonefile far cheaper on disk than a copy", async () => {
    const src = tempDir("bench-src");
    const big = "x".repeat(1024 * 1024);
    writeTree(src, Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`f${i}.bin`, big])));
    const rows = await bench(src, 4, true);
    const apfs = rows.find((r) => r.forker === "apfs-clonefile")!;
    const copy = rows.find((r) => r.forker === "copy")!;
    expect(apfs.logicalBytes).toBe(copy.logicalBytes);
    expect(copy.physicalBytes).toBeGreaterThan(apfs.physicalBytes);
  });
});
