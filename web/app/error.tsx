"use client";

import { Button, Container } from "./components";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="section section--lg">
      <Container size="narrow">
        <div className="stack stack-lg">
          <p className="label">Error</p>
          <h1 className="h1">Something failed to render.</h1>
          <p className="lede">Try again. If it keeps happening, open an issue on GitHub with the page you were on.</p>
          <div className="cluster">
            <Button variant="primary" onClick={() => reset()}>
              Try again
            </Button>
            <Button href="/">Back to Forkbomb</Button>
          </div>
        </div>
      </Container>
    </section>
  );
}
