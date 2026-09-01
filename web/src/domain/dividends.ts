import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dividends, ledger, purchases } from "@/db/schema";
import { CATEGORIES, Category } from "./money";

export type DividendInput = {
  receivedAt: string;
  category: Category;
  ticker: string;
  etfName: string;
  /** 세후 실수령액 */
  amountKrw: number;
  /** 세전 총액 (모르면 생략) */
  grossKrw?: number | null;
  /** 원천징수 세액 (모르면 생략) */
  taxKrw?: number | null;
  memo?: string | null;
  /** 재투자용으로 잔액에 더할지 */
  addToBalance?: boolean;
};

/**
 * 분배금 기록. 기본은 총수익 집계용이고 잔액은 건드리지 않는다.
 * addToBalance면 같은 트랜잭션에서 ledger에 adjust 행을 만들어 잔액을 올린다.
 */
export async function addDividend(input: DividendInput) {
  return db.transaction(async (tx) => {
    let refLedgerId: number | null = null;

    if (input.addToBalance) {
      const [led] = await tx
        .insert(ledger)
        .values({
          type: "adjust",
          category: input.category,
          amountKrw: input.amountKrw,
          memo: `분배금 재투자 — ${input.etfName}`,
        })
        .returning({ id: ledger.id });
      refLedgerId = led.id;
    }

    const [row] = await tx
      .insert(dividends)
      .values({
        receivedAt: input.receivedAt,
        category: input.category,
        ticker: input.ticker.trim(),
        etfName: input.etfName.trim(),
        amountKrw: input.amountKrw,
        grossKrw: input.grossKrw ?? null,
        taxKrw: input.taxKrw ?? null,
        refLedgerId,
        memo: input.memo ?? null,
      })
      .returning();

    return row;
  });
}

/** 분배금 삭제 — 잔액에 더했던 것이면 그 ledger 행도 함께 지운다 */
export async function deleteDividend(id: number) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(dividends).where(eq(dividends.id, id));
    if (!row) return;
    if (row.refLedgerId) {
      await tx.delete(ledger).where(eq(ledger.id, row.refLedgerId));
    }
    await tx.delete(dividends).where(eq(dividends.id, id));
  });
}

/** 세전·세액 합계. 세전을 모르는 기록은 세후로 대체한다 */
export async function dividendTotals(): Promise<{
  net: number;
  gross: number;
  tax: number;
  /** 세전을 모르는 기록 수 — 세전 합계가 과소평가된다는 뜻 */
  unknownGross: number;
}> {
  const [row] = await db
    .select({
      net: sql<number>`coalesce(sum(${dividends.amountKrw}), 0)::int`,
      gross: sql<number>`coalesce(sum(coalesce(${dividends.grossKrw}, ${dividends.amountKrw})), 0)::int`,
      tax: sql<number>`coalesce(sum(coalesce(${dividends.taxKrw}, 0)), 0)::int`,
      unknownGross: sql<number>`count(*) filter (where ${dividends.grossKrw} is null)::int`,
    })
    .from(dividends);
  return {
    net: Number(row?.net ?? 0),
    gross: Number(row?.gross ?? 0),
    tax: Number(row?.tax ?? 0),
    unknownGross: Number(row?.unknownGross ?? 0),
  };
}

export async function listDividends(limit = 200) {
  return db
    .select()
    .from(dividends)
    .orderBy(desc(dividends.receivedAt), desc(dividends.id))
    .limit(limit);
}

/** 종목별 누적 분배금 — 보유 현황 표에 붙인다 */
export async function dividendsByTicker(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      key: sql<string>`${dividends.category} || ':' || ${dividends.ticker}`,
      total: sql<number>`sum(${dividends.amountKrw})::int`,
    })
    .from(dividends)
    .groupBy(dividends.category, dividends.ticker);
  return new Map(rows.map((r) => [r.key, Number(r.total)]));
}

export type ReturnSummary = {
  /** 매입에 쓴 원금 */
  costKrw: number;
  /** 현재가로 평가한 금액 (가격을 못 구한 종목은 빠진다) */
  valueKrw: number;
  /** 평가액을 못 구한 종목이 있으면 true — 총수익이 부분값이라는 뜻 */
  partial: boolean;
  /** 평가손익 = 평가액 − 원금 */
  unrealizedKrw: number;
  /** 받은 분배금 누적 */
  dividendKrw: number;
  /** 총수익 = 평가손익 + 분배금 */
  totalReturnKrw: number;
  /** 총수익률 = 총수익 ÷ 원금 */
  totalReturnPct: number | null;
};

/**
 * 총수익 요약.
 * 평가액은 호출부가 현재가를 알고 있으므로 인자로 받는다(실시간 시세 + 조사 문서 폴백).
 */
export async function returnSummary(
  holdings: { category: string; ticker: string; qty: number; costKrw: number }[],
  priceOf: (ticker: string) => number | null,
): Promise<ReturnSummary> {
  const [divRow] = await db
    .select({ total: sql<number>`coalesce(sum(${dividends.amountKrw}), 0)::int` })
    .from(dividends);
  const dividendKrw = Number(divRow?.total ?? 0);

  let costKrw = 0;
  let valueKrw = 0;
  let partial = false;

  for (const h of holdings) {
    costKrw += h.costKrw;
    const p = priceOf(h.ticker);
    if (p === null) {
      partial = true;
      // 가격을 모르면 원금으로 대신 세워 손익을 0으로 둔다 (없는 수익을 만들지 않는다)
      valueKrw += h.costKrw;
    } else {
      valueKrw += p * h.qty;
    }
  }

  const unrealizedKrw = valueKrw - costKrw;
  const totalReturnKrw = unrealizedKrw + dividendKrw;

  return {
    costKrw,
    valueKrw,
    partial,
    unrealizedKrw,
    dividendKrw,
    totalReturnKrw,
    totalReturnPct: costKrw > 0 ? (totalReturnKrw / costKrw) * 100 : null,
  };
}

export { purchases };

/** 카테고리별 수익 — 주가 손익과 배당 수익을 따로, 그리고 합쳐서 */
export type CategoryReturn = {
  category: Category;
  costKrw: number;
  valueKrw: number;
  /** 현재가를 못 구한 종목이 섞였는지 */
  partial: boolean;
  /** 주가가 오르내려 생긴 손익 */
  priceGainKrw: number;
  /** 받은 분배금 */
  dividendKrw: number;
  /** 둘을 합친 수익 */
  totalKrw: number;
  priceGainPct: number | null;
  dividendPct: number | null;
  totalPct: number | null;
};

/**
 * 카테고리별 + 전체 수익 현황.
 * 분배금은 잔액에 더하지 않고 수익으로만 잡는다.
 */
export async function returnByCategory(
  holdings: { category: string; ticker: string; qty: number; costKrw: number }[],
  priceOf: (ticker: string) => number | null,
): Promise<{ rows: CategoryReturn[]; total: CategoryReturn }> {
  const divRows = await db
    .select({
      category: dividends.category,
      total: sql<number>`sum(${dividends.amountKrw})::int`,
    })
    .from(dividends)
    .groupBy(dividends.category);
  const divByCat = new Map(divRows.map((r) => [r.category, Number(r.total)]));

  const pct = (part: number, base: number) =>
    base > 0 ? (part / base) * 100 : null;

  const rows: CategoryReturn[] = CATEGORIES.map((c) => {
    const hs = holdings.filter((h) => h.category === c);
    let costKrw = 0;
    let valueKrw = 0;
    let partial = false;

    for (const h of hs) {
      costKrw += h.costKrw;
      const p = priceOf(h.ticker);
      if (p === null) {
        partial = true;
        valueKrw += h.costKrw; // 모르는 값으로 손익을 만들지 않는다
      } else {
        valueKrw += p * h.qty;
      }
    }

    const priceGainKrw = valueKrw - costKrw;
    const dividendKrw = divByCat.get(c) ?? 0;
    const totalKrw = priceGainKrw + dividendKrw;

    return {
      category: c,
      costKrw,
      valueKrw,
      partial,
      priceGainKrw,
      dividendKrw,
      totalKrw,
      priceGainPct: pct(priceGainKrw, costKrw),
      dividendPct: pct(dividendKrw, costKrw),
      totalPct: pct(totalKrw, costKrw),
    };
  });

  const sum = (f: (r: CategoryReturn) => number) =>
    rows.reduce((a, r) => a + f(r), 0);
  const costKrw = sum((r) => r.costKrw);
  const priceGainKrw = sum((r) => r.priceGainKrw);
  const dividendKrw = sum((r) => r.dividendKrw);
  const totalKrw = priceGainKrw + dividendKrw;

  return {
    rows,
    total: {
      category: "div_growth", // 합계 행에서는 쓰이지 않는다
      costKrw,
      valueKrw: sum((r) => r.valueKrw),
      partial: rows.some((r) => r.partial),
      priceGainKrw,
      dividendKrw,
      totalKrw,
      priceGainPct: pct(priceGainKrw, costKrw),
      dividendPct: pct(dividendKrw, costKrw),
      totalPct: pct(totalKrw, costKrw),
    },
  };
}
