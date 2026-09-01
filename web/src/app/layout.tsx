import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ETF 매입 도우미",
  description: "월간 ETF 적립 매수 도우미 (1인용)",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-neutral-50 text-neutral-900">
        {children}
      </body>
    </html>
  );
}
