import Link from "next/link";
import { cx } from "./cx";

/** The Hydra mark: one neck forking into three heads. Inherits currentColor. */
export function Mark({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M16 29V17M16 17C16 11 9 11 6 5M16 17C16 11 23 11 26 5M16 17V4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="6" cy="5" r="2.4" fill="currentColor" />
      <circle cx="16" cy="4" r="2.4" fill="currentColor" />
      <circle cx="26" cy="5" r="2.4" fill="currentColor" />
    </svg>
  );
}

/** Mark + wordmark, linking home. */
export function Logo({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cx("brand", className)} aria-label="Hydra home">
      <Mark className="brand__mark" />
      <span className="brand__word" aria-hidden="true">
        HYDRA
      </span>
    </Link>
  );
}
