import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-serif",
});

// Absolute base for OG/canonical URLs. Vercel exposes the production domain
// at build time; NEXT_PUBLIC_SITE_URL overrides it (e.g. a custom domain).
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

const description =
  "Free webhook inspector. Get a temporary URL, watch every HTTP request that hits it arrive live, inspect headers and body, and replay it anywhere.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "hookscope: webhook inspector",
    template: "%s",
  },
  description,
  applicationName: "hookscope",
  keywords: ["webhook", "requestbin", "webhook tester", "http inspector", "replay", "debugging"],
  openGraph: {
    type: "website",
    title: "hookscope: catch every webhook, inspect it, replay it",
    description,
    siteName: "hookscope",
  },
  twitter: {
    card: "summary_large_image",
    title: "hookscope: webhook inspector",
    description,
  },
};

export const viewport: Viewport = {
  themeColor: "#090c09",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexMono.variable} ${instrumentSerif.variable}`}>
      <body>
        <div className="scanlines" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
