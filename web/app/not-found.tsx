import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Button, Container, Icon } from "./components";
import { REPLAY_URL } from "./config";
import styles from "./not-found.module.css";

// Next adds its own noindex to not-found responses. No canonical: a 404 is not a copy of the home page.
export const metadata: Metadata = {
  title: "Page not found",
  description: "This page does not exist on the Forkbomb site.",
  alternates: { canonical: null },
  openGraph: { title: "Page not found — Forkbomb", description: "This page does not exist on the Forkbomb site.", url: null },
};

const ROUTES: { label: string; path: string; href: string; native?: boolean }[] = [
  { label: "Documentation", path: "/docs", href: "/docs" },
  { label: "Install from source", path: "/docs#install", href: "/docs#install" },
  { label: "Security model", path: "/security", href: "/security" },
  { label: "Watch a recorded run", path: "/replay", href: REPLAY_URL, native: true },
];

/** The site as a tree: three live branches, and the one that was cut. */
function SeveredTree() {
  return (
    <svg className={styles.tree} viewBox="0 0 360 228" role="img" aria-labelledby="nf-tree-title">
      <title id="nf-tree-title">
        A tree of site routes. Docs, security and home are live. The requested page is a severed branch.
      </title>
      <g fill="none" strokeWidth="1.5" strokeLinecap="round">
        <path d="M180 212V150" stroke="var(--border-strong)" />
        <path d="M180 150C180 110 60 120 60 64" stroke="var(--border-strong)" />
        <path d="M180 150C180 110 140 110 140 64" stroke="var(--border-strong)" />
        <path d="M180 150C180 110 220 110 220 64" stroke="var(--border-strong)" />
        <path d="M180 150C180 118 300 120 300 92" stroke="var(--danger)" strokeDasharray="4 5" opacity="0.8" />
        <path d="M292 80l16 16M308 80l-16 16" stroke="var(--danger)" strokeWidth="2" />
      </g>
      <circle cx="180" cy="212" r="5" fill="var(--text-3)" />
      <circle cx="180" cy="150" r="4" fill="var(--text-3)" />
      {[60, 140, 220].map((x) => (
        <circle key={x} cx={x} cy="58" r="6" fill="var(--surface-3)" stroke="var(--border-strong)" strokeWidth="1.5" />
      ))}
      <g fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-2)" textAnchor="middle">
        <text x="60" y="36">/</text>
        <text x="140" y="36">/docs</text>
        <text x="220" y="36">/security</text>
        <text x="300" y="66" fill="var(--danger)">
          404
        </text>
      </g>
    </svg>
  );
}

export default function NotFound() {
  return (
    <section className="section section--lg" aria-labelledby="nf-title">
      <Container>
        <div className={styles.grid}>
          <div className="stack stack-lg">
            <div className="cluster">
              <Badge tone="danger" dot>
                severed
              </Badge>
              <span className="label">Error 404</span>
            </div>
            <h1 id="nf-title" className="h1">
              This head was severed.
            </h1>
            <p className="lede">
              The page you asked for does not exist, or it moved. Nothing else was touched. Pick a branch that survived.
            </p>
            <div className="cluster">
              <Button href="/" variant="primary" iconRight="arrowRight">
                Back to Forkbomb
              </Button>
              <Button href="/docs">Read the docs</Button>
            </div>
          </div>

          <div className={styles.panel}>
            <SeveredTree />
          </div>
        </div>

        <nav className={styles.routes} aria-label="Pages that exist">
          <h2 className="label">Pages that exist</h2>
          <ul className={styles.routeList}>
            {ROUTES.map((r) => {
              const inner = (
                <>
                  <span className={styles.routeLabel}>{r.label}</span>
                  <span className={styles.routePath}>{r.path}</span>
                  <Icon name="arrowRight" className={styles.routeIcon} />
                </>
              );
              return (
                <li key={r.path}>
                  {r.native ? (
                    <a className={styles.route} href={r.href}>
                      {inner}
                    </a>
                  ) : (
                    <Link className={styles.route} href={r.href}>
                      {inner}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </Container>
    </section>
  );
}
