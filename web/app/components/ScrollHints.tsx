"use client";

import { useEffect } from "react";

const SELECTOR = ".code__body, .terminal__body, .table-wrap, [data-scroll-hint]";

/**
 * Marks scroll boxes that have content past their right or bottom edge with
 * data-overflow="right bottom". globals.css fades that edge so clipped code reads as
 * scrollable even with overlay scrollbars. Mounted once in the root layout.
 */
export function ScrollHints() {
  useEffect(() => {
    const update = (el: Element) => {
      const e = el as HTMLElement;
      const tokens: string[] = [];
      if (e.scrollLeft + e.clientWidth < e.scrollWidth - 2) tokens.push("right");
      if (e.scrollTop + e.clientHeight < e.scrollHeight - 2) tokens.push("bottom");
      const next = tokens.join(" ");
      if ((e.getAttribute("data-overflow") ?? "") !== next) {
        if (next) e.setAttribute("data-overflow", next);
        else e.removeAttribute("data-overflow");
      }
    };
    const seen = new WeakSet<Element>();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver((es) => es.forEach((x) => update(x.target))) : null;
    const onScroll = (ev: Event) => update(ev.currentTarget as Element);
    const scan = () => {
      document.querySelectorAll(SELECTOR).forEach((el) => {
        if (seen.has(el)) return update(el);
        seen.add(el);
        el.addEventListener("scroll", onScroll, { passive: true });
        ro?.observe(el);
        update(el);
      });
    };
    scan();
    // Client navigations render new pages; rescan when <main> changes.
    const main = document.getElementById("main");
    const mo = main ? new MutationObserver(() => scan()) : null;
    mo?.observe(main!, { childList: true, subtree: true });
    window.addEventListener("load", scan);
    return () => {
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener("load", scan);
    };
  }, []);
  return null;
}
