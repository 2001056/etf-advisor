/**
 * 보유 종목 시세 폴백 검증 (getQuotes). 검증용 DB에서만 실행할 것 — 테이블을 비운다.
 *   DATABASE_URL=<test db> pnpm run check:quotes
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { purchases, researchDocs, sales, settings } from "../src/db/schema";
import { Category } from "../src/domain/money";
import { getQuotes } from "../src/domain/quotes";

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

async function guardAgainstRealData() {
  const [row] = await db
    .select({
      n: sql<number>`(select count(*) from ${purchases})::int + (select count(*) from ${settings})::int + (select count(*) from ${researchDocs})::int`,
    })
    .from(sql`(select 1) as _`);
  if (Number(row?.n ?? 0) > 0 && process.env.ALLOW_WIPE !== "1") {
    console.error(
      "데이터가 있는 DB입니다. 검증용 DB(etf_advisor_test)에서 실행하세요.",
    );
    process.exit(2);
  }
}

async function reset() {
  await db.execute(
    sql`truncate ${researchDocs}, ${purchases}, ${sales} restart identity cascade`,
  );
}

type Row = [ticker: string, name: string, category: string, price: number, distYield: number];

function tableDoc(date: string, rows: Row[], prose = "요약"): string {
  return `---
run_id: 1
date: ${date}
type: scheduled
tickers: [${rows.map((r) => r[0]).join(", ")}]
---
## 1. 요약
${prose}
## 2. 시장 개관
개관
## 3. 카테고리별 ETF 현황
현황
## 4. 데이터 표
| ticker | name | category | price | dist_yield | premium | note |
|---|---|---|---|---|---|---|
${rows.map(([t, n, c, p, y]) => `| ${t} | ${n} | ${c} | ${p} | ${y} | 0.1 | - |`).join("\n")}
## 5. 이벤트·뉴스
없음
## 6. 리스크 신호
없음
## 7. 출처
없음
`;
}

async function addDoc(
  date: string,
  content: string,
  type: "scheduled" | "ondemand" | "watch" | "consolidate" = "scheduled",
) {
  await db
    .insert(researchDocs)
    .values({ docDate: date, type, title: `${type} ${date}`, content });
}

async function buy(category: Category, ticker: string, qty: number) {
  await db.insert(purchases).values({
    boughtAt: "2026-07-01",
    category,
    ticker,
    etfName: ticker,
    qty,
    unitPrice: 10_000,
    amountKrw: qty * 10_000,
  });
}

async function sell(category: Category, ticker: string, qty: number) {
  await db.insert(sales).values({
    soldAt: "2026-08-20",
    category,
    ticker,
    etfName: ticker,
    qty,
    unitPrice: 10_000,
    amountKrw: qty * 10_000,
    costBasisKrw: qty * 10_000,
    realizedPnlKrw: 0,
  });
}

const DIV: Row = ["446720", "SOL 미국배당다우존스", "배당성장", 14_000, 3.5];
const assetRow = (price: number): Row => ["379800", "KODEX 미국S&P500", "자산성장", price, 1.0];

async function main() {
  await guardAgainstRealData();

  console.log("=== 1. 창 밖 문서에만 표 행이 있는 보유 종목 → 값 채워짐 + stale ===");
  await reset();
  await buy("div_growth", "446720", 10);
  await buy("asset_growth", "379800", 5);
  await addDoc(
    "2026-08-01",
    tableDoc("2026-08-01", [DIV, ["133690", "TIGER 미국나스닥100", "자산성장", 150_000, 0.3]]),
  );
  await addDoc("2026-09-01", tableDoc("2026-09-01", [assetRow(21_000)]));
  await addDoc("2026-09-02", tableDoc("2026-09-02", [assetRow(21_200)]));
  await addDoc("2026-09-03", tableDoc("2026-09-03", [assetRow(21_500)]));
  let q = await getQuotes({ window: 3 });
  const div = q.get("446720");
  check(
    "446720 가격·분배율은 창 밖 08-01 문서 값",
    [div?.price, div?.distYield, div?.priceAsOf, div?.distYieldAsOf],
    [14_000, 3.5, "2026-08-01", "2026-08-01"],
  );
  check("  stale", div?.stale, true);
  check("  분배율 stale", div?.distYieldStale, true);
  const asset = q.get("379800");
  check("379800 은 창 안 최신 문서 값", [asset?.price, asset?.priceAsOf], [21_500, "2026-09-03"]);
  check("  stale 아님", [asset?.stale, asset?.distYieldStale], [false, false]);
  check("대조군: 보유 안 한 133690 은 창 밖 문서에만 있어 값 없음", q.has("133690"), false);

  console.log("\n=== 2. 표 없이 언급만 있는 더 최근 문서 5건을 건너뛰고 표 행 문서를 찾는다 ===");
  for (const d of ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-14"]) {
    await addDoc(
      d,
      tableDoc(
        d,
        [assetRow(20_500)],
        "SOL 미국배당다우존스(446720)는 이번 조사 대상이 아니다. 446720 수치는 싣지 않는다.",
      ),
    );
  }
  q = await getQuotes({ window: 3 });
  check(
    "446720 은 여전히 08-01 표 행 값",
    [q.get("446720")?.price, q.get("446720")?.priceAsOf],
    [14_000, "2026-08-01"],
  );
  const mentionOnly = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${researchDocs} where ${researchDocs.content} ilike '%446720%' and ${researchDocs.docDate} > '2026-08-01'`,
  );
  check("전제: 08-01 보다 최근에 446720 을 언급만 한 문서 5건", mentionOnly.rows[0].n, 5);

  console.log("\n=== 3. 전량 매도한 종목은 폴백 대상이 아니다 ===");
  await reset();
  await buy("high_div", "490600", 10);
  await sell("high_div", "490600", 10);
  await buy("div_growth", "446720", 10);
  await sell("div_growth", "446720", 4);
  await addDoc(
    "2026-08-01",
    tableDoc("2026-08-01", [DIV, ["490600", "RISE 커버드콜", "고배당", 10_000, 10.0]]),
  );
  await addDoc("2026-09-01", tableDoc("2026-09-01", [assetRow(21_000)]));
  q = await getQuotes({ window: 1 });
  check("전량 매도한 490600 은 값 없음", q.has("490600"), false);
  check("대조군: 일부만 판 446720(6주 보유)은 폴백으로 채워짐", q.get("446720")?.price, 14_000);

  console.log("\n=== 4. watch·consolidate 문서가 창을 차지하지 않는다 ===");
  await reset();
  await addDoc("2026-08-29", tableDoc("2026-08-29", [["133690", "TIGER 미국나스닥100", "자산성장", 150_000, 0.3]]));
  await addDoc("2026-08-30", tableDoc("2026-08-30", [assetRow(20_800)]));
  await addDoc("2026-08-31", tableDoc("2026-08-31", [assetRow(20_900)]));
  await addDoc("2026-09-01", tableDoc("2026-09-01", [assetRow(21_000)]));
  for (const d of ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]) {
    await addDoc(d, "## 보유 점검\n379800 보유 유지", "watch");
  }
  await addDoc("2026-09-06", "## 종목 정리\n379800 정리 불필요", "consolidate");
  q = await getQuotes({ window: 3 });
  const a = q.get("379800");
  check("보유 안 한 379800 도 창 안 조사 문서 값", [a?.price, a?.priceAsOf], [21_000, "2026-09-01"]);
  check("  최신 조사 문서(09-01) 기준이라 stale 아님", a?.stale, false);
  check("대조군: 조사 문서 4번째(08-29)의 133690 은 창 밖이라 값 없음", q.has("133690"), false);

  await reset();
  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
