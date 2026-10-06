"use client";

import { useEffect, useRef, useState } from "react";
import s from "../security.module.css";

export type TocItem = { id: string; label: string };

/**
 * Sticky in-page index. Plain anchor links work without JS;
 * with JS the link for the section in view gets aria-current.
 */
export function OnThisPage({ items }: { items: TocItem[] }) {
  const [active, setActive] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = items.map((i) => document.getElementById(i.id)).filter((el): el is HTMLElement => !!el);
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
          else visible.delete(e.target.id);
        }
        if (visible.size === 0) return;
        // The topmost section still in the band wins.
        const first = items.find((i) => visible.has(i.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-120px 0px -55% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items]);

  // Keep the active link in view inside the horizontally scrolling list (mobile).
  useEffect(() => {
    if (!active || !listRef.current) return;
    const link = listRef.current.querySelector<HTMLAnchorElement>(`a[href="#${active}"]`);
    const list = listRef.current;
    if (!link) return;
    const l = link.offsetLeft;
    const r = l + link.offsetWidth;
    if (l < list.scrollLeft || r > list.scrollLeft + list.clientWidth) {
      list.scrollTo({ left: Math.max(0, l - 16), behavior: "smooth" });
    }
  }, [active]);

  return (
    <nav className={s.toc} aria-label="On this page">
      <div className="container">
        <ul ref={listRef} className={s.tocList}>
          {items.map((i, n) => (
            <li key={i.id}>
              <a href={`#${i.id}`} className={s.tocLink} aria-current={active === i.id ? "location" : undefined}>
                <span className={s.tocNum} aria-hidden="true">
                  {String(n + 1).padStart(2, "0")}
                </span>
                {i.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
