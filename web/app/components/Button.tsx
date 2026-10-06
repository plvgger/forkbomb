import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { Icon, type IconName } from "./Icon";

/**
 * Every button is an Inter semibold pill.
 * primary = signal orange (main CTA, one per view) · secondary = surface · outline = cream hairline
 * (e.g. "Connect wallet") · ghost = text only · ok = green, only for exit-0 / success actions.
 */
export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "ok";
export type ButtonSize = "sm" | "md" | "lg";

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon before the label. */
  icon?: IconName;
  /** Icon after the label (e.g. "arrowRight"). */
  iconRight?: IconName;
  block?: boolean;
  className?: string;
  children: ReactNode;
};

type AsLink = Common & {
  href: string;
  /** Opens in a new tab with rel="noopener noreferrer". Auto-true for http(s) URLs. */
  external?: boolean;
  /** Force a plain <a> (needed for static files like /replay/index.html). Auto for *.html. */
  native?: boolean;
  "aria-label"?: string;
};

type AsButton = Common & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & { href?: undefined };

export type ButtonProps = AsLink | AsButton;

export function Button(props: ButtonProps) {
  const { variant = "secondary", size = "md", icon, iconRight, block, className, children } = props;
  const cls = cx(
    "btn",
    `btn--${variant}`,
    size !== "md" && `btn--${size}`,
    block && "btn--block",
    className,
  );
  const inner = (
    <>
      {icon && <Icon name={icon} className="btn__icon" />}
      <span>{children}</span>
      {iconRight && <Icon name={iconRight} className="btn__icon" />}
    </>
  );

  if (props.href !== undefined) {
    const { href, external, native } = props;
    const isExternal = external ?? /^https?:\/\//.test(href);
    const isNative = native || isExternal || /\.html(\?|#|$)/.test(href);
    if (isNative) {
      return (
        <a
          href={href}
          className={cls}
          aria-label={props["aria-label"]}
          {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {inner}
        </a>
      );
    }
    return (
      <Link href={href} className={cls} aria-label={props["aria-label"]}>
        {inner}
      </Link>
    );
  }

  const {
    variant: _v,
    size: _s,
    icon: _i,
    iconRight: _ir,
    block: _b,
    className: _c,
    children: _ch,
    type,
    ...rest
  } = props as AsButton;
  return (
    <button type={type ?? "button"} className={cls} {...rest}>
      {inner}
    </button>
  );
}
