"use client";

import { useEffect, useRef } from "react";

/**
 * Reveals .term-line children one by one once in view. Lines are server-rendered,
 * so without JS (or with reduced motion) everything is visible.
 */
export function TerminalAnimator({ interval, loop }: { interval: number; loop: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current?.closest(".terminal");
    if (!root) return;
    const lines = Array.from(root.querySelectorAll<HTMLElement>(".term-line"));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") {
      lines.forEach((l) => l.classList.add("is-shown"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let i = 0;
    const step = () => {
      if (i < lines.length) {
        lines[i++].classList.add("is-shown");
        timer = setTimeout(step, interval);
      } else if (loop) {
        timer = setTimeout(() => {
          lines.forEach((l) => l.classList.remove("is-shown"));
          i = 0;
          timer = setTimeout(step, 400);
        }, 4000);
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          step();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(root);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, [interval, loop]);
  return <div ref={ref} hidden />;
}
