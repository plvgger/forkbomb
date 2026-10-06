// Display helpers for the burn ledger. Inputs are the API's decimal strings; nothing here invents a value.

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Group a decimal string's integer part and cut its fraction to `maxFrac` digits (no float rounding). */
export function fmtDecimal(raw: string | null | undefined, maxFrac = 2): string {
  const m = DECIMAL.exec(String(raw ?? "").trim());
  if (!m) return "—";
  const [, sign, int, frac = ""] = m;
  const grouped = int.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cut = frac.slice(0, maxFrac).replace(/0+$/, "");
  return `${sign}${grouped}${cut ? `.${cut}` : ""}`;
}

/** Token amounts: whole tokens once they are large, two decimals below 1,000. */
export function fmtTokens(raw: string | null | undefined): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "—";
  return fmtDecimal(raw, Math.abs(n) >= 1000 ? 0 : 2);
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtUsd(raw: string | number | null | undefined): string {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (raw === null || raw === undefined || raw === "" || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "<$0.01";
  return USD.format(n);
}

/** Micro-USD integer to dollars. */
export function fmtMicroUsd(micro: number | null | undefined): string {
  if (typeof micro !== "number" || !Number.isFinite(micro)) return "—";
  return fmtUsd(micro / 1_000_000);
}

const SIG4 = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 });

/** Token prices can be tiny: keep four significant digits, never scientific notation. */
export function fmtPrice(raw: string | null | undefined): string {
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === "" || !Number.isFinite(n)) return "—";
  if (n >= 1) return USD.format(n);
  return `$${SIG4.format(n)}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-06 14:03 UTC". Deterministic, so it reads the same for everyone. */
export function fmtUtc(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "just now", "4 min ago", "3 h ago", "2 d ago". */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function short(a: string, head = 4, tail = 4): string {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/** Solscan link for a wallet, or null if the value doesn't look like a Solana address. */
export function solscanAccount(owner: string): string | null {
  return owner.length >= 32 && owner.length <= 44 && BASE58.test(owner)
    ? `https://solscan.io/account/${encodeURIComponent(owner)}`
    : null;
}

/** Solscan link for a transaction, or null if the value doesn't look like a signature. */
export function solscanTx(sig: string): string | null {
  return sig.length >= 43 && sig.length <= 90 && BASE58.test(sig) ? `https://solscan.io/tx/${encodeURIComponent(sig)}` : null;
}
