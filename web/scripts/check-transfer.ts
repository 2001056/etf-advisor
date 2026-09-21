/**
 * 고배당 건너뜀 시 자금 이동 검증 (§2.2 예외). 검증용 DB에서만 실행할 것.
 *   DATABASE_URL=<test db> pnpm exec tsx scripts/check-transfer.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { ledger, purchases, purchaseCycles, settings } from "../src/db/schema";
import { getBalances, seedInitialBalances } from "../src/domain/ledger";
import { addPurchaseWithHighDivTransfer } from "../src/domain/purchases";
import { guardAgainstRealData } from "./lib/guard";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      기대=${JSON.stringify(expected)}\n      실제=${JSON.stringify(actual)}`);
}

async function reset() {
  await db.execute(sql`truncate ${ledger}, ${purchases}, ${purchaseCycles}, ${settings} restart identity cascade`);
  await seedInitialBalances({ div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 });
}

async function main() {
  await guardAgainstRealData();

  console.log("=== 잔액 안에서 사면 이동 없음 ===");
  await reset();
  // 배당성장 350,000 중 300,000어치
  await addPurchaseWithHighDivTransfer(
    { boughtAt: "2026-09-16", category: "div_growth", ticker: "446720", etfName: "A", qty: 20, unitPrice: 15_000 },
    { allowTransfer: true },
  );
  check("배당성장 차감만", await getBalances(), { div_growth: 50_000, asset_growth: 210_000, high_div: 140_000 });

  console.log("\n=== 고배당 건너뜀: 부족분만 고배당에서 끌어온다 ===");
  await reset();
  // 배당성장 잔액 350,000 + 재배분 87,500 = 437,500 → 14,000 × 31주 = 434,000
  await addPurchaseWithHighDivTransfer(
    { boughtAt: "2026-09-16", category: "div_growth", ticker: "446720", etfName: "A", qty: 31, unitPrice: 14_000 },
    { allowTransfer: true },
  );
  const after = await getBalances();
  // 부족분 434,000 - 350,000 = 84,000만 이동
  check("배당성장 0으로", after.div_growth, 0);
  check("고배당은 부족분만 빠짐", after.high_div, 140_000 - 84_000);
  check("자산성장 그대로", after.asset_growth, 210_000);
  check("총액 보존", after.div_growth + after.asset_growth + after.high_div, 700_000 - 434_000);

  console.log("\n=== 이동 내역이 원장에 남는다 ===");
  const rows = await db.select().from(ledger);
  const moves = rows.filter((r) => (r.memo ?? "").includes("고배당 건너뜀"));
  check("이동 행 2건(-/+)", moves.length, 2);
  check("합이 0 (양쪽 대응)", moves.reduce((s, r) => s + r.amountKrw, 0), 0);

  console.log("\n=== 고배당을 건너뛰지 않았으면 초과 매입은 거절 ===");
  await reset();
  let rejected = "";
  try {
    await addPurchaseWithHighDivTransfer(
      { boughtAt: "2026-09-16", category: "div_growth", ticker: "446720", etfName: "A", qty: 31, unitPrice: 14_000 },
      { allowTransfer: false },
    );
  } catch (e) {
    rejected = e instanceof Error ? e.message : String(e);
  }
  check("거절됨", rejected.includes("잔액"), true);
  check("잔액 그대로", await getBalances(), { div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 });

  console.log("\n=== 고배당 잔액으로도 부족하면 거절 ===");
  await reset();
  let rejected2 = "";
  try {
    await addPurchaseWithHighDivTransfer(
      { boughtAt: "2026-09-16", category: "div_growth", ticker: "446720", etfName: "A", qty: 100, unitPrice: 14_000 },
      { allowTransfer: true },
    );
  } catch (e) {
    rejected2 = e instanceof Error ? e.message : String(e);
  }
  check("거절됨", rejected2.includes("고배당 잔액"), true);
  check("이동 없음(롤백)", await getBalances(), { div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 });

  console.log("\n=== 고배당 자신은 끌어올 수 없다 ===");
  await reset();
  let rejected3 = "";
  try {
    await addPurchaseWithHighDivTransfer(
      { boughtAt: "2026-09-16", category: "high_div", ticker: "490600", etfName: "C", qty: 20, unitPrice: 10_000 },
      { allowTransfer: true },
    );
  } catch (e) {
    rejected3 = e instanceof Error ? e.message : String(e);
  }
  check("거절됨", rejected3.length > 0, true);

  await db.execute(sql`truncate ${ledger}, ${purchases}, ${purchaseCycles}, ${settings} restart identity cascade`);
  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
