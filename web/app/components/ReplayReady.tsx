"use client";

import { useEffect, useRef } from "react";

/**
 * Listens for the embedded replay's "ready" message and marks the enclosing
 * .replay-frame, which swaps the static poster for the live replay (CSS).
 * public/replay/app.js posts { type: "forkbomb:replay-ready" } once the tree has drawn.
 */
export function ReplayReady() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const frame = ref.current?.closest(".replay-frame");
    const iframe = frame?.querySelector("iframe");
    if (!frame || !iframe) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== iframe.contentWindow) return;
      if (e.data && typeof e.data === "object" && (e.data as { type?: string }).type === "forkbomb:replay-ready") {
        frame.setAttribute("data-ready", "");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return <span ref={ref} hidden />;
}
