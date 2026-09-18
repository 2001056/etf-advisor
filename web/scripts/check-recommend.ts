/**
 * ③ 추천 출력 정규화 검증 (기획서 §5.3, docs/프롬프트-시스템-계약.md).
 *   pnpm run check:recommend
 */
import {
  activeBalances,
  activeCategories,
  activeCategoriesLine,
  activeHoldings,
  allocateBudgets,
  applyRealtimePrices,
  budgetLine,
  computeRefQty,
  extractJson,
  holdingLine,
  isDrift,
  normalizePicks,
  positiveInt,
  recommendOutputRules,
  researchTickers,
  toInt,
} from "../src/domain/recommendation";
import { Category, isMarketOpenKST } from "../src/domain/money";
import { buildFormatInstruction, parseResearchDoc } from "../src/domain/docFormat";

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

console.log("\n=== 기준가를 실시간 체결가로 교체 ===");
const pricedAt = new Date("2026-09-15T15:24:00+09:00");
// 고배당을 건너뛰어 재배분된다 — 배당성장 배정액은 437,500원(350,000 + 140,000×5/8)
const base = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14_000, ref_qty: 25, rationale: "", source_doc_ids: [], source_urls: [] },
      { category: "자산성장", action: "buy", ticker: "133690", etf_name: "B", ref_price: 21_000, ref_qty: 10, rationale: "", source_doc_ids: [], source_urls: [] },
      { category: "고배당", action: "skip", ticker: null, etf_name: null, ref_price: null, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  ctx,
).rows;
check("교체 전 배당성장 수량", base[0].refQty, 31);
check("교체 전 출처는 조사", base[0].priceSource, "research");

const swapped = applyRealtimePrices(
  base,
  new Map([["446720", { price: 12_500, pricedAt }]]),
).rows;
check("실시간가로 교체", swapped[0].refPrice, 12_500);
check("수량 재계산 floor(437500/12500)", swapped[0].refQty, 35);
check("조사 가격은 남는다", swapped[0].researchPrice, 14_000);
check("출처는 실시간", swapped[0].priceSource, "realtime");
check("기준 시각 기록", swapped[0].pricedAt?.toISOString(), pricedAt.toISOString());
check("실시간가 없는 종목은 조사가 유지", swapped[1].refPrice, 21_000);
check("  수량도 그대로", swapped[1].refQty, 12);
check("  출처도 조사 그대로", swapped[1].priceSource, "research");
check("  기준 시각 없음", swapped[1].pricedAt, null);
check("skip은 null 유지", swapped[2].refPrice, null);
check("  skip 출처도 조사", swapped[2].priceSource, "research");
check("  skip 수량 0", swapped[2].refQty, 0);

console.log("\n=== 대조군: 실시간가 = 조사가면 수량이 안 바뀐다 ===");
const same = applyRealtimePrices(
  base,
  new Map([["446720", { price: 14_000, pricedAt }]]),
).rows;
check("가격 동일", same[0].refPrice, 14_000);
check("수량 불변", same[0].refQty, 31);
check("출처만 실시간으로", same[0].priceSource, "realtime");

console.log("\n=== 갈아타기도 매도가를 실시간으로 ===");
const sw = normalizePicks(
  {
    picks: [
      { category: "고배당", action: "switch", ticker: "490600", etf_name: "C", ref_price: 10_000, ref_qty: 0, sell_ticker: "458730", sell_qty: 10, sell_ref_price: 14_000, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  { ...ctx, holdings: [{ category: "high_div" as Category, ticker: "458730", qty: 10 }] },
).rows;
check("교체 전 수량 floor((140000+140000)/10000)", sw[0].refQty, 28);
const swPriced = applyRealtimePrices(
  sw,
  new Map([
    ["490600", { price: 11_000, pricedAt }],
    ["458730", { price: 15_000, pricedAt }],
  ]),
).rows;
check("매도가 교체", swPriced[0].sellRefPrice, 15_000);
check("매도 조사가 보존", swPriced[0].sellResearchPrice, 14_000);
check("수량 floor((140000+150000)/11000)", swPriced[0].refQty, 26);

console.log("\n=== 매도 다리만 실시간이어도 출처는 실시간 ===");
const sellOnly = applyRealtimePrices(
  sw,
  new Map([["458730", { price: 15_000, pricedAt }]]),
);
check("매수가는 조사가 그대로", sellOnly.rows[0].refPrice, 10_000);
check("매도가만 교체", sellOnly.rows[0].sellRefPrice, 15_000);
check("출처는 실시간", sellOnly.rows[0].priceSource, "realtime");
check("기준 시각 채움", sellOnly.rows[0].pricedAt?.toISOString(), pricedAt.toISOString());
check("수량 floor((140000+150000)/10000)", sellOnly.rows[0].refQty, 29);
check("적용 1/1", [sellOnly.applied, sellOnly.eligible], [1, 1]);

console.log("\n=== 실시간가로 0주가 되면 교체하지 않는다 (skipped=false ∧ 수량 0 금지) ===");
const tinyCtx = {
  balances: { div_growth: 15_000, asset_growth: 0, high_div: 0 } as Record<Category, number>,
  injectedDocIds: [],
};
const tiny = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14_000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  tinyCtx,
).rows;
check("교체 전 1주", tiny[0].refQty, 1);
const raised = applyRealtimePrices(
  tiny,
  new Map([["446720", { price: 16_000, pricedAt }]]),
);
check("조사가 유지", raised.rows[0].refPrice, 14_000);
check("조사 수량 유지", raised.rows[0].refQty, 1);
check("출처는 조사 그대로", raised.rows[0].priceSource, "research");
check("기준 시각 없음", raised.rows[0].pricedAt, null);
check("건너뜀 아님(원래대로)", raised.rows[0].skipped, false);
check("적용 0/1", [raised.applied, raised.eligible], [0, 1]);
check("제외 사유 기록", raised.excluded[0]?.includes("1주도 못 사서"), true);

console.log("\n=== 대조군: 이미 건너뛴 행은 가격이 떨어져도 되살아나지 않는다 ===");
const revived = applyRealtimePrices(
  tooPricey.rows,
  new Map([["490600", { price: 5_000, pricedAt }]]),
);
check("건너뜀 유지", revived.rows[0].skipped, true);
check("수량 0 유지", revived.rows[0].refQty, 0);
check("가격 null 유지", revived.rows[0].refPrice, null);
check("출처도 조사", revived.rows[0].priceSource, "research");
check("대상 자체가 아님", revived.eligible, 0);

console.log("\n=== 실시간가 위생: 조사가에서 30% 넘게 벌어지면 안 쓴다 ===");
const insane = applyRealtimePrices(
  base,
  new Map([["446720", { price: 20_000, pricedAt }]]),
);
check("조사가 유지", insane.rows[0].refPrice, 14_000);
check("수량 유지", insane.rows[0].refQty, 31);
check("출처는 조사", insane.rows[0].priceSource, "research");
check("제외 사유 기록", insane.excluded[0]?.includes("30%"), true);
// 경계 바로 안쪽(+30%)은 그대로 쓴다
const edge = applyRealtimePrices(
  base,
  new Map([["446720", { price: 18_200, pricedAt }]]),
);
check("정확히 +30%는 적용", edge.rows[0].refPrice, 18_200);
check("  출처도 실시간", edge.rows[0].priceSource, "realtime");

console.log("\n=== isDrift 경계 (화면 경로도 같은 함수를 쓴다) ===");
check("+29%는 통과", isDrift(12_900, 10_000), false);
check("+31%는 드리프트", isDrift(13_100, 10_000), true);
check("−29%는 통과", isDrift(7_100, 10_000), false);
check("−31%는 드리프트", isDrift(6_900, 10_000), true);
check("조사가 없으면 판정 불가", isDrift(99_999, null), false);

console.log("\n=== computeRefQty 경계 ===");
check("정확히 나누어떨어짐", computeRefQty(140_000, 0, 14_000), 10);
check("1원 모자람", computeRefQty(13_999, 0, 14_000), 0);
check("딱 1주", computeRefQty(14_000, 0, 14_000), 1);
check("매도대금 합산해서 딱 떨어짐", computeRefQty(50, 50, 100), 1);
check("배정 0", computeRefQty(0, 0, 100), 0);
check("가격 0은 0주", computeRefQty(100_000, 0, 0), 0);

console.log("\n=== 장 운영시간 가드 (KST, 공휴일 미판별) ===");
check("평일 10:00", isMarketOpenKST(new Date("2026-09-15T10:00:00+09:00")), true);
check("평일 15:30", isMarketOpenKST(new Date("2026-09-15T15:30:00+09:00")), true);
check("평일 15:31", isMarketOpenKST(new Date("2026-09-15T15:31:00+09:00")), false);
check("평일 08:59", isMarketOpenKST(new Date("2026-09-15T08:59:00+09:00")), false);
check("평일 09:00", isMarketOpenKST(new Date("2026-09-15T09:00:00+09:00")), true);
check("토요일 11:00", isMarketOpenKST(new Date("2026-09-19T11:00:00+09:00")), false);
check("일요일 11:00", isMarketOpenKST(new Date("2026-09-20T11:00:00+09:00")), false);
// UTC로 들어와도 KST로 환산해서 본다 — 2026-09-15 01:00Z = KST 10:00
check("UTC 입력도 KST 기준", isMarketOpenKST(new Date("2026-09-15T01:00:00Z")), true);
check("KST 자정", isMarketOpenKST(new Date("2026-09-15T00:00:00+09:00")), false);

console.log("\n=== 활성 카테고리 = 월 충전액 > 0 (잔액은 보지 않는다) ===");
const zero: Record<Category, number> = { div_growth: 0, asset_growth: 0, high_div: 0 };
check(
  "충전 0/50만/0 → 자산성장만",
  activeCategories({ div_growth: 0, asset_growth: 500_000, high_div: 0 }),
  ["asset_growth"],
);
check("전부 0이면 세 개 전부", activeCategories(zero), [
  "div_growth",
  "asset_growth",
  "high_div",
]);
check(
  "대조군: 충전 28만/28만/14만이면 세 개 모두 활성",
  activeCategories({ div_growth: 280_000, asset_growth: 280_000, high_div: 140_000 }),
  ["div_growth", "asset_growth", "high_div"],
);
check(
  "대조군: 충전 20만/0/10만이면 배당성장·고배당",
  activeCategories({ div_growth: 200_000, asset_growth: 0, high_div: 100_000 }),
  ["div_growth", "high_div"],
);
check(
  "활성 줄",
  activeCategoriesLine(["asset_growth"]),
  "[이번 회차 활성 카테고리: 자산성장]",
);
check(
  "활성 줄 (세 개)",
  activeCategoriesLine(["div_growth", "asset_growth", "high_div"]),
  "[이번 회차 활성 카테고리: 배당성장·자산성장·고배당]",
);

console.log("\n=== ② 재조사 대상: 활성 카테고리 문서 행 ∪ 활성 카테고리 보유 ===");
const activeDoc = parseResearchDoc(`---
run_id: 1
date: 2026-09-18
type: scheduled
tickers: [446720, 133690, 490600, 999990]
---
## 1. 요약
요약
## 2. 시장 개관
개관
## 3. 카테고리별 ETF 현황
현황
## 4. 데이터 표
| ticker | name | category | price | dist_yield | premium | note |
|---|---|---|---|---|---|---|
| 446720 | SOL 미국배당다우존스 | 배당성장 | 14000 | 3.5 | 0.1 | - |
| 133690 | TIGER 미국나스닥100 | 자산성장 | 150000 | 0.3 | 0.0 | - |
| 490600 | RISE 커버드콜 | 고배당 | 10000 | 10.0 | 0.1 | - |
| 111110 | 가상 채권 | 채권 | 1000 | 1.0 | 0.0 | - |
## 5. 이벤트·뉴스
없음
## 6. 리스크 신호
없음
## 7. 출처
없음
`);
const heldAll: { category: Category; ticker: string }[] = [
  { category: "div_growth", ticker: "446720" },
  { category: "high_div", ticker: "490600" },
  { category: "asset_growth", ticker: "379800" },
];
const assetOnly = researchTickers([activeDoc], heldAll, ["asset_growth"]);
check("자산성장만: 문서 자산성장 행 + 자산성장 보유", assetOnly, ["133690", "379800"]);
check(
  "비활성 보유(446720·490600)는 빠진다",
  assetOnly.filter((t) => ["446720", "490600"].includes(t)),
  [],
);
check("알 수 없는 카테고리 행은 빠진다", assetOnly.includes("111110"), false);
check("category를 모르는 frontmatter 전용 티커는 빠진다", assetOnly.includes("999990"), false);
check(
  "두 개 활성: 배당성장·자산성장",
  researchTickers([activeDoc], heldAll, ["div_growth", "asset_growth"]),
  ["446720", "133690", "379800"],
);
check(
  "대조군: 세 개 전부 활성이면 기존 식(문서 전 종목 ∪ 보유 전부)과 같다",
  researchTickers([activeDoc], heldAll, ["div_growth", "asset_growth", "high_div"]),
  ["446720", "133690", "490600", "999990", "111110", "379800"],
);

console.log("\n=== 잔돈 케이스: 충전 0/50만/0 + 잔액 8,335/500,000/0 ===");
// 비활성 카테고리에 1주도 못 사는 잔돈(갈아타기 차액·분배금)이 남아도 되살아나면 안 된다
const dustTopup = { div_growth: 0, asset_growth: 500_000, high_div: 0 };
const dustBalances = { div_growth: 8_335, asset_growth: 500_000, high_div: 0 };
const dustHoldings = [
  { category: "div_growth" as Category, ticker: "446720", etfName: "SOL 미국배당다우존스", qty: 10, avgPrice: 13_500 },
  { category: "asset_growth" as Category, ticker: "379800", etfName: "KODEX 미국S&P500", qty: 5, avgPrice: 20_000 },
];
const dustActive = activeCategories(dustTopup);
check("활성 = 자산성장만", dustActive, ["asset_growth"]);
check(
  "researchTickers 에 배당성장 보유 446720 없음",
  researchTickers([activeDoc], dustHoldings, dustActive).includes("446720"),
  false,
);
check(
  "배당성장 잔액 줄에 매수 안 함 표시",
  budgetLine("div_growth", dustBalances.div_growth, dustActive),
  "- 배당성장: 8,335원 (이번 회차 매수 안 함)",
);
check(
  "배당성장 보유 줄에 매수 대상 아님 표시",
  holdingLine(dustHoldings[0], dustActive),
  "- 배당성장 | 446720 SOL 미국배당다우존스 | 10주 | 평단가 13,500원 (이번 회차 매수 대상 아님)",
);
check(
  "자산성장 보유 줄은 표시 없음",
  holdingLine(dustHoldings[1], dustActive),
  "- 자산성장 | 379800 KODEX 미국S&P500 | 5주 | 평단가 20,000원",
);
check("정규화 잔액: 비활성은 0", activeBalances(dustBalances, dustActive), {
  div_growth: 0,
  asset_growth: 500_000,
  high_div: 0,
});
check("정규화 보유: 활성만", activeHoldings(dustHoldings, dustActive), [
  { category: "asset_growth", ticker: "379800", qty: 5 },
]);
const dustSwitch = {
  picks: [
    { category: "배당성장", action: "switch", ticker: "402970", etf_name: "A", ref_price: 12_000, ref_qty: 12, sell_ticker: "446720", sell_qty: 10, sell_ref_price: 14_000, rationale: "", source_doc_ids: [], source_urls: [] },
    { category: "자산성장", action: "buy", ticker: "379800", etf_name: "KODEX 미국S&P500", ref_price: 22_000, ref_qty: 22, rationale: "", source_doc_ids: [], source_urls: [] },
  ],
};
const dustNorm = normalizePicks(dustSwitch, {
  balances: activeBalances(dustBalances, dustActive),
  injectedDocIds: [],
  holdings: activeHoldings(dustHoldings, dustActive),
  active: dustActive,
});
check("배당성장 switch pick 은 건너뜀", dustNorm.rows[0].skipped, true);
check("  매도 없음", dustNorm.rows[0].sellTicker, null);
check("  수량 0", dustNorm.rows[0].refQty, 0);
check(
  "  사유: 매수 대상이 아닌 카테고리",
  dustNorm.dropped.some((d) => d.startsWith("이번 회차 매수 대상이 아닌 카테고리라 갈아타기를 적용하지 않음")),
  true,
);
check("자산성장 매수는 그대로: floor(500000/22000)", dustNorm.rows[1].refQty, 22);
// 방어 층을 하나씩만 남겨도 막혀야 한다 — active 를 빼고 잔액 0·보유 필터만으로
const dustNoActive = normalizePicks(dustSwitch, {
  balances: activeBalances(dustBalances, dustActive),
  injectedDocIds: [],
  holdings: activeHoldings(dustHoldings, dustActive),
});
check("active 없이도 잔액 0·보유 필터로 건너뜀", dustNoActive.rows[0].skipped, true);
const dustActiveOnly = normalizePicks(dustSwitch, {
  balances: dustBalances,
  injectedDocIds: [],
  holdings: dustHoldings,
  active: dustActive,
});
check("잔액·보유를 그대로 넘겨도 active 로 건너뜀", dustActiveOnly.rows[0].skipped, true);
const dustUnguarded = normalizePicks(dustSwitch, {
  balances: dustBalances,
  injectedDocIds: [],
  holdings: dustHoldings,
});
check(
  "대조군: 세 겹을 다 빼면 잔돈+매도대금으로 갈아타기가 성립",
  [dustUnguarded.rows[0].skipped, dustUnguarded.rows[0].sellTicker],
  [false, "446720"],
);

console.log("\n=== 고배당 건너뜀 재배분이 비활성 카테고리로 흐르지 않는다 ===");
const reallocNorm = normalizePicks(
  {
    picks: [
      { category: "고배당", action: "skip", ticker: null, etf_name: null, ref_price: null, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] },
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14_000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  {
    balances: activeBalances({ div_growth: 0, asset_growth: 0, high_div: 160_000 }, ["asset_growth", "high_div"]),
    injectedDocIds: [],
    active: ["asset_growth", "high_div"],
  },
);
check("비활성 배당성장 매수는 건너뜀", reallocNorm.rows[1].skipped, true);
check("  배정 0", reallocNorm.rows[1].budgetKrw, 0);
const reallocLeak = normalizePicks(
  {
    picks: [
      { category: "고배당", action: "skip", ticker: null, etf_name: null, ref_price: null, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] },
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 11_000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  {
    balances: activeBalances({ div_growth: 0, asset_growth: 0, high_div: 160_000 }, ["asset_growth", "high_div"]),
    injectedDocIds: [],
  },
);
check(
  "대조군: active 를 안 넘기면 재배분 10만(5/8)이 비활성 배당성장으로 흘러 매수가 성립",
  [reallocLeak.rows[1].skipped, reallocLeak.rows[1].budgetKrw, reallocLeak.rows[1].refQty],
  [false, 100_000, 9],
);

console.log("\n=== ③ 출력 규칙: 세 개 활성이면 HEAD 원문과 한 글자도 다르지 않다 ===");
// git show HEAD:web/src/server/orchestrator.ts 의 [출력 규칙] 10줄 원문
const HEAD_OUTPUT_RULES = [
  "- 세 카테고리(배당성장·자산성장·고배당) 각각 정확히 한 번씩, 총 3개를 picks에 담아라.",
  "- 매수면 action=\"buy\", 건너뜀이면 action=\"skip\", 보유 종목을 팔고 다른 종목으로 교체하는 게 낫다고 판단되면 action=\"switch\".",
  "- action=skip이면 ticker·etf_name·ref_price는 null, ref_qty는 0으로 둔다. 값을 지어내지 마라.",
  "- action=switch이면 sell_ticker=팔 보유 종목 코드, sell_qty=팔 수량(위 보유 현황의 수량 이내), sell_ref_price=그 종목의 조사 가격. ticker·etf_name·ref_price에는 새로 살 종목을 적는다. 갈아타기의 근거(왜 파는지, 왜 그 종목으로 가는지)를 rationale에 조사 수치를 인용해 설명하라.",
  "- action이 buy나 skip이면 sell_ticker·sell_qty·sell_ref_price는 null로 둔다.",
  "- 보유하지 않은 종목을 팔라고 하지 마라. 갈아타기는 위 [현재 보유 현황]에 있는 종목만 대상으로 한다.",
  "- ref_price는 위 매입 시점 조사 문서의 price를 그대로 쓴다.",
  "- ref_qty: buy면 floor(budget_krw ÷ ref_price), switch면 floor((budget_krw + sell_qty×sell_ref_price) ÷ ref_price).",
  "- source_doc_ids에는 위에 표시된 research_doc_id 중 실제로 근거로 쓴 것만 넣어라.",
  "- JSON 밖에는 아무것도 출력하지 마라.",
];
const ALL: Category[] = ["div_growth", "asset_growth", "high_div"];
check("대조군: 세 개 활성 = HEAD 10줄", recommendOutputRules(ALL, false), HEAD_OUTPUT_RULES);
const rulesAsset = recommendOutputRules(["asset_growth"], true);
check(
  "자산성장만",
  rulesAsset[0],
  "- 이번 회차 활성 카테고리는 자산성장뿐이다. 자산성장 한 개만 picks에 담아라. 다른 카테고리는 이번 회차에 매수하지 않는다.",
);
check(
  "비활성 보유가 있으면 갈아타기 제외 문구",
  rulesAsset[5],
  `${HEAD_OUTPUT_RULES[5]} (이번 회차 매수 대상 아님) 표시가 붙은 종목은 팔거나 갈아타지 않는다.`,
);
check("  나머지 8줄은 HEAD 그대로", [...rulesAsset.slice(1, 5), ...rulesAsset.slice(6)], [...HEAD_OUTPUT_RULES.slice(1, 5), ...HEAD_OUTPUT_RULES.slice(6)]);
check(
  "대조군: 비활성 보유가 없으면 갈아타기 문구 그대로",
  recommendOutputRules(["asset_growth"], false)[5],
  HEAD_OUTPUT_RULES[5],
);
check(
  "두 개 활성",
  recommendOutputRules(["div_growth", "asset_growth"], false)[0],
  "- 이번 회차 활성 카테고리는 배당성장·자산성장뿐이다. 배당성장·자산성장 각각 정확히 한 번씩, 총 2개를 picks에 담아라. 다른 카테고리는 이번 회차에 매수하지 않는다.",
);
check(
  "대조군: 세 개 활성이면 잔액·보유 줄도 HEAD 형식 그대로(표시 없음)",
  [budgetLine("high_div", 140_000, ALL), holdingLine(dustHoldings[0], ALL)],
  ["- 고배당: 140,000원", "- 배당성장 | 446720 SOL 미국배당다우존스 | 10주 | 평단가 13,500원"],
);
check(
  "대조군: 세 개 활성이면 정규화 잔액·보유도 그대로",
  [activeBalances(balances, ALL), activeHoldings(dustHoldings, ALL).length],
  [balances, 2],
);

console.log("\n=== 자산성장만 출력해도 정규화는 자산성장 1행, 잔액 전액 배정 ===");
const assetBalances = { div_growth: 0, asset_growth: 500_000, high_div: 0 };
const assetPick = normalizePicks(
  {
    picks: [
      { category: "자산성장", action: "buy", ticker: "379800", etf_name: "KODEX 미국S&P500", ref_price: 22_000, ref_qty: 22, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  { balances: assetBalances, injectedDocIds: [], active: ["asset_growth"] },
);
check("1행", assetPick.rows.length, 1);
check("자산성장", assetPick.rows[0].category, "asset_growth");
check("잔액 전액 배정", assetPick.rows[0].budgetKrw, 500_000);
check("수량 floor(500000/22000)", assetPick.rows[0].refQty, 22);
check("버린 것 없음", assetPick.dropped.length, 0);

console.log("\n=== 형식 지시문: 세 개 활성이면 HEAD 원문 스냅샷과 같다 ===");
// git show HEAD:web/src/domain/docFormat.ts 의 buildFormatInstruction 을 아래 인자로 돌린 출력
const HEAD_FORMAT_ONDEMAND = `
────────────────────────────────
[출력 형식 — 반드시 지킬 것]

아래 형식으로만 출력하라. 헤딩 문구를 한 글자도 바꾸지 말고, 순서도 그대로 유지하라.
프로그램이 이 문서를 기계적으로 읽으므로 형식이 틀리면 사용할 수 없다.
조사 대상 종목(전원 빠짐없이 ## 4 표에 포함할 것): 446720, 133690

---
run_id: 7
date: 2026-09-18
type: ondemand
tickers: [종목코드를 쉼표로 구분해 나열]
model: (사용한 모델명)
---

## 1. 요약
(3줄 이내)

## 2. 시장 개관
(코스피·S&P500·나스닥·원달러 환율·미 금리를 표로)

## 3. 카테고리별 ETF 현황
### 배당성장
### 자산성장
### 고배당
(각 항목에 ETF별 현재가·최근 분배금·분배율·괴리율·특이사항)

## 4. 데이터 표
| ticker | name | category | price | dist_yield | total_return_1y | nav_trend | yield_basis | premium | note |
|---|---|---|---|---|---|---|---|---|---|
| 446720 | SOL 미국배당다우존스 | 배당성장 | 12345 | 3.5 | 14.2 | up | trailing12m | 0.1 | 비고 |

이 표 규칙(가장 중요):
- 컬럼은 위 10개 그대로, 순서도 그대로.
- ticker는 앞의 0을 보존한 6자리 문자열.
- price는 원 단위 정수만 (쉼표·"원" 금지). 나머지 비율은 % 기호 없는 숫자만.
- category는 배당성장 / 자산성장 / 고배당 중 하나.
- **total_return_1y**: 최근 1년 총투자수익률(기준가격 변동 + 분배금). 분배율과 나란히 비교하기 위한 값이다.
- **nav_trend**: 최근 6~12개월 NAV 방향을 up / flat / down 중 하나로. 확인 불가면 NA.
- **yield_basis**: 그 분배율이 어떤 기준으로 산출된 값인지.
  trailing12m(후행 12개월 실지급) / annualized_1m(직전월 연율화) / target(목표분배율) / unknown 중 하나.
  기준이 다르면 종목 간 분배율 비교가 성립하지 않으므로 반드시 확인해서 적어라.
- 확인하지 못한 값은 지어내지 말고 NA로 적고, note에 이유와 마지막 확인일을 남겨라.

## 5. 이벤트·뉴스
(ETF별 bullet, 날짜 명기)

## 6. 리스크 신호
(없으면 "없음"이라고 명시)

## 7. 출처
(수치마다 근거 URL. 웹 검색으로 실제 확인한 것만 적을 것)
`.trim();
const fmtBase = {
  type: "ondemand" as const,
  dateKey: "2026-09-18",
  runId: 7,
  tickers: ["446720", "133690"],
};
check("대조군: 지정 없음(④ 경로) = HEAD", buildFormatInstruction(fmtBase) === HEAD_FORMAT_ONDEMAND, true);
check("대조군: 세 개 지정 = HEAD", buildFormatInstruction({ ...fmtBase, categories: ALL }) === HEAD_FORMAT_ONDEMAND, true);
const fmtAsset = buildFormatInstruction({ ...fmtBase, categories: ["asset_growth"] });
check(
  "자산성장만: 소제목",
  fmtAsset.split("\n").filter((l) => l.startsWith("### ")),
  ["### 자산성장"],
);
check(
  "자산성장만: 예시 행이 자산성장",
  fmtAsset.split("\n").filter((l) => /^\| \d{6} /.test(l)),
  ["| 360750 | TIGER 미국S&P500 | 자산성장 | 12345 | 1.1 | 18.3 | up | trailing12m | 0.1 | 비고 |"],
);
check(
  "고배당만: 예시 행이 고배당",
  buildFormatInstruction({ ...fmtBase, categories: ["high_div"] })
    .split("\n")
    .filter((l) => /^\| \d{6} /.test(l))
    .map((l) => l.split("|")[3].trim()),
  ["고배당"],
);
check(
  "자산성장만: 소제목·예시 행 말고는 HEAD 와 같다",
  fmtAsset
    .replace("### 자산성장", "### 배당성장\n### 자산성장\n### 고배당")
    .replace(
      "| 360750 | TIGER 미국S&P500 | 자산성장 | 12345 | 1.1 | 18.3 | up | trailing12m | 0.1 | 비고 |",
      "| 446720 | SOL 미국배당다우존스 | 배당성장 | 12345 | 3.5 | 14.2 | up | trailing12m | 0.1 | 비고 |",
    ) === HEAD_FORMAT_ONDEMAND,
  true,
);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
