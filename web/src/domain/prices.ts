import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { prices, purchases } from "@/db/schema";
import { getOfficialQuotes, hasOfficialKey } from "@/server/officialQuote";
import { getLivePrices } from "@/server/livePrice";
import { dateKeyKST } from "./money";

/**
 * 일별 종가 적재·조회.
 *
 * TWR과 기간 수익 추이는 "과거 어느 날의 평가액"을 알아야 계산된다.
 * 실시간 시세만 쓰면 그날이 지나는 순간 값이 사라지므로, 볼 때마다 저장해 둔다.
 */

/** 괴리율을 정수로 보관(×100). 0.236% → 24 */
function toBp(premium: number | null | undefined): number | null {
  return premium === null || premium === undefined || !Number.isFinite(premium)
    ? null
    : Math.round(premium * 100);
}

export function fromBp(bp: number | null): number | null {
  return bp === null ? null : bp / 100;
}

/**
 * 현재 시세를 오늘자로 저장한다. 같은 (종목, 날짜)는 덮어쓴다.
 * 공식 API가 있으면 그 기준일로, 없으면 오늘 날짜로 기록한다.
 */
export async function snapshotPrices(tickers: string[]): Promise<number> {
  const list = [...new Set(tickers.filter(Boolean))];
  if (!list.length) return 0;

  type Row = typeof prices.$inferInsert;
  const rows: Row[] = [];

  if (hasOfficialKey()) {
    const official = await getOfficialQuotes(list);
    for (const [ticker, q] of official) {
      if (!q.baseDate || q.baseDate.length !== 8) continue;
      rows.push({
        ticker,
        date: `${q.baseDate.slice(0, 4)}-${q.baseDate.slice(4, 6)}-${q.baseDate.slice(6, 8)}`,
        close: Math.round(q.price),
        nav: q.nav === null ? null : Math.round(q.nav),
        premiumBp: toBp(q.premium),
        volume: q.volume === null ? null : Math.round(q.volume),
        source: "official",
      });
    }
  }

  // 공식 소스로 못 채운 종목은 네이버 값을 오늘 날짜로
  const covered = new Set(rows.map((r) => r.ticker));
  const rest = list.filter((t) => !covered.has(t));
  if (rest.length) {
    const live = await getLivePrices(rest);
    const today = dateKeyKST();
    for (const [ticker, q] of live) {
      rows.push({
        ticker,
        date: today,
        close: Math.round(q.price),
        // 네이버 현재가 행에 전일 기준 공식 NAV를 섞으면 괴리율이 어긋난다 — 공식 값은 위 official 행에서만
        nav: null,
        premiumBp: null,
        volume: null,
        source: "naver",
      });
    }
  }

  if (!rows.length) return 0;

  await db
    .insert(prices)
    .values(rows)
    .onConflictDoUpdate({
      target: [prices.ticker, prices.date],
      set: {
        close: sql`excluded.close`,
        nav: sql`excluded.nav`,
        premiumBp: sql`excluded.premium_bp`,
        volume: sql`excluded.volume`,
        source: sql`excluded.source`,
      },
    });

  return rows.length;
}

/**
 * 특정 날짜 기준으로 각 종목의 "그 날 또는 그 이전 가장 최근" 종가.
 * 휴장일·적재 공백이 있어도 평가액을 만들 수 있다.
 */
export async function priceAsOf(
  tickers: string[],
  date: string,
): Promise<Map<string, number>> {
  const list = [...new Set(tickers.filter(Boolean))];
  const out = new Map<string, number>();
  if (!list.length) return out;

  const rows = await db
    .select({
      ticker: prices.ticker,
      close: prices.close,
      date: prices.date,
    })
    .from(prices)
    .where(and(inArray(prices.ticker, list), lte(prices.date, date)))
    .orderBy(prices.ticker, desc(prices.date));

  for (const r of rows) {
    if (!out.has(r.ticker)) out.set(r.ticker, r.close);
  }
  return out;
}

/** 적재된 날짜 목록 (오래된 순) */
export async function pricedDates(from?: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ date: prices.date })
    .from(prices)
    .where(from ? gte(prices.date, from) : undefined)
    .orderBy(asc(prices.date));
  return rows.map((r) => r.date);
}

export type PriceCoverage = {
  days: number;
  firstDate: string | null;
  lastDate: string | null;
  tickers: number;
};

export async function priceCoverage(): Promise<PriceCoverage> {
  const [row] = await db
    .select({
      days: sql<number>`count(distinct ${prices.date})::int`,
      firstDate: sql<string | null>`min(${prices.date})::text`,
      lastDate: sql<string | null>`max(${prices.date})::text`,
      tickers: sql<number>`count(distinct ${prices.ticker})::int`,
    })
    .from(prices);
  return {
    days: Number(row?.days ?? 0),
    firstDate: row?.firstDate ?? null,
    lastDate: row?.lastDate ?? null,
    tickers: Number(row?.tickers ?? 0),
  };
}

/** 보유한 적 있는 모든 종목 (과거 보유 포함) */
export async function everHeldTickers(): Promise<string[]> {
  const rows = await db.selectDistinct({ t: purchases.ticker }).from(purchases);
  return rows.map((r) => r.t);
}
