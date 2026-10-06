"use client";

import { useEffect, useRef, useState } from "react";
import { TERMINAL } from "./config";

/** Copy-to-clipboard button with a transient "Copied" toast. */
export function CopyButton({ target, children }: { target: string; children: React.ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const el = document.getElementById(target);
          const text = (el?.textContent || "").replace(/^\$\s*/, "");
          if (navigator.clipboard && text) {
            navigator.clipboard.writeText(text).then(() => {
              setShown(true);
              setTimeout(() => setShown(false), 1400);
            });
          }
        }}
      >
        {children}
      </button>
      <span className={`toast${shown ? " show" : ""}`} aria-live="polite">
        Copied
      </span>
    </>
  );
}

/** Reveal-on-scroll wrapper. */
export function Reveal({ children, className = "", id }: { children: React.ReactNode; className?: string; id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) el.classList.add("in");
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} id={id} className={`reveal ${className}`}>
      {children}
    </div>
  );
}

/** Replays the real run's terminal transcript, looping, once scrolled into view. */
export function TerminalReplay() {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    let started = false;
    const line = () => {
      if (i >= TERMINAL.length) {
        timer = setTimeout(() => {
          el.innerHTML = "";
          i = 0;
          line();
        }, 3500);
        return;
      }
      const row = document.createElement("div");
      row.className = TERMINAL[i][0];
      row.textContent = TERMINAL[i][1];
      el.appendChild(row);
      i++;
      timer = setTimeout(line, 650);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !started) {
            started = true;
            line();
          }
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clearTimeout(timer);
    };
  }, []);
  return <pre ref={ref} className="mono" />;
}
