"use client";

import { useEffect, useRef, type ElementType, type ReactNode } from "react";
import { cx } from "./cx";

/**
 * Fades content in when it scrolls into view.
 * Progressive enhancement: visible without JS; only `html.js .reveal` starts hidden.
 */
export function Reveal({
  as: Tag = "div",
  delay = 0,
  className,
  id,
  children,
}: {
  as?: ElementType;
  /** ms before the transition starts (use for staggering siblings: 0, 80, 160...). */
  delay?: number;
  className?: string;
  id?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.classList.add("is-in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            el.classList.add("is-in");
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag
      ref={ref}
      id={id}
      className={cx("reveal", className)}
      style={delay ? ({ ["--reveal-delay" as string]: `${delay}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </Tag>
  );
}
