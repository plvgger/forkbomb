import { test } from "node:test";
import assert from "node:assert/strict";
import { format, formatISO, parse } from "./durations.js";

test("single units", () => {
  assert.equal(parse("90s"), 90_000);
  assert.equal(parse("45m"), 2_700_000);
  assert.equal(parse("2h"), 7_200_000);
  assert.equal(parse("1d"), 86_400_000);
});
test("compound durations, with or without spaces", () => {
  assert.equal(parse("1h 30m"), 5_400_000);
  assert.equal(parse("1h30m"), 5_400_000);
  assert.equal(parse("1d 2h 3m 4s"), 93_784_000);
  assert.equal(parse(" 2h "), 7_200_000);
});
test("milliseconds", () => {
  assert.equal(parse("500ms"), 500);
  assert.equal(parse("1s 250ms"), 1250);
});
test("decimals", () => {
  assert.equal(parse("2.5h"), 9_000_000);
  assert.equal(parse("1.5m"), 90_000);
  assert.equal(parse("0.25s"), 250);
});
test("rounds to the nearest millisecond, halves away from zero", () => {
  assert.equal(parse("2.3h"), 8_280_000);
  assert.equal(parse("0.0004s"), 0);
  assert.equal(parse("1.5ms"), 2);
  assert.equal(parse("-1.5ms"), -2);
});
test("a leading minus negates the whole duration", () => {
  assert.equal(parse("-90s"), -90_000);
  assert.equal(parse("-1h 30m"), -5_400_000);
  assert.equal(parse("-PT1H30M"), -5_400_000);
});
test("malformed input is a SyntaxError that says where", () => {
  for (const [bad, at] of [["", 0], ["1h banana", 3], ["1h 30x", 5], ["1h 30", 5], ["--1h", 1], [" 2h x", 4]]) {
    assert.throws(
      () => parse(bad),
      (e) => e instanceof SyntaxError && e.position === at && e.message.includes(`position ${at}`),
      `expected a SyntaxError at position ${at} for ${JSON.stringify(bad)}`,
    );
  }
});
test("ISO 8601", () => {
  assert.equal(parse("PT1H30M"), 5_400_000);
  assert.equal(parse("PT90S"), 90_000);
  assert.equal(parse("PT1M"), 60_000);
  assert.equal(parse("P2D"), 172_800_000);
  assert.equal(parse("P1DT2H"), 93_600_000);
});
test("ISO 8601 fractions", () => {
  assert.equal(parse("PT0.5S"), 500);
  assert.equal(parse("PT1M1.001S"), 61_001);
  assert.equal(parse("PT1.5H"), 5_400_000);
});
test("ISO 8601 years and months have no fixed length: RangeError", () => {
  for (const bad of ["P1Y", "P1M", "P1Y2M3D", "-P1M"]) {
    assert.throws(() => parse(bad), RangeError, `expected RangeError for ${JSON.stringify(bad)}`);
  }
});
test("ISO 8601 durations need at least one component", () => {
  for (const bad of ["P", "PT", "P1DT", "-P"]) {
    assert.throws(() => parse(bad), SyntaxError, `expected SyntaxError for ${JSON.stringify(bad)}`);
  }
});
test("format: largest units first, zero units left out", () => {
  assert.equal(format(5_400_000), "1h 30m");
  assert.equal(format(90_000), "1m 30s");
  assert.equal(format(7_200_000), "2h");
  assert.equal(format(93_784_000), "1d 2h 3m 4s");
});
test("format: zero and anything under half a second is 0s", () => {
  assert.equal(format(0), "0s");
  assert.equal(format(400), "0s");
  assert.equal(format(-400), "0s");
});
test("format: rounds to the nearest second and carries", () => {
  assert.equal(format(1_499), "1s");
  assert.equal(format(1_500), "2s");
  assert.equal(format(59_500), "1m");
  assert.equal(format(3_599_500), "1h");
  assert.equal(format(86_399_999), "1d");
});
test("format: one leading minus for negative durations", () => {
  assert.equal(format(-5_400_000), "-1h 30m");
  assert.equal(format(-90_000), "-1m 30s");
  assert.equal(format(-1_500), "-2s");
});
test("formatISO", () => {
  assert.equal(formatISO(5_400_000), "PT1H30M");
  assert.equal(formatISO(93_600_000), "P1DT2H");
  assert.equal(formatISO(86_400_000), "P1D");
  assert.equal(formatISO(1_500), "PT1.5S");
  assert.equal(formatISO(-3_600_000), "-PT1H");
  assert.equal(formatISO(0), "PT0S");
});
