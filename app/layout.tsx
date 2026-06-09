import type { Metadata } from "next";
import { Newsreader, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Nav from "./Nav";

const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", style: ["normal", "italic"] });
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-jb" });

export const metadata: Metadata = {
  title: "Study OS",
  description: "Your whole semester — understood.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${newsreader.variable} ${hanken.variable} ${mono.variable} antialiased`}>
        <Nav />
        <div className="min-h-dvh">{children}</div>
      </body>
    </html>
  );
}
