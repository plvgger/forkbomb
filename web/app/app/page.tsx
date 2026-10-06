import { Badge, Container, PixelHeading } from "@/app/components";
import { SITE, STATUS } from "@/app/config";
import { pageMetadata } from "@/app/lib/seo";
import { Dapp } from "./_parts/Dapp";
import s from "./app.module.css";

export const metadata = pageMetadata({
  title: "App",
  description: `Create a ${SITE.name} workspace, get an API key for the hosted engine, burn ${SITE.ticker} for compute credit and watch usage.`,
  path: "/app",
});

export default function AppPage() {
  return (
    <>
      <section className={s.hero} aria-labelledby="app-title">
        <Container>
          <div className="stack stack-sm">
            <div className="cluster">
              <span className="label">/app</span>
              {STATUS.tokenLive ? (
                <Badge tone="ok" dot>
                  {SITE.ticker} live
                </Badge>
              ) : (
                <Badge tone="signal" dot>
                  {SITE.ticker} launching
                </Badge>
              )}
              {STATUS.hostedPoolLive ? (
                <Badge tone="ok" dot>
                  hosted pool online
                </Badge>
              ) : (
                <Badge tone="warn" dot>
                  hosted pool coming online
                </Badge>
              )}
            </div>
            <PixelHeading as="h1" size="xl" id="app-title">
              Workspace, key, <span className="hl">burn.</span>
            </PixelHeading>
            <p className={s.lede}>
              A workspace holds credit for the CLI&apos;s <code className="inline-code">--engine hosted</code>. Burn{" "}
              {SITE.ticker} from your wallet with the workspace memo and it&apos;s credited in USD at the burn-time price.
              No sign-up, no email. The key is the account.
            </p>
          </div>
        </Container>
      </section>

      <section className={s.body} aria-label="App">
        <Container>
          <Dapp />
          <p className={s.fine}>
            Credit only buys hosted compute. It is not refundable or transferable, and there are no buybacks, yield or
            revenue share. Self-hosting with Claude Code or an Anthropic API key stays free. Not affiliated with
            Anthropic.
          </p>
        </Container>
      </section>
    </>
  );
}
