/**
 * 공식 시세 소스 (공공데이터포털 금융위원회 증권상품시세정보).
 *
 * 네이버 폴링 API는 빠르고 잘 동작하지만 비공식이고 NAV를 주지 않는다.
 * 공식 API는 NAV를 주므로 괴리율을 직접 계산해 검증할 수 있다 (dataChecks.checkPremiumIdentity).
 *
 * 키가 없으면 이 모듈은 아무것도 하지 않고, 호출부가 네이버로 되돌아간다.
 * 키 발급: https://www.data.go.kr/data/15094806/openapi.do (무료·자동승인)
 *
 * 응답 필드는 실호출로 확정했다(2026-08-28, 종목 133690):
 *   basDt srtnCd isinCd itmsNm clpr vs fltRt nav mkp hipr lopr
 *   trqu trPrc mrktTotAmt stLstgCnt bssIdxIdxNm bssIdxClpr nPptTotAmt
 */

const ENDPOINT =
  "https://apis.data.go.kr/1160100/service/GetSecuritiesProductInfoService/getETFPriceInfo";
const TIMEOUT_MS = 4000;

export type OfficialQuote = {
  ticker: string;
  name: string;
  /** 종가(원) */
  price: number;
  /** 순자산가치 — 네이버에는 없는 값. 괴리율 계산의 근거 */
  nav: number | null;
  /** 전일 대비(원) */
  change: number | null;
  /** 등락률(%) */
  changePct: number | null;
  /** 기준일 YYYYMMDD */
  baseDate: string;
  /** 거래량 / 거래대금 */
  volume: number | null;
  tradeValue: number | null;
  /** 순자산총액 — 규모 판단에 쓴다 */
  netAssetTotal: number | null;
  /** 기초지수명 (예: NASDAQ 100) */
  indexName: string;
  /** 괴리율(%) = (종가 − NAV) / NAV × 100. NAV가 있을 때만 */
  premium: number | null;
};

export function hasOfficialKey(): boolean {
  return Boolean(process.env.DATA_GO_KR_KEY);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 응답 한 건을 우리 타입으로. 필드명은 실호출로 확정됐다. */
function mapItem(it: Record<string, unknown>): OfficialQuote | null {
  const ticker = String(it.srtnCd ?? "").replace(/[^0-9A-Za-z]/g, "");
  const price = num(it.clpr);
  if (!ticker || price === null) return null;

  const nav = num(it.nav);
  // 괴리율은 표시값을 받아오지 않고 여기서 직접 계산한다 — 검증 가능한 값이 된다
  const premium =
    nav !== null && nav > 0 ? ((price - nav) / nav) * 100 : null;

  return {
    ticker,
    name: String(it.itmsNm ?? ""),
    price,
    nav,
    change: num(it.vs),
    changePct: num(it.fltRt),
    baseDate: String(it.basDt ?? ""),
    volume: num(it.trqu),
    tradeValue: num(it.trPrc),
    netAssetTotal: num(it.nPptTotAmt),
    indexName: String(it.bssIdxIdxNm ?? ""),
    premium,
  };
}

/** 원본 응답을 그대로 돌려준다 — 필드 매핑 확정용 진단에 쓴다 */
export async function fetchOfficialRaw(
  params: Record<string, string>,
): Promise<unknown> {
  const key = process.env.DATA_GO_KR_KEY;
  if (!key) throw new Error("DATA_GO_KR_KEY가 설정되지 않았습니다");

  const qs = new URLSearchParams({
    serviceKey: decodeURIComponent(key),
    resultType: "json",
    numOfRows: "100",
    ...params,
  });

  const res = await fetch(`${ENDPOINT}?${qs}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 지정한 종목들의 공식 시세. 실패하면 빈 Map — 호출부가 네이버로 되돌아간다.
 * 일별 데이터라 장중 실시간은 아니다(전 영업일 종가 기준).
 */
export async function getOfficialQuotes(
  tickers: string[],
  baseDate?: string,
): Promise<Map<string, OfficialQuote>> {
  const out = new Map<string, OfficialQuote>();
  if (!hasOfficialKey() || tickers.length === 0) return out;

  for (const ticker of [...new Set(tickers)]) {
    try {
      const body = (await fetchOfficialRaw({
        likeSrtnCd: ticker,
        ...(baseDate ? { basDt: baseDate } : {}),
      })) as {
        response?: { body?: { items?: { item?: unknown } } };
      };

      const raw = body?.response?.body?.items?.item;
      const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
      // 같은 종목의 여러 날짜가 오면 가장 최근 것
      const mapped = items
        .map((i) => mapItem(i as Record<string, unknown>))
        .filter((q): q is OfficialQuote => q !== null)
        .sort((a, b) => b.baseDate.localeCompare(a.baseDate));

      if (mapped[0]) out.set(mapped[0].ticker, mapped[0]);
    } catch {
      // 이 종목만 건너뛴다 — 나머지는 계속 시도
    }
  }

  return out;
}
