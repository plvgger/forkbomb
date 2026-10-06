import Link from "next/link";
import { FOOTER, GITHUB_URL, SITE } from "../config";
import { Button } from "./Button";
import { Logo } from "./Logo";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="site-footer__grid">
          <div className="site-footer__brand">
            <Logo />
            <p>
              Fork your coding agent into sandboxed heads. Your test suite picks the survivor. Open source, runs on your
              own machine. {SITE.platform}.
            </p>
            <div className="cluster">
              <Button href={GITHUB_URL} external size="sm" icon="github">
                Source
              </Button>
            </div>
          </div>
          {FOOTER.map((col) => (
            <nav key={col.title} className="site-footer__col" aria-labelledby={`footer-${col.title.toLowerCase()}`}>
              <h2 id={`footer-${col.title.toLowerCase()}`}>{col.title}</h2>
              <ul>
                {col.links.map((l) =>
                  l.external || l.native ? (
                    <li key={l.href + l.label}>
                      <a href={l.href} {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                        {l.label}
                      </a>
                    </li>
                  ) : (
                    <li key={l.href + l.label}>
                      <Link href={l.href}>{l.label}</Link>
                    </li>
                  ),
                )}
              </ul>
            </nav>
          ))}
        </div>
        <div className="site-footer__base">
          <span>© 2026 Forkbomb contributors. {SITE.license} licensed.</span>
          <ul>
            <li>Not affiliated with Anthropic.</li>
            <li>Draft — not indexed</li>
          </ul>
        </div>
      </div>
    </footer>
  );
}
