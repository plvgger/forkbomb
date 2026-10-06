import type { ReactNode } from "react";
import type { Flag } from "./content";
import s from "../docs.module.css";

/** One top-level docs section: numbered, anchored h2. */
export function DocSection({
  id,
  index,
  title,
  lede,
  children,
}: {
  id: string;
  index: number;
  title: string;
  lede?: ReactNode;
  children: ReactNode;
}) {
  const hid = `${id}-title`;
  return (
    <section id={id} aria-labelledby={hid} className={s.section}>
      <header className={s.sectionHead}>
        <p className={`eyebrow ${s.sectionIdx}`} aria-hidden="true">
          <span className="eyebrow__index">{String(index).padStart(2, "0")}</span>
        </p>
        <h2 id={hid} className={s.h2}>
          {title}
          <a className={s.anchor} href={`#${id}`} aria-label={`Link to ${title}`}>
            #
          </a>
        </h2>
        {lede && <p className={s.sectionLede}>{lede}</p>}
      </header>
      <div className={s.flow}>{children}</div>
    </section>
  );
}

/** Anchored h3 inside a section. */
export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className={s.h3}>
      {children}
      <a className={s.anchor} href={`#${id}`} aria-label="Link to this heading">
        #
      </a>
    </h3>
  );
}

/** Flag / default / description table. Scrolls inside its own box. */
export function FlagTable({ flags, caption }: { flags: Flag[]; caption: string }) {
  return (
    <div className={`table-wrap ${s.tableWrap}`} tabIndex={0} role="region" aria-label={caption}>
      <table className={`${s.table} ${s.flagTable}`}>
        <caption className="sr-only">{caption}</caption>
        <colgroup>
          <col className={s.colFlag} />
          <col className={s.colDef} />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Flag</th>
            <th scope="col">Default</th>
            <th scope="col">Description</th>
          </tr>
        </thead>
        <tbody>
          {flags.map((f) => (
            <tr key={f.flag}>
              <td className={s.flagCell}>
                <code>{f.flag}</code>
              </td>
              <td className={s.defCell}>{f.def}</td>
              <td>{f.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Generic two- or three-column reference table. */
export function RefTable({
  caption,
  head,
  rows,
  mono = [0],
}: {
  caption: string;
  head: string[];
  rows: ReactNode[][];
  /** Column indexes rendered in mono. */
  mono?: number[];
}) {
  return (
    <div className={`table-wrap ${s.tableWrap}`} tabIndex={0} role="region" aria-label={caption}>
      <table className={s.table}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={mono.includes(j) ? s.monoCell : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Synopsis line for a command reference entry. */
export function Synopsis({ children }: { children: ReactNode }) {
  return (
    <p className={s.synopsis}>
      <span className={s.synopsisLabel}>Usage</span>
      <code>{children}</code>
    </p>
  );
}
