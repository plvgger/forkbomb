import type { ElementType, ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";

/* ---------- Badge ---------- */
/** accent/ok = green (exit 0, pass). signal/danger = orange (forks, kills, brand). */
export type Tone = "neutral" | "accent" | "ok" | "signal" | "danger" | "warn" | "info";

export function Badge({
  tone = "neutral",
  dot,
  pulse,
  className,
  children,
}: {
  tone?: Tone;
  /** Leading status dot in the badge color. */
  dot?: boolean;
  /** Pulse the dot (respects reduced motion). */
  pulse?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("badge", tone !== "neutral" && `badge--${tone}`, pulse && "badge--pulse", className)}>
      {(dot || pulse) && <span className="badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/* ---------- Eyebrow (max one per section) ----------
   One format site-wide: optional two-digit index in text-3, then the label in text-2.
   Pass the index separately; never bake "01 · Label" into the string. */
export function Eyebrow({
  index,
  dot,
  className,
  children,
}: {
  /** Optional numeric index, e.g. "01". */
  index?: string;
  /** Small accent square before the text. */
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <p className={cx("eyebrow", className)}>
      {dot && <span className="eyebrow__dot" aria-hidden="true" />}
      {index && <span className="eyebrow__index">{index}</span>}
      <span>{children}</span>
    </p>
  );
}

/* ---------- Container ---------- */
export function Container({
  size = "default",
  as: Tag = "div",
  className,
  children,
}: {
  size?: "default" | "narrow" | "wide";
  as?: ElementType;
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={cx("container", size !== "default" && `container--${size}`, className)}>{children}</Tag>;
}

/* ---------- Section ---------- */
export function Section({
  id,
  tone = "default",
  size = "md",
  divider,
  container = "default",
  labelledBy,
  className,
  children,
}: {
  id?: string;
  /** default = page bg, raised = slightly lifted bg, inset = raised + hairline top/bottom */
  tone?: "default" | "raised" | "inset";
  /** Vertical padding: sm 48-72px, md 64-112px, lg 80-144px */
  size?: "sm" | "md" | "lg";
  /** Hairline on top. Also keeps full top padding when following a same-tone section. */
  divider?: boolean;
  /** Width of the inner container. false = no container (full-bleed children). */
  container?: "default" | "narrow" | "wide" | false;
  /** id of the heading that names this section (aria-labelledby). */
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cx("section", `section--${tone}`, size !== "md" && `section--${size}`, divider && "section--divider", className)}
    >
      {container === false ? children : <Container size={container}>{children}</Container>}
    </section>
  );
}

/* ---------- SectionHeader: eyebrow + h2 + lede ---------- */
export function SectionHeader({
  eyebrow,
  index,
  title,
  lede,
  id,
  as: Heading = "h2",
  align = "left",
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  /** Section number shown before the eyebrow label, e.g. "01". */
  index?: string;
  title: ReactNode;
  lede?: ReactNode;
  /** id for the heading; pass the same string to <Section labelledBy>. */
  id?: string;
  as?: "h1" | "h2" | "h3";
  align?: "left" | "center";
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("section-header", align === "center" && "section-header--center", className)}>
      {eyebrow && <Eyebrow index={index}>{eyebrow}</Eyebrow>}
      <Heading id={id} className={Heading === "h1" ? "h1" : "h2"}>
        {title}
      </Heading>
      {lede && <p className="lede">{lede}</p>}
      {actions && <div className="section-header__actions">{actions}</div>}
    </header>
  );
}

/* ---------- PageHeader: interior page hero with the page's single h1 ---------- */
export function PageHeader({
  eyebrow,
  title,
  lede,
  meta,
  actions,
  size = "default",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lede?: ReactNode;
  /** Small mono line(s) under the lede, e.g. ["Last updated 2026-10-05", "v0.1"]. */
  meta?: ReactNode[];
  actions?: ReactNode;
  size?: "default" | "narrow" | "wide";
}) {
  return (
    <header className="page-header">
      <Container size={size}>
        <div className="page-header__inner">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          <h1 className="h1">{title}</h1>
          {lede && <p className="lede">{lede}</p>}
          {actions && <div className="cluster mt-2">{actions}</div>}
          {meta && meta.length > 0 && (
            <div className="page-header__meta">
              {meta.map((m, i) => (
                <span key={i}>{m}</span>
              ))}
            </div>
          )}
        </div>
      </Container>
    </header>
  );
}

/* ---------- Card ---------- */
export function Card({
  as: Tag = "div",
  padding = "md",
  tone = "default",
  interactive,
  className,
  children,
  ...rest
}: {
  as?: ElementType;
  padding?: "none" | "sm" | "md" | "lg";
  tone?: "default" | "raised" | "accent" | "ok" | "signal";
  /** Hover state; use when the whole card is a link (pass as="a" / href via rest). */
  interactive?: boolean;
  className?: string;
  children: ReactNode;
  [key: string]: unknown;
}) {
  return (
    <Tag
      className={cx(
        "card",
        padding === "none" ? "card--flush" : padding !== "md" && `card--${padding}`,
        tone !== "default" && `card--${tone}`,
        interactive && "card--interactive",
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/* ---------- Stat ---------- */
export function Stat({
  value,
  unit,
  label,
  note,
  tone = "default",
  className,
}: {
  value: ReactNode;
  /** Smaller unit after the value, e.g. "ms". */
  unit?: string;
  label: ReactNode;
  /** Source / footnote in small mono, e.g. "bench · M2 Air". */
  note?: ReactNode;
  tone?: "default" | "accent" | "ok" | "signal" | "danger" | "warn";
  className?: string;
}) {
  return (
    <div className={cx("stat", tone !== "default" && `stat--${tone}`, className)}>
      <span className="stat__value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      <span className="stat__label">{label}</span>
      {note && <span className="stat__note">{note}</span>}
    </div>
  );
}

/** Hairline grid of <Stat>s. 4 columns desktop, 2 on mobile. */
export function StatGrid({ cols = 4, className, children }: { cols?: 2 | 3 | 4; className?: string; children: ReactNode }) {
  return (
    <div className={cx("stat-grid", className)} style={{ ["--stat-cols" as string]: cols }}>
      {children}
    </div>
  );
}

/* ---------- Callout ---------- */
export function Callout({
  tone = "info",
  title,
  className,
  children,
}: {
  tone?: "info" | "warn" | "danger" | "signal" | "ok";
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const icon = tone === "warn" || tone === "danger" || tone === "signal" ? "warn" : tone === "ok" ? "check" : "info";
  return (
    <aside className={cx("callout", tone !== "info" && `callout--${tone}`, className)} role="note">
      <Icon name={icon} className="callout__icon" />
      <div>
        {title && <strong className="callout__title">{title}</strong>}
        {children}
      </div>
    </aside>
  );
}

/* ---------- Prose ---------- */
export function Prose({ as: Tag = "div", className, children }: { as?: ElementType; className?: string; children: ReactNode }) {
  return <Tag className={cx("prose", className)}>{children}</Tag>;
}
