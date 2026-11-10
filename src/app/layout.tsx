import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "HoldFast — Clear deals. Confident delivery.", template: "%s | HoldFast" },
  description: "Shape a services deal together, authorize each milestone with PayPal sandbox, and keep people in control of release decisions.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth"><body>{children}</body></html>;
}
