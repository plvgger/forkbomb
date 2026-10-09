import { Children, type ReactNode } from "react";
import { SITE } from "../config";

/**
 * Sets the ticker in mono wherever a pixel-type element would print it. Pixelify Sans draws B so it reads as G, so
 * "$FORKBOMB" read "$FORKGOMG": a misread ticker on the token's own pages. Wraps every occurrence inside string
 * children in <span class="ticker"> (globals.css); everything else passes through untouched.
 */
export function monoTicker(node: ReactNode): ReactNode {
  return Children.map(node, (child) => {
    if (typeof child !== "string" || !child.includes(SITE.ticker)) return child;
    return child.split(SITE.ticker).flatMap((part, i) =>
      i === 0
        ? [part]
        : [
            <span key={i} className="ticker" translate="no">
              {SITE.ticker}
            </span>,
            part,
          ],
    );
  });
}
