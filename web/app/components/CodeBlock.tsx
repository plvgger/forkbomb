import type { CSSProperties } from "react";
import { CopyButton } from "./CopyButton";
import { cx } from "./cx";
import { Icon } from "./Icon";

export type CodeTone = "add" | "del" | "hunk" | "meta" | "comment" | "hl";
export type CodeLine = { text: string; tone?: CodeTone | "" };

/**
 * Code in a bordered box. Scrolls horizontally inside its own box, never the page.
 * - `code`: plain string (split on newlines), or `lines` for per-line tones.
 * - `lang="sh"`: lines starting with "$ " get a styled prompt; copy strips it.
 * - `diff`: auto-tone lines by leading +, -, @@, diff/index.
 * - `more`: footer link for clipped excerpts, e.g. the full patch in the replay.
 */
export function CodeBlock({
  code,
  lines,
  title,
  lang,
  diff,
  highlight,
  numbers,
  copy = true,
  copyText,
  maxHeight,
  className,
  ariaLabel,
  more,
}: {
  code?: string;
  lines?: CodeLine[];
  /** Filename / tab label in the header. */
  title?: string;
  /** Short language tag shown in the header, e.g. "sh", "ts", "diff". */
  lang?: string;
  diff?: boolean;
  /** 1-based line numbers to highlight. */
  highlight?: number[];
  numbers?: boolean;
  copy?: boolean;
  /** Override the copied text. */
  copyText?: string;
  /** e.g. 360 (px) or "50vh". Body scrolls vertically past this. */
  maxHeight?: number | string;
  className?: string;
  ariaLabel?: string;
  more?: { href: string; label: string; note?: string };
}) {
  const rows: CodeLine[] = lines ?? (code ?? "").replace(/\n$/, "").split("\n").map((text) => ({ text }));
  const isShell = lang === "sh" || lang === "bash" || lang === "shell";
  const toned = rows.map((r, i) => {
    let tone = r.tone || "";
    if (!tone && diff) {
      if (r.text.startsWith("diff --git") || r.text.startsWith("index ")) tone = "meta";
      else if (r.text.startsWith("@@")) tone = "hunk";
      else if (r.text.startsWith("+") && !r.text.startsWith("+++")) tone = "add";
      else if (r.text.startsWith("-") && !r.text.startsWith("---")) tone = "del";
    }
    if (!tone && isShell && r.text.startsWith("# ")) tone = "comment";
    if (!tone && highlight?.includes(i + 1)) tone = "hl";
    return { text: r.text, tone };
  });
  const clip =
    copyText ??
    toned.map((r) => (isShell && r.text.startsWith("$ ") ? r.text.slice(2) : r.text)).join("\n");
  const hasHead = Boolean(title || lang);
  const style = maxHeight !== undefined
    ? ({ ["--code-max-h" as string]: typeof maxHeight === "number" ? `${maxHeight}px` : maxHeight } as CSSProperties)
    : undefined;

  return (
    <figure className={cx("code", !hasHead && "code--headless", numbers && "code--numbered", className)} style={style}>
      {hasHead && (
        <figcaption className="code__head">
          {title && <span className="code__title">{title}</span>}
          {lang && <span className="code__lang">{lang}</span>}
          {copy && <CopyButton text={clip} />}
        </figcaption>
      )}
      {!hasHead && copy && <CopyButton text={clip} iconOnly label="Copy code" />}
      <div className="code__body" tabIndex={0} role="region" aria-label={ariaLabel ?? title ?? "Code"}>
        <pre className="code__pre">
          <code className="code__code">
            {toned.map((r, i) => (
              <span key={i} className={cx("code__line", r.tone && `line--${r.tone}`)}>
                {numbers && <span className="code__ln" aria-hidden="true">{i + 1}</span>}
                {isShell && r.text.startsWith("$ ") ? (
                  <>
                    <span className="code__prompt" aria-hidden="true">$ </span>
                    {r.text.slice(2)}
                  </>
                ) : (
                  r.text || " "
                )}
              </span>
            ))}
          </code>
        </pre>
      </div>
      {more && (
        <div className="code__more">
          <span>{more.note}</span>
          <a href={more.href}>
            <span>{more.label}</span>
            <Icon name="arrowUpRight" />
          </a>
        </div>
      )}
    </figure>
  );
}
