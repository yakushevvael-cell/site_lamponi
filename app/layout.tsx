import type { Metadata } from "next";
import "./globals.css";
import { SiteFrame } from "@/components/site-frame";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Lamponi Hub — остатки и аналитика",
  description:
    "Единый центр управления остатками и аналитикой маркетплейсов Lamponi.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">
        <SiteFrame>{children}</SiteFrame>
        <Toaster position="top-right" richColors />
      </body>
    </html>
  );
}
