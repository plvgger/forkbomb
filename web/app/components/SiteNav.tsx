"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { GITHUB_URL, NAV, SITE, TOKEN_LINK, type NavLink } from "../config";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { Logo } from "./Logo";

function isActive(pathname: string, href: string) {
  if (href.includes(".html") || href === "/replay") return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavAnchor({
  link,
  className,
  pathname,
  chevron,
}: {
  link: NavLink;
  className?: string;
  pathname: string;
  chevron?: boolean;
}) {
  const current = isActive(pathname, link.href) ? "page" : undefined;
  const inner = (
    <>
      {link.label}
      {chevron && <Icon name={link.external ? "arrowUpRight" : "arrowRight"} />}
    </>
  );
  if (link.native || link.external) {
    return (
      <a
        href={link.href}
        className={className}
        {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {inner}
      </a>
    );
  }
  return (
    <Link href={link.href} className={className} aria-current={current}>
      {inner}
    </Link>
  );
}

export function SiteNav() {
  const pathname = usePathname() || "/";
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  // Close the mobile menu on navigation and on Escape.
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const m = menu.current;
      if (!m?.open) return;
      const target = e.target as Element;
      // Outside the menu, or on a link inside the sheet (same-page #hash links don't change the route).
      if (!m.contains(target) || target.closest(".nav-sheet a")) m.open = false;
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <header className="site-nav">
      <nav className="container site-nav__inner" aria-label="Primary">
        <Logo />
        <ul className="site-nav__links">
          {NAV.map((l) => (
            <li key={l.href}>
              <NavAnchor link={l} className="nav-link" pathname={pathname} />
            </li>
          ))}
        </ul>
        <div className="site-nav__end">
          <NavAnchor link={TOKEN_LINK} className="nav-token" pathname={pathname} />
          <Button href={GITHUB_URL} external size="sm" icon="github" className="btn--gh" aria-label="Forkbomb on GitHub">
            GitHub
          </Button>
          <Button href="/docs#install" size="sm" variant="primary" className="btn--install">
            Install
          </Button>
          <details className="nav-menu" ref={menu} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary aria-label={open ? "Close menu" : "Open menu"}>
              <Icon name="menu" className="icon-menu" />
              <Icon name="close" className="icon-close" />
            </summary>
            <div className="nav-sheet">
              <ul>
                {[...NAV, TOKEN_LINK].map((l) => (
                  <li key={l.href}>
                    <NavAnchor link={l} pathname={pathname} chevron />
                  </li>
                ))}
              </ul>
              <div className="nav-sheet__actions">
                <Button href="/docs#install" variant="primary" size="lg" block iconRight="arrowRight">
                  Install from source
                </Button>
                <Button href={GITHUB_URL} external size="lg" icon="github" block>
                  View on GitHub
                </Button>
                <p className="nav-sheet__meta">
                  {SITE.license} · {SITE.platform}
                </p>
              </div>
            </div>
          </details>
        </div>
      </nav>
    </header>
  );
}
