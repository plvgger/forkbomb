// Human-readable durations, in milliseconds.
// parse("1h 30m") === 5_400_000, parse("PT1H30M") === 5_400_000
// format(5_400_000) === "1h 30m", formatISO(5_400_000) === "PT1H30M"

const UNITS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

export function parse(input) {
  const src = input.trim();
  if (src.startsWith("P") || src.startsWith("-P")) return parseISO(src);
  let total = 0;
  for (const [, num, unit] of src.matchAll(/(-?\d+)\s*(d|h|m|s|ms)/g)) {
    total += Number(num) * UNITS[unit];
  }
  if (total === 0 && !src.startsWith("0")) throw new SyntaxError("invalid duration: " + input);
  return total;
}

function parseISO(src) {
  const m = /^(-)?P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(src);
  if (!m) throw new SyntaxError("invalid ISO 8601 duration: " + src);
  const [, sign, d = 0, h = 0, min = 0, s = 0] = m;
  const ms = d * UNITS.d + h * UNITS.h + min * UNITS.m + s * UNITS.s;
  return sign ? -ms : ms;
}

export function format(ms) {
  const parts = [];
  let rest = ms;
  for (const unit of ["d", "h", "m"]) {
    const n = Math.trunc(rest / UNITS[unit]);
    if (n !== 0) parts.push(`${n}${unit}`);
    rest -= n * UNITS[unit];
  }
  const s = Math.round(rest / 1000);
  if (s !== 0) parts.push(`${s}s`);
  return parts.join(" ");
}

export function formatISO(ms) {
  const sign = ms < 0 ? "-" : "";
  let rest = Math.abs(ms);
  const d = Math.floor(rest / UNITS.d);
  rest %= UNITS.d;
  const h = Math.floor(rest / UNITS.h);
  rest %= UNITS.h;
  const m = Math.floor(rest / UNITS.m);
  rest %= UNITS.m;
  const s = rest / 1000;
  let out = sign + "P";
  if (d) out += d + "D";
  out += "T";
  if (h) out += h + "H";
  if (m) out += m + "M";
  if (s) out += s + "S";
  return out;
}
