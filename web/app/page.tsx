import {
  Benchmark,
  Engines,
  Faq,
  FinalCta,
  Hero,
  HowItWorks,
  Isolation,
  Judge,
  Quickstart,
  RunSection,
} from "./_home/sections";
import { pageMetadata } from "./lib/seo";

export const metadata = pageMetadata({
  description:
    "Forkbomb forks a coding agent into sandboxed copies of your repo in milliseconds. Each head takes a different approach. Your test suite keeps the one that passes. Open source, MIT, macOS.",
  path: "/",
});

export default function Home() {
  return (
    <>
      <Hero />
      <RunSection />
      <HowItWorks />
      <Benchmark />
      <Judge />
      <Isolation />
      <Engines />
      <Quickstart />
      <Faq />
      <FinalCta />
    </>
  );
}
