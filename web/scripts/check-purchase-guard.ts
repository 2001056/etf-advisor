/**
 * 수기 매입 폼 잔액 검증 (§5 A2). 검증용 DB에서만 실행할 것 — 테이블을 비운다.
 *   DATABASE_URL=<test db> pnpm exec tsx scripts/check-purchase-guard.ts
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
import { addManualPurchase } from "../src/domain/purchases";
import { guardAgainstRealData } from "./lib/guard";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(
      `      기대=${JSON.stringify(expected)}\n      실제=${JSON.stringify(actual)}`,
    );
  }
}

async function reset(balances: {
  div_growth: number;
  asset_growth: number;
  high_div: number;
}) {
  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  await seedInitialBalances(balances);
}

async function counts() {
  const r = await db.execute<{ p: number; lp: number }>(sql`select
      (select count(*) from purchases)::int as p,
      (select count(*) from ledger where type='purchase')::int as lp`);
  return r.rows[0];
}

async function messageOf(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const buy = (category: "div_growth" | "high_div", qty: number, price: number) => ({
  boughtAt: "2026-09-16",
  category,
  ticker: "446720",
  etfName: "SOL 미국배당다우존스",
  qty,
  unitPrice: price,
});

async function main() {
  await guardAgainstRealData();

  const seed = { div_growth: 350_000, asset_growth: 0, high_div: 0 };

  console.log("=== 시나리오 1: 잔액 35만에 40만 매입 → 거부 ===");
  await reset(seed);
  const overMsg = await messageOf(() =>
    addManualPurchase(buy("div_growth", 1, 400_000), {
      allowOverBalance: false,
    }),
  );
  check(
    "거부 메시지",
    overMsg,
    '배당성장 잔액(350,000원)보다 큰 금액입니다. 초과 매입이 맞으면 "잔액 초과 허용"을 켜세요',
  );
  const c1 = await counts();
  check("purchases 0행", c1.p, 0);
  check("ledger purchase 0행", c1.lp, 0);
  check("잔액 불변", (await getBalances()).div_growth, 350_000);

  console.log("\n=== 시나리오 2: 허용 플래그를 켜면 통과하고 잔액이 음수가 된다 ===");
  await reset(seed);
  const allowMsg = await messageOf(() =>
    addManualPurchase(buy("div_growth", 1, 400_000), { allowOverBalance: true }),
  );
  check("예외 없음", allowMsg, null);
  const c2 = await counts();
  check("purchases 1행", c2.p, 1);
  check("ledger purchase 1행", c2.lp, 1);
  check("잔액 −5만", (await getBalances()).div_growth, -50_000);

  console.log("\n=== 시나리오 3: 기존 보유분(skipLedger)은 잔액과 무관하게 통과 ===");
  await reset(seed);
  const skipMsg = await messageOf(() =>
    addManualPurchase(
      { ...buy("div_growth", 1, 400_000), skipLedger: true },
      { allowOverBalance: false },
    ),
  );
  check("예외 없음", skipMsg, null);
  const c3 = await counts();
  check("purchases 1행", c3.p, 1);
  check("ledger purchase 0행", c3.lp, 0);
  check("잔액 불변", (await getBalances()).div_growth, 350_000);

  console.log("\n=== 대조군: 잔액 이내 매입은 플래그 없이 통과 ===");
  await reset(seed);
  const okMsg = await messageOf(() =>
    addManualPurchase(buy("div_growth", 1, 300_000), {
      allowOverBalance: false,
    }),
  );
  check("예외 없음", okMsg, null);
  const c4 = await counts();
  check("purchases 1행", c4.p, 1);
  check("ledger purchase 1행", c4.lp, 1);
  check("잔액 5만", (await getBalances()).div_growth, 50_000);

  console.log("\n=== 시나리오 4: 고배당 건너뜀 달의 재배분 매입을 수기로 ===");
  // 고배당을 건너뛴 회차: 배당성장 배정액(35만 + 고배당 14만)이 자기 잔액을 넘는다.
  // 수기 경로는 이전을 하지 않으므로 고배당 잔액은 그대로 남고 배당성장이 음수가 된다.
  await reset({ div_growth: 350_000, asset_growth: 0, high_div: 140_000 });
  const rebalMsg = await messageOf(() =>
    addManualPurchase(buy("div_growth", 1, 490_000), {
      allowOverBalance: false,
    }),
  );
  check(
    "플래그 없이는 거부",
    rebalMsg,
    '배당성장 잔액(350,000원)보다 큰 금액입니다. 초과 매입이 맞으면 "잔액 초과 허용"을 켜세요',
  );
  const rebalOk = await messageOf(() =>
    addManualPurchase(buy("div_growth", 1, 490_000), { allowOverBalance: true }),
  );
  check("허용 플래그로 통과", rebalOk, null);
  check("고배당 잔액은 그대로", (await getBalances()).high_div, 140_000);
  check("배당성장 잔액 −14만", (await getBalances()).div_growth, -140_000);
  const c5 = await counts();
  check("purchases 1행", c5.p, 1);

  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
