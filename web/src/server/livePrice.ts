/**
 * 대시보드용 실시간 시세.
 *
 * 조사 문서의 가격은 마지막 조사 시점 스냅샷이라 며칠 묵을 수 있다.
 * 보유 현황을 볼 때만이라도 현재가를 쓰려고 가볍게 한 번 긁어온다.
 *
 * 원칙:
 * - 여러 종목을 한 번의 요청으로 (네이버 폴링 API가 콤마 구분을 지원)
 * - 실패하거나 느리면 조용히 포기하고 조사 문서 값으로 되돌아간다 (대시보드를 막지 않는다)
 * - 짧게 캐시해 새로고침마다 때리지 않는다
 */

import { getOfficialQuotes, hasOfficialKey } from "./officialQuote";

const ENDPOINT = "https://polling.finance.naver.com/api/realtime/domestic/stock";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30_000;

export type LivePrice = {
  ticker: string;
  price: number;
  /** 순자산가치 — 공식 API에서만 온다. 있으면 괴리율을 직접 계산할 수 있다 */
  nav?: number | null;
  /** 괴리율(%) — NAV로 직접 계산한 값 */
  premium?: number | null;
  /** 공식 API의 기준일 YYYYMMDD (일별 종가라 당일이 아닐 수 있다) */
  baseDate?: string;
  /** 어디서 온 값인지 */
  source?: "official" | "naver";
  /** 전일 대비 (원). 알 수 없으면 null */
  change: number | null;
  /** OPEN / CLOSE 등 장 상태 */
  marketStatus: string | null;
  /** 체결 시각 */
  tradedAt: Date;
};

/** 네이버 폴링만 쓴 값 — 장중이면 현재가, 장 마감 뒤면 당일 종가 */
export type RealtimePrice = {
  ticker: string;
  price: number;
  /** 기준 시각 — 응답의 localTradedAt, 없으면 조회 시각 */
  pricedAt: Date;
  change: number | null;
  marketStatus: string | null;
};

type CacheEntry = { at: number; value: LivePrice };
const cache = new Map<string, CacheEntry>();
const realtimeCache = new Map<string, { at: number; value: RealtimePrice }>();

function parseKrw(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 종목별 현재가.
 *
 * 공식 API(공공데이터포털) 키가 있으면 그쪽을 먼저 쓴다 — 비공식 소스가 아니고
 * NAV까지 줘서 괴리율을 직접 계산할 수 있다. 다만 일별 종가라 장중 실시간은 아니다.
 * 키가 없거나 실패한 종목은 네이버로 메운다.
 */
export async function getLivePrices(
  tickers: string[],
): Promise<Map<string, LivePrice>> {
  const out = new Map<string, LivePrice>();
  const now = Date.now();

  const wanted = [...new Set(tickers.filter((t) => /^[0-9A-Z]{5,12}$/i.test(t)))];
  const missing: string[] = [];

  for (const t of wanted) {
    const hit = cache.get(t);
    if (hit && now - hit.at < CACHE_TTL_MS) out.set(t, hit.value);
    else missing.push(t);
  }

  if (missing.length === 0) return out;

  // 공식 API 우선 (키가 있을 때만)
  if (hasOfficialKey()) {
    try {
      const official = await getOfficialQuotes(missing);
      for (const [ticker, q] of official) {
        const value: LivePrice = {
          ticker,
          price: q.price,
          nav: q.nav,
          premium: q.premium,
          source: "official",
          change: q.change,
          // 공식 API는 전 영업일 종가라 장중 상태가 없다
          marketStatus: null,
          baseDate: q.baseDate,
          tradedAt: new Date(),
        };
        cache.set(ticker, { at: now, value });
        out.set(ticker, value);
      }
    } catch {
      // 공식 API 실패 — 아래 네이버로 진행
    }
  }

  const stillMissing = missing.filter((t) => !out.has(t));
  if (stillMissing.length === 0) return out;

  for (const [ticker, r] of await fetchNaver(stillMissing)) {
    const value: LivePrice = {
      ticker,
      price: r.price,
      change: r.change,
      marketStatus: r.marketStatus,
      tradedAt: r.pricedAt,
      source: "naver",
      nav: null,
      premium: null,
    };
    cache.set(ticker, { at: now, value });
    out.set(ticker, value);
  }

  return out;
}

/** 네이버 폴링 한 번. 실패·타임아웃은 조용히 빈 Map. */
async function fetchNaver(tickers: string[]): Promise<Map<string, RealtimePrice>> {
  const out = new Map<string, RealtimePrice>();
  if (tickers.length === 0) return out;

  try {
    const res = await fetch(`${ENDPOINT}/${tickers.join(",")}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return out;

    const body = (await res.json()) as {
      datas?: Array<Record<string, unknown>>;
    };

    for (const row of body.datas ?? []) {
      const ticker = String(row.itemCode ?? "");
      const price = parseKrw(row.closePrice);
      if (!ticker || price === null || price <= 0) continue;

      const tradedRaw = row.localTradedAt;
      const traded =
        typeof tradedRaw === "string" ? new Date(tradedRaw) : new Date();

      out.set(ticker, {
        ticker,
        price,
        change: parseKrw(row.compareToPreviousClosePrice),
        marketStatus:
          typeof row.marketStatus === "string" ? row.marketStatus : null,
        pricedAt: Number.isNaN(traded.getTime()) ? new Date() : traded,
      });
    }
  } catch {
    // 타임아웃·네트워크 실패는 조용히 넘어간다.
  }

  return out;
}

/**
 * 증권사 앱에 보이는 값에 맞추기 위한 실시간 전용 조회.
 *
 * 공식 API는 일별 종가(basDt 기준)라 장중에는 이미 지난 값이다. 그래서 여기서는
 * 공식 API를 건너뛰고 네이버 폴링만 쓴다 — 장중이면 현재가, 장 마감 뒤면 당일 종가.
 * 실패하면 빈 Map을 돌려주고 호출부가 조사 문서 가격을 그대로 쓴다.
 */
export async function getRealtimePrices(
  tickers: string[],
): Promise<Map<string, RealtimePrice>> {
  const out = new Map<string, RealtimePrice>();
  const now = Date.now();

  const wanted = [...new Set(tickers.filter((t) => /^[0-9A-Z]{5,12}$/i.test(t)))];
  const missing: string[] = [];

  for (const t of wanted) {
    const hit = realtimeCache.get(t);
    if (hit && now - hit.at < CACHE_TTL_MS) out.set(t, hit.value);
    else missing.push(t);
  }

  for (const [ticker, value] of await fetchNaver(missing)) {
    realtimeCache.set(ticker, { at: now, value });
    out.set(ticker, value);
  }

  return out;
}
