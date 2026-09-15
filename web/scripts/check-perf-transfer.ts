/**
 * 고배당 건너뜀 이전(adjust 쌍)이 포트폴리오 납입액을 부풀리지 않는지 검증 (§5 A7).
 * 테이블을 비우므로 검증용 DB에서만 실행할 것.
 *   DATABASE_URL=<test db> pnpm exec tsx scripts/check-perf-transfer.ts
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  agentRuns,
  dividends,
  ledger,
  purchaseCycles,
  purchases,
  recommendations,
  sales,
  settings,
} from "../src/db/schema";
import {
  getBalances,
  runLazyTopup,
  seedInitialBalances,
} from "../src/domain/ledger";
import { addPurchaseWithHighDivTransfer } from "../src/domain/purchases";
import { getPerformance } from "../src/domain/performance";
import { Category } from "../src/domain/money";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok)
    console.log(
      `      기대=${JSON.stringify(expected)}\n      실제=${JSON.stringify(actual)}`,
    );
}

async function reset() {
  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${dividends}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
}

/**
 * 이 스크립트는 테이블을 비운다. 실제로 쓰고 있는 DB를 가리키면 매입 기록과
 * 잔액이 통째로 날아가므로, 데이터가 들어 있으면 실행을 거부한다.
 */
async function guardAgainstRealData() {
  const [row] = await db
    .select({
      n: sql<number>`(select count(*) from ${purchases})::int + (select count(*) from ${settings})::int`,
    })
    .from(sql`(select 1) as _`);

  if (Number(row?.n ?? 0) > 0 && process.env.ALLOW_WIPE !== "1") {
    console.error(
      [
        "이 DB에는 이미 데이터가 있습니다. 검증 스크립트는 테이블을 비우므로 중단합니다.",
        "",
        "  검증용 DB로 실행:",
        "    DATABASE_URL=postgresql://etf_advisor:…@localhost:5433/etf_advisor_test pnpm exec tsx scripts/check-perf-transfer.ts",
        "",
        "  (정말로 이 DB를 비우려면 ALLOW_WIPE=1)",
      ].join("\n"),
    );
    process.exit(2);
  }
}

/** 수정 전 로직(양수만 집계)을 같은 데이터에 그대로 재현한 대조군 */
async function legacyPaidIn(category?: Category): Promise<number> {
  const rows = await db
    .select({ a: ledger.amountKrw, t: ledger.type, c: ledger.category })
    .from(ledger);
  return rows
    .filter((r) => (!category || r.c === category) && (r.t === "topup" || r.t === "adjust") && r.a > 0)
    .reduce((s, r) => s + r.a, 0);
}

async function main() {
  await guardAgainstRealData();

  console.log("=== 시나리오 A: topup 70만 + 이전 14만 + 매입 ===");
  await reset();
  await seedInitialBalances(
    { div_growth: 0, asset_growth: 0, high_div: 0 },
    new Date("2026-08-27T01:00:00Z"), // baseline 2026-08, 시딩 행은 생기지 않는다
  );
  const topupRows = await runLazyTopup(new Date("2026-09-01T05:00:00Z"));
  check("9월 충전 행 수(3카테고리)", topupRows, 3);
  check("충전 직후 잔액", await getBalances(), {
    div_growth: 350_000,
    asset_growth: 210_000,
    high_div: 140_000,
  });

  // 배당성장 잔액 350,000 < 490,000 → 부족분 140,000을 고배당에서 이전
  await addPurchaseWithHighDivTransfer(
    {
      boughtAt: "2026-09-16",
      category: "div_growth",
      ticker: "446720",
      etfName: "SOL 미국배당다우존스",
      qty: 49,
      unitPrice: 10_000,
    },
    { allowTransfer: true },
  );
  check("이전 후 잔액", await getBalances(), {
    div_growth: 0,
    asset_growth: 210_000,
    high_div: 0,
  });

  const perf = await getPerformance({
    marketValue: 500_000,
    cashBalance: 210_000,
    partial: false,
  });
  check("포트폴리오 납입액 = 충전액만", perf.paidIn, 700_000);

  console.log("\n=== 대조군: 수정 전 '양수만 집계'는 같은 데이터에서 부풀었다 ===");
  const legacy = await legacyPaidIn();
  check("양수만 집계 값", legacy, 840_000);
  check("두 값이 실제로 갈린다", legacy !== perf.paidIn, true);
  check("부풀린 폭 = 이전 금액", legacy - perf.paidIn, 140_000);

  console.log("\n=== 시나리오 D: 카테고리별 조회에서는 이전이 유입/유출로 남는다 ===");
  const high = await getPerformance({
    marketValue: 0,
    cashBalance: 0,
    partial: false,
    category: "high_div",
  });
  check("고배당 납입액 = 14만 − 14만", high.paidIn, 0);
  check("대조군(고배당, 양수만)", await legacyPaidIn("high_div"), 140_000);

  const grown = await getPerformance({
    marketValue: 500_000,
    cashBalance: 0,
    partial: false,
    category: "div_growth",
  });
  check("배당성장 납입액 = 35만 + 이전 14만", grown.paidIn, 490_000);

  console.log("\n=== 시나리오 C: 짝 없는 온보딩 시딩은 납입으로 남는다 ===");
  await reset();
  await seedInitialBalances(
    { div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 },
    new Date("2026-08-27T01:00:00Z"),
  );
  const seeded = await getPerformance({
    marketValue: 0,
    cashBalance: 700_000,
    partial: false,
  });
  check("시딩 납입액", seeded.paidIn, 700_000);
  check("대조군(양수만)도 같은 값", await legacyPaidIn(), 700_000);

  console.log("\n=== 시나리오 E: 짝 없는 음수 adjust 는 납입액을 그만큼 줄인다 ===");
  await reset();
  await seedInitialBalances(
    { div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 },
    new Date("2026-08-27T01:00:00Z"),
  );
  // 상대 카테고리에 +행이 없는 단독 출금 — 순액 집계에서는 유출로 남아야 한다
  await db.insert(ledger).values({
    ts: new Date("2026-09-05T01:00:00Z"),
    type: "adjust",
    category: "div_growth",
    amountKrw: -100_000,
    memo: "검증용 단독 출금",
  });
  const withdrawn = await getPerformance({
    marketValue: 0,
    cashBalance: 600_000,
    partial: false,
  });
  check("납입액 = 70만 − 10만", withdrawn.paidIn, 600_000);
  check("대조군(양수만)은 줄지 않는다", await legacyPaidIn(), 700_000);
  const grownAfter = await getPerformance({
    marketValue: 0,
    cashBalance: 250_000,
    partial: false,
    category: "div_growth",
  });
  check("배당성장 납입액 = 35만 − 10만", grownAfter.paidIn, 250_000);

  await reset();
  console.log(
    `\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
