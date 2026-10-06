import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./calc.js";

test("numbers", () => assert.equal(evaluate("42"), 42));
test("addition", () => assert.equal(evaluate("1 + 2"), 3));
test("multiplication binds tighter than addition", () => assert.equal(evaluate("2 + 3 * 4"), 14));
test("left to right at equal precedence", () => assert.equal(evaluate("10 - 4 - 3"), 3));
test("parentheses", () => assert.equal(evaluate("(2 + 3) * 4"), 20));
test("exponent is right-associative", () => assert.equal(evaluate("2 ^ 3 ^ 2"), 512));
test("exponent binds tighter than unary minus", () => assert.equal(evaluate("-2 ^ 2"), -4));
test("unary minus", () => {
  assert.equal(evaluate("-(3 + 4) * 2"), -14);
  assert.equal(evaluate("3 - -2"), 5);
});
test("decimals", () => {
  assert.ok(Math.abs(evaluate("0.1 + 0.2") - 0.3) < 1e-12);
  assert.equal(evaluate(".5 * 4"), 2);
});
test("any whitespace", () => assert.equal(evaluate("\t1 +\n 2"), 3));
test("division by zero is a RangeError", () => assert.throws(() => evaluate("1 / 0"), RangeError));
test("malformed input is a SyntaxError", () => {
  for (const bad of ["2 +", "(1 + 2", "1 2", "1.2.3", ")", ""]) {
    assert.throws(() => evaluate(bad), SyntaxError, `expected SyntaxError for ${JSON.stringify(bad)}`);
  }
});
test("errors say where", () => assert.throws(() => evaluate("2 $ 3"), (e) => e instanceof SyntaxError && /position 2\b/.test(e.message)));
test("everything at once", () => assert.equal(evaluate("2 * (3 + 4) ^ 2 / 7 - 1"), 13));
