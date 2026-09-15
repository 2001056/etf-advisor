import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { dividends, ledger, purchases } from "@/db/schema";
import { CashFlow, roai, xirr } from "./xirr";
import { twr, Valuation } from "./twr";
import { priceAsOf, priceCoverage, pricedDates } from "./prices";
import { Category, dateKeyKST } from "./money";

/**
 * 두 층위의 금액가중수익률(XIRR).
 *
 * **증권 레벨** — 실제로 투자된 돈의 성과.
 *   흐름: 매입(−), 분배금(+), 마지막에 보유 평가액(+).
 *   여기서 분배금은 "들어온 돈"이므로 현금흐름이다.
 *
 * **포트폴리오 레벨** — 내가 넣은 돈 전체의 성과(놀린 잔액 포함).
 *   흐름: 월 충전(−), 마지막에 (보유 평가액 + 남은 잔액)(+).
 *   여기서 분배금은 흐름이 아니라 평가액의 일부다 — 포트폴리오 밖으로 나가지 않았으므로.
 *   재투자로 잔액에 더한 분배금(ledger.adjust)은 **외부 유입이 아니므로 제외**한다.
 *   포함하면 같은 돈이 '수익'과 '신규 납입'으로 이중 계상돼 수익률이 낮게 나온다.
 *
 * 두 값은 서로 다른 질문에 답하므로 하나로 합치면 안 된다.
 * 이 앱은 건너뜀 이월로 잔액이 실제로 노는 구조라 차이가 특히 크다.
 */

export type PerfResult = {
  /** 연환산 수익률(%) */
  annualPct: number | null;
  /** 폴백으로 ROAI를 쓴 경우 true */
  usedFallback: boolean;
  flowCount: number;
  days: number;
};

export type Performance = {
  security: PerfResult;
  portfolio: PerfResult;
  /** 외부에서 넣은 돈의 합계. 카테고리 간 이전은 상쇄돼 들어오지 않는다 */
  paidIn: number;
  /** 시간가중수익률 — 가격 이력이 쌓여야 계산된다 */
  twr: {
    cumulativePct: number;
    annualPct: number | null;
    days: number;
    series: { date: string; cumulativePct: number }[];
  } | null;
  /** TWR을 못 구한 이유 (가격 이력 부족 등) */
  twrReason: string | null;
  /** 현재가를 못 구한 종목이 있으면 지표를 신뢰할 수 없다 */
  partial: boolean;
};

/**
 * 시간가중수익률. 매입일마다 구간을 끊고 그 시점 평가액을 가격 이력에서 복원한다.
 * 가격 이력이 없는 기간은 계산할 수 없다 — 오늘부터 쌓이므로 처음에는 비어 있다.
 */
async function computeTwr(
  marketValue: number,
): Promise<{ result: Performance["twr"]; reason: string | null }> {
  const cov = await priceCoverage();
  if (cov.days < 2) {
    return {
      result: null,
      reason: `가격 이력이 ${cov.days}일치뿐입니다 — 매일 쌓이며 이틀치가 모이면 계산됩니다`,
    };
  }

  const buys = await db
    .select({ d: purchases.boughtAt, a: purchases.amountKrw, t: purchases.ticker, q: purchases.qty })
    .from(purchases)
    .orderBy(asc(purchases.boughtAt));
  if (!buys.length) return { result: null, reason: "매입 기록이 없습니다" };

  // 평가 시점 = 가격이 있는 날 + 매입일 (흐름이 생긴 날)
  const dates = new Set(await pricedDates(cov.firstDate ?? undefined));
  for (const b of buys) if (b.d >= (cov.firstDate ?? "")) dates.add(b.d);
  const sortedDates = [...dates].sort();
  if (sortedDates.length < 2) {
    return { result: null, reason: "평가 시점이 2개 미만입니다" };
  }

  const tickers = [...new Set(buys.map((b) => b.t))];
  const points: Valuation[] = [];

  for (const date of sortedDates) {
    const px = await priceAsOf(tickers, date);
    // 그 날까지 누적 보유 수량으로 평가
    const qty = new Map<string, number>();
    let flow = 0;
    for (const b of buys) {
      if (b.d <= date) qty.set(b.t, (qty.get(b.t) ?? 0) + b.q);
      if (b.d === date) flow += b.a;
    }
    let value = 0;
    let missing = false;
    for (const [t, q] of qty) {
      const p = px.get(t);
      if (p === undefined) missing = true;
      else value += p * q;
    }
    // 마지막 날은 현재 평가액을 쓴다(실시간 시세 반영)
    if (date === sortedDates[sortedDates.length - 1] && marketValue > 0) {
      value = marketValue;
      missing = false;
    }
    if (missing && value === 0) continue;
    points.push({ date, value, netFlow: flow });
  }

  const r = twr(points);
  if (!r) return { result: null, reason: "구간을 만들 수 없습니다" };
  return {
    result: {
      cumulativePct: r.cumulativePct,
      annualPct: r.annualPct,
      days: r.days,
      series: r.series,
    },
    reason: null,
  };
}

function toResult(
  flows: CashFlow[],
  endDate: string,
  totalReturn: number,
): PerfResult {
  const x = xirr(flows);
  if (x) {
    return {
      annualPct: x.rate * 100,
      usedFallback: false,
      flowCount: x.flowCount,
      days: x.days,
    };
  }
  const r = roai(flows, endDate, totalReturn);
  return {
    annualPct: r === null ? null : r * 100,
    usedFallback: r !== null,
    flowCount: flows.length,
    days: 0,
  };
}

/**
 * @param marketValue 보유 ETF 평가액 (현재가 × 수량 합)
 * @param cashBalance 카테고리 잔액 합계
 * @param partial 현재가를 못 구한 종목이 있는지
 */
export async function getPerformance(opts: {
  marketValue: number;
  cashBalance: number;
  partial: boolean;
  category?: Category;
}): Promise<Performance> {
  const today = dateKeyKST();
  const catFilter = opts.category
    ? eq(purchases.category, opts.category)
    : undefined;

  const [buys, divs] = await Promise.all([
    db
      .select({ d: purchases.boughtAt, a: purchases.amountKrw })
      .from(purchases)
      .where(catFilter),
    db
      .select({ d: dividends.receivedAt, a: dividends.amountKrw })
      .from(dividends)
      .where(
        opts.category ? eq(dividends.category, opts.category) : undefined,
      ),
  ]);

  // ── 증권 레벨 ──
  const secFlows: CashFlow[] = [
    ...buys.map((b) => ({ date: b.d, amount: -b.a })),
    ...divs.map((d) => ({ date: d.d, amount: d.a })),
  ];
  const cost = buys.reduce((s, b) => s + b.a, 0);
  const divSum = divs.reduce((s, d) => s + d.a, 0);
  if (opts.marketValue > 0) {
    secFlows.push({ date: today, amount: opts.marketValue });
  }
  const security = toResult(
    secFlows,
    today,
    opts.marketValue - cost + divSum,
  );

  // ── 포트폴리오 레벨 ──
  // 외부 유입 = topup + (재투자가 아닌) adjust. adjust는 양수만이 아니라 순액으로 본다 —
  // 카테고리 간 이전은 한 트랜잭션에서 같은 ts로 −/+ 한 쌍이 남으므로 전체 조회에서는
  // 상쇄되고, 카테고리별 조회에서는 한쪽만 남아 그 카테고리의 유입/유출로 남는다.
  const reinvested = await db
    .select({ id: dividends.refLedgerId })
    .from(dividends)
    .where(sql`${dividends.refLedgerId} is not null`);
  const reinvestedIds = reinvested
    .map((r) => r.id)
    .filter((n): n is number => n !== null);

  const inflows = await db
    .select({
      d: sql<string>`to_char(${ledger.ts} at time zone 'Asia/Seoul', 'YYYY-MM-DD')`,
      a: ledger.amountKrw,
      t: ledger.type,
      id: ledger.id,
      ts: ledger.ts,
    })
    .from(ledger)
    .where(
      opts.category ? eq(ledger.category, opts.category) : undefined,
    );

  const adjustNet = new Map<number, { d: string; a: number }>();
  for (const r of inflows) {
    if (r.t !== "adjust" || reinvestedIds.includes(r.id)) continue;
    const key = r.ts.getTime();
    const g = adjustNet.get(key);
    if (g) g.a += r.a;
    else adjustNet.set(key, { d: r.d, a: r.a });
  }

  const external: { d: string; a: number }[] = [
    ...inflows
      .filter((r) => r.t === "topup" && r.a > 0 && !reinvestedIds.includes(r.id))
      .map((r) => ({ d: r.d, a: r.a })),
    ...[...adjustNet.values()].filter((g) => g.a !== 0),
  ];

  const portFlows: CashFlow[] = external.map((r) => ({
    date: r.d,
    amount: -r.a,
  }));
  const endValue = opts.marketValue + opts.cashBalance;
  if (endValue > 0) portFlows.push({ date: today, amount: endValue });

  const paidIn = external.reduce((s, r) => s + r.a, 0);
  const portfolio = toResult(portFlows, today, endValue - paidIn);

  // 카테고리별 조회에서는 TWR을 계산하지 않는다(구간 정의가 달라진다)
  const { result: twrResult, reason: twrReason } = opts.category
    ? { result: null, reason: null }
    : await computeTwr(opts.marketValue);

  return {
    security,
    portfolio,
    paidIn,
    twr: twrResult,
    twrReason,
    partial: opts.partial,
  };
}
