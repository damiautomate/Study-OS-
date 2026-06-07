import type { Metadata } from "next";
import { Fraunces, Hanken_Grotesk } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  axes: ["opsz", "SOFT"],
});
const hanken = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-hanken" });

export const metadata: Metadata = {
  title: "Study OS",
  description: "Bring your courses into one place, understood.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${hanken.variable} antialiased`}>
        <div className="min-h-dvh">{children}</div>
      </body>
    </html>
  );
}
