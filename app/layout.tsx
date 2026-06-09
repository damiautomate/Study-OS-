import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Schibsted_Grotesk, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";
import Nav from "./Nav";

const brico = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-brico" });
const schibsted = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-schibsted" });
const splineMono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-spline-mono" });

export const metadata: Metadata = {
  title: "Study OS",
  description: "Your whole semester — understood.",
};

export const viewport: Viewport = {
  themeColor: "#fbf7f0",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${brico.variable} ${schibsted.variable} ${splineMono.variable} antialiased`}>
        <Nav />
        <div className="min-h-dvh pb-20 sm:pb-0">{children}</div>
      </body>
    </html>
  );
}
