import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WP Plugin Forge",
  description: "Generate production-grade WordPress plugins with a multi-model AI pipeline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
