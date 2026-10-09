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

/**
 * A cell's text with each --flag in a <code> that never wraps, so "--engine" can't break after its dashes.
 * Other cells pass through.
 */
function cellText(c: ReactNode): ReactNode {
  if (typeof c !== "string" || !c.includes("--")) return c;
  return c.split(/(--[a-z][a-z0-9-]*)/g).map((part, i) =>
    i % 2 ? (
      <code key={i} className={s.flagInline}>
        {part}
      </code>
    ) : (
      part
    ),
  );
}

/** Flag / default / description table. Scrolls inside its own box; a labelled card per row on phones. */
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
              <td className={s.flagCell} data-label="Flag">
                <code>{f.flag}</code>
              </td>
              <td className={s.defCell} data-label="Default">
                {f.def}
              </td>
              <td data-label="Description">{cellText(f.desc)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Generic two- or three-column reference table. A labelled card per row on phones, so no column hides off-screen. */
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
                <td key={j} className={mono.includes(j) ? s.monoCell : undefined} data-label={head[j]}>
                  {cellText(c)}
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

/** API endpoint reference block: method chip, path, auth, then its details. */
export function Endpoint({
  id,
  method,
  path,
  auth,
  summary,
  children,
}: {
  id: string;
  method: "GET" | "POST";
  path: string;
  auth: string;
  summary: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className={s.endpoint} aria-labelledby={`${id}-path`}>
      <header className={s.endpointHead}>
        <span className={s.method} data-method={method}>
          {method}
        </span>
        <h3 id={id} className={s.endpointPath}>
          <code id={`${id}-path`}>{path}</code>
          <a className={s.anchor} href={`#${id}`} aria-label={`Link to ${method} ${path}`}>
            #
          </a>
        </h3>
        <span className={s.endpointAuth}>{auth}</span>
      </header>
      <div className={s.endpointBody}>
        <p className={s.endpointSummary}>{summary}</p>
        {children}
      </div>
    </article>
  );
}

/** Error code table: code, HTTP status, meaning. */
export function ErrorTable({ caption, rows }: { caption: string; rows: { code: string; status: number; meaning: string }[] }) {
  return (
    <RefTable
      caption={caption}
      head={["Code", "HTTP", "Meaning"]}
      mono={[0, 1]}
      rows={rows.map((r) => [r.code, String(r.status), r.meaning])}
    />
  );
}

/** Numbered flow with mono step numbers (burn steps, hosted setup). */
export function Flow({ label, steps }: { label: string; steps: { title: string; body: ReactNode }[] }) {
  return (
    <ol className={s.flowSteps} aria-label={label}>
      {steps.map((st, i) => (
        <li key={st.title} className={s.flowStep}>
          <span className={s.flowNum} aria-hidden="true">
            {String(i + 1).padStart(2, "0")}
          </span>
          <div className={s.flowText}>
            <h4 className={s.flowTitle}>{st.title}</h4>
            <div className={s.flowBody}>{st.body}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
