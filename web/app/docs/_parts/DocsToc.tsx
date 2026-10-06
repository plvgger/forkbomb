"use client";

import { useEffect, useRef, useState } from "react";
import type { TocItem } from "./content";
import s from "../docs.module.css";

/**
 * Table of contents. Sidebar on desktop, a sticky "On this page" bar under
 * 1024px. Plain anchor links, so it works without JS; JS adds scroll-spy and
 * closes the mobile sheet after a jump.
 */
export function DocsToc({ items, issuesUrl }: { items: TocItem[]; issuesUrl: string }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");
  const sheet = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const els = items.map((i) => document.getElementById(i.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = 220;
      let current = els[0]!.id;
      for (const el of els) {
        if (el.getBoundingClientRect().top - line <= 0) current = el.id;
        else break;
      }
      // At the very bottom, the last section is current even if it is short.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = els[els.length - 1]!.id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && sheet.current?.open) {
        sheet.current.open = false;
        sheet.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const activeLabel = items.find((i) => i.id === active)?.label;

  const list = (onPick?: () => void) => (
    <ol className={s.tocList}>
      {items.map((item, i) => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            className={s.tocLink}
            aria-current={item.id === active ? "location" : undefined}
            onClick={onPick}
          >
            <span className={s.tocNum} aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span>{item.label}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <>
      <nav className={s.sideToc} aria-label="Documentation">
        <p className={s.tocLabel}>On this page</p>
        {list()}
        <div className={s.tocFoot}>
          <a className={s.tocAux} href={issuesUrl} target="_blank" rel="noopener noreferrer">
            Report a docs issue
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <a className={s.tocAux} href="#main">
            Back to top
          </a>
        </div>
      </nav>

      <details className={s.sheet} ref={sheet}>
        <summary className={s.sheetBar}>
          <span className={s.sheetLabel}>On this page</span>
          {activeLabel && (
            <span className={s.sheetCurrent} aria-hidden="true">
              {activeLabel}
            </span>
          )}
          <svg className={s.chev} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        <nav className={s.sheetPanel} aria-label="Documentation, compact">
          {list(() => {
            if (sheet.current) sheet.current.open = false;
          })}
        </nav>
      </details>
    </>
  );
}
