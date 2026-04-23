import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

/**
 * Inter at the display + body weights we actually use. We load 400/500/600/700
 * only — extra weights slow first paint for no visual gain in a chat UI.
 * JetBrains Mono shows up in only one place (the idempotency hash on the
 * trip confirmation card), but it's cheap enough to keep.
 */
const sans = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Lumo — one app, any task",
  description:
    "Lumo is a conversational agent that books flights, orders food, reserves hotels, and strings them together into one trip.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Lumo — one app, any task",
    description:
      "One conversation. Flights, food, hotels — booked by specialist agents working together.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#F7F7F5",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
