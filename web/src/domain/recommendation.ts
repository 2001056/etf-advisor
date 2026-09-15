import { Category } from "./money";

/**
 * ③ 추천 에이전트의 JSON 출력을 DB 행으로 바꾸는 순수 로직.
 * 모델 출력은 스키마를 줘도 보장이 아니므로 여기서 전부 다시 검증한다.
 */

export const CATEGORY_FROM_KO: Record<string, Category> = {
  배당성장: "div_growth",
  자산성장: "asset_growth",
  고배당: "high_div",
};

/**
 * 모델 출력에서 JSON을 꺼낸다.
 * --output-schema를 줘도 코드펜스나 앞머리 산문이 붙어 오는 경우가 있다.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, ""),
  ];

  const braced = text.match(/[{[][\s\S]*[}\]]/);
  if (braced) candidates.push(braced[0]);

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // 다음 후보
    }
  }
  return null;
}

/** DB의 integer 컬럼에 안전하게 넣기 위한 정수 변환 (모델이 3.7 같은 값을 낼 수 있다) */
export function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return Math.abs(t) <= 2_147_483_647 ? t : null;
}

export function positiveInt(v: unknown): number | null {
  const n = toInt(v);
  return n !== null && n > 0 ? n : null;
}

export function nonNegativeInt(v: unknown): number | null {
  const n = toInt(v);
  return n !== null && n >= 0 ? n : null;
}

export type NormalizedPick = {
  category: Category;
  ticker: string | null;
  etfName: string | null;
  budgetKrw: number;
  refPrice: number | null;
  refQty: number;
  /** 갈아타기(action="switch")일 때만 채워진다. buy/skip은 전부 null */
  sellTicker: string | null;
  sellQty: number | null;
  sellRefPrice: number | null;
  /** 조사 문서에 적혀 있던 원래 가격 — refPrice가 실시간가로 바뀌어도 남는다 */
  researchPrice: number | null;
  sellResearchPrice: number | null;
  /** refPrice가 어디서 온 값인지 */
  priceSource: PriceSource;
  /** 실시간가일 때의 기준 시각 */
  pricedAt: Date | null;
  skipped: boolean;
  rationale: string;
  sourceDocIds: number[];
  sourceUrls: string[];
};

export type PriceSource = "realtime" | "research";

/** 실시간 시세 한 건 — server/livePrice.getRealtimePrices의 결과에서 쓰는 부분만 */
export type RealtimeQuote = { price: number; pricedAt: Date };

export type NormalizeResult = {
  rows: NormalizedPick[];
  dropped: string[];
};

/** 배정액(+매도 예상대금)으로 몇 주를 살 수 있는지 — 정규화·교체·화면이 같은 식을 쓴다 */
export function computeRefQty(
  budget: number,
  proceeds: number,
  price: number,
): number {
  if (!(price > 0)) return 0;
  return Math.floor((budget + proceeds) / price);
}

/**
 * 고배당을 건너뛸 때에만 그 잔액을 배당성장·자산성장에 5:3(기존 50:30 비중)으로 나눈다.
 * 배당성장/자산성장이 건너뛰면 그 몫은 배정하지 않고 고배당에 남겨 이월한다.
 *
 * 배정 금액은 모델 값을 믿지 않고 시스템이 계산한다 — 잔액을 넘겨 쓰는 일이 없어야 한다.
 */
export function allocateBudgets(
  balances: Record<Category, number>,
  skipped: Record<Category, boolean>,
): Record<Category, number> {
  const budgets: Record<Category, number> = { ...balances };
  if (!skipped.high_div) return budgets;

  const pool = balances.high_div;
  if (pool <= 0) return budgets;

  const toDiv = Math.floor((pool * 5) / 8);
  const toAsset = pool - toDiv;

  // 받을 카테고리도 건너뛰면 그 몫은 고배당에 남는다
  if (!skipped.div_growth) budgets.div_growth += toDiv;
  if (!skipped.asset_growth) budgets.asset_growth += toAsset;

  return budgets;
}

/**
 * 모델의 picks를 DB 행으로 정규화한다.
 *
 * - 배정 금액은 모델 값을 믿지 않고 시스템 잔액을 쓴다.
 * - action=skip이거나 종목·가격·수량이 성립하지 않으면 건너뜀으로 저장한다.
 * - source_doc_ids는 실제 주입한 문서 ID만 남긴다.
 */
export function normalizePicks(
  raw: unknown,
  ctx: {
    balances: Record<Category, number>;
    injectedDocIds: number[];
    /** 갈아타기 검증용 현재 보유. (category, ticker) 단위 수량 */
    holdings?: { category: Category; ticker: string; qty: number }[];
  },
): NormalizeResult {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { picks?: unknown[] } | null)?.picks ?? []);

  const injected = new Set(ctx.injectedDocIds);
  const dropped: string[] = [];

  // 1차: 카테고리·종목·가격을 정리하고 건너뜀 여부를 판정한다
  type Draft = {
    category: Category;
    ticker: string | null;
    etfName: string | null;
    refPrice: number | null;
    sellTicker: string | null;
    sellQty: number | null;
    sellRefPrice: number | null;
    skipped: boolean;
    /** 모델이 명시적으로 action="skip"이라고 한 경우에만 true */
    explicitSkip: boolean;
    rationale: string;
    sourceDocIds: number[];
    sourceUrls: string[];
  };
  const drafts: Draft[] = [];

  for (const item of Array.isArray(list) ? list : []) {
    const p = (item ?? {}) as Record<string, unknown>;
    const category = CATEGORY_FROM_KO[String(p.category ?? "").trim()];

    if (!category) {
      dropped.push(
        `알 수 없는 카테고리 '${String(p.category)}' — ${String(p.ticker ?? "")}`,
      );
      continue;
    }

    const price = positiveInt(p.ref_price);
    const ticker = String(p.ticker ?? "").replace(/[^0-9A-Za-z]/g, "");
    const explicitSkip = String(p.action ?? "").trim() === "skip";
    const skipped = explicitSkip || !ticker || price === null;

    // 갈아타기(action="switch"): 팔 종목이 실제 보유와 맞아야만 인정한다.
    // 모델 출력은 보장이 아니므로 여기서 보유 대조 후, 안 맞으면 매수로 강등한다.
    const wantSwitch = String(p.action ?? "").trim() === "switch";
    let sellTicker: string | null = null;
    let sellQty: number | null = null;
    let sellRefPrice: number | null = null;
    if (wantSwitch && !skipped) {
      const st = String(p.sell_ticker ?? "").replace(/[^0-9A-Za-z]/g, "");
      const sq = positiveInt(p.sell_qty);
      const held = ctx.holdings?.find(
        (h) => h.category === category && h.ticker === st,
      );
      if (!st || !sq || !held) {
        dropped.push(
          `갈아타기 무효(보유 확인 실패: '${st || "?"}') → 매수로 강등 — ${ticker}`,
        );
      } else {
        sellTicker = st;
        sellRefPrice = positiveInt(p.sell_ref_price);
        if (sq > held.qty) {
          dropped.push(
            `갈아타기 매도 수량 초과(보유 ${held.qty}주 < ${sq}주) → 보유 전량으로 조정 — ${st}`,
          );
          sellQty = held.qty;
        } else {
          sellQty = sq;
        }
      }
    }

    drafts.push({
      category,
      ticker: skipped ? null : ticker,
      etfName: skipped ? null : String(p.etf_name ?? ""),
      refPrice: skipped ? null : price,
      sellTicker,
      sellQty,
      sellRefPrice,
      skipped,
      explicitSkip,
      rationale: String(p.rationale ?? ""),
      sourceDocIds: Array.isArray(p.source_doc_ids)
        ? p.source_doc_ids.map((n) => Number(n)).filter((n) => injected.has(n))
        : [...injected],
      sourceUrls: Array.isArray(p.source_urls)
        ? p.source_urls.filter((u): u is string => typeof u === "string")
        : [],
    });
  }

  // 2차: 건너뜀 여부가 다 정해진 뒤에 배정 금액과 수량을 시스템이 계산한다.
  //      (고배당 건너뜀이면 그 잔액이 배당성장·자산성장으로 재배분된다)
  const highDiv = drafts.find((d) => d.category === "high_div");
  const skippedMap = {
    // 받을 쪽: pick이 없으면 쓸 곳이 없으니 배정하지 않는다
    div_growth: drafts.find((d) => d.category === "div_growth")?.skipped ?? true,
    asset_growth:
      drafts.find((d) => d.category === "asset_growth")?.skipped ?? true,
    // 줄 쪽: 모델이 명시적으로 skip이라고 한 경우에만 재배분한다.
    // pick이 없거나(출력 불완전) buy인데 가격이 빠진 경우(데이터 오류)까지
    // 재배분하면 실수로 돈이 조용히 옮겨간다.
    high_div: highDiv ? highDiv.explicitSkip : false,
  };
  const budgets = allocateBudgets(ctx.balances, skippedMap);

  const rows: NormalizedPick[] = drafts.map((d) => {
    // 갈아타기는 매도 예상대금(수량×조사가)이 매수 재원에 더해진다.
    // 매도가를 모르면 0으로 두고 배정 잔액만으로 계산한다(보수적).
    const proceeds =
      d.sellTicker && d.sellQty && d.sellRefPrice
        ? d.sellQty * d.sellRefPrice
        : 0;
    // 배정 금액(+매도대금)으로 1주도 못 사면 결국 건너뜀이다
    const qty =
      d.skipped || d.refPrice === null
        ? 0
        : computeRefQty(budgets[d.category], proceeds, d.refPrice);
    const skipped = d.skipped || qty <= 0;

    return {
      category: d.category,
      ticker: skipped ? null : d.ticker,
      etfName: skipped ? null : d.etfName,
      // 건너뛴 카테고리는 재배분 전 자기 잔액을 그대로 보여준다(이월액)
      budgetKrw: skipped ? ctx.balances[d.category] : budgets[d.category],
      refPrice: skipped ? null : d.refPrice,
      refQty: qty,
      sellTicker: skipped ? null : d.sellTicker,
      sellQty: skipped ? null : d.sellQty,
      sellRefPrice: skipped ? null : d.sellRefPrice,
      researchPrice: skipped ? null : d.refPrice,
      sellResearchPrice: skipped ? null : d.sellRefPrice,
      priceSource: "research",
      pricedAt: null,
      skipped,
      rationale: d.rationale,
      sourceDocIds: d.sourceDocIds,
      sourceUrls: d.sourceUrls,
    };
  });

  return { rows, dropped };
}

/** 조사가에서 이만큼 벌어진 실시간가는 오파싱으로 보고 버린다 */
const MAX_PRICE_DRIFT = 0.3;

export function isDrift(price: number, research: number | null): boolean {
  if (research === null || research <= 0) return false;
  return Math.abs(price - research) / research > MAX_PRICE_DRIFT;
}

export type RealtimeApplyResult = {
  rows: NormalizedPick[];
  /** 실시간가를 실제로 갈아끼운 행 수 */
  applied: number;
  /** 갈아끼울 수 있었던 행 수 (건너뛰지 않은 행) */
  eligible: number;
  /** 갈아끼우지 않은 행과 그 이유 */
  excluded: string[];
};

/**
 * 정규화된 추천의 기준가를 추천 시점의 실시간 체결가로 갈아끼운다.
 *
 * 조사 문서의 price는 ②가 웹을 훑은 시점 값이라 몇 분~몇 시간 묵는다. 증권사 앱은
 * KRX 체결가를 보여주므로 그대로 두면 "몇 주 살 수 있는지"가 어긋난다.
 * 실시간가를 못 얻은 종목은 조사 가격을 그대로 둔다. 원값은 researchPrice에 남는다.
 *
 * 갈아끼운 뒤 수량이 0이 되면 그 행은 매수·매도 다리를 모두 되돌린다 —
 * normalizePicks가 세운 "수량 0이면 반드시 건너뜀"을 여기서 깨면 안 되고,
 * 수량 0인 채로 건너뜀이 아닌 행은 잔액 검증이 없는 갈아타기 경로에서 원장을 음수로 만든다.
 */
export function applyRealtimePrices(
  rows: NormalizedPick[],
  quotes: Map<string, RealtimeQuote>,
): RealtimeApplyResult {
  const excluded: string[] = [];
  let applied = 0;
  let eligible = 0;

  const out = rows.map((r) => {
    if (r.skipped || r.ticker === null || r.refPrice === null) return r;
    eligible++;

    const buyRaw = quotes.get(r.ticker);
    const sellRaw = r.sellTicker ? quotes.get(r.sellTicker) : undefined;

    const buyDrift =
      buyRaw !== undefined && isDrift(buyRaw.price, r.researchPrice ?? r.refPrice);
    const sellDrift =
      sellRaw !== undefined &&
      isDrift(sellRaw.price, r.sellResearchPrice ?? r.sellRefPrice);
    if (buyDrift) excluded.push(`${r.ticker} 조사가와 30% 넘게 차이`);
    if (sellDrift) excluded.push(`${r.sellTicker} 매도가가 조사가와 30% 넘게 차이`);

    const buy = buyRaw && !buyDrift ? buyRaw : null;
    const sell = sellRaw && !sellDrift ? sellRaw : null;
    if (!buy && !sell) {
      if (!buyDrift && !sellDrift) excluded.push(`${r.ticker} 실시간가 없음`);
      return r;
    }

    const refPrice = buy ? buy.price : r.refPrice;
    const sellRefPrice = sell ? sell.price : r.sellRefPrice;
    const proceeds =
      r.sellTicker && r.sellQty && sellRefPrice ? r.sellQty * sellRefPrice : 0;
    const refQty = computeRefQty(r.budgetKrw, proceeds, refPrice);

    if (refQty <= 0) {
      excluded.push(`${r.ticker} 실시간가로는 1주도 못 사서 조사가 유지`);
      return r;
    }

    applied++;
    return {
      ...r,
      refPrice,
      sellRefPrice,
      refQty,
      // 매수·매도 어느 다리든 갈아끼웠으면 실시간이다
      priceSource: "realtime" as PriceSource,
      pricedAt: (buy ?? sell)!.pricedAt,
    };
  });

  return { rows: out, applied, eligible, excluded };
}
