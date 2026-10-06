import type { ReactNode } from "react";
import Link from "next/link";
import { Container, PageHeader, Prose } from "../../components";
import styles from "./legal.module.css";

export type LegalSection = { id: string; title: string; body: ReactNode };

/**
 * Shared layout for /terms and /privacy: page header, a short plain-English
 * summary, a sticky table of contents on wide screens, and the full text.
 */
export function LegalDoc({
  title,
  lede,
  updated,
  summary,
  sections,
  related,
}: {
  title: string;
  lede: ReactNode;
  updated: string;
  summary: ReactNode[];
  sections: LegalSection[];
  related: { label: string; href: string };
}) {
  return (
    <>
      <PageHeader
        eyebrow="Legal"
        title={title}
        lede={lede}
        meta={[`Draft · last updated ${updated}`, "Plain English", <Link key="r" className="link" href={related.href}>{related.label}</Link>]}
      />
      <section className="section section--sm" aria-label={`${title} text`}>
        <Container>
          <div className={styles.layout}>
            <nav className={styles.toc} aria-label="On this page">
              <p className={styles.tocLabel}>On this page</p>
              <ol className={styles.tocList}>
                {sections.map((s, i) => (
                  <li key={s.id}>
                    <a href={`#${s.id}`} className={styles.tocLink}>
                      <span className={styles.tocNum} aria-hidden="true">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      {s.title}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>

            <div className={styles.body}>
              <div className={styles.summary}>
                <h2 className={styles.summaryTitle} id="summary">
                  The short version
                </h2>
                <ul className={styles.summaryList}>
                  {summary.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>

              <Prose>
                {sections.map((s, i) => (
                  <div key={s.id} className={styles.clause}>
                    <p className={`eyebrow ${styles.clauseNum}`} aria-hidden="true">
                      <span className="eyebrow__index">{String(i + 1).padStart(2, "0")}</span>
                    </p>
                    <h2 id={s.id}>{s.title}</h2>
                    {s.body}
                  </div>
                ))}
              </Prose>
            </div>
          </div>
        </Container>
      </section>
    </>
  );
}
