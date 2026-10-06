import { HazardStripe } from "./components";
import { SITE } from "./config";
import {
  Benchmark,
  BurnForCompute,
  Engines,
  Faq,
  FinalCta,
  GlyphMarquee,
  Hero,
  HowItWorks,
  Isolation,
  RunSection,
} from "./_home/sections";
import { pageMetadata } from "./lib/seo";

export const metadata = pageMetadata({
  description: `${SITE.description} Burn ${SITE.ticker} for hosted compute; self-hosting stays free.`,
  path: "/",
});

export default function Home() {
  return (
    <>
      <Hero />
      <GlyphMarquee />
      <RunSection />
      <HowItWorks />
      <HazardStripe label={`${SITE.ticker} · burn for compute`} size="lg" />
      <BurnForCompute />
      <Benchmark />
      <Engines />
      <Isolation />
      <Faq />
      <FinalCta />
    </>
  );
}
