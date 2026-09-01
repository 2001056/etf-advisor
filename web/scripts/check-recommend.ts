/**
 * ③ 추천 출력 정규화 검증 (기획서 §5.3, docs/프롬프트-시스템-계약.md).
 *   pnpm run check:recommend
 */
import {
  allocateBudgets,
  extractJson,
  normalizePicks,
  positiveInt,
  toInt,
} from "../src/domain/recommendation";
import { Category } from "../src/domain/money";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok)
    console.log(`      기대=${JSON.stringify(expected)}\n      실제=${JSON.stringify(actual)}`);
}

const balances: Record<Category, number> = {
  div_growth: 350_000,
  asset_growth: 210_000,
  high_div: 140_000,
};
const ctx = { balances, injectedDocIds: [10, 11, 12] };

console.log("=== JSON 추출 ===");
check("순수 JSON", extractJson('{"picks":[]}'), { picks: [] });
check("```json 펜스", extractJson('```json\n{"picks":[]}\n```'), { picks: [] });
check("언어 태그 없는 펜스", extractJson('```\n{"picks":[]}\n```'), { picks: [] });
check("앞머리 산문", extractJson('결과입니다:\n{"picks":[]}'), { picks: [] });
check("파싱 불가", extractJson("JSON이 아닙니다"), null);

console.log("\n=== 정수 변환 (Postgres integer 컬럼 보호) ===");
check("소수 절삭", toInt(3.7), 3);
check("문자열 숫자", toInt("24"), 24);
check("null", toInt(null), null);
check("빈 문자열", toInt(""), null);
check("0은 유효", toInt(0), 0);
check("positiveInt는 0 거부", positiveInt(0), null);
check("범위 초과 거부", toInt(9_999_999_999), null);

console.log("\n=== 정상 매수 3건 ===");
const buy = normalizePicks(
  {
    picks: [
      {
        category: "배당성장",
        action: "buy",
        ticker: "446720",
        etf_name: "SOL 미국배당다우존스",
        budget_krw: 999,
        ref_price: 14110,
        ref_qty: 24,
        rationale: "근거",
        source_doc_ids: [10, 11],
        source_urls: ["https://a"],
      },
      {
        category: "자산성장",
        action: "buy",
        ticker: "360750",
        etf_name: "TIGER 미국S&P500",
        budget_krw: 0,
        ref_price: 26335,
        ref_qty: 7,
        rationale: "근거",
        source_doc_ids: [10],
        source_urls: [],
      },
      {
        category: "고배당",
        action: "buy",
        ticker: "490600",
        etf_name: "RISE 커버드콜",
        budget_krw: 0,
        ref_price: 9260,
        ref_qty: 15,
        rationale: "근거",
        source_doc_ids: [12],
        source_urls: [],
      },
    ],
  },
  ctx,
);
check("3건 정규화", buy.rows.length, 3);
check("버려진 것 없음", buy.dropped.length, 0);
check("배정 금액은 시스템 잔액으로 덮어씀", buy.rows[0].budgetKrw, 350_000);
check("수량 유지", buy.rows[0].refQty, 24);
check("skipped=false", buy.rows[0].skipped, false);

console.log("\n=== 건너뜀(action=skip): 종목·가격이 null이어도 받아야 함 ===");
const skip = normalizePicks(
  {
    picks: [
      {
        category: "고배당",
        action: "skip",
        ticker: null,
        etf_name: null,
        budget_krw: 5000,
        ref_price: null,
        ref_qty: 0,
        rationale: "1주도 못 삼",
        source_doc_ids: [10],
        source_urls: [],
      },
    ],
  },
  ctx,
);
check("건너뜀 1건 저장됨", skip.rows.length, 1);
check("skipped=true", skip.rows[0].skipped, true);
check("ticker null", skip.rows[0].ticker, null);
check("refPrice null", skip.rows[0].refPrice, null);
check("refQty 0", skip.rows[0].refQty, 0);
check("잔액은 유지", skip.rows[0].budgetKrw, 140_000);

console.log("\n=== 모델이 어긋난 값을 낼 때 ===");
const messy = normalizePicks(
  {
    picks: [
      // action=buy인데 수량이 소수 → 절삭
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14110.6, ref_qty: 24.9, rationale: "", source_doc_ids: [], source_urls: [] },
      // 카테고리 앞뒤 공백 → trim으로 인식
      { category: " 자산성장 ", action: "buy", ticker: "360750", etf_name: "B", ref_price: 26335, ref_qty: 7, rationale: "", source_doc_ids: [], source_urls: [] },
      // 알 수 없는 카테고리 → 버리고 기록
      { category: "채권", action: "buy", ticker: "111111", etf_name: "C", ref_price: 1000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] },
      // action=buy인데 가격 없음 → 건너뜀 처리
      { category: "고배당", action: "buy", ticker: "490600", etf_name: "D", ref_price: null, ref_qty: 15, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  ctx,
);
check("소수 가격 절삭", messy.rows[0].refPrice, 14110);
check("소수 수량 절삭", messy.rows[0].refQty, 24);
check("공백 카테고리 인식", messy.rows[1].category, "asset_growth");
check("알 수 없는 카테고리는 버림", messy.dropped.length, 1);
check("버린 이유 기록", messy.dropped[0].includes("채권"), true);
check("가격 없으면 건너뜀", messy.rows[2].skipped, true);

console.log("\n=== source_doc_ids: 주입 안 한 ID는 버림 ===");
const docs = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 100, ref_qty: 1, rationale: "", source_doc_ids: [10, 99, 12], source_urls: [] },
    ],
  },
  ctx,
);
check("실제 주입 ID만 남김", docs.rows[0].sourceDocIds, [10, 12]);

console.log("\n=== 배열만 온 경우도 받아줌 ===");
const bare = normalizePicks(
  [{ category: "배당성장", action: "skip", ticker: null, etf_name: null, ref_price: null, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] }],
  ctx,
);
check("bare array 처리", bare.rows.length, 1);

console.log("\n=== 잘못된 source_urls 원소는 걸러냄 ===");
const urls = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 100, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: ["https://a", { bad: 1 }, null] },
    ],
  },
  ctx,
);
check("문자열 URL만 남김", urls.rows[0].sourceUrls, ["https://a"]);

// ── 고배당 건너뜀 시 재배분 (§2.2 예외) ──────────────────

console.log("\n=== 배정 계산: 아무도 안 건너뛰면 재배분 없음 ===");
check(
  "잔액 그대로",
  allocateBudgets(balances, { div_growth: false, asset_growth: false, high_div: false }),
  { div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 },
);

console.log("\n=== 고배당만 건너뜀 → 5:3으로 재배분 ===");
// 140,000 × 5/8 = 87,500 → 배당성장, 나머지 52,500 → 자산성장
check(
  "5:3 분배",
  allocateBudgets(balances, { div_growth: false, asset_growth: false, high_div: true }),
  { div_growth: 437_500, asset_growth: 262_500, high_div: 140_000 },
);
check(
  "합계 보존",
  Object.values(
    allocateBudgets(balances, { div_growth: false, asset_growth: false, high_div: true }),
  ).reduce((a, b) => a + b, 0) - 140_000,
  700_000,
);

console.log("\n=== 배당성장만 건너뜀 → 재배분하지 않음 ===");
check(
  "고배당은 그대로",
  allocateBudgets(balances, { div_growth: true, asset_growth: false, high_div: false }),
  { div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 },
);

console.log("\n=== 고배당 + 배당성장 동시 건너뜀 → 자산성장만 받음 ===");
check(
  "받을 곳이 하나면 그 몫만",
  allocateBudgets(balances, { div_growth: true, asset_growth: false, high_div: true }),
  { div_growth: 350_000, asset_growth: 262_500, high_div: 140_000 },
);

console.log("\n=== 셋 다 건너뜀 → 이동 없음 ===");
check(
  "전부 이월",
  allocateBudgets(balances, { div_growth: true, asset_growth: true, high_div: true }),
  { div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 },
);

console.log("\n=== 실제 픽 정규화: 고배당 건너뜀이면 수량이 늘어난다 ===");
const redistributed = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14000, ref_qty: 25, rationale: "", source_doc_ids: [], source_urls: [] },
      { category: "자산성장", action: "buy", ticker: "360750", etf_name: "B", ref_price: 26000, ref_qty: 8, rationale: "", source_doc_ids: [], source_urls: [] },
      { category: "고배당", action: "skip", ticker: null, etf_name: null, ref_price: null, ref_qty: 0, rationale: "6% 넘는 후보 없음", source_doc_ids: [], source_urls: [] },
    ],
  },
  ctx,
);
const byCat = Object.fromEntries(redistributed.rows.map((r) => [r.category, r]));
// 배당성장 437,500 ÷ 14,000 = 31.25 → 31주 (재배분 전이면 25주)
check("배당성장 배정액", byCat.div_growth.budgetKrw, 437_500);
check("배당성장 수량(재배분 반영)", byCat.div_growth.refQty, 31);
// 자산성장 262,500 ÷ 26,000 = 10.09 → 10주 (재배분 전이면 8주)
check("자산성장 배정액", byCat.asset_growth.budgetKrw, 262_500);
check("자산성장 수량(재배분 반영)", byCat.asset_growth.refQty, 10);
// 건너뛴 고배당은 자기 잔액을 이월액으로 표시
check("고배당 이월액", byCat.high_div.budgetKrw, 140_000);
check("고배당 skipped", byCat.high_div.skipped, true);

console.log("\n=== 모델이 낸 수량이 틀려도 시스템이 다시 계산한다 ===");
const wrongQty = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14000, ref_qty: 999, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  ctx,
);
check("잔액 기준으로 재계산", wrongQty.rows[0].refQty, 25); // 350,000 ÷ 14,000

console.log("\n=== 명시적 skip이 아니면 재배분하지 않는다 (돈이 실수로 옮겨가면 안 됨) ===");
// 고배당이 buy인데 가격이 없어 실패한 경우 — 데이터 오류지 건너뜀이 아니다
const brokenHighDiv = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14000, ref_qty: 25, rationale: "", source_doc_ids: [], source_urls: [] },
      { category: "고배당", action: "buy", ticker: "490600", etf_name: "D", ref_price: null, ref_qty: 15, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  ctx,
);
const bhd = Object.fromEntries(brokenHighDiv.rows.map((r) => [r.category, r]));
check("가격 누락은 재배분 트리거 아님", bhd.div_growth.budgetKrw, 350_000);
check("수량도 원래 잔액 기준", bhd.div_growth.refQty, 25);
check("고배당은 건너뜀으로 저장", bhd.high_div.skipped, true);

console.log("\n=== 고배당 pick이 아예 없어도 재배분하지 않는다 ===");
const noHighDiv = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14000, ref_qty: 25, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  ctx,
);
check("배정액 그대로", noHighDiv.rows[0].budgetKrw, 350_000);

console.log("\n=== 1주도 못 사면 건너뜀으로 바뀐다 ===");
const tooPricey = normalizePicks(
  {
    picks: [
      { category: "고배당", action: "buy", ticker: "490600", etf_name: "C", ref_price: 200_000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  ctx,
);
check("가격 > 잔액이면 skip", tooPricey.rows[0].skipped, true);
check("수량 0", tooPricey.rows[0].refQty, 0);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
