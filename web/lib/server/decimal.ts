// Exact decimal <-> scaled bigint conversion. No floats touch money.

/** Atto-USD: prices are bigints scaled by 1e18 so tiny token prices keep their precision. */
export const PRICE_SCALE = 18;

/**
 * Parse a non-negative decimal ("0.00012", "12", "1.5e-7") into a bigint scaled by 10^scale.
 * Digits past the scale are truncated (floored). Throws on anything else.
 */
export function parseDecimal(input: string | number, scale: number): bigint {
  const s = typeof input === "number" ? numberToString(input) : input.trim();
  const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/.exec(s);
  if (!m || (!m[1] && !m[2])) throw new RangeError(`not a decimal: ${s}`);
  const digits = (m[1] ?? "") + (m[2] ?? "");
  const exp = Number(m[3] ?? 0) - (m[2] ?? "").length + scale; // value = digits * 10^exp
  const n = BigInt(digits || "0");
  return exp >= 0 ? n * 10n ** BigInt(exp) : n / 10n ** BigInt(-exp);
}

function numberToString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`not a non-negative finite number: ${n}`);
  return String(n); // may use exponent form; parseDecimal handles it
}

/** Scaled bigint -> plain decimal string without trailing zeros, e.g. (1500n, 3) -> "1.5". */
export function formatScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(scale);
  const whole = abs / base;
  const frac = scale > 0 ? (abs % base).toString().padStart(scale, "0").replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
