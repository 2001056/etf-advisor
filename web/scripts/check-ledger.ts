/**
 * 원장·잔액 도메인 로직 실검증 (기획서 §2.2).
 * 실제 DB에 시나리오를 돌린 뒤 전부 롤백하지 않고 정리한다 — 개발용 스크립트.
 *   pnpm run check:ledger
 *
 * 주의: DATABASE_URL은 node --env-file로 주입한다. ES 모듈 import는 호이스팅되어
 * 스크립트 본문의 dotenv 호출보다 DB 풀 생성이 먼저 일어나기 때문.
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  ledger,
  purchaseCycles,
  purchases,
  settings,
} from "../src/db/schema";
import {
  closePurchaseCycle,
  getBalances,
  runLazyTopup,
  seedInitialBalances,
} from "../src/domain/ledger";
import { addPurchase, getHoldings, updatePurchase } from "../src/domain/purchases";
import { formatKRW, monthsAfter } from "../src/domain/money";
import { guardAgainstRealData } from "./lib/guard";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n      기대=${JSON.stringify(expected)} 실제=${JSON.stringify(actual)}`,
  );
}

async function reset() {
  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${purchaseCycles}, ${settings} restart identity cascade`,
  );
}

async function main() {
  await guardAgainstRealData();
  console.log("=== 순수 함수: monthsAfter ===");
  check("2026-08 → 2026-11", monthsAfter("2026-08", "2026-11"), [
    "2026-09",
    "2026-10",
    "2026-11",
  ]);
  check("연말 넘김", monthsAfter("2026-11", "2027-01"), ["2026-12", "2027-01"]);
  check("이미 최신이면 빈 배열", monthsAfter("2026-08", "2026-08"), []);

  await reset();

  console.log("\n=== 시나리오 1: 온보딩 전에는 충전되지 않는다 ===");
  const before = await runLazyTopup(new Date("2026-08-27T01:00:00Z"));
  check("온보딩 전 충전 행 수", before, 0);

  console.log("\n=== 시나리오 2: 온보딩 시딩 ===");
  await seedInitialBalances(
    { div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 },
    new Date("2026-08-27T01:00:00Z"), // KST 2026-08-27 → baseline 2026-08
  );
  check("시딩 직후 잔액", await getBalances(), {
    div_growth: 350_000,
    asset_growth: 210_000,
    high_div: 140_000,
  });

  console.log("\n=== 시나리오 3: 같은 달에는 중복 충전되지 않는다 ===");
  const dup = await runLazyTopup(new Date("2026-08-28T01:00:00Z"));
  check("baseline 당월 재충전 행 수", dup, 0);

  console.log("\n=== 시나리오 4: 매입 → 해당 카테고리만 차감 ===");
  // 배당성장 35만 중 1주 179,030원 → 잔액 170,970원
  const p = await addPurchase({
    boughtAt: "2026-08-18",
    category: "div_growth",
    ticker: "446720",
    etfName: "SOL 미국배당다우존스",
    qty: 1,
    unitPrice: 179_030,
  });
  check("매입 후 잔액", await getBalances(), {
    div_growth: 350_000 - 179_030,
    asset_growth: 210_000,
    high_div: 140_000,
  });

  console.log("\n=== 시나리오 5: 매입 수정 시 원장이 따라 움직인다 ===");
  await updatePurchase(p.id, {
    boughtAt: "2026-08-18",
    category: "div_growth",
    ticker: "446720",
    etfName: "SOL 미국배당다우존스",
    qty: 2, // 1주 → 2주로 정정
    unitPrice: 179_030,
  });
  check("수정 후 잔액", await getBalances(), {
    div_growth: 350_000 - 179_030 * 2,
    asset_growth: 210_000,
    high_div: 140_000,
  });

  console.log("\n=== 시나리오 6: 마감 다음날 충전 (매입 다음날 규칙) ===");
  await closePurchaseCycle("2026-08", new Date("2026-08-20T05:00:00Z"));
  const sameDay = await runLazyTopup(new Date("2026-08-20T09:00:00Z"));
  check("마감 당일에는 충전 없음", sameDay, 0);

  const nextDay = await runLazyTopup(new Date("2026-08-21T05:00:00Z"));
  check("마감 다음날 충전 행 수(3카테고리)", nextDay, 3);
  check("충전 후 잔액(9월 몫 유입)", await getBalances(), {
    div_growth: 350_000 - 179_030 * 2 + 350_000,
    asset_growth: 210_000 + 210_000,
    high_div: 140_000 + 140_000,
  });

  console.log("\n=== 시나리오 7: 재호출해도 중복 충전 없음(멱등) ===");
  check("동일 시점 재호출", await runLazyTopup(new Date("2026-08-22T05:00:00Z")), 0);

  console.log("\n=== 시나리오 8: 매입을 거른 달도 누적된다 ===");
  // 9·10월을 통째로 건너뛰고 11월에 접속 → 10월·11월 몫이 채워져야 함(9월은 이미 있음)
  const skipped = await runLazyTopup(new Date("2026-11-05T05:00:00Z"));
  check("거른 달 보정 행 수(2개월 × 3카테고리)", skipped, 6);
  check("보정 후 배당성장 잔액", (await getBalances()).div_growth,
    350_000 - 179_030 * 2 + 350_000 * 3);

  console.log("\n=== 시나리오 9: 평단가 ===");
  await addPurchase({
    boughtAt: "2026-09-16",
    category: "div_growth",
    ticker: "446720",
    etfName: "SOL 미국배당다우존스",
    qty: 1,
    unitPrice: 200_000,
  });
  const holdings = await getHoldings();
  const sol = holdings.find((h) => h.ticker === "446720")!;
  check("보유수량", sol.qty, 3);
  // (179,030×2 + 200,000) / 3 = 186,020
  check("평단가", sol.avgPrice, Math.round((179_030 * 2 + 200_000) / 3));

  await reset();

  console.log(
    `\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`,
  );
  console.log(`(참고 표시 예: ${formatKRW(186_020)})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
