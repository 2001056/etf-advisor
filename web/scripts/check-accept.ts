/**
 * 추천 확정 이중 제출 방지 검증 (§5 A1). 검증용 DB에서만 실행할 것 — 테이블을 비운다.
 *   DATABASE_URL=<test db> pnpm exec tsx scripts/check-accept.ts
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  agentRuns,
  ledger,
  purchaseCycles,
  purchases,
  recommendations,
  sales,
  settings,
} from "../src/db/schema";
import { getBalances, seedInitialBalances } from "../src/domain/ledger";
import {
  acceptBlockReason,
  acceptedRecommendationIds,
  addPurchase,
  addPurchaseWithHighDivTransfer,
  duplicateRecommendationMessage,
  executeSwitch,
  holdingRoles,
} from "../src/domain/purchases";
import { GrowthRole, normalizePicks } from "../src/domain/recommendation";
import { Category } from "../src/domain/money";
import { guardAgainstRealData } from "./lib/guard";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      기대=${JSON.stringify(expected)}\n      실제=${JSON.stringify(actual)}`);
}

async function reset() {
  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  await seedInitialBalances({ div_growth: 900_000, asset_growth: 0, high_div: 0 });
}

async function newRecommendation(ticker: string) {
  const [row] = await db
    .insert(recommendations)
    .values({
      month: "2026-09",
      category: "div_growth",
      ticker,
      etfName: ticker,
      budgetKrw: 100_000,
      rationale: "검증용",
    })
    .returning();
  return row;
}

async function counts() {
  const r = await db.execute<{
    p: number;
    s: number;
    lp: number;
    ls: number;
  }>(sql`select
      (select count(*) from purchases)::int as p,
      (select count(*) from sales)::int as s,
      (select count(*) from ledger where type='purchase')::int as lp,
      (select count(*) from ledger where type='sell')::int as ls`);
  return r.rows[0];
}

/** 던진 예외를 acceptRecommendationAction 과 같은 규칙으로 사용자 메시지로 바꾼다 */
async function messageOf(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (e) {
    return (
      duplicateRecommendationMessage(e) ??
      (e instanceof Error ? e.message : String(e))
    );
  }
}

/** acceptRecommendationAction 진입부의 선확인과 같은 순서로 확정을 시도한다 */
async function acceptWithGuard(recId: number, run: () => Promise<unknown>) {
  const [rec] = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.id, recId));
  if (!rec) return "추천을 찾을 수 없습니다";
  const blocked = acceptBlockReason(
    rec,
    (await acceptedRecommendationIds([recId])).length > 0,
  );
  if (blocked) return blocked;
  return messageOf(run);
}

async function main() {
  await guardAgainstRealData();

  // acceptRecommendationAction 과 위 acceptWithGuard 가 같은 순수 함수를 부른다.
  // 화면·검증이 따로 판정하다 어긋나는 일이 없도록 여기서 함수 자체를 먼저 고정한다.
  console.log("=== 선확인 순수 함수 acceptBlockReason ===");
  const okRec = { skipped: false, ticker: "446720", sellTicker: null };
  check(
    "건너뛴 추천",
    acceptBlockReason({ ...okRec, skipped: true, ticker: null }, false),
    "건너뛴 추천은 매입 기록으로 옮길 수 없습니다",
  );
  check(
    "옛 갈아타기 행",
    acceptBlockReason({ ...okRec, sellTicker: "379800" }, false),
    "옛 갈아타기 추천입니다. /switch 화면에서 직접 기록하세요",
  );
  check(
    "이미 기록된 추천",
    acceptBlockReason(okRec, true),
    "이 추천은 이미 매입으로 기록되었습니다",
  );
  check("대조군: 막을 이유가 없으면 null", acceptBlockReason(okRec, false), null);
  check(
    "대조군: skipped=false 여도 ticker 가 없으면 막는다",
    acceptBlockReason({ ...okRec, ticker: null }, false),
    "건너뛴 추천은 매입 기록으로 옮길 수 없습니다",
  );

  console.log("\n=== 전제: partial unique 인덱스가 걸려 있다 ===");
  const idx = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where tablename='purchases' and indexname='purchases_one_per_recommendation'`,
  );
  check("purchases_one_per_recommendation 존재", idx.rows.length, 1);

  console.log("\n=== 시나리오 1: 같은 추천으로 두 번 매입 ===");
  await reset();
  const rec = await newRecommendation("446720");
  await addPurchase({
    boughtAt: "2026-09-16",
    category: "div_growth",
    ticker: "446720",
    etfName: "SOL 미국배당다우존스",
    qty: 1,
    unitPrice: 100_000,
    recommendationId: rec.id,
  });
  const dupMsg = await messageOf(() =>
    addPurchase({
      boughtAt: "2026-09-16",
      category: "div_growth",
      ticker: "446720",
      etfName: "SOL 미국배당다우존스",
      qty: 1,
      unitPrice: 100_000,
      recommendationId: rec.id,
    }),
  );
  check("두 번째는 한국어 안내", dupMsg, "이 추천은 이미 매입으로 기록되었습니다");
  check("Postgres 원문 비노출", /duplicate key|insert into/.test(dupMsg ?? ""), false);
  const c1 = await counts();
  check("purchases 1행", c1.p, 1);
  check("ledger purchase 1행", c1.lp, 1);
  check("잔액은 1회분만 차감", (await getBalances()).div_growth, 800_000);

  console.log("\n=== 시나리오 2: 갈아타기 추천으로 두 번 확정 ===");
  await reset();
  const recSwitch = await newRecommendation("490600");
  // 팔 물량을 미리 확보 (수기 매입 — 추천과 무관)
  await addPurchase({
    boughtAt: "2026-09-01",
    category: "div_growth",
    ticker: "379800",
    etfName: "KODEX 미국S&P500",
    qty: 20,
    unitPrice: 20_000,
  });
  await executeSwitch({
    category: "div_growth",
    executedAt: "2026-09-16",
    sell: { ticker: "379800", qty: 5, unitPrice: 20_000 },
    buy: { ticker: "490600", etfName: "PLUS 고배당주", qty: 10, unitPrice: 10_000 },
    recommendationId: recSwitch.id,
  });
  const balAfterSwitch = await getBalances();
  const switchMsg = await messageOf(() =>
    executeSwitch({
      category: "div_growth",
      executedAt: "2026-09-16",
      sell: { ticker: "379800", qty: 5, unitPrice: 20_000 },
      buy: { ticker: "490600", etfName: "PLUS 고배당주", qty: 10, unitPrice: 10_000 },
      recommendationId: recSwitch.id,
    }),
  );
  check("두 번째는 한국어 안내", switchMsg, "이 추천은 이미 매입으로 기록되었습니다");
  const c2 = await counts();
  // 매수 실패가 트랜잭션 전체를 롤백하므로 매도까지 함께 사라진다
  check("sales 1행(매도 롤백)", c2.s, 1);
  check("ledger sell 1행", c2.ls, 1);
  check("purchases 2행(수기 1 + 갈아타기 매수 1)", c2.p, 2);
  check("잔액 불변", await getBalances(), balAfterSwitch);

  console.log("\n=== 시나리오 2-b: 보유 전량을 파는 갈아타기 추천을 두 번 확정 ===");
  await reset();
  const recAll = await newRecommendation("490600");
  await addPurchase({
    boughtAt: "2026-09-01",
    category: "div_growth",
    ticker: "379800",
    etfName: "KODEX 미국S&P500",
    qty: 20,
    unitPrice: 20_000,
  });
  const switchAll = {
    category: "div_growth" as const,
    executedAt: "2026-09-16",
    sell: { ticker: "379800", qty: 20, unitPrice: 20_000 },
    buy: { ticker: "490600", etfName: "PLUS 고배당주", qty: 40, unitPrice: 10_000 },
    recommendationId: recAll.id,
  };
  await executeSwitch(switchAll);
  const balAfterAll = await getBalances();

  // 대조군: 선확인 없이 그대로 다시 실행하면 매도 단계가 먼저 터진다
  const rawMsg = await messageOf(() => executeSwitch(switchAll));
  check("선확인 없이는 보유 메시지", rawMsg, "배당성장 379800 보유분이 없습니다");
  const guardedMsg = await acceptWithGuard(recAll.id, () =>
    executeSwitch(switchAll),
  );
  check("선확인이 있으면 중복 안내", guardedMsg, "이 추천은 이미 매입으로 기록되었습니다");
  check("두 메시지가 실제로 갈린다", rawMsg !== guardedMsg, true);
  const c2b = await counts();
  check("purchases 2행(수기 1 + 갈아타기 매수 1)", c2b.p, 2);
  check("sales 1행", c2b.s, 1);
  check("잔액 불변", await getBalances(), balAfterAll);

  console.log("\n=== 시나리오 3: 자산성장 두 자리를 차례로 기록해도 잔액 검증을 통과한다 ===");
  // 합성 잔액 50만. 두 자리가 25만씩 받으므로 1번을 기록한 뒤에도 2번 배정액이 남는다.
  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  await seedInitialBalances({ div_growth: 0, asset_growth: 500_000, high_div: 0 });

  const seatPicks = normalizePicks(
    {
      picks: [
        { category: "자산성장", action: "buy", role: "aggressive", ticker: "133690", etf_name: "공격 합성 ETF", ref_price: 21_000, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] },
        { category: "자산성장", action: "buy", role: "stable", ticker: "379800", etf_name: "안정 합성 ETF", ref_price: 22_000, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] },
      ],
    },
    {
      balances: { div_growth: 0, asset_growth: 500_000, high_div: 0 } as Record<Category, number>,
      injectedDocIds: [],
      active: ["asset_growth"] as Category[],
    },
  ).rows;
  check("자리 2개로 정규화", seatPicks.map((r) => [r.role, r.budgetKrw, r.refQty]), [
    ["aggressive", 250_000, 11],
    ["stable", 250_000, 11],
  ]);

  const seatRecs = [];
  for (const r of seatPicks) {
    const [row] = await db
      .insert(recommendations)
      .values({
        month: "2026-09",
        category: "asset_growth",
        role: r.role,
        weight: r.weight,
        ticker: r.ticker,
        etfName: r.etfName,
        budgetKrw: r.budgetKrw,
        refPrice: r.refPrice,
        refQty: r.refQty,
        rationale: "검증용",
      })
      .returning();
    seatRecs.push(row);
  }

  const seatMsgs: (string | null)[] = [];
  for (const [i, rec] of seatRecs.entries()) {
    const pickRow = seatPicks[i];
    seatMsgs.push(
      await acceptWithGuard(rec.id, () =>
        addPurchaseWithHighDivTransfer(
          {
            boughtAt: "2026-09-21",
            category: "asset_growth",
            ticker: pickRow.ticker!,
            etfName: pickRow.etfName!,
            qty: pickRow.refQty,
            unitPrice: pickRow.refPrice!,
            recommendationId: rec.id,
          },
          { allowTransfer: false },
        ),
      ),
    );
  }
  check("1번 자리 통과", seatMsgs[0], null);
  check("2번 자리도 통과 (잔액 검증이 순차로 성립)", seatMsgs[1], null);
  check("purchases 2행", (await counts()).p, 2);
  check(
    "잔액 = 50만 − (11×21,000 + 11×22,000)",
    (await getBalances()).asset_growth,
    500_000 - 11 * 21_000 - 11 * 22_000,
  );
  check("잔액이 음수가 되지 않았다", (await getBalances()).asset_growth >= 0, true);
  const seatRoles = await holdingRoles();
  check("보유 종목의 자리를 되찾을 수 있다", [
    seatRoles.get("asset_growth::133690"),
    seatRoles.get("asset_growth::379800"),
  ] as (GrowthRole | undefined)[], ["aggressive", "stable"]);

  console.log("\n=== 대조군: 자리를 안 나누고 각각 잔액 전액으로 사면 두 번째가 막힌다 ===");
  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  await seedInitialBalances({ div_growth: 0, asset_growth: 500_000, high_div: 0 });
  const fullQty = [Math.floor(500_000 / 21_000), Math.floor(500_000 / 22_000)];
  const fullMsgs: (string | null)[] = [];
  for (const [i, t] of ["133690", "379800"].entries()) {
    const [row] = await db
      .insert(recommendations)
      .values({
        month: "2026-09",
        category: "asset_growth",
        ticker: t,
        etfName: t,
        budgetKrw: 500_000,
        rationale: "대조군",
      })
      .returning();
    fullMsgs.push(
      await acceptWithGuard(row.id, () =>
        addPurchaseWithHighDivTransfer(
          {
            boughtAt: "2026-09-21",
            category: "asset_growth",
            ticker: t,
            etfName: t,
            qty: fullQty[i],
            unitPrice: i === 0 ? 21_000 : 22_000,
            recommendationId: row.id,
          },
          { allowTransfer: false },
        ),
      ),
    );
  }
  check("1번은 통과", fullMsgs[0], null);
  check(
    "2번은 잔액 초과로 막힌다",
    fullMsgs[1],
    "자산성장 잔액(17,000원)보다 큰 금액입니다 — 수량을 1주 줄이거나 실제 체결금액에 맞추세요",
  );
  check("purchases 1행만", (await counts()).p, 1);

  console.log("\n=== 대조군: 추천 없는 수기 매입은 몇 건이든 통과 ===");
  await reset();
  const manual1 = await messageOf(() =>
    addPurchase({
      boughtAt: "2026-09-16",
      category: "div_growth",
      ticker: "446720",
      etfName: "SOL 미국배당다우존스",
      qty: 1,
      unitPrice: 100_000,
    }),
  );
  const manual2 = await messageOf(() =>
    addPurchase({
      boughtAt: "2026-09-16",
      category: "div_growth",
      ticker: "446720",
      etfName: "SOL 미국배당다우존스",
      qty: 1,
      unitPrice: 100_000,
    }),
  );
  check("첫 번째 통과", manual1, null);
  check("두 번째도 통과", manual2, null);
  const c3 = await counts();
  check("purchases 2행", c3.p, 2);
  check("ledger purchase 2행", c3.lp, 2);

  console.log("\n=== 시나리오 5: 옛 갈아타기 행(sell_ticker 있음)은 수락되지 않는다 ===");
  await reset();
  const [oldSwitch] = await db
    .insert(recommendations)
    .values({
      month: "2026-09",
      category: "div_growth",
      ticker: "446720",
      etfName: "SOL 미국배당다우존스",
      budgetKrw: 100_000,
      refPrice: 14_000,
      refQty: 7,
      sellTicker: "379800",
      sellQty: 5,
      sellRefPrice: 20_000,
      rationale: "옛 형식",
    })
    .returning();
  const oldSwitchMsg = await acceptWithGuard(oldSwitch.id, () =>
    addPurchase({
      boughtAt: "2026-09-21",
      category: "div_growth",
      ticker: "446720",
      etfName: "SOL 미국배당다우존스",
      qty: 7,
      unitPrice: 14_000,
      recommendationId: oldSwitch.id,
    }),
  );
  check(
    "수락 거부 메시지",
    oldSwitchMsg,
    "옛 갈아타기 추천입니다. /switch 화면에서 직접 기록하세요",
  );
  const c5 = await counts();
  check("purchases 0행", c5.p, 0);
  check("sales 0행", c5.s, 0);
  check("원장 purchase 0행", c5.lp, 0);

  console.log("\n=== 대조군: 같은 행에서 sell_ticker 만 없으면 수락된다 ===");
  await reset();
  const [buyOnly] = await db
    .insert(recommendations)
    .values({
      month: "2026-09",
      category: "div_growth",
      ticker: "446720",
      etfName: "SOL 미국배당다우존스",
      budgetKrw: 100_000,
      refPrice: 14_000,
      refQty: 7,
      rationale: "새 형식",
    })
    .returning();
  const buyMsg = await acceptWithGuard(buyOnly.id, () =>
    addPurchase({
      boughtAt: "2026-09-21",
      category: "div_growth",
      ticker: "446720",
      etfName: "SOL 미국배당다우존스",
      qty: 7,
      unitPrice: 14_000,
      recommendationId: buyOnly.id,
    }),
  );
  check("수락 통과", buyMsg, null);
  check("purchases 1행", (await counts()).p, 1);

  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
