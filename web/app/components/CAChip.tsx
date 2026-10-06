import { CONTRACT_ADDRESS } from "../config";
import { CopyButton } from "./CopyButton";
import { cx } from "./cx";

/** Middle-truncate a base58 address for display: "AbCd…WxYz". The full value is copied. */
export function shortAddress(a: string, head = 6, tail = 6) {
  return a.length <= head + tail + 1 ? a : `${a.slice(0, head)}…${a.slice(-tail)}`;
}

/**
 * Contract-address pill for under the hero CTA (Darwin-style "CA: …").
 * Empty address (pre-launch) renders an honest "launching" state with no copy button.
 */
export function CAChip({
  address = CONTRACT_ADDRESS,
  label = "CA",
  full = false,
  className,
}: {
  address?: string;
  label?: string;
  /** Show the whole address instead of a middle-truncated one. */
  full?: boolean;
  className?: string;
}) {
  const a = address.trim();
  const live = a.length > 0;
  return (
    <div
      className={cx("ca-chip", live && "ca-chip--live", className)}
      data-state={live ? "live" : "pending"}
      aria-label={live ? `Contract address ${a}` : "Contract address: not published yet, launching"}
      role="group"
    >
      <span className="ca-chip__label">{label}</span>
      {live ? (
        <>
          <code className="ca-chip__value" title={a} translate="no">
            {full ? a : shortAddress(a)}
          </code>
          <CopyButton text={a} label="Copy contract address" copiedLabel="Copied" iconOnly />
        </>
      ) : (
        <span className="ca-chip__pending">launching</span>
      )}
    </div>
  );
}
