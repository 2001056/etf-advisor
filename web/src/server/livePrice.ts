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
 * - 공식 API(느리고 전일 기준)는 렌더를 막지 않고 백그라운드로 받아 NAV·괴리율만 덧붙인다
 */

import { getOfficialQuotes, hasOfficialKey } from "./officialQuote";

const ENDPOINT = "https://polling.finance.naver.com/api/realtime/domestic/stock";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 30_000;
/** 공식 API(공공데이터포털)는 전 영업일 종가·NAV라 30초 캐시가 의미 없다. 6시간 캐시. */
const OFFICIAL_TTL_MS = 6 * 60 * 60 * 1000;

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

/** 공식 API에서 받은 NAV·괴리율·기준일. 가격은 여기서 쓰지 않는다(전일 종가라 장중엔 묵은 값). */
type OfficialEntry = {
  at: number;
  nav: number | null;
  premium: number | null;
  baseDate?: string;
};
const officialCache = new Map<string, OfficialEntry>();
const officialInflight = new Set<string>();

/**
 * 공식 API를 백그라운드로 갱신한다 — 종목별 병렬, 실패는 조용히, 같은 종목 중복 호출 방지.
 * 대시보드는 이 결과를 기다리지 않고, 다음 렌더부터 캐시에 있는 값을 붙여 보여준다.
 * (이전에는 렌더가 종목별 순차 호출을 기다려 종목당 1~5초씩 막혔다 — 2026-09-16 실측)
 */
function refreshOfficialInBackground(tickers: string[]): void {
  const targets = tickers.filter((t) => !officialInflight.has(t));
  if (targets.length === 0) return;
  for (const t of targets) officialInflight.add(t);
  void Promise.allSettled(
    targets.map(async (t) => {
      try {
        const q = (await getOfficialQuotes([t])).get(t);
        if (q) {
          officialCache.set(t, {
            at: Date.now(),
            nav: q.nav,
            premium: q.premium,
            baseDate: q.baseDate,
          });
        }
      } catch {
        // 공식 API 실패·타임아웃은 조용히. 다음 렌더 때 다시 시도한다.
      } finally {
        officialInflight.delete(t);
      }
    }),
  );
}
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

  // 1) 네이버 — 한 번의 요청으로 즉시. 대시보드를 막지 않는다.
  if (missing.length > 0) {
    for (const [ticker, r] of await fetchNaver(missing)) {
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
  }

  // 2) 공식 API의 NAV·괴리율은 캐시에 있으면 붙이고, 없거나 낡았으면 백그라운드로 갱신한다.
  //    가격 자체는 네이버 값을 유지한다(공식 API는 전 영업일 종가).
  if (hasOfficialKey()) {
    const stale = wanted.filter((t) => {
      const o = officialCache.get(t);
      return !o || now - o.at >= OFFICIAL_TTL_MS;
    });
    if (stale.length > 0) refreshOfficialInBackground(stale);
    for (const [t, v] of out) {
      const o = officialCache.get(t);
      if (o) {
        v.nav = o.nav;
        v.premium = o.premium;
        v.baseDate = o.baseDate;
      }
    }
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
