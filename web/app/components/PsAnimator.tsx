"use client";

import { useEffect, useRef } from "react";

/**
 * Plays the PsTable once: rows show "R+ running" until the table is in view, then
 * resolve to the real end state (SIGKILL / exit 0). Without JS the end state shows.
 */
export function PsAnimator({ delay = 1400 }: { delay?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const table = ref.current?.parentElement?.querySelector<HTMLTableElement>("table.ps");
    if (!table) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      table.dataset.phase = "done";
      return;
    }
    table.dataset.phase = "run";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          timer = setTimeout(() => (table.dataset.phase = "done"), delay);
        }
      },
      { threshold: 0.5 },
    );
    io.observe(table);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, [delay]);
  return <span ref={ref} hidden />;
}
