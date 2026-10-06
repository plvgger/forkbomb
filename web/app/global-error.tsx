"use client";

import "./globals.css";

// Replaces the root layout when the layout itself throws, so it carries its own <html> and <body>.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Something failed — Forkbomb</title>
        <meta name="robots" content="noindex, nofollow" />
      </head>
      <body>
        <main id="main" className="section section--lg">
          <div className="container container--narrow">
            <div className="stack stack-lg">
              <p className="label">Error</p>
              <h1 className="h1">Something failed to load.</h1>
              <p className="lede">
                The page could not start. Reload to try again. If it keeps happening, the docs and source are linked
                from the home page.
              </p>
              <div className="cluster">
                <button type="button" className="btn btn--primary" onClick={() => reset()}>
                  Try again
                </button>
                <a className="btn btn--secondary" href="/">
                  Back to Forkbomb
                </a>
              </div>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
