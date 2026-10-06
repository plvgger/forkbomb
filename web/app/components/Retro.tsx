import type { ElementType, ReactNode } from "react";
import { cx } from "./cx";

/* ---------- PixelHeading ----------
   Pixel display heading. Wrap words in <span className="hl"> (orange) or
   <span className="hl-ok"> (green, exit 0 only) for emphasis. */
export function PixelHeading({
  as: Tag = "h2",
  size = "lg",
  tone = "default",
  glow = false,
  id,
  className,
  children,
}: {
  as?: "h1" | "h2" | "h3" | "p" | "span" | "div";
  /** mega 56-160px · display 48-104px · xl 36-56px · lg 28-42px · md 22-26px · sm 20px */
  size?: "mega" | "display" | "xl" | "lg" | "md" | "sm";
  tone?: "default" | "signal" | "ok";
  /** CRT glow (text-shadow). Use on one heading per view at most. */
  glow?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      id={id}
      className={cx(
        "pixel-heading",
        `pixel-heading--${size}`,
        tone !== "default" && `pixel-heading--${tone}`,
        glow && "pixel-heading--glow",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/* ---------- Marquee ----------
   Decorative, endlessly scrolling strip. Content is duplicated for a seamless loop;
   the whole strip is aria-hidden, so pass `label` if it carries meaning.
   Pauses on hover; static under prefers-reduced-motion. */
export type MarqueeItem = string | { text: string; tone?: "hot" | "ok" };

export function Marquee({
  items,
  repeat = 3,
  speed = 40,
  reverse = false,
  size = "md",
  tone = "default",
  label,
  className,
}: {
  items: MarqueeItem[];
  /** How many times `items` repeat inside one track (fill wide screens). */
  repeat?: number;
  /** Seconds per loop. Higher is slower. */
  speed?: number;
  reverse?: boolean;
  size?: "md" | "lg";
  /** signal = orange band with dark text. */
  tone?: "default" | "signal";
  /** Screen-reader text for the strip. */
  label?: string;
  className?: string;
}) {
  const list = Array.from({ length: Math.max(1, repeat) }, () => items).flat();
  const track = (hidden: boolean) => (
    <div className="marquee__track" aria-hidden={hidden || undefined}>
      {list.map((it, i) => {
        const text = typeof it === "string" ? it : it.text;
        const t = typeof it === "string" ? undefined : it.tone;
        return (
          <span key={i} className={cx("marquee__item", t && `marquee__item--${t}`)} translate="no">
            {text}
          </span>
        );
      })}
    </div>
  );
  return (
    <div
      className={cx(
        "marquee",
        reverse && "marquee--reverse",
        size === "lg" && "marquee--lg",
        tone === "signal" && "marquee--signal",
        className,
      )}
      style={{ ["--mq-dur" as string]: `${speed}s` }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {track(false)}
      {track(true)}
    </div>
  );
}

/* ---------- HazardStripe ----------
   Orange/black caution tape. Use once or twice per page, between major sections. */
export function HazardStripe({
  label,
  size = "md",
  className,
}: {
  /** Optional pixel label centered on the tape, e.g. "live fire". */
  label?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <div className={cx("hazard", size !== "md" && `hazard--${size}`, className)} role="presentation">
      {label && <span className="hazard__label">{label}</span>}
    </div>
  );
}

/* ---------- CrtPanel ----------
   Generic CRT window: title bar + scanlined body. For terminals use <Terminal>. */
export function CrtPanel({
  as: Tag = "section",
  title,
  status,
  flush = false,
  className,
  bodyClassName,
  labelledBy,
  children,
}: {
  as?: ElementType;
  /** Mono title in the bar, e.g. "ps -ef | grep forkbomb". Omit for no bar. */
  title?: ReactNode;
  /** Right side of the bar, e.g. a <Badge>. */
  status?: ReactNode;
  /** No body padding (tables, canvases). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={cx("crt crt-panel", flush && "crt-panel--flush", className)} aria-labelledby={labelledBy}>
      {(title || status) && (
        <div className="crt-panel__bar">
          <span className="terminal__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {title && <span className="crt-panel__title">{title}</span>}
          {status && <span className="crt-panel__status">{status}</span>}
        </div>
      )}
      <div className={cx("crt-panel__body", bodyClassName)}>{children}</div>
    </Tag>
  );
}

/* ---------- StateBlock ----------
   Designed empty / loading / error state for data that may be absent (ledger, price, app).
   Never fill these with placeholder numbers. */
export function StateBlock({
  kind = "empty",
  glyph,
  title,
  children,
  action,
  className,
}: {
  kind?: "empty" | "loading" | "error";
  /** Big pixel glyph on top. Defaults: empty "0 burns", loading "...", error "ERR". */
  glyph?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const g = glyph ?? (kind === "error" ? "ERR" : kind === "loading" ? "..." : "∅");
  return (
    <div
      className={cx("state", `state--${kind}`, className)}
      role={kind === "error" ? "alert" : "status"}
      aria-busy={kind === "loading" || undefined}
    >
      <span className={cx("state__glyph", kind === "loading" && "cursor")} aria-hidden="true">
        {g}
      </span>
      <p className="state__title">{title}</p>
      {children && <div className="state__body">{children}</div>}
      {action && <div className="cluster" style={{ justifyContent: "center" }}>{action}</div>}
    </div>
  );
}
