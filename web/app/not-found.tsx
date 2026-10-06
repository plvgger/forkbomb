import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Button, Container, Icon, Terminal, type TerminalLine } from "./components";
import { REPLAY_URL } from "./config";
import styles from "./not-found.module.css";

// Next adds its own noindex to not-found responses. No canonical: a 404 is not a copy of the home page.
export const metadata: Metadata = {
  title: "Process not found",
  description: "This page does not exist on the Forkbomb site. It was probably killed.",
  alternates: { canonical: null },
  openGraph: {
    title: "Process not found — Forkbomb",
    description: "This page does not exist on the Forkbomb site.",
    url: null,
  },
};

const ROUTES: { label: string; path: string; href: string; native?: boolean }[] = [
  { label: "Documentation", path: "/docs", href: "/docs" },
  { label: "Install from source", path: "/docs#install", href: "/docs#install" },
  { label: "Burn ledger", path: "/burns", href: "/burns" },
  { label: "Watch a recorded run", path: "/replay", href: REPLAY_URL, native: true },
];

const LINES: TerminalLine[] = [
  { tone: "cmd", text: "ps -p $PAGE" },
  { tone: "dim", text: "  PID  STAT  CMD" },
  { tone: "err", text: "ps: process not found" },
  { tone: "cmd", text: "kill -0 $PAGE" },
  { tone: "err", text: "kill: (404) - No such process" },
  { tone: "out", text: "pid 1 is still running. Pick a route below." },
];

export default function NotFound() {
  return (
    <section className="section section--lg" aria-labelledby="nf-title">
      <Container>
        <div className={styles.grid}>
          <div className="stack stack-lg">
            <div className="cluster">
              <Badge tone="signal" dot>
                SIGKILL
              </Badge>
              <span className="label">Error 404</span>
            </div>
            <h1 id="nf-title" className="display">
              Process not found.
            </h1>
            <p className="lede">
              It was probably killed. The page you asked for does not exist, or it moved. Nothing else was touched.
            </p>
            <div className="cluster">
              <Button href="/" variant="primary" iconRight="arrowRight">
                Back to pid 1
              </Button>
              <Button href="/docs">Read the docs</Button>
            </div>
          </div>

          <Terminal lines={LINES} title="zsh · 404" ariaLabel="Terminal: the requested page is not a running process" />
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
