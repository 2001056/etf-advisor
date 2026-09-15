/**
 * 추천 확정 이중 제출 방지 검증 (§5 A1). 검증용 DB에서만 실행할 것 — 테이블을 비운다.
 *   DATABASE_URL=<test db> pnpm exec tsx scripts/check-accept.ts
 */
import { sql } from "drizzle-orm";
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
  acceptedRecommendationIds,
  addPurchase,
  duplicateRecommendationMessage,
  executeSwitch,
} from "../src/domain/purchases";

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
  if ((await acceptedRecommendationIds([recId])).length > 0) {
    return "이 추천은 이미 매입으로 기록되었습니다";
  }
  return messageOf(run);
}

async function main() {
  const [guard] = await db
    .select({ n: sql<number>`(select count(*) from ${purchases})::int + (select count(*) from ${settings})::int` })
    .from(sql`(select 1) as _`);
  if (Number(guard?.n ?? 0) > 0 && process.env.ALLOW_WIPE !== "1") {
    console.error("데이터가 있는 DB입니다. 검증용 DB(etf_advisor_test)에서 실행하세요.");
    process.exit(2);
  }

  console.log("=== 전제: partial unique 인덱스가 걸려 있다 ===");
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

  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
