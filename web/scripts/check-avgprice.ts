/** 평단가 자동 조정 검증 — 검증용 DB에서만 실행 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { ledger, purchases, settings } from "../src/db/schema";
import { seedInitialBalances } from "../src/domain/ledger";
import { addPurchase, getHoldings, deletePurchase, updatePurchase, listPurchases } from "../src/domain/purchases";

let failed = 0;
function check(l: string, a: unknown, e: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}  ${ok ? a : `기대=${e} 실제=${a}`}`);
}

async function main() {
  const g = await db.select({ n: sql<number>`(select count(*) from ${purchases})::int` }).from(sql`(select 1) as _`);
  if (Number(g[0]?.n ?? 0) > 0 && process.env.ALLOW_WIPE !== "1") {
    console.error("데이터가 있는 DB입니다."); process.exit(2);
  }
  await db.execute(sql`truncate ${ledger}, ${purchases}, ${settings} restart identity cascade`);
  await seedInitialBalances({ div_growth: 10_000_000, asset_growth: 10_000_000, high_div: 10_000_000 });

  const B = { category: "div_growth" as const, ticker: "446720", etfName: "SOL 미국배당다우존스" };
  const hold = async () => (await getHoldings()).find((h) => h.ticker === "446720");

  console.log("=== 1회차: 10주 × 13,000 ===");
  await addPurchase({ ...B, boughtAt: "2026-06-16", qty: 10, unitPrice: 13_000 });
  check("보유수량", (await hold())?.qty, 10);
  check("평단가", (await hold())?.avgPrice, 13_000);

  console.log("\n=== 2회차: 10주 × 15,000 (같은 종목 추가 매입) ===");
  await addPurchase({ ...B, boughtAt: "2026-07-16", qty: 10, unitPrice: 15_000 });
  // (130,000 + 150,000) / 20 = 14,000
  check("보유수량 합산", (await hold())?.qty, 20);
  check("평단가 재계산", (await hold())?.avgPrice, 14_000);
  check("매입원금 누적", (await hold())?.costKrw, 280_000);

  console.log("\n=== 3회차: 5주 × 20,000 (수량이 다를 때 가중평균) ===");
  await addPurchase({ ...B, boughtAt: "2026-08-16", qty: 5, unitPrice: 20_000 });
  // (280,000 + 100,000) / 25 = 15,200
  check("보유수량", (await hold())?.qty, 25);
  check("가중평균 평단가", (await hold())?.avgPrice, 15_200);

  console.log("\n=== 매입 기록을 고치면 평단가도 따라 바뀐다 ===");
  const rows = await listPurchases(10);
  const second = rows.find((r) => r.boughtAt === "2026-07-16")!;
  await updatePurchase(second.id, {
    boughtAt: "2026-07-16", category: "div_growth", ticker: "446720",
    etfName: "SOL 미국배당다우존스", qty: 10, unitPrice: 17_000, memo: null,
  });
  // (130,000 + 170,000 + 100,000) / 25 = 16,000
  check("수정 후 평단가", (await hold())?.avgPrice, 16_000);

  console.log("\n=== 매입 기록을 지우면 그만큼 빠진다 ===");
  await deletePurchase(second.id);
  // (130,000 + 100,000) / 15 = 15,333.33 → 반올림 15,333
  check("삭제 후 보유수량", (await hold())?.qty, 15);
  check("삭제 후 평단가", (await hold())?.avgPrice, 15_333);

  console.log("\n=== 같은 종목을 다른 카테고리에서 사면 따로 잡힌다 ===");
  await addPurchase({ category: "high_div", ticker: "446720", etfName: "SOL 미국배당다우존스",
    boughtAt: "2026-08-16", qty: 10, unitPrice: 9_000 });
  const all = (await getHoldings()).filter((h) => h.ticker === "446720");
  check("행이 2개", all.length, 2);
  check("배당성장 평단가 유지", all.find((h) => h.category === "div_growth")?.avgPrice, 15_333);
  check("고배당 평단가 별도", all.find((h) => h.category === "high_div")?.avgPrice, 9_000);

  await db.execute(sql`truncate ${ledger}, ${purchases}, ${settings} restart identity cascade`);
  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
