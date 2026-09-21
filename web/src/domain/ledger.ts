import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, purchaseCycles, recommendations, settings } from "@/db/schema";
import {
  CATEGORIES,
  Category,
  DEFAULT_MONTHLY_TOPUP,
  monthKeyKST,
  monthsAfter,
  nextMonth,
} from "./money";
import { GrowthRole, normalizeRoleWeights } from "./recommendation";

const BASELINE_KEY = "topup_baseline_month";
const TOPUP_KEY = "monthly_topup";
const GROWTH_ROLES_KEY = "growth_roles";

/** 카테고리별 잔액. 저장하지 않고 항상 원장 합계로 파생한다 (§7). */
export async function getBalances(): Promise<Record<Category, number>> {
  const rows = await db
    .select({
      category: ledger.category,
      balance: sql<number>`coalesce(sum(${ledger.amountKrw}), 0)::int`,
    })
    .from(ledger)
    .groupBy(ledger.category);

  const out = { div_growth: 0, asset_growth: 0, high_div: 0 } as Record<
    Category,
    number
  >;
  for (const r of rows) out[r.category as Category] = Number(r.balance);
  return out;
}

export async function setMonthlyTopup(
  value: Record<Category, number>,
): Promise<void> {
  await db
    .insert(settings)
    .values({ key: TOPUP_KEY, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function getMonthlyTopup(): Promise<Record<Category, number>> {
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, TOPUP_KEY))
    .limit(1);
  if (!row.length) return { ...DEFAULT_MONTHLY_TOPUP };
  return row[0].value as Record<Category, number>;
}

/** 자산성장 두 자리(공격·안정)의 비중. 저장값이 깨져 있으면 기본 50:50으로 읽는다 */
export async function getGrowthRoleWeights(): Promise<
  Record<GrowthRole, number>
> {
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, GROWTH_ROLES_KEY))
    .limit(1);
  return normalizeRoleWeights(row[0]?.value);
}

export async function setGrowthRoleWeights(
  value: Record<GrowthRole, number>,
): Promise<void> {
  await db
    .insert(settings)
    .values({ key: GROWTH_ROLES_KEY, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
}

async function getBaselineMonth(): Promise<string | null> {
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, BASELINE_KEY))
    .limit(1);
  return row.length ? (row[0].value as { month: string }).month : null;
}

/**
 * 밀린 충전을 채운다 (§2.2-3). 요청 처리 중 lazy 호출.
 *
 * 대상 달 = max(마지막 topup month, baseline) 다음 달 ~ 상한.
 * 상한은 (a) 이번 달, (b) 마감된 달의 다음 달 중 더 나중 —
 * 마감을 누르면 다음 달 몫이 하루 뒤 앞당겨 들어오고(결정: 매입 다음날),
 * 마감을 잊어도 달이 바뀌면 자동으로 채워진다.
 *
 * 유니크 인덱스가 멱등을 보장하므로 동시 호출도 안전하다.
 */
export async function runLazyTopup(now = new Date()): Promise<number> {
  const baseline = await getBaselineMonth();
  if (!baseline) return 0; // 온보딩 전에는 아무것도 하지 않는다

  const lastTopup = await db
    .select({ month: ledger.month })
    .from(ledger)
    .where(eq(ledger.type, "topup"))
    .orderBy(desc(ledger.month))
    .limit(1);

  const from =
    lastTopup.length && lastTopup[0].month
      ? lastTopup[0].month > baseline
        ? lastTopup[0].month
        : baseline
      : baseline;

  const thisMonth = monthKeyKST(now);

  // 마감된 가장 최근 달의 다음 달까지는 미리 충전 대상 (매입 다음날 충전 규칙)
  const lastClosed = await db
    .select({ month: purchaseCycles.month, closedAt: purchaseCycles.closedAt })
    .from(purchaseCycles)
    .orderBy(desc(purchaseCycles.month))
    .limit(1);

  let until = thisMonth;
  if (lastClosed.length) {
    const closedNext = nextMonth(lastClosed[0].month);
    // 마감 "다음날"부터 충전 — 마감 당일에는 아직 채우지 않는다
    const dayAfterClose = new Date(lastClosed[0].closedAt);
    dayAfterClose.setUTCDate(dayAfterClose.getUTCDate() + 1);
    if (now >= dayAfterClose && closedNext > until) until = closedNext;
  }

  const targets = monthsAfter(from, until);
  if (!targets.length) return 0;

  const amounts = await getMonthlyTopup();
  const rows = targets.flatMap((month) =>
    CATEGORIES.map((category) => ({
      type: "topup" as const,
      category,
      amountKrw: amounts[category],
      month,
      memo: `${month} 정기 충전`,
    })),
  );

  const inserted = await db
    .insert(ledger)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: ledger.id });

  return inserted.length;
}

/** 온보딩: 현재 잔액을 adjust로 시딩하고 baseline을 기록한다 (§2.2-2). */
export async function seedInitialBalances(
  balances: Record<Category, number>,
  now = new Date(),
): Promise<void> {
  const month = monthKeyKST(now);

  await db.transaction(async (tx) => {
    const rows = CATEGORIES.filter((c) => balances[c] !== 0).map((category) => ({
      type: "adjust" as const,
      category,
      amountKrw: balances[category],
      memo: "온보딩 초기 잔액",
    }));
    if (rows.length) await tx.insert(ledger).values(rows);

    await tx
      .insert(settings)
      .values({ key: BASELINE_KEY, value: { month } })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: { month }, updatedAt: new Date() },
      });
  });
}

export async function isOnboarded(): Promise<boolean> {
  return (await getBaselineMonth()) !== null;
}

/** 이번 달 매입 마감 (§2.2). 마감 다음날 lazy 충전이 다음 달 몫을 채운다. */
export async function closePurchaseCycle(
  month = monthKeyKST(),
  now = new Date(),
): Promise<void> {
  await db
    .insert(purchaseCycles)
    .values({ month, closedAt: now })
    .onConflictDoUpdate({
      target: purchaseCycles.month,
      set: { closedAt: now },
    });
}

export async function getCycle(month = monthKeyKST()) {
  const rows = await db
    .select()
    .from(purchaseCycles)
    .where(eq(purchaseCycles.month, month))
    .limit(1);
  return rows[0] ?? null;
}

/** 그 회차에서 고배당을 건너뛰었는지 — 재배분 허용 여부의 근거 */
export async function wasHighDivSkipped(
  runId: number | null,
): Promise<boolean> {
  if (runId === null) return false;
  const rows = await db
    .select({ skipped: recommendations.skipped })
    .from(recommendations)
    .where(
      and(
        eq(recommendations.runId, runId),
        eq(recommendations.category, "high_div"),
      ),
    )
    .limit(1);
  return rows[0]?.skipped ?? false;
}

export async function getRecommendation(id: number) {
  const rows = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export { and };
