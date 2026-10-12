import assert from "node:assert";
import { Script } from "node:vm";
import { globToRegExp, matchesAny } from "./util.js";

/**
 * The tamper guard. Protected files keep a fork from editing the tests, but the code under test runs inside
 * the test process, so a source file the tests import can still switch the tests off: replace assert.equal,
 * redefine the runner's globals, mock the assertion library, or exit 0 before a test runs. The guard reads the
 * lines a fork's patch adds to JavaScript and TypeScript sources and flags those forms. It is static and
 * deliberately narrow: ordinary use of an assertion library, a project's own test helpers and code that only
 * imports one are not flagged. probeScript() adds a run-time check for node:test suites.
 */

/** One thing in a fork's patch that changes how the tests judge rather than what they test. */
export interface TamperHit {
  /** Repo-relative path of the patched file (several, comma-separated, for a probe hit). */
  file: string;
  /** Line in the patched file; null when the run-time probe found it. */
  line: number | null;
  /** What the added code does, in a few words. */
  why: string;
}

/** The sources the guard reads, as git pathspecs. */
export const GUARDED_SOURCES = ["*.js", "*.mjs", "*.cjs", "*.jsx", "*.ts", "*.mts", "*.cts", "*.tsx"];
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Test code, where mocks and runner globals are normal. The guard reads only the code under test. */
const TEST_CODE = ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**", "**/__mocks__/**", "**/vitest.setup.*", "**/jest.setup.*", "**/setupTests.*"].map(globToRegExp);

const ASSERT_SPEC = /^(?:node:)?assert(?:\/strict)?$/;
/** What node:assert exports. Assigning a new name next to these (a project's own helper) replaces nothing. */
const ASSERT_API = new Set([...Object.keys(assert), "default"]);
const NODE_TEST_API = new Set(["test", "it", "describe", "suite", "before", "after", "beforeEach", "afterEach", "mock", "only", "skip", "todo", "run", "snapshot", "assert", "expectFailure", "default"]);
/** Other assertion and test libraries: any member a source file assigns on them counts, except their config. */
const OTHER_LIBS = new Set(["vitest", "@vitest/expect", "@vitest/runner", "@jest/globals", "@jest/expect", "expect", "chai", "should", "power-assert", "uvu", "uvu/assert", "ava", "tap", "tape", "mocha"]);
const LOADER_SPEC = /^(?:node:)?module$/;

/** Names the test runners put on the global object. */
const RUNNER_GLOBALS = "expect|test|it|describe|suite|before|after|beforeEach|afterEach|beforeAll|afterAll|fit|fdescribe|xit|xdescribe|xtest|vi|jest|chai|assert|AssertionError|Error";
/** jest's and vitest's built-in matchers: expect.extend with one of these names replaces it. */
const BUILTIN_MATCHERS = new Set(
  "toBe toEqual toStrictEqual toBeTruthy toBeFalsy toBeNull toBeUndefined toBeDefined toBeNaN toBeTypeOf toBeInstanceOf toBeCloseTo toBeGreaterThan toBeGreaterThanOrEqual toBeLessThan toBeLessThanOrEqual toContain toContainEqual toHaveLength toHaveProperty toMatch toMatchObject toThrow toThrowError toSatisfy toBeOneOf toHaveBeenCalled toHaveBeenCalledTimes toHaveBeenCalledWith toHaveBeenLastCalledWith toHaveBeenNthCalledWith toHaveReturned toHaveReturnedTimes toHaveReturnedWith toHaveLastReturnedWith toHaveNthReturnedWith toHaveResolved toHaveResolvedWith toMatchSnapshot toMatchInlineSnapshot toMatchFileSnapshot toThrowErrorMatchingSnapshot toThrowErrorMatchingInlineSnapshot".split(" "),
);
/** Code that asks whether it is running under a test runner. */
const TEST_ENV =
  /\b(?:NODE_TEST_CONTEXT|VITEST(?:_WORKER_ID|_POOL_ID)?|JEST_WORKER_ID|__vitest_worker__)\b|\bNODE_ENV\b[^;\n]{0,40}["'`]test["'`]|["'`]test["'`]\s*[!=]==?\s*process\s*\.\s*env\s*\.\s*NODE_ENV|\bnpm_lifecycle_event\b|\btypeof\s+(?:describe|it|test|expect|jest|vi)\b|\bprocess\s*\.\s*(?:argv|execArgv)\b[^;\n]{0,80}(?:--test|vitest|jest|\.test\.|\.spec\.)/g;

interface Binding {
  /** The local name, or "" for an inline `require("assert")`. */
  name: string;
  spec: string;
  /** Members that count when replaced; null when every member does. */
  api: Set<string> | null;
  exempt: Set<string>;
  /** jest's or vitest's expect. */
  expect: boolean;
  /** Where the function the name is bound in opens; -1 for the module. */
  scope: number;
}

function binding(name: string, spec: string, member: string | null, scope: number): Binding | null {
  const whole = member === null || member === "default" || member === "strict";
  const expect = member === "expect" || (spec === "expect" && whole);
  if (ASSERT_SPEC.test(spec)) return { name, spec, api: whole ? ASSERT_API : null, exempt: new Set(), expect, scope };
  if (spec === "node:test") return { name, spec, api: whole ? NODE_TEST_API : null, exempt: new Set(), expect, scope };
  if (OTHER_LIBS.has(spec)) return { name, spec, api: null, exempt: new Set(["config"]), expect, scope };
  return null;
}

const isAssertionLib = (spec: string) => binding("", spec, null, -1) !== null;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------------------------------------
// A small JavaScript/TypeScript lexer: enough to skip comments, strings, templates and regexes, and to tell
// module top-level code (runs on import) from function bodies (runs when called).

export type Kind = "top" | "fn" | "arrow" | "block" | "obj" | "class" | "paren" | "brack" | "tpl";
interface Frame {
  kind: Kind;
  /** Where the frame's contents begin. */
  open: number;
  /** Where the current statement in this frame started; in a list (arguments, an array, an object), the current item. */
  stmt: number;
  /** For a paren: the word before it (`if`, a function's name). */
  owner: string;
  /** A `{` read after `): `, which may be an object return type rather than the body. */
  typed?: boolean;
  /** Ternary `?`s in this frame still waiting for their `:`. */
  qs?: number[];
}

/** Words whose `(...)` is followed by a block, not a function body. */
const BLOCK_HEAD = new Set(["if", "for", "while", "switch", "catch", "with", "await"]);
/** Words after which `/` starts a regex rather than a division. */
const BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);
/** Words that leave a statement open across a line break. */
const OPEN_WORDS = new Set([...BEFORE_REGEX, "export", "import", "const", "let", "var", "function", "class", "extends", "async", "static"]);
const STATEMENTS = new Set<Kind>(["top", "fn", "block", "class"]);

export interface Lexed {
  /** The source with comments blanked out; every offset is unchanged. */
  code: string;
  /** 1 where a character is part of a string, template or regex literal. */
  literal: Uint8Array;
  /** Where the statement around each character starts, within its function or the module. */
  stmt: Int32Array;
  /**
   * Where the innermost function around each character opens; -1 at module level. Anything at 0 or above is
   * inside a function body or an arrow function: code that runs when called, not on import.
   */
  scope: Int32Array;
  /** Where the innermost expression around each character starts: its statement, or its item in a list. */
  expr: Int32Array;
  /** Where the innermost frame (brackets or an arrow function's body) around each character opens; -1 at module level. */
  frame: Int32Array;
  /** What each frame is, by the offset it opens at. */
  kinds: Map<number, Kind>;
  /** Each bracket's partner, both ways. */
  pairs: Map<number, number>;
  /** The top-level commas in each parenthesis, array or object literal, by the offset it opens at. */
  commas: Map<number, number[]>;
  /** The `?` each ternary `:` belongs to. */
  ternary: Map<number, number>;
  /** Where each function, by the offset it opens at, closes. */
  ends: Map<number, number>;
}

const isWordCode = (k: number) => (k >= 48 && k <= 57) || (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || k === 36 || k === 95 || k >= 128;
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

/** Lex one source file. Built to be wrong safely: a construct it misreads stays inside one line or one frame. */
export function lex(text: string): Lexed {
  const n = text.length;
  const literal = new Uint8Array(n);
  const stmt = new Int32Array(n);
  const scope = new Int32Array(n);
  const expr = new Int32Array(n);
  const frame = new Int32Array(n);
  const kinds = new Map<number, Kind>();
  const pairs = new Map<number, number>();
  const commas = new Map<number, number[]>();
  const ternary = new Map<number, number>();
  const ends = new Map<number, number>();
  const comments: Array<[number, number]> = [];
  const frames: Frame[] = [{ kind: "top", open: -1, stmt: 0, owner: "" }];
  const fns: number[] = [0];
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tpl" | "re" = "code";
  let start = 0; // where the current comment or word began
  let word = false;
  let escaped = false;
  let reClass = false;
  let tplOpen = false;
  let prev = ""; // last significant character
  let prevWord = ""; // the last token, when it was a word
  let lastOwner = ""; // owner of the paren closed most recently
  let arrow = false; // just read `=>`
  let arrowBrace = false; // the `{` after `=>`
  let classHead = false; // between `class` and its body
  let typedFn = false; // `): Type` after a parameter list, before the body
  let afterTyped = false; // just closed a `{ ... }` return type; a `{` next is the body
  let blankTo = -1; // the end of the run of white space a line break last looked across
  let pos = 0;

  const top = () => frames[frames.length - 1]!;
  const push = (kind: Kind, at: number, owner = "") => {
    frames.push({ kind, open: at, stmt: at, owner });
    kinds.set(at, kind);
    if (kind === "fn" || kind === "arrow") fns.push(frames.length - 1);
  };
  const pop = (): Frame => {
    if (frames.length === 1) return frames[0]!;
    const f = frames.pop()!;
    if (fns[fns.length - 1] === frames.length) {
      fns.pop();
      ends.set(f.open, pos);
    }
    return f;
  };
  const popArrows = () => {
    while (top().kind === "arrow") pop();
  };
  const endStatement = (at: number) => {
    popArrows();
    const f = top();
    if (STATEMENTS.has(f.kind)) {
      f.stmt = at;
      f.qs = undefined;
    }
  };
  /** Close the nearest frame of these kinds, if it is near the top: a stray bracket shouldn't unwind the file. */
  const close = (want: Kind[]): Frame | null => {
    popArrows();
    for (let d = frames.length - 1; d >= Math.max(1, frames.length - 3); d--) {
      if (!want.includes(frames[d]!.kind)) continue;
      let f = frames[d]!;
      while (frames.length > d) f = pop();
      if (f.kind !== "tpl") {
        pairs.set(f.open - 1, pos);
        pairs.set(pos, f.open - 1);
      }
      return f;
    }
    return null;
  };
  const endWord = (i: number) => {
    word = false;
    prevWord = text.slice(start, i);
    prev = text[i - 1]!;
    if (prevWord === "class") classHead = true;
  };
  // A line break ends the statement unless the line stops mid-expression or the next line continues it.
  const newline = (i: number) => {
    const f = top();
    if (!STATEMENTS.has(f.kind) && f.kind !== "arrow") return;
    if (!prev || arrow || "([{,.=+-*/%&|^!~?:<>".includes(prev)) return;
    if (prev === ")" && BLOCK_HEAD.has(lastOwner)) return;
    if (prevWord && OPEN_WORDS.has(prevWord)) return;
    // Every line break in one run of blank lines reaches the same answer; look across the run once.
    if (i < blankTo) return;
    let j = i + 1;
    while (j < n && isSpace(text[j]!)) j++;
    blankTo = j;
    if (j < n && ".?:,)]}+-*%&|^=<>[(`".includes(text[j]!)) return;
    endStatement(j);
  };

  for (let i = 0; i < n; i++) {
    const c = text[i]!;
    pos = i;
    if (mode === "code" && arrow && !isSpace(c) && !(c === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))) {
      arrow = false;
      if (c === "{") arrowBrace = true;
      else push("arrow", i);
    }
    const fn = frames[fns[fns.length - 1]!]!;
    const inner = top();
    stmt[i] = fn.stmt;
    scope[i] = fn.open;
    expr[i] = inner.stmt;
    frame[i] = inner.open;

    switch (mode) {
      case "line":
        if (c === "\n") {
          comments.push([start, i]);
          mode = "code";
          newline(i);
        }
        continue;
      case "block":
        if (c === "/" && text[i - 1] === "*" && i - 1 >= start + 2) {
          comments.push([start, i + 1]);
          mode = "code";
        }
        continue;
      case "sq":
      case "dq":
      case "re":
        literal[i] = 1;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === "\n") {
          // An unclosed quote or regex (an apostrophe or `</tag>` in JSX text, say) ends with its line.
          literal[i] = 0;
          mode = "code";
          prev = "0";
          prevWord = "";
          newline(i);
        } else if (mode === "re") {
          if (c === "[") reClass = true;
          else if (c === "]") reClass = false;
          else if (c === "/" && !reClass) {
            mode = "code";
            prev = "0";
            prevWord = "";
          }
        } else if (c === (mode === "sq" ? "'" : '"')) {
          mode = "code";
          prev = c;
          prevWord = "";
        }
        continue;
      case "tpl":
        literal[i] = 1;
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (tplOpen) {
          tplOpen = false;
          push("tpl", i + 1);
          mode = "code";
          prev = "{";
          prevWord = "";
        } else if (c === "`") {
          mode = "code";
          prev = c;
          prevWord = "";
        } else if (c === "$" && text[i + 1] === "{") tplOpen = true;
        continue;
    }

    if (isWordCode(c.charCodeAt(0))) {
      if (!word) {
        word = true;
        start = i;
        afterTyped = false;
      }
      continue;
    }
    if (word) endWord(i);
    if (c === "\n") {
      newline(i);
      continue;
    }
    if (isSpace(c)) continue;
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      mode = text[i + 1] === "/" ? "line" : "block";
      start = i;
      continue;
    }
    if (c === "#" && i === 0 && text[1] === "!") {
      mode = "line";
      start = i;
      continue;
    }
    const sig = prev;
    const sigWord = prevWord;
    const bodyNext = afterTyped;
    prev = c;
    prevWord = "";
    afterTyped = false;
    switch (c) {
      case "'":
      case '"':
      case "`":
        mode = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
        literal[i] = 1;
        break;
      case "/":
        if (!sig || "(,=:[!&|?{};+-*%<>~^".includes(sig) || BEFORE_REGEX.has(sigWord)) {
          mode = "re";
          reClass = false;
          literal[i] = 1;
        }
        break;
      case "{": {
        let kind: Kind = "obj";
        if (classHead) kind = "class";
        else if (arrowBrace || bodyNext) kind = "fn";
        else if (sig === ")") kind = BLOCK_HEAD.has(lastOwner) ? "block" : "fn";
        else if (typedFn) kind = "fn";
        else if (["else", "try", "finally", "do", "static"].includes(sigWord)) kind = "block";
        else if (!sig || sig === ";" || sig === "{" || sig === "}") kind = "block";
        push(kind, i + 1);
        if (typedFn && kind === "fn" && !arrowBrace) top().typed = true;
        classHead = typedFn = arrowBrace = false;
        break;
      }
      case "}": {
        const f = close(["fn", "block", "obj", "class", "tpl"]);
        if (f?.kind === "tpl") {
          mode = "tpl";
          literal[i] = 1;
        } else if (f?.kind === "block") endStatement(i + 1);
        afterTyped = !!f?.typed;
        break;
      }
      case "(":
        push("paren", i + 1, sigWord);
        break;
      case ")":
        lastOwner = close(["paren"])?.owner ?? "";
        break;
      case "[":
        push("brack", i + 1);
        break;
      case "]":
        close(["brack"]);
        break;
      case ";":
        classHead = typedFn = false;
        endStatement(i + 1);
        break;
      case ",": {
        typedFn = false;
        popArrows();
        const f = top();
        f.qs = undefined;
        if (f.kind === "paren" || f.kind === "brack" || f.kind === "obj") {
          f.stmt = i + 1;
          const list = commas.get(f.open);
          if (list) list.push(i);
          else commas.set(f.open, [i]);
        }
        break;
      }
      case "?":
        // Not `??`, `??=` or `?.` (but `a ?.5 : b` is a ternary).
        if (text[i + 1] === "?" || text[i - 1] === "?" || (text[i + 1] === "." && !/[0-9]/.test(text[i + 2] ?? ""))) break;
        (top().qs ??= []).push(i);
        break;
      case ":": {
        const q = top().qs?.pop();
        if (q !== undefined) ternary.set(i, q);
        else if (sig === ")" && !BLOCK_HEAD.has(lastOwner)) typedFn = true;
        break;
      }
      case "=":
        typedFn = false;
        break;
      case ">":
        if (sig === "=" && text[i - 1] === "=") arrow = true;
        break;
    }
  }
  if (mode === "line" || mode === "block") comments.push([start, n]);
  for (const f of frames) if (f.kind === "fn" || f.kind === "arrow") ends.set(f.open, n);

  let code = "";
  let last = 0;
  for (const [s, e] of comments) {
    code += text.slice(last, s) + text.slice(s, e).replace(/[^\n]/g, " ");
    last = e;
  }
  code += text.slice(last);
  return { code, literal, stmt, scope, expr, frame, kinds, pairs, commas, ternary, ends };
}

// ---------------------------------------------------------------------------------------------------------
// The rules.

/** The last non-blank character of `code` before `i`, or -1. Comments are already blank. */
function before(code: string, i: number): number {
  let j = i - 1;
  while (j >= 0 && isSpace(code[j]!)) j--;
  return j;
}

/**
 * The argument spans of the call whose `(` is at `open`, and where it closes. The lexer has already paired the
 * brackets and found the commas, so this costs the number of arguments, not the length of the call.
 */
function callArgs(lx: Lexed, open: number): { args: Array<[number, number]>; end: number } {
  const close = lx.pairs.get(open);
  if (close === undefined) return { args: [], end: open + 1 };
  const cuts = [open, ...(lx.commas.get(open + 1) ?? []), close];
  const args: Array<[number, number]> = [];
  for (let k = 0; k + 1 < cuts.length; k++) args.push([cuts[k]! + 1, cuts[k + 1]!]);
  // `f()` and a trailing comma leave an empty last argument.
  const last = args[args.length - 1]!;
  if (before(lx.code, last[1]) < last[0]) args.pop();
  return { args, end: close + 1 };
}

/** The value of a string literal argument, or null for anything else. */
function stringArg(lx: Lexed, span: [number, number] | undefined): string | null {
  if (!span || span[1] - span[0] > 1000) return null;
  const m = /^\s*(["'`])([^"'`\n]*)\1\s*$/.exec(lx.code.slice(span[0], span[1]));
  return m ? m[2]! : null;
}

const KEY = /^(?:\.\.\.|(?:(?:async|get|set|static)\s+(?!\(|:|,))?\*?\s*(?:(["'`])([^"'`\n]*)\1|([\w$]+)))/;

/** The keys of an object literal argument, or null when it isn't one or a key can't be read (a spread, `[k]`). */
function objectKeys(lx: Lexed, span: [number, number] | undefined): string[] | null {
  if (!span) return null;
  const { code } = lx;
  let i = span[0];
  while (i < span[1] && isSpace(code[i]!)) i++;
  const close = code[i] === "{" ? lx.pairs.get(i) : undefined;
  if (close === undefined || close >= span[1]) return null;
  const keys: string[] = [];
  for (const from of [i, ...(lx.commas.get(i + 1) ?? [])]) {
    let k = from + 1;
    while (k < close && isSpace(code[k]!)) k++;
    if (k >= close) continue;
    const m = KEY.exec(code.slice(k, k + 200));
    if (!m || m[0] === "...") return null;
    keys.push(m[2] ?? m[3]!);
  }
  return keys;
}

/** One `[...]` member access on one line. No `[` inside, so a run of `[[[[` costs one pass, not one per bracket. */
const INDEX = String.raw`\s*\[[^[\]\n]*\]`;
const MEMBERS = String.raw`((?:\s*\??\.\s*[\w$#]+|${INDEX})+)`;
const ASSIGN = String.raw`\s*(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])`;
const QUOTED = String.raw`["'\`][^"'\`\n]+["'\`]`;
const GLOBAL_OBJECT = String.raw`(?<![\w$.])(?:globalThis|global|window|self)`;

/** The first member a chain like `.equal.x` or `["equal"]` reaches, or null when it is computed. */
function firstMember(chain: string): string | null {
  const m = /^\s*\??\.\s*([\w$#]+)|^\s*\[\s*(["'`])([^"'`]*)\2\s*\]/.exec(chain);
  return m ? (m[1] ?? m[3] ?? null) : null;
}

const touches = (b: Binding, member: string | null) => (member === null ? true : !b.exempt.has(member) && (b.api === null || b.api.has(member)));
const tidy = (s: string) => s.replace(/\s+/g, "");
const shown = (b: Binding, chain: string) => (b.name ? `${b.name}${tidy(chain)}` : tidy(chain).replace(/^\??\./, ""));

/** Every tamper hit in one patched source file. `added[k]` says whether line k (0-based) is one the patch adds. */
export function scanSource(file: string, text: string, added: boolean[], lineNos?: number[]): TamperHit[] {
  if (!added.some(Boolean)) return [];
  const lx = lex(text);
  const { code, literal } = lx;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const lineAt = (off: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  // The first added line at or after each line.
  const nextAdded = new Int32Array(starts.length + 1).fill(starts.length);
  for (let k = starts.length - 1; k >= 0; k--) nextAdded[k] = added[k] ? k : nextAdded[k + 1]!;
  const hits = new Map<number, TamperHit>();
  /** Record a hit on the first added line in [s, e): code the patch didn't add is never flagged. */
  const report = (s: number, e: number, why: string) => {
    const k = nextAdded[lineAt(s)]!;
    if (k > lineAt(Math.max(s, e - 1))) return;
    const line = lineNos?.[k] ?? k + 1;
    if (!hits.has(line)) hits.set(line, { file, line, why });
  };
  const find = (re: RegExp, fn: (m: RegExpExecArray, at: number) => void) => {
    for (const m of code.matchAll(re)) if (!literal[m.index]) fn(m, m.index);
  };
  const addedCode = code.split("\n").filter((_, k) => added[k]).join("\n");

  // Which local names are assertion libraries, test runners or the module loader. A name bound inside a
  // function counts only inside that function, so a bundle that reuses `data` elsewhere isn't misread.
  const libs: Binding[] = [];
  const loader = new Set<string>();
  /** Local names for node:module's `register`. */
  const registers = new Set<string>();
  /** Every name the file imports or requires, from any module. */
  const imported = new Set<string>();
  // By name, then by the function it is bound in (-1 for the module). A lookup walks out through the functions
  // around the use, innermost first: the parent of a function opened at s is the one around offset s - 1.
  const scoped = new Map<string, Map<number, Binding>>();
  const add = (b: Binding) => {
    libs.push(b);
    const byScope = scoped.get(b.name) ?? new Map<number, Binding>();
    scoped.set(b.name, byScope.set(b.scope, b));
  };
  const lookup = (name: string, at: number): Binding | null => {
    const byScope = scoped.get(name);
    if (!byScope) return null;
    for (let s = lx.scope[at]!; ; s = s > 0 ? lx.scope[s - 1]! : -1) {
      const b = byScope.get(s);
      if (b || s < 0) return b ?? null;
    }
  };
  const bind = (lhs: string, spec: string, member: string | null, at: number) => {
    const entries: Array<[string, string | null]> = [];
    if (lhs.startsWith("{")) {
      for (const part of lhs.slice(1, -1).split(",")) {
        const m = /^\s*(?:type\s+)?([\w$]+)(?:\s*(?::|\bas\b)\s*([\w$]+))?/.exec(part);
        if (m) entries.push([m[2] ?? m[1]!, m[1]!]);
      }
    } else entries.push([lhs, member]);
    for (const [local, key] of entries) {
      imported.add(local);
      if (LOADER_SPEC.test(spec)) {
        if (key === null || key === "default" || key === "Module") loader.add(local);
        else if (key === "register") registers.add(local);
        continue;
      }
      const b = binding(local, spec, key, lx.scope[at]!);
      if (b) add(b);
    }
  };
  // `{[^{}]*}`, not `{[^}]*}`: an unclosed `{` then stops at the next one instead of reading to the end of the file.
  find(/\bimport\s+(?!type\b)([\w$]+\s*,\s*)?(\*\s*as\s+[\w$]+|\{[^{}]*\}|[\w$]+)\s*from\s*(["'])([^"'\n]+)\3/g, (m, at) => {
    if (m[1]) bind(m[1].replace(/[\s,]/g, ""), m[4]!, null, at);
    bind(m[2]!.replace(/^\*\s*as\s+/, ""), m[4]!, null, at);
  });
  find(new RegExp(String.raw`\b(?:const|let|var|import)\s+([\w$]+|\{[^{}]*\})\s*=\s*(?:require\s*\(\s*(${QUOTED})\s*\)|\(?\s*(?:await\s+)?import\s*\(\s*(${QUOTED})\s*\)\s*\)?)((?:\s*\.\s*[\w$]+)*)`, "g"), (m, at) => {
    const chain = tidy(m[4] ?? "").split(".").filter(Boolean);
    bind(m[1]!, (m[2] ?? m[3]!).slice(1, -1), chain.length ? chain[chain.length - 1]! : null, at);
  });
  // Aliases: `const a = assert`, `const s = assert.strict`.
  for (let pass = 0; pass < 2; pass++) {
    find(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*([\w$]+)((?:\s*\.\s*[\w$]+)*)\s*(?=[;,)\n]|$)/g, (m, at) => {
      const src = lookup(m[2]!, at);
      if (!src || lookup(m[1]!, at)) return;
      const chain = tidy(m[3] ?? "").split(".").filter(Boolean);
      const whole = chain.every((p) => p === "strict" || p === "default");
      add({ ...src, name: m[1]!, api: whole ? src.api : null, expect: src.expect && whole, scope: lx.scope[at]! });
    });
  }
  // jest's and vitest's globals, when the file uses them without declaring or importing the name.
  for (const g of ["expect", "vi", "jest"]) {
    if (imported.has(g) || libs.some((b) => b.name === g)) continue;
    if (new RegExp(String.raw`\b(?:const|let|var|function|class)\s+${g}\b|[(,]\s*${g}\s*[,)=]|\b${g}\s*=>`).test(code)) continue;
    add({ name: g, spec: "the test runner's global", api: null, exempt: new Set(), expect: g === "expect", scope: -1 });
  }

  const names = [...new Set(libs.map((b) => escape(b.name)))];
  const target = String.raw`(?<![\w$.])(?<!\btypeof\s+)(${[...names, String.raw`require\s*\(\s*${QUOTED}\s*\)`, String.raw`\(\s*await\s+import\s*\(\s*${QUOTED}\s*\)\s*\)`].join("|")})`;
  const resolve = (t: string, at: number): Binding | null => {
    const spec = /^(?:require|\()/.test(t) ? /["'`]([^"'`]+)["'`]/.exec(t)?.[1] : undefined;
    return spec ? binding("", spec, null, -1) : lookup(t, at);
  };
  const from = (b: Binding) => (b.spec.startsWith("the ") ? `on ${b.spec}` : `from ${b.spec}`);
  /** `assert.equal from node:assert`; `members of …` for an unknown key; no key for the object itself. */
  const member = (b: Binding, chain: string, key: string | null | undefined) => {
    const obj = shown(b, chain);
    if (key === undefined) return obj ? `${obj} ${from(b)}` : b.spec;
    if (key === null) return obj ? `members of ${obj} ${from(b)}` : `members of ${b.spec}`;
    return `${shown(b, `${chain}.${key}`)} ${from(b)}`;
  };

  // Assigning, deleting or stubbing a member of an assertion library.
  find(new RegExp(target + MEMBERS + ASSIGN, "g"), (m, at) => {
    const b = resolve(m[1]!, at);
    if (b && touches(b, firstMember(m[2]!))) report(at, at + m[0].length, `replaces ${shown(b, m[2]!)} ${from(b)}`);
  });
  find(new RegExp(String.raw`\bdelete\s+` + target + MEMBERS, "g"), (m, at) => {
    const b = resolve(m[1]!, at);
    if (b && touches(b, firstMember(m[2]!))) report(at, at + m[0].length, `deletes ${shown(b, m[2]!)} ${from(b)}`);
  });
  find(new RegExp(String.raw`\b(Object|Reflect)\s*\.\s*(assign|defineProperty|defineProperties|setPrototypeOf|set|deleteProperty)\s*\(\s*` + target + String.raw`((?:\s*\??\.\s*[\w$#]+)*)\s*(?=[,)])`, "g"), (m, at) => {
    const b = resolve(m[3]!, at);
    const via = firstMember(m[4] ?? "");
    if (!b || (via !== null && b.exempt.has(via))) return;
    const how = `${m[1]}.${m[2]}`;
    const { args, end } = callArgs(lx, at + m[0].indexOf("("));
    if (m[2] === "setPrototypeOf") return report(at, end, `replaces the prototype of ${member(b, m[4] ?? "", undefined)} (${how})`);
    let keys: Array<string | null>;
    if (m[2] === "assign" || m[2] === "defineProperties") {
      keys = args.slice(1).flatMap((a) => objectKeys(lx, a) ?? [null]);
    } else keys = [stringArg(lx, args[1])];
    const key = keys.find((k) => touches(b, k));
    if (key !== undefined) report(at, end, `replaces ${member(b, m[4] ?? "", key)} (${how})`);
  });
  find(new RegExp(String.raw`(\b(?:vi|jest)\s*\.\s*spyOn|\bmock\s*\.\s*method|\bsinon\s*\.\s*(?:stub|spy|replace))\s*\(\s*` + target + String.raw`((?:\s*\??\.\s*[\w$#]+)*)\s*,\s*(?:(["'\`])([\w$#]+)\4)?`, "g"), (m, at) => {
    const b = resolve(m[2]!, at);
    const key = m[5] ?? null;
    if (b && touches(b, key)) report(at, at + m[0].length, `stubs ${member(b, m[3] ?? "", key)} (${tidy(m[1]!)})`);
  });

  // jest's and vitest's built-in matchers, replaced through expect.extend. New matchers are fine.
  const expects = [...new Set(libs.filter((b) => b.expect).map((b) => escape(b.name)))];
  if (expects.length) {
    find(new RegExp(String.raw`(?<![\w$.])(${expects.join("|")})\s*\.\s*extend\s*\(`, "g"), (m, at) => {
      if (!lookup(m[1]!, at)?.expect) return;
      const { args, end } = callArgs(lx, at + m[0].length - 1);
      const key = (objectKeys(lx, args[0]) ?? []).find((k) => BUILTIN_MATCHERS.has(k));
      if (key) report(at, end, `overrides the built-in matcher ${key} (${m[1]}.extend)`);
    });
  }

  // The runner's globals, redefined on the global object.
  find(new RegExp(GLOBAL_OBJECT + String.raw`\s*(?:\??\.\s*(${RUNNER_GLOBALS})\b|\[\s*(["'\`])(${RUNNER_GLOBALS})\2\s*\])((?:\s*\??\.\s*[\w$#]+|${INDEX})*)` + ASSIGN, "g"), (m, at) => {
    const name = m[1] ?? m[3]!;
    report(at, at + m[0].length, m[4] ? `replaces ${name}${tidy(m[4])} on the global object` : `redefines the global ${name}`);
  });
  find(new RegExp(String.raw`\bdelete\s+` + GLOBAL_OBJECT + String.raw`\s*\.\s*(${RUNNER_GLOBALS})\b`, "g"), (m, at) => report(at, at + m[0].length, `deletes the global ${m[1]}`));
  find(new RegExp(String.raw`\b(?:Object|Reflect)\s*\.\s*(assign|defineProperty|defineProperties|set)\s*\(\s*` + GLOBAL_OBJECT + String.raw`\s*,`, "g"), (m, at) => {
    const { args, end } = callArgs(lx, at + m[0].indexOf("("));
    // Unknown keys (Object.assign(globalThis, polyfills)) are left alone: only a runner name counts here.
    const keys = m[1] === "assign" || m[1] === "defineProperties" ? args.slice(1).flatMap((a) => objectKeys(lx, a) ?? []) : [stringArg(lx, args[1])];
    const key = keys.find((k) => k !== null && new RegExp(`^(?:${RUNNER_GLOBALS})$`).test(k));
    if (key) report(at, end, `redefines the global ${key}`);
  });
  find(new RegExp(String.raw`\b(?:vi|jest)\s*\.\s*stubGlobal\s*\(\s*(["'\`])(${RUNNER_GLOBALS})\1`, "g"), (m, at) => report(at, at + m[0].length, `redefines the global ${m[2]} (stubGlobal)`));

  // Error.captureStackTrace, replaced. A polyfill that only fills in a missing one is fine: `||=`, `??=`,
  // `= Error.captureStackTrace || fallback`, or under `if (!Error.captureStackTrace)` or a typeof check.
  find(/(?<![\w$.])Error\s*\.\s*captureStackTrace\s*(\?\?|\|\|)?=(?![=>])(\s*Error\s*\.\s*captureStackTrace\s*(?:\|\||\?\?))?/g, (m, at) => {
    if (m[1] || m[2] || /!\s*Error\s*\.\s*captureStackTrace|typeof\s+Error\s*\.\s*captureStackTrace/.test(code.slice(Math.max(0, at - 300), at))) return;
    report(at, at + m[0].length, "replaces Error.captureStackTrace");
  });
  find(/\b(?:Object|Reflect)\s*\.\s*defineProperty\s*\(\s*Error\s*,\s*["'`]captureStackTrace["'`]/g, (m, at) => report(at, at + m[0].length, "replaces Error.captureStackTrace"));

  // Module mocks of an assertion library.
  find(new RegExp(String.raw`(\b(?:vi|jest)\s*\.\s*(?:mock|doMock|unstable_mockModule|setMock)|\bmock\s*\.\s*module)\s*\(\s*(?:import\s*\(\s*)?(["'\`])([^"'\`\n]+)\2`, "g"), (m, at) => {
    if (isAssertionLib(m[3]!)) report(at, at + m[0].length, `mocks ${m[3]} (${tidy(m[1]!)})`);
  });

  // The module loader, patched in a file whose new code names an assertion library: a swapped module.
  const named = [...addedCode.matchAll(/(["'`])([^"'`\n]+)\1/g)].map((m) => m[2]!).find(isAssertionLib);
  if (named) {
    const swap = (at: number, end: number, via: string) => report(at, end, `swaps ${named} through the module loader (${via})`);
    const mod = [...[...loader].map(escape), String.raw`module\s*\.\s*constructor`, String.raw`require\s*\(\s*["'\`](?:node:)?module["'\`]\s*\)`].join("|");
    find(new RegExp(String.raw`(?<![\w$.])require\s*\.\s*cache\b(?:\s*\??\.\s*[\w$]+|${INDEX})+` + ASSIGN, "g"), (m, at) => swap(at, at + m[0].length, "require.cache"));
    find(/\b(?:Object|Reflect)\s*\.\s*(?:assign|defineProperty|set)\s*\(\s*require\s*\.\s*cache\b/g, (m, at) => swap(at, at + m[0].length, "require.cache"));
    find(new RegExp(String.raw`(?<![\w$.])(?:${mod})\s*\.\s*(_load|_resolveFilename|_findPath|_cache|_extensions|prototype\s*\.\s*require)\b(?:\s*\??\.\s*[\w$]+|${INDEX})*` + ASSIGN, "g"), (m, at) =>
      swap(at, at + m[0].length, `Module.${tidy(m[1]!)}`),
    );
    find(/\bsyncBuiltinESMExports\s*\(/g, (m, at) => swap(at, at + m[0].length, "syncBuiltinESMExports"));
    const register = [String.raw`(?:${mod})\s*\.\s*register`, ...[...registers].map(escape)].join("|");
    find(new RegExp(String.raw`(?<![\w$.])(?:${register})\s*\(`, "g"), (m, at) => swap(at, at + m[0].length, "module.register"));
  }

  // Exit tricks: exit 0, exitCode = 0 or a replaced process.exit, on import or on the branch that finds a test runner.
  // On import only counts in a file tests could import: one that exports something, or isn't a script (a
  // shebang, a bin/ or scripts/ folder, reading process.argv). A script may well end with process.exit(0).
  const isScript = /^#!/.test(text) || /(?:^|\/)(?:bin|scripts?)\//.test(file) || /\bprocess\s*\.\s*argv\b/.test(code);
  const exports = /\bexport\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\b|\{|\*)|\bmodule\s*\.\s*exports\b|\bexports\s*\.\s*[\w$]+\s*=/.test(code);
  const importable = exports || !isScript;
  const exitCalls: Array<[RegExp, string]> = [
    [/(?<![\w$.])process\s*\.\s*(?:exit|reallyExit)\s*\(\s*(?:0|false|null|undefined|void\s+0)?\s*\)/g, "exits with code 0"],
    [/(?<![\w$.])process\s*\.\s*exitCode\s*=(?![=>])\s*(?:0|null|undefined|void\s+0)\b(?!\s*[-+*/%&|^<>=?.(\[])/g, "sets process.exitCode to 0"],
    [new RegExp(String.raw`(?<![\w$.])process\s*\.\s*(?:exit|reallyExit)` + ASSIGN, "g"), "replaces process.exit"],
    [/\b(?:Object|Reflect)\s*\.\s*defineProperty\s*\(\s*process\s*,\s*["'`](?:exit|exitCode|reallyExit)["'`]/g, "replaces process.exit"],
  ];
  const exits: Array<{ at: number; end: number; what: string }> = [];
  for (const [re, what] of exitCalls) find(re, (m, at) => exits.push({ at, end: at + m[0].length, what }));
  exits.sort((a, b) => a.at - b.at);

  // Where the code asks whether a test runner is there, split by which answer the check is true on.
  const runnerYes: number[] = [];
  const runnerNo: number[] = [];
  for (const m of code.matchAll(TEST_ENV)) (detectsRunner(code, m) ? runnerYes : runnerNo).push(m.index);
  // Tokens that make the code after them conditional, for the on-import rule.
  const conditional: number[] = [];
  find(/\b(?:if|else|switch|case|catch|while|for|do)\b|\?(?!\.)|&&|\|\|/g, (_, at) => conditional.push(at));

  const guard = conditionOf(lx);
  for (const x of exits) {
    const g = guard(x.at);
    if (g && within(g.onTrue ? runnerYes : runnerNo, g.from, g.to)) report(x.at, x.end, `${x.what} when it detects the test runner`);
    else if (lx.scope[x.at]! < 0 && importable && !within(conditional, lx.stmt[x.at]!, x.at)) report(x.at, x.end, `${x.what} on import`);
  }
  const handlers: Array<[number, number]> = [];
  find(/\bprocess\s*\.\s*(?:on|once|addListener|prependListener|prependOnceListener)\s*\(\s*["'`](?:exit|beforeExit)["'`]\s*,/g, (m, at) => {
    if (importable) handlers.push([at, callArgs(lx, at + m[0].indexOf("(")).end]);
  });
  // Exits inside an exit handler's call, in one sweep over both lists (each is in source order).
  for (let h = 0, reach = -1, k = 0; k < exits.length; k++) {
    const x = exits[k]!;
    while (h < handlers.length && handlers[h]![0] < x.at) reach = Math.max(reach, handlers[h++]![1]);
    if (x.at < reach && x.what !== "replaces process.exit") report(x.at, x.end, "forces exit code 0 from an exit handler");
  }

  return [...hits.values()].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** Whether a sorted list of offsets has one in [from, to). */
function within(sorted: number[], from: number, to: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]! < to;
}

/**
 * Whether a test-runner check (a TEST_ENV match) is true when the runner is there. `!process.env.VITEST`,
 * `NODE_ENV !== "test"`, `process.env.JEST_WORKER_ID === undefined` and `typeof describe === "undefined"` are
 * true when it isn't.
 */
function detectsRunner(code: string, m: RegExpMatchArray): boolean {
  const at = m.index!;
  const end = at + m[0].length;
  let yes = true;
  // An odd number of `!` in front of the check: `!process.env.X`, `!("VITEST" in process.env)`, `!(typeof x ...)`.
  const lead = /(!*)\s*(?:\(\s*)*(?:[\w$]+\s*(?:\??\.\s*|\[\s*))*["'`]?$/.exec(code.slice(Math.max(0, at - 48), at));
  if (lead && lead[1]!.length % 2) yes = !yes;
  if (/!=/.test(m[0])) return !yes;
  // A comparison after it: `=== undefined` and `!== "true"` are true when the runner isn't there.
  const cmp = /^["'`]?\s*\]?\s*(?:\)\s*)?(===?|!==?)\s*(undefined\b|null\b|void\s+0\b|["'`]undefined["'`])?/.exec(code.slice(end, end + 60));
  if (cmp && cmp[1]!.startsWith("=") === !!cmp[2]) yes = !yes;
  return yes;
}

/** The condition code runs under: the source range [from, to) of the check, and whether the code runs when it is true. */
interface Condition {
  from: number;
  to: number;
  onTrue: boolean;
}

/**
 * Finds the innermost condition guarding a piece of code: the `if`/`while` head or `else` it sits under, the
 * left side of the `&&`, `||` or `??` before it, or the test of the ternary it is a branch of. Statements in a
 * block take the block's condition; `try`, `finally`, `do` and bare blocks pass through to theirs. A function
 * body ends the search: code there runs when called. null when nothing guards it within its function or the
 * module.
 */
function conditionOf(lx: Lexed): (at: number) => Condition | null {
  const { code, literal } = lx;
  const prev = (i: number) => before(code, i);
  const wordAt = (j: number) => {
    if (j < 0 || literal[j] || !isWordCode(code.charCodeAt(j))) return "";
    let s = j;
    while (s > 0 && isWordCode(code.charCodeAt(s - 1))) s--;
    return code.slice(s, j + 1);
  };
  /** The paren after `if`/`while` at the start of the statement at `s`, if it closes before `t`; or that statement's `else`. */
  const head = (s: number, t: number): Condition | null => {
    const m = /^\s*(else\b\s*)?(?:(if|while)\s*\()?/.exec(code.slice(s, s + 200))!;
    if (m[2]) {
      const open = s + m[0].length - 1;
      const close = lx.pairs.get(open);
      return close !== undefined && close < t ? { from: open + 1, to: close, onTrue: true } : null;
    }
    return m[1] ? elseOf(s + m[0].indexOf("else")) : null;
  };
  /** The condition of the `if` whose `else` starts at `k`, inverted. */
  const elseOf = (k: number): Condition | null => {
    const j = prev(k);
    if (j < 0 || literal[j]) return null;
    let c: Condition | null;
    if (code[j] === "}") {
      const o = lx.pairs.get(j);
      const p = o === undefined ? -1 : prev(o);
      const po = code[p] === ")" ? lx.pairs.get(p) : undefined;
      c = po !== undefined && wordAt(prev(po)) === "if" ? { from: po + 1, to: p, onTrue: true } : null;
    } else c = head(lx.expr[j]!, j); // `if (C) x; else`: the statement before the else starts with the if.
    return c && { ...c, onTrue: !c.onTrue };
  };
  /** A `(` that calls something or opens an `if`/`for`/... head, rather than grouping. */
  const opensCall = (p: number) => {
    const j = prev(p);
    if (j < 0 || literal[j]) return false;
    if (code[j] === ")" || code[j] === "]") return true;
    const w = wordAt(j);
    return w !== "" && !BEFORE_REGEX.has(w);
  };
  const blocks = new Map<number, Condition | null>();

  return (at) => {
    const passed: number[] = []; // blocks walked out of, which all share the answer
    let found: Condition | null = null;
    let t = at;
    for (let step = 0; step < 64; step++) {
      const j = prev(t);
      if (j < 0) break;
      let block = -1;
      if (lx.expr[t]! > j) {
        // t starts its statement, or its item in a list: the condition, if any, is outside.
        const open = lx.frame[t]!;
        const kind = open < 0 ? "top" : lx.kinds.get(open);
        if (kind === "block") block = open - 1;
        else if (kind === "paren" && !opensCall(open - 1)) {
          t = open - 1;
          continue;
        } else break;
      } else if (literal[j]) break;
      else {
        const c = code[j]!;
        if (c === ")") {
          const o = lx.pairs.get(j);
          const w = o === undefined ? "" : wordAt(prev(o));
          if (w === "if" || w === "while") found = { from: o! + 1, to: j, onTrue: true };
        } else if ((c === "&" || c === "|" || c === "?") && code[j - 1] === c) found = { from: lx.expr[j - 1]!, to: j - 1, onTrue: c === "&" };
        else if (c === "?") found = { from: lx.expr[j]!, to: j, onTrue: true };
        else if (c === ":") {
          const q = lx.ternary.get(j);
          if (q !== undefined) found = { from: lx.expr[q]!, to: q, onTrue: false };
        } else if (wordAt(j) === "else") found = elseOf(j - 3);
        else {
          // `return process.exit(0)`, `x = process.exitCode = 0`: the statement's own if, or else whatever
          // guards the statement.
          const s = lx.expr[j]!;
          if (/^\s*(?:else\b|(?:if|while)\s*\()/.test(code.slice(s, s + 200))) found = head(s, t);
          else {
            let k = s;
            while (k < j && isSpace(code[k]!)) k++;
            t = k;
            continue;
          }
        }
        break;
      }
      if (blocks.has(block)) {
        found = blocks.get(block)!;
        break;
      }
      passed.push(block);
      const h = prev(block);
      const w = wordAt(h);
      if (h >= 0 && !literal[h] && code[h] === ")") {
        const o = lx.pairs.get(h);
        const ow = o === undefined ? "" : wordAt(prev(o));
        if (ow === "if" || ow === "while") found = { from: o! + 1, to: h, onTrue: true };
        break; // for, switch, catch: no condition we read
      }
      if (w === "else") {
        found = elseOf(h - 3);
        break;
      }
      // try, finally, do, or a bare block: its statement's condition.
      t = w === "try" || w === "finally" || w === "do" ? h - w.length + 1 : block;
    }
    for (const b of passed) blocks.set(b, found);
    return found;
  };
}

// ---------------------------------------------------------------------------------------------------------
// Patches.

/** A path from a `+++` line, unquoted the way git quotes unusual names. */
function diffPath(raw: string): string | null {
  let s = raw.replace(/\t$/, "");
  if (s === "/dev/null") return null;
  if (s.startsWith('"') && s.endsWith('"')) {
    const bytes: number[] = [];
    const esc: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
    for (let i = 1; i < s.length - 1; i++) {
      const c = s[i]!;
      if (c !== "\\") bytes.push(...Buffer.from(c));
      else if (/[0-7]/.test(s[i + 1] ?? "")) {
        bytes.push(Number.parseInt(s.slice(i + 1, i + 4), 8));
        i += 3;
      } else bytes.push(esc[s[++i] ?? ""] ?? s.charCodeAt(i));
    }
    s = Buffer.from(bytes).toString("utf8");
  }
  return s.startsWith("b/") ? s.slice(2) : s;
}

export interface PatchedFile {
  path: string;
  /** The file's new text as far as the diff shows it: all of it in a full-context diff. */
  text: string;
  added: boolean[];
  lineNos: number[];
}

/** The new side of every file in a unified diff, with the lines the patch adds marked. */
export function patchedFiles(diff: string): PatchedFile[] {
  const out: PatchedFile[] = [];
  let cur: { path: string; lines: string[]; added: boolean[]; lineNos: number[] } | null = null;
  let path: string | null = null;
  let next = 0; // the new-side line number of the next hunk line
  let inHunk = false;
  const flush = () => {
    if (cur && cur.lines.length) out.push({ path: cur.path, text: cur.lines.join("\n"), added: cur.added, lineNos: cur.lineNos });
    cur = null;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      path = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      path = diffPath(line.slice(4));
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      inHunk = path !== null;
      if (inHunk && !cur) cur = { path: path!, lines: [], added: [], lineNos: [] };
      next = Number(h[1]);
      continue;
    }
    if (!inHunk || !cur) continue;
    const c: { lines: string[]; added: boolean[]; lineNos: number[] } = cur;
    if (line.startsWith("+") || line.startsWith(" ")) {
      c.lines.push(line.slice(1));
      c.added.push(line.startsWith("+"));
      c.lineNos.push(next++);
    }
  }
  flush();
  return out;
}

/** Whether the guard reads this path: a JavaScript or TypeScript file that is neither protected (`skip`) nor test code. */
export function isGuarded(path: string, skip: RegExp[] = []): boolean {
  return SOURCE.test(path) && !matchesAny(path, skip) && !matchesAny(path, TEST_CODE);
}

/**
 * How long one patch's scan may take. The scan is synchronous, so this is also the longest it can hold up the
 * CLI (the live view, Ctrl-C). A real patch takes a fraction of it: on an M2, TypeScript's 9 MB typescript.js
 * scans in under a second.
 */
export const SCAN_BUDGET_MS = 10_000;

const inBudget = new Script("run()");

/**
 * Scan a fork's patch (ideally a full-context diff, so each file's imports are in view) for tampering. Only the
 * code under test is read (isGuarded). Returns the hits and the files it read. A scan still running after
 * `budgetMs` is stopped, and the file it was reading becomes a hit: a scan that can't finish can't vouch for it.
 */
export function scanPatch(diff: string, skip: RegExp[] = [], budgetMs = SCAN_BUDGET_MS): { hits: TamperHit[]; files: string[] } {
  const hits: TamperHit[] = [];
  const files: string[] = [];
  const run = () => {
    for (const f of patchedFiles(diff)) {
      if (!isGuarded(f.path, skip)) continue;
      files.push(f.path);
      hits.push(...scanSource(f.path, f.text, f.added, f.lineNos));
    }
  };
  try {
    // vm's timeout interrupts any JavaScript the script calls, a slow regex included.
    inBudget.runInNewContext({ run }, { timeout: budgetMs });
  } catch (err) {
    if ((err as { code?: string }).code !== "ERR_SCRIPT_EXECUTION_TIMEOUT") throw err;
    hits.push({ file: files[files.length - 1] ?? "the patch", line: null, why: `took the tamper guard over ${budgetMs / 1000} s to read` });
  }
  return { hits, files };
}

/** Hits as one line for the narration and the judge's output: `sum.js:3 replaces assert.equal from node:assert`. */
export function guardSummary(hits: TamperHit[]): string {
  return hits.map((h) => `${h.line === null ? h.file : `${h.file}:${h.line}`} ${h.why}`).join("; ");
}

// ---------------------------------------------------------------------------------------------------------
// The run-time probe for node:test suites.

/** Assertions that must fail under any honest node:test run. */
const MUST_FAIL = [
  "assert.equal(1, 2)",
  "assert.strictEqual(1, 2)",
  "assert.deepEqual([1], [2])",
  "assert.deepStrictEqual({ a: 1 }, { a: 2 })",
  "assert.ok(false)",
  "assert.throws(() => {})",
  "strict.equal(1, 2)",
  "strict.deepEqual({ a: 1 }, { a: 2 })",
  "strict.ok(false)",
  "strict.match('a', /b/)",
  "namedEqual(1, 2)",
  "throw new Error('must fail')",
];

/**
 * A node:test file that loads the patched modules, as a test file would, then runs assertions that must fail.
 * If one passes, a patched module switched off assertions wholesale. The modules load one at a time, each given
 * `loadMs` (a pending top-level await doesn't stall the rest), and process.exit, process.abort and
 * process.reallyExit throw until loading is done, so a module that throws or exits while loading is skipped.
 * Each module's start and end are printed, so when one kills the process anyway, readProbe() can say which.
 */
export function probeScript(moduleUrls: string[], loadMs = 5_000): string {
  return [
    'import { createRequire } from "node:module";',
    'import { equal as namedEqual } from "node:assert/strict";',
    "const require = createRequire(import.meta.url);",
    "const write = process.stdout.write.bind(process.stdout);",
    "const { exit, abort, reallyExit } = process;",
    "process.exit = (code) => { throw new Error(`exit(${code}) while loading`); };",
    'process.abort = () => { throw new Error("abort() while loading"); };',
    "process.reallyExit = (code) => { throw new Error(`reallyExit(${code}) while loading`); };",
    `const urls = ${JSON.stringify(moduleUrls)};`,
    "for (let i = 0; i < urls.length; i++) {",
    "  write(`forkbomb-probe loading ${i}\\n`);",
    "  let timer;",
    `  await Promise.race([import(urls[i]).catch(() => {}), new Promise((done) => { timer = setTimeout(done, ${loadMs}); })]);`,
    "  clearTimeout(timer);",
    "  write(`forkbomb-probe loaded ${i}\\n`);",
    "}",
    "Object.assign(process, { exit, abort, reallyExit });",
    'const { test } = require("node:test");',
    'const assert = require("node:assert");',
    'const strict = require("node:assert/strict");',
    ...MUST_FAIL.map((c) => `test(${JSON.stringify(`must fail: ${c}`)}, () => { ${c}; });`),
    "",
  ].join("\n");
}

/**
 * What a probe run (TAP) shows: the must-fail cases that passed, whether every case reported, and, when the
 * run stopped while a module was loading, that module's index.
 */
export function readProbe(output: string): { passed: string[]; complete: boolean; stuck: number | null } {
  const results = new Map<string, boolean>();
  for (const m of output.matchAll(/^[ \t]*(not )?ok \d+ - must fail: (.+?)\s*(?:#.*)?$/gm)) results.set(m[2]!, !m[1]);
  let stuck: number | null = null;
  for (const m of output.matchAll(/forkbomb-probe (loading|loaded) (\d+)/g)) {
    const i = Number(m[2]);
    if (m[1] === "loading") stuck = i;
    else if (stuck === i) stuck = null;
  }
  return { passed: MUST_FAIL.filter((c) => results.get(c) === true), complete: MUST_FAIL.every((c) => results.has(c)), stuck };
}
