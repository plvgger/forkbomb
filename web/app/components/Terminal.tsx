import type { ReactNode } from "react";
import { cx } from "./cx";
import { TerminalAnimator } from "./TerminalAnimator";

/** ok = green (pass / exit 0 only) · signal = orange (fork, kill) · err = orange-red error. */
export type TerminalTone = "cmd" | "out" | "dim" | "ok" | "err" | "warn" | "info" | "signal";
export type TerminalLine = { text: string; tone?: TerminalTone };

/**
 * Terminal window. `cmd` lines get a "$ " prompt automatically (do not include it).
 * `animate` types lines in when scrolled into view (progressive enhancement).
 * CRT look (scanlines, glow) by default; `flat` turns it off for dense reference blocks.
 */
export function Terminal({
  lines,
  title = "zsh",
  status,
  animate = false,
  interval = 420,
  loop = false,
  flat = false,
  className,
  ariaLabel,
}: {
  lines: TerminalLine[];
  title?: string;
  /** Right side of the title bar, e.g. <Badge tone="accent" dot>pass</Badge>. */
  status?: ReactNode;
  animate?: boolean;
  /** ms between lines when animating. */
  interval?: number;
  loop?: boolean;
  /** No scanlines / vignette. */
  flat?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <figure className={cx("terminal", flat && "terminal--flat", className)} data-animate={animate ? "true" : undefined}>
      <figcaption className="terminal__bar">
        <span className="terminal__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="terminal__title">{title}</span>
        {status && <span className="terminal__status">{status}</span>}
      </figcaption>
      <div className="terminal__body" tabIndex={0} role="region" aria-label={ariaLabel ?? `Terminal: ${title}`}>
        <pre className="terminal__lines" style={{ font: "inherit" }}>
          {lines.map((l, i) => (
            <span key={i} className={cx("term-line", `term-line--${l.tone ?? "out"}`)}>
              {l.text || " "}
            </span>
          ))}
        </pre>
      </div>
      {animate && <TerminalAnimator interval={interval} loop={loop} />}
    </figure>
  );
}
