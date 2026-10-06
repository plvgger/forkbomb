"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";

/** Copies `text` to the clipboard. Announces the result to screen readers. */
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  iconOnly = false,
  className,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  /** Hide the visible label (the accessible name stays). */
  iconOnly?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className={cx("copy-btn", className)}
      onClick={copy}
      data-copied={copied ? "true" : undefined}
      aria-label={iconOnly ? (copied ? copiedLabel : label) : undefined}
    >
      <Icon name={copied ? "check" : "copy"} />
      {!iconOnly && <span>{copied ? copiedLabel : label}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}
