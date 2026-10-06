import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Forkbomb — fork your coding agent. Let the tests pick the winner.",
  description:
    "Forkbomb forks a coding agent into many sandboxed copies in milliseconds. Each one takes a different approach to the same bug. Your test suite decides who wins. Open source, runs on your own machine.",
  robots: { index: false, follow: false },
  openGraph: {
    title: "Forkbomb — many agents, one bug, one survivor",
    description: "Fork a coding agent into N sandboxed heads in milliseconds. They race. Your tests judge. One survives.",
    type: "website",
  },
  icons: {
    icon:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M16 29V17M16 17C16 11 9 11 6 5M16 17C16 11 23 11 26 5M16 17V4' fill='none' stroke='%233cf2b4' stroke-width='2.2' stroke-linecap='round'/%3E%3Ccircle cx='6' cy='5' r='2.4' fill='%233cf2b4'/%3E%3Ccircle cx='16' cy='4' r='2.4' fill='%233cf2b4'/%3E%3Ccircle cx='26' cy='5' r='2.4' fill='%233cf2b4'/%3E%3C/svg%3E",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
