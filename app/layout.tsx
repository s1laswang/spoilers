import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Spoilers",
  description: "Your AI agent test-drives a hackathon weekend with each team before you join.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
