// Element trees of shared server components: legibility and accessibility fixes that live in the markup.
// The components are called as plain functions and their returned trees walked (no renderer, no DOM).

import { describe, expect, it } from "vitest";
import { Marquee, PixelHeading } from "../app/components/Retro";
import { ReplayFrame } from "../app/components/ReplayFrame";
import { monoTicker } from "../app/components/ticker";
import { SITE } from "../app/config";
import { FlagTable, RefTable } from "../app/docs/_parts/Blocks";

type El = { type: unknown; props: Record<string, unknown> };
const isEl = (n: unknown): n is El => !!n && typeof n === "object" && "props" in n && "type" in n;

/** Every host element in a returned tree. Child components are not called (they may use hooks). */
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isEl(node)) {
    out.push(node);
    elements(node.props.children, out);
  }
  return out;
}

/** Text of a tree, with each ticker span marked as [ticker]. */
function text(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  if (isEl(node)) {
    const inner = text(node.props.children);
    return node.props.className === "ticker" ? `[${inner}]` : inner;
  }
  return "";
}

describe("the ticker in pixel type", () => {
  // Regression: Pixelify Sans' B reads as G, so headings and the marquee printed "$FORKGOMG".
  it("is set in mono inside pixel headings and the marquee", () => {
    expect(text(PixelHeading({ size: "xl", children: ["What ", SITE.ticker, " is"] }))).toBe(`What [${SITE.ticker}] is`);
    expect(text(PixelHeading({ children: `Burn ${SITE.ticker}` }))).toBe(`Burn [${SITE.ticker}]`);
    expect(text(Marquee({ items: ["fork()", SITE.ticker], repeat: 1 }))).toContain(`fork()[${SITE.ticker}]`);
    expect(text(PixelHeading({ children: "Burn it." }))).toBe("Burn it.");
  });

  it("keeps the ticker untranslated and leaves everything else untouched", () => {
    const span = elements(monoTicker(`${SITE.ticker} and ${SITE.ticker}`)).filter((e) => e.props.className === "ticker");
    expect(span).toHaveLength(2);
    expect(span[0]!.props.translate).toBe("no");
    expect(monoTicker("no ticker here")).toEqual(["no ticker here"]);
  });
});

describe("home replay frame", () => {
  // Regression: the chromeless embed was an invisible Tab stop between "Open full replay" and the next link.
  it("keeps the embed out of the tab order, and an interactive replay in it", () => {
    const frame = (src?: string) => elements(ReplayFrame(src ? { src } : {})).find((e) => e.type === "iframe")!;
    expect(frame().props.tabIndex).toBe(-1);
    expect(frame("/replay").props.tabIndex).toBeUndefined();
  });
});

describe("docs reference tables", () => {
  const cells = (tree: unknown) => elements(tree).filter((e) => e.type === "td");
  const codes = (tree: unknown) => elements(tree).filter((e) => e.type === "code").map((e) => text(e.props.children));

  // Regression: on phones the doctor table's fix column hid behind a sideways scroll, and "--engine hosted"
  // wrapped after its dashes.
  it("label every cell for the stacked phone layout and keep flags whole", () => {
    const ref = RefTable({ caption: "doctor", head: ["Check", "If it fails"], rows: [["Hosted", "Optional, only for --engine hosted."]] });
    expect(cells(ref).map((c) => c.props["data-label"])).toEqual(["Check", "If it fails"]);
    expect(text(cells(ref)[1])).toBe("Optional, only for --engine hosted.");
    expect(codes(ref)).toEqual(["--engine"]);

    const flags = FlagTable({ caption: "flags", flags: [{ flag: "--forks <n>", def: "4", desc: "Same as --fork-count." }] });
    expect(cells(flags).map((c) => c.props["data-label"])).toEqual(["Flag", "Default", "Description"]);
    expect(codes(flags)).toEqual(["--forks <n>", "--fork-count"]);
  });
});
