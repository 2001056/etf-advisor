import Link from "next/link";
import { ReactNode } from "react";

export function Card({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      {(title || action) && (
        <header className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Nav({ current }: { current: string }) {
  const items = [
    { href: "/", label: "대시보드" },
    { href: "/purchases", label: "매입 기록" },
    { href: "/switch", label: "갈아타기" },
    { href: "/dividends", label: "분배금" },
    { href: "/docs", label: "조사 문서" },
    { href: "/runs", label: "실행 이력" },
    { href: "/settings", label: "설정" },
  ];
  return (
    <nav className="border-b border-neutral-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center gap-1 px-4 py-3">
        <span className="mr-3 text-sm font-bold">ETF 매입 도우미</span>
        {items.map((it) => (
          <Link
            key={it.href}
            href={it.href}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              current === it.href
                ? "bg-neutral-900 text-white"
                : "text-neutral-600 hover:bg-neutral-100"
            }`}
          >
            {it.label}
          </Link>
        ))}
        <form action="/api/logout" method="post" className="ml-auto">
          <button className="rounded-lg px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100">
            로그아웃
          </button>
        </form>
      </div>
    </nav>
  );
}

export function Page({
  current,
  children,
}: {
  current: string;
  children: ReactNode;
}) {
  return (
    <>
      <Nav current={current} />
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-5 px-4 py-6">
        {children}
      </main>
    </>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-700">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900";

export const buttonClass =
  "rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";

export function Notice({
  kind = "info",
  children,
}: {
  kind?: "info" | "warn" | "error";
  children: ReactNode;
}) {
  const tone = {
    info: "border-blue-200 bg-blue-50 text-blue-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-900",
  }[kind];
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${tone}`}>{children}</div>
  );
}
