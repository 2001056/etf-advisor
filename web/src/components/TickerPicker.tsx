"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { inputClass } from "./ui";

export type Candidate = {
  ticker: string;
  name: string;
  category: string | null;
  held: boolean;
};

const CATEGORY_LABEL: Record<string, string> = {
  div_growth: "배당성장",
  asset_growth: "자산성장",
  high_div: "고배당",
};

/**
 * 종목 검색 입력칸.
 *
 * 종목코드든 종목명이든 치면 아래에 "종목코드 (종목명)"으로 후보가 뜨고,
 * 고르면 종목명과 구분까지 같이 채워진다 — 다른 화면에서 복붙할 일이 없다.
 */
export default function TickerPicker({
  candidates,
  tickerName = "ticker",
  etfNameName = "etfName",
  categoryName,
  label = "종목",
}: {
  candidates: Candidate[];
  tickerName?: string;
  etfNameName?: string;
  /** 지정하면 고를 때 이 이름의 select/hidden 값도 함께 맞춘다 */
  categoryName?: string;
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const [etfName, setEtfName] = useState("");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? candidates.filter(
          (c) =>
            c.ticker.toLowerCase().includes(q) ||
            c.name.toLowerCase().includes(q),
        )
      : candidates;
    return list.slice(0, 12);
  }, [candidates, query]);

  useEffect(() => setCursor(0), [query]);

  // 바깥을 누르면 닫는다
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (c: Candidate) => {
    setQuery(c.ticker);
    setEtfName(c.name);
    setOpen(false);

    // 구분 select도 같이 맞춰준다
    if (categoryName && c.category) {
      const form = boxRef.current?.closest("form");
      const sel = form?.elements.namedItem(categoryName);
      if (sel instanceof HTMLSelectElement) sel.value = c.category;
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <span className="mb-1 block text-sm font-medium text-neutral-700">
        {label}
      </span>
      <input
        name={tickerName}
        value={query}
        required
        autoComplete="off"
        placeholder="종목코드 또는 이름으로 검색"
        className={inputClass}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            setOpen(true);
            return;
          }
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((i) => (i + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((i) => (i - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(matches[cursor]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />

      {/* 종목명은 고르면 자동으로 채워지지만, 새 종목은 직접 쓸 수 있게 남겨둔다 */}
      <input
        name={etfNameName}
        value={etfName}
        required
        placeholder="종목명"
        className={`${inputClass} mt-2`}
        onChange={(e) => setEtfName(e.target.value)}
      />

      {open && matches.length > 0 && (
        <ul className="absolute left-0 right-0 top-[4.75rem] z-20 max-h-64 overflow-auto rounded-lg border border-neutral-300 bg-white shadow-lg">
          {matches.map((c, i) => (
            <li key={c.ticker}>
              <button
                type="button"
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(c)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                  i === cursor ? "bg-neutral-100" : "bg-white"
                }`}
              >
                <span className="font-mono tabular-nums">{c.ticker}</span>
                <span className="flex-1 truncate text-neutral-700">
                  ({c.name})
                </span>
                {c.category && (
                  <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600">
                    {CATEGORY_LABEL[c.category]}
                  </span>
                )}
                {c.held && (
                  <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
                    보유
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && query.trim() && matches.length === 0 && (
        <div className="absolute left-0 right-0 top-[4.75rem] z-20 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-500 shadow-lg">
          후보에 없는 종목입니다 — 코드와 이름을 직접 입력하세요
        </div>
      )}
    </div>
  );
}
