import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Pixelify_Sans } from "next/font/google";
import { ScrollHints, SiteFooter, SiteNav } from "./components";
import { SITE } from "./config";
import "./globals.css";

// Body and buttons: Inter. Code and every number: JetBrains Mono (tabular).
// Pixel type, for words only (wordmark, headings): Pixelify Sans, one face everywhere.
// Its numerals misread at display sizes (5 -> 9, B -> G) and its "fi" ligature reads as "A",
// so globals.css turns ligatures off and numbers never use it.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
});
const pixel = Pixelify_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  variable: "--font-pixelify",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: SITE.title, template: `%s — ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  // Draft until launch: keep everything out of search indexes.
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE.name,
    locale: "en_US",
    url: "/",
    title: SITE.title,
    description: SITE.description,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.title,
    description: SITE.description,
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0b",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

// Runs before paint. Enables JS-only enhancements (e.g. .reveal starting hidden).
const JS_FLAG = "document.documentElement.classList.add('js')";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${mono.variable} ${pixel.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: JS_FLAG }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteNav />
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <SiteFooter />
        <ScrollHints />
      </body>
    </html>
  );
}
