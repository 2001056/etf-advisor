/**
 * ③ 추천 출력 정규화 검증 (기획서 §5.3, docs/프롬프트-시스템-계약.md).
 *   pnpm run check:recommend
 */
import {
  activeBalances,
  activeCategories,
  activeCategoriesLine,
  allocateBudgets,
  applyRealtimePrices,
  budgetLine,
  computeRefQty,
  extractJson,
  holdingLine,
  isDrift,
  NormalizedPick,
  normalizePicks,
  normalizeRoleWeights,
  positiveInt,
  realtimePriceBlock,
  recommendOutputRules,
  researchTickers,
  roleBudgetLine,
  seatBudget,
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
// 자산성장 pick 이 하나라 안정적 성장 자리가 비고, 그 빈 자리가 건너뜀 행으로 뒤에 붙는다
check("3건 + 빈 자리 1건", buy.rows.length, 4);
const buyEmptySeat = buy.rows.at(3);
check("빈 자리 행은 맨 뒤", [buyEmptySeat?.category, buyEmptySeat?.role, buyEmptySeat?.skipped], ["asset_growth", "stable", true]);
check("  그 자리 몫만 들고 있다 floor(210000×0.5)", buyEmptySeat?.budgetKrw, 105_000);
check("  사유", buyEmptySeat?.rationale, "모델이 이 자리를 내지 않음");
check(
  "자산성장 pick 1개라 자리 자동 배정·빈 자리 이월 2건만 기록",
  buy.dropped,
  [
    "자산성장 pick에 role이 없어 공격적 성장 자리로 배정 — 360750",
    "자산성장 자리 1개가 비어 그 몫은 자산성장 잔액으로 이월",
  ],
);
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
check(
  "알 수 없는 카테고리는 버림",
  messy.dropped.filter((d) => d.includes("채권")).length,
  1,
);
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
// 빈 자리 건너뜀 행이 뒤에 붙으므로 카테고리마다 먼저 나온(모델이 낸) 행을 본다
const byCat = Object.fromEntries(
  [...redistributed.rows].reverse().map((r) => [r.category, r]),
);
// 배당성장 437,500 ÷ 14,000 = 31.25 → 31주 (재배분 전이면 25주)
check("배당성장 배정액", byCat.div_growth.budgetKrw, 437_500);
check("배당성장 수량(재배분 반영)", byCat.div_growth.refQty, 31);
// 자산성장 262,500의 공격 자리 몫 131,250 ÷ 26,000 = 5.04 → 5주
check("자산성장 자리 배정액", byCat.asset_growth.budgetKrw, 131_250);
check("자산성장 수량(재배분 반영)", byCat.asset_growth.refQty, 5);
check(
  "  대조군: 자리를 안 나눴다면 floor(262500/26000)",
  computeRefQty(262_500, 0, 26_000),
  10,
);
// 건너뛴 고배당은 자기 잔액을 이월액으로 표시
check("고배당 이월액", byCat.high_div.budgetKrw, 140_000);
check("고배당 skipped", byCat.high_div.skipped, true);
// 빈 안정적 성장 자리도 재배분된 자산성장 배정액에서 자기 몫을 들고 이월된다
check(
  "빈 자리 행도 재배분 후 자리 몫",
  redistributed.rows.at(-1),
  {
    category: "asset_growth", role: "stable", weight: 0.5,
    ticker: null, etfName: null, budgetKrw: 131_250, refPrice: null, refQty: 0,
    sellTicker: null, sellQty: null, sellRefPrice: null,
    researchPrice: null, sellResearchPrice: null,
    priceSource: "research", pricedAt: null, skipped: true,
    rationale: "모델이 이 자리를 내지 않음", sourceDocIds: [], sourceUrls: [],
  },
);
check(
  "  두 자리 몫의 합은 자산성장 배정액을 넘지 않는다",
  131_250 + 131_250 <= 262_500,
  true,
);

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
  // ② 표 가격 = 모델이 적어 온 ref_price 와 같은 경우
  { ...ctx, researchPrices: new Map([["446720", 14_000], ["133690", 21_000]]) },
).rows;
check("교체 전 배당성장 수량", base[0].refQty, 31);
check("교체 전 자산성장 수량 floor(131250/21000)", base[1].refQty, 6);
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
check("실시간가 없는 종목은 이번 회차에서 빠진다", swapped[1].skipped, true);
check("  기준가를 조사가로 대체하지 않는다", swapped[1].refPrice, null);
check("  수량 0", swapped[1].refQty, 0);
check("  종목도 비운다", [swapped[1].ticker, swapped[1].etfName], [null, null]);
check("  출처도 조사 그대로", swapped[1].priceSource, "research");
check("  기준 시각 없음", swapped[1].pricedAt, null);
check(
  "  사유를 rationale 에 남긴다",
  swapped[1].rationale.includes("133690 실시간가 없음 — 이번 회차 제외"),
  true,
);
check(
  "  자리 몫은 그대로 남아 이월된다",
  swapped[1].budgetKrw,
  base[1].budgetKrw,
);
check("skip은 null 유지", swapped[2].refPrice, null);
check("  skip 출처도 조사", swapped[2].priceSource, "research");
check("  skip 수량 0", swapped[2].refQty, 0);

console.log("\n=== research_price 는 ② 문서 표의 가격이다 (모델 ref_price 가 아니다) ===");
const v3Picks = [
  { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 12_380, ref_qty: 28, rationale: "", source_doc_ids: [], source_urls: [] },
  { category: "자산성장", action: "buy", ticker: "133690", etf_name: "B", ref_price: 21_000, ref_qty: 10, rationale: "", source_doc_ids: [], source_urls: [] },
];
// ③ 출력 규칙이 "ref_price 는 [실시간 시세] 값" 이라 모델 값은 실시간가다.
// ② 문서 표에서 읽은 12,000 이 research_price 가 되어야 ② 오파싱 탐지가 성립한다.
const fromDoc = normalizePicks(
  { picks: v3Picks },
  { ...ctx, researchPrices: new Map([["446720", 12_000]]) },
).rows;
check("② 표 가격이 research_price", fromDoc[0].researchPrice, 12_000);
check("  기준가는 모델이 적어 온 실시간가 그대로", fromDoc[0].refPrice, 12_380);
check("② 표에 없는 티커는 null", fromDoc[1].researchPrice, null);
check(
  // 3번째는 빈 안정적 성장 자리 행이다 — 종목이 없으니 원값도 없다
  "대조군: ② 표를 안 넘기면 전부 null (실시간가를 베껴 넣지 않는다)",
  normalizePicks({ picks: v3Picks }, ctx).rows.map((r) => r.researchPrice),
  [null, null, null],
);
check(
  "건너뛴 행은 ② 표에 있어도 null",
  normalizePicks(
    { picks: [{ ...v3Picks[0], action: "skip", ticker: null, ref_price: null }] },
    { ...ctx, researchPrices: new Map([["446720", 12_000]]) },
  ).rows[0].researchPrice,
  null,
);

console.log("\n=== isDrift 는 ② 가격을 기준으로 판정한다 (② 오파싱 탐지 복원) ===");
const sane = applyRealtimePrices(
  fromDoc,
  new Map([["446720", { price: 12_400, pricedAt }]]),
);
check("② 12,000 대비 +3%면 실시간가로 교체", sane.rows[0].refPrice, 12_400);
// ②를 1,200원으로 잘못 읽은 문서 — 실시간 12,400은 ② 기준 열 배가 넘는다
const misparsed = normalizePicks(
  { picks: v3Picks },
  { ...ctx, researchPrices: new Map([["446720", 1_200]]) },
).rows;
const guarded = applyRealtimePrices(
  misparsed,
  new Map([["446720", { price: 12_400, pricedAt }]]),
);
check("② 오파싱이면 실시간가를 버리고 이번 회차에서 뺀다", guarded.rows[0].skipped, true);
check("  조사가로 대체하지 않는다", guarded.rows[0].refPrice, null);
check("  출처도 조사 그대로", guarded.rows[0].priceSource, "research");
check(
  "  사유를 남긴다",
  guarded.excluded.includes("446720 실시간가가 조사가와 30% 넘게 차이 — 이번 회차 제외"),
  true,
);
check(
  "대조군: 실시간가가 있으면 그대로 매수 행으로 남는다",
  [sane.rows[0].skipped, sane.rows[0].priceSource],
  [false, "realtime"],
);
check("대조군: isDrift 자체도 ② 가격 기준", [isDrift(12_400, 1_200), isDrift(12_400, 12_000)], [true, false]);

console.log("\n=== research_price 가 없으면 드리프트 검사를 건너뛰고 실시간가를 채택한다 ===");
// ② 표에 없는 티커라 견줄 원값이 없다. 모델이 적어 온 ref_price 와 재면 실시간가끼리
// 재는 꼴이라 검사가 성립하지 않는다 — 그럴 바엔 검사를 건너뛰고 실시간가를 쓴다.
const noResearch = normalizePicks({ picks: v3Picks }, ctx).rows;
check("전제: research_price 가 null", noResearch[0].researchPrice, null);
const noResearchPriced = applyRealtimePrices(
  noResearch,
  // ref_price(12,380) 와 5배 넘게 벌어진 값이라 옛 기준(refPrice)이면 드리프트로 잘렸다
  new Map([["446720", { price: 62_000, pricedAt }]]),
);
check("실시간가를 채택한다", noResearchPriced.rows[0].refPrice, 62_000);
check("  매수 행으로 남는다", noResearchPriced.rows[0].skipped, false);
check("  출처는 실시간", noResearchPriced.rows[0].priceSource, "realtime");
check(
  "  30% 제외 사유를 남기지 않는다",
  noResearchPriced.excluded.some((e) => e.includes("30% 넘게 차이")),
  false,
);
check(
  "대조군: research_price 가 있고 30%를 넘으면 그대로 제외된다",
  (() => {
    const withResearch = applyRealtimePrices(
      normalizePicks(
        { picks: v3Picks },
        { ...ctx, researchPrices: new Map([["446720", 12_000]]) },
      ).rows,
      new Map([["446720", { price: 62_000, pricedAt }]]),
    );
    return [
      withResearch.rows[0].skipped,
      withResearch.rows[0].refPrice,
      withResearch.excluded.includes(
        "446720 실시간가가 조사가와 30% 넘게 차이 — 이번 회차 제외",
      ),
    ];
  })(),
  [true, null, true],
);
check(
  "대조군: isDrift 는 research 가 null 이면 언제나 false",
  [isDrift(62_000, null), isDrift(62_000, 12_000)],
  [false, true],
);

console.log("\n=== 실시간가는 필수다: 하나도 못 받으면 전부 건너뜀 ===");
// base 4행 = 배당성장 매수 / 자산성장 매수 / 고배당 skip / 빈 안정적 성장 자리
const blackout = applyRealtimePrices(base, new Map());
check("매수 행이 전부 건너뜀", blackout.rows.map((r) => r.skipped), [true, true, true, true]);
check("기준가도 전부 비었다", blackout.rows.map((r) => r.refPrice), [null, null, null, null]);
check("수량도 전부 0", blackout.rows.map((r) => r.refQty), [0, 0, 0, 0]);
check("적용 0/2", [blackout.applied, blackout.eligible], [0, 2]);
check(
  "제외 사유 2건",
  blackout.excluded,
  ["446720 실시간가 없음 — 이번 회차 제외", "133690 실시간가 없음 — 이번 회차 제외"],
);
check(
  "대조군: 둘 다 받으면 둘 다 매수로 남는다",
  applyRealtimePrices(
    base,
    new Map([
      ["446720", { price: 12_500, pricedAt }],
      ["133690", { price: 20_000, pricedAt }],
    ]),
  ).rows.map((r) => [r.skipped, r.priceSource]),
  [[false, "realtime"], [false, "realtime"], [true, "research"], [true, "research"]],
);

console.log("\n=== 빼낸 행의 이월액은 정규화의 불변식과 같다 (비자리=재배분 전 잔액, 자리=자리 몫) ===");
// base 는 고배당 명시 skip 이라 배당성장이 350,000 → 437,500 으로 재배분된 상태다.
// 정규화에서 건너뛴 비자리 행은 재배분 전 350,000 을 이월액으로 들고 있으므로,
// 실시간가가 없어 여기서 빠지는 행도 같은 350,000 이어야 한다.
check(
  "전제: 재배분으로 배당성장 배정이 부풀어 있다",
  [base[0].weight, base[0].budgetKrw, base[1].weight, base[1].budgetKrw],
  [null, 437_500, 0.5, 131_250],
);
const carried = applyRealtimePrices(base, new Map(), balances);
check("비자리 행 이월액 = 재배분 전 잔액", carried.rows[0].budgetKrw, 350_000);
check("  자리 행은 자리 몫 그대로", carried.rows[1].budgetKrw, 131_250);
check(
  "  정규화에서 건너뛴 행과 같은 값",
  carried.rows[0].budgetKrw,
  normalizePicks(
    {
      picks: [
        { category: "배당성장", action: "skip", ticker: null, etf_name: null, ref_price: null, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] },
        { category: "고배당", action: "skip", ticker: null, etf_name: null, ref_price: null, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] },
      ],
    },
    ctx,
  ).rows[0].budgetKrw,
);
check(
  "대조군: balances 를 안 넘기면 재배분된 437,500 이 그대로 남는다",
  applyRealtimePrices(base, new Map()).rows[0].budgetKrw,
  437_500,
);
check(
  "대조군: 매수로 남는 행의 배정액은 재배분된 값 그대로다",
  applyRealtimePrices(
    base,
    new Map([["446720", { price: 12_500, pricedAt }]]),
    balances,
  ).rows[0].budgetKrw,
  437_500,
);

console.log("\n=== 대조군: 실시간가 = 조사가면 수량이 안 바뀐다 ===");
const same = applyRealtimePrices(
  base,
  new Map([["446720", { price: 14_000, pricedAt }]]),
).rows;
check("가격 동일", same[0].refPrice, 14_000);
check("수량 불변", same[0].refQty, 31);
check("출처만 실시간으로", same[0].priceSource, "realtime");

console.log("\n=== applyRealtimePrices는 매도 다리를 그대로 지원한다 (③은 더 이상 만들지 않는다) ===");
// ③ 정규화가 매도를 만들지 않으므로 행을 직접 세워 교체 로직만 본다
const sw: NormalizedPick[] = [
  {
    category: "high_div",
    role: null,
    weight: null,
    ticker: "490600",
    etfName: "C",
    budgetKrw: 140_000,
    refPrice: 10_000,
    refQty: 28,
    sellTicker: "251350",
    sellQty: 10,
    sellRefPrice: 14_000,
    researchPrice: 10_000,
    sellResearchPrice: 14_000,
    priceSource: "research",
    pricedAt: null,
    skipped: false,
    rationale: "",
    sourceDocIds: [],
    sourceUrls: [],
  },
];
check("교체 전 수량 floor((140000+140000)/10000)", sw[0].refQty, 28);
const swPriced = applyRealtimePrices(
  sw,
  new Map([
    ["490600", { price: 11_000, pricedAt }],
    ["251350", { price: 15_000, pricedAt }],
  ]),
).rows;
check("매도가 교체", swPriced[0].sellRefPrice, 15_000);
check("매도 조사가 보존", swPriced[0].sellResearchPrice, 14_000);
check("수량 floor((140000+150000)/11000)", swPriced[0].refQty, 26);

console.log("\n=== 매도 다리만 실시간이어도 출처는 실시간 ===");
const sellOnly = applyRealtimePrices(
  sw,
  new Map([["251350", { price: 15_000, pricedAt }]]),
);
check("매수가는 조사가 그대로", sellOnly.rows[0].refPrice, 10_000);
check("매도가만 교체", sellOnly.rows[0].sellRefPrice, 15_000);
check("출처는 실시간", sellOnly.rows[0].priceSource, "realtime");
check("기준 시각 채움", sellOnly.rows[0].pricedAt?.toISOString(), pricedAt.toISOString());
check("수량 floor((140000+150000)/10000)", sellOnly.rows[0].refQty, 29);
check("적용 1/1", [sellOnly.applied, sellOnly.eligible], [1, 1]);

console.log("\n=== 실시간가로 0주가 되면 이번 회차에서 뺀다 (skipped=false ∧ 수량 0 금지) ===");
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
check("조사가로 1주 남기지 않는다", raised.rows[0].refPrice, null);
check("수량 0", raised.rows[0].refQty, 0);
check("출처는 조사 그대로", raised.rows[0].priceSource, "research");
check("기준 시각 없음", raised.rows[0].pricedAt, null);
check("건너뜀", raised.rows[0].skipped, true);
check("적용 0/1", [raised.applied, raised.eligible], [0, 1]);
check("제외 사유 기록", raised.excluded[0], "446720 실시간가로는 1주도 못 산다 — 이번 회차 제외");
check(
  "대조군: 실시간가로도 1주를 살 수 있으면 그대로 매수",
  applyRealtimePrices(tiny, new Map([["446720", { price: 13_000, pricedAt }]])).rows[0]
    .skipped,
  false,
);

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
check("조사가로 대체하지 않는다", insane.rows[0].refPrice, null);
check("이번 회차에서 뺀다", insane.rows[0].skipped, true);
check("수량 0", insane.rows[0].refQty, 0);
check("출처는 조사", insane.rows[0].priceSource, "research");
check("제외 사유 기록", insane.excluded[0], "446720 실시간가가 조사가와 30% 넘게 차이 — 이번 회차 제외");
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
const dustPicks = {
  picks: [
    { category: "배당성장", action: "buy", ticker: "402970", etf_name: "A", ref_price: 8_000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] },
    { category: "자산성장", action: "buy", ticker: "379800", etf_name: "KODEX 미국S&P500", ref_price: 22_000, ref_qty: 22, rationale: "", source_doc_ids: [], source_urls: [] },
  ],
};
const dustNorm = normalizePicks(dustPicks, {
  balances: activeBalances(dustBalances, dustActive),
  injectedDocIds: [],
  active: dustActive,
});
check("배당성장 pick 은 건너뜀", dustNorm.rows[0].skipped, true);
check("  수량 0", dustNorm.rows[0].refQty, 0);
check(
  "  사유: 매수 대상이 아닌 카테고리",
  dustNorm.dropped.some((d) => d.startsWith("이번 회차 매수 대상이 아닌 카테고리라 매수하지 않음")),
  true,
);
check("자산성장 매수는 자리 몫 floor(250000/22000)", dustNorm.rows[1].refQty, 11);
// 방어 층을 하나씩만 남겨도 막혀야 한다
const dustNoActive = normalizePicks(dustPicks, {
  balances: activeBalances(dustBalances, dustActive),
  injectedDocIds: [],
});
check("active 없이도 잔액 0으로 건너뜀", dustNoActive.rows[0].skipped, true);
const dustActiveOnly = normalizePicks(dustPicks, {
  balances: dustBalances,
  injectedDocIds: [],
  active: dustActive,
});
check("잔액을 그대로 넘겨도 active 로 건너뜀", dustActiveOnly.rows[0].skipped, true);
const dustUnguarded = normalizePicks(dustPicks, {
  balances: dustBalances,
  injectedDocIds: [],
});
check(
  "대조군: 두 겹을 다 빼면 잔돈 8,335원으로 1주 매수가 성립",
  [dustUnguarded.rows[0].skipped, dustUnguarded.rows[0].refQty],
  [false, 1],
);

console.log("\n=== ③은 갈아타기를 쓰지 않는다: action=switch 는 매수로 강등 ===");
const legacySwitch = normalizePicks(
  {
    picks: [
      { category: "고배당", action: "switch", ticker: "490600", etf_name: "C", ref_price: 10_000, ref_qty: 0, sell_ticker: "251350", sell_qty: 10, sell_ref_price: 14_000, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  ctx,
);
check("1행", legacySwitch.rows.length, 1);
check("매수로 처리(건너뜀 아님)", legacySwitch.rows[0].skipped, false);
check("매도 다리 없음", [legacySwitch.rows[0].sellTicker, legacySwitch.rows[0].sellQty, legacySwitch.rows[0].sellRefPrice], [null, null, null]);
check("매도 조사가도 없음", legacySwitch.rows[0].sellResearchPrice, null);
check("수량은 배정액만으로 floor(140000/10000)", legacySwitch.rows[0].refQty, 14);
check(
  "사유 기록",
  legacySwitch.dropped,
  ["③은 갈아타기를 쓰지 않음 — 매수로 처리: 490600"],
);
check(
  "대조군: 같은 pick 을 action=buy 로 내면 사유 없이 같은 결과",
  (() => {
    const asBuy = normalizePicks(
      {
        picks: [
          { category: "고배당", action: "buy", ticker: "490600", etf_name: "C", ref_price: 10_000, ref_qty: 0, rationale: "", source_doc_ids: [], source_urls: [] },
        ],
      },
      ctx,
    );
    return [asBuy.rows[0].refQty, asBuy.dropped.length];
  })(),
  [14, 0],
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

console.log("\n=== ③ 출력 규칙 v3: 갈아타기 3줄이 빠지고 기준가가 실시간 시세로 바뀐다 ===");
// 직전 판(자리 도입 시점, 커밋 9b2b83d)의 꼬리 9줄 원문 — 무엇이 사라졌는지 이 배열로 대조한다.
// 그 커밋의 recommendOutputRules 에서 그대로 복사한 스냅샷이며, HEAD 가 앞으로 가도
// 이 문자열은 고정이다(git show 로 매번 읽으면 HEAD 가 바뀔 때마다 검사가 깨진다).
const PREV_TAIL_RULES = [
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
// v3 꼬리 6줄: action 줄이 교체되고, 갈아타기 3줄이 사라지고,
// ref_price·ref_qty 두 줄이 실시간 시세 기준으로 바뀌었다.
const TAIL_RULES = [
  "- action은 buy 또는 skip만 쓴다. 기존 보유분 매도·교체는 이 단계에서 제안하지 않는다(매도·교체 검토는 ④, 중복 보유 정리는 ⑤).",
  "- action=skip이면 ticker·etf_name·ref_price는 null, ref_qty는 0으로 둔다. 값을 지어내지 마라.",
  "- ref_price는 [실시간 시세]의 값만 쓴다. 실시간가가 없는 종목은 이번 회차 후보에서 제외한다 — ② 문서의 price로 대체하지 마라.",
  "- ref_qty: floor(budget_krw ÷ ref_price).",
  "- source_doc_ids에는 위에 표시된 research_doc_id 중 실제로 근거로 쓴 것만 넣어라.",
  "- JSON 밖에는 아무것도 출력하지 마라.",
];
const ALL: Category[] = ["div_growth", "asset_growth", "high_div"];
const ROLE_RULES = [
  '- 자산성장만은 예외다. 공격적 성장 자리(role="aggressive", 변동이 크더라도 장기 기대 수익이 높은 성장 지수)와 안정적 성장 자리(role="stable", 여러 업종에 분산하여 특정 업종·종목 의존도를 낮추는 주식 지수)에 ETF를 하나씩 골라 자산성장 pick 2개를 담아라. 두 자리에 같은 종목이나 같은 기초지수를 넣지 마라.',
  '- role은 자산성장 pick에만 "aggressive" 또는 "stable"로 적고 다른 카테고리 pick은 null로 둔다. 자리 비중과 자리별 budget_krw는 시스템이 자산성장 잔액을 나눠 채우므로 직접 계산하지 마라. 두 자리에 같은 종목을 넣으면 공격적 성장 자리만 남고 안정적 성장 자리는 비운다. 건너뛴 자리의 몫은 자산성장 잔액으로 이월되어 다음 회차에 다시 자리 비중대로 나뉜다. 다른 카테고리로는 가지 않는다.',
];
check(
  "세 개 활성: 개수 줄 + 자리 2줄 + 꼬리 6줄",
  recommendOutputRules(ALL),
  [
    "- 배당성장·고배당은 각각 정확히 한 번씩 picks에 담고, 자산성장은 아래 자리 규칙을 따른다.",
    ...ROLE_RULES,
    ...TAIL_RULES,
  ],
);
check(
  "대조군: 직전 판의 갈아타기 4줄이 전부 사라졌다",
  recommendOutputRules(ALL).filter((l) =>
    [PREV_TAIL_RULES[0], PREV_TAIL_RULES[2], PREV_TAIL_RULES[3], PREV_TAIL_RULES[4]].includes(l),
  ),
  [],
);
// 활성 조합은 공집합을 뺀 7가지뿐이다 — 하나도 빠뜨리지 않고 전부 본다
const COMBOS: Category[][] = [1, 2, 3, 4, 5, 6, 7].map((mask) =>
  ALL.filter((_, i) => (mask >> i) & 1),
);
check("전수 검사 대상은 활성 조합 7가지", COMBOS.length, 7);
check(
  "대조군: 활성 조합 7가지 어디에도 'switch' 라는 낱말이 없다",
  COMBOS.flatMap((a) => recommendOutputRules(a)).filter(
    (l) => l.includes("switch") || l.includes("갈아타기"),
  ),
  [],
);
check(
  "대조군: 바뀌지 않은 꼬리 3줄은 직전 판 원문 그대로",
  [TAIL_RULES[1], TAIL_RULES[4], TAIL_RULES[5]],
  [PREV_TAIL_RULES[1], PREV_TAIL_RULES[7], PREV_TAIL_RULES[8]],
);
check(
  "자산성장이 비활성이면 개수 줄은 직전 판 원문 그대로",
  recommendOutputRules(["div_growth", "high_div"]),
  [
    "- 이번 회차 활성 카테고리는 배당성장·고배당뿐이다. 배당성장·고배당 각각 정확히 한 번씩, 총 2개를 picks에 담아라. 다른 카테고리는 이번 회차에 매수하지 않는다.",
    ...TAIL_RULES,
  ],
);
check(
  "대조군: 자산성장이 비활성이면 자리 줄이 붙지 않는다",
  recommendOutputRules(["div_growth"]).some((l) => ROLE_RULES.includes(l)),
  false,
);
check(
  "대조군: 배당성장만 활성이면 개수 줄도 직전 판 그대로",
  recommendOutputRules(["div_growth"])[0],
  "- 이번 회차 활성 카테고리는 배당성장뿐이다. 배당성장 한 개만 picks에 담아라. 다른 카테고리는 이번 회차에 매수하지 않는다.",
);
const rulesAsset = recommendOutputRules(["asset_growth"]);
check(
  "자산성장만: 개수는 자리 규칙에 맡긴다",
  rulesAsset[0],
  "- 이번 회차 활성 카테고리는 자산성장뿐이다. 자산성장만 picks에 담고, 몇 개를 담을지는 아래 자리 규칙을 따른다. 다른 카테고리는 이번 회차에 매수하지 않는다.",
);
check(
  "  개수 줄이 자리 줄과 모순되지 않는다(‘한 개만’ 문구 없음)",
  rulesAsset[0].includes("한 개만"),
  false,
);
check("  자리 2줄이 바로 뒤에", rulesAsset.slice(1, 3), ROLE_RULES);
check("  꼬리 6줄", rulesAsset.slice(3), TAIL_RULES);
check(
  "두 개 활성(자산성장 포함)",
  recommendOutputRules(["div_growth", "asset_growth"])[0],
  "- 이번 회차 활성 카테고리는 배당성장·자산성장뿐이다. 배당성장은 정확히 한 번씩 picks에 담고, 자산성장은 아래 자리 규칙을 따른다. 다른 카테고리는 이번 회차에 매수하지 않는다.",
);
check(
  "대조군: 세 개 활성이면 잔액·보유 줄도 이전 형식 그대로(표시 없음)",
  [budgetLine("high_div", 140_000, ALL), holdingLine(dustHoldings[0], ALL)],
  ["- 고배당: 140,000원", "- 배당성장 | 446720 SOL 미국배당다우존스 | 10주 | 평단가 13,500원"],
);
check(
  "대조군: 세 개 활성이면 정규화 잔액도 그대로",
  activeBalances(balances, ALL),
  balances,
);

console.log("\n=== 자리별 배정액 줄 (③ 잔액 줄 아래) ===");
check(
  "50:50",
  roleBudgetLine(500_000, { aggressive: 0.5, stable: 0.5 }),
  "  · 공격적 성장 자리 50%: 250,000원 / 안정적 성장 자리 50%: 250,000원",
);
check(
  "40:60",
  roleBudgetLine(500_000, { aggressive: 0.4, stable: 0.6 }),
  "  · 공격적 성장 자리 40%: 200,000원 / 안정적 성장 자리 60%: 300,000원",
);
check(
  "비중을 안 주면 기본 50:50",
  roleBudgetLine(8_335),
  "  · 공격적 성장 자리 50%: 4,167원 / 안정적 성장 자리 50%: 4,167원",
);
check(
  "정규화가 쓰는 식과 같다",
  [seatBudget(500_000, 0.4), seatBudget(500_000, 0.6)],
  [200_000, 300_000],
);
check("대조군: 부동소수 오차(0.7×700,000)를 걷어낸다", seatBudget(700_000, 0.7), 490_000);
check("  나머지 자리 몫", seatBudget(700_000, 0.3), 210_000);
check("  두 몫의 합이 잔액", seatBudget(700_000, 0.7) + seatBudget(700_000, 0.3), 700_000);
check("  대조군: 보정 없는 floor 는 1원을 흘린다", Math.floor(700_000 * 0.7), 489_999);
check("진짜 소수 몫은 내림", seatBudget(8_335, 0.5), 4_167);

console.log("\n=== ③ 입력의 실시간 시세 블록 ===");
const liveAt = new Date("2026-09-21T14:23:00+09:00");
check(
  "있는 값과 없는 값 — 종목마다 체결 시각을 병기한다",
  realtimePriceBlock(
    ["446720", "133690"],
    new Map([["446720", { price: 14_110, pricedAt: liveAt, marketStatus: "OPEN" }]]),
  ),
  "[실시간 시세 — 14:23 KST 기준, 장중, 매수 가능 여부와 ref_qty는 이 값으로 판단]\n- 446720: 14,110원 (14:23)\n- 133690: 실시간가 없음",
);
check(
  "장이 닫혔으면 머리줄이 종가라고 말한다",
  realtimePriceBlock(
    ["446720"],
    new Map([["446720", { price: 14_110, pricedAt: liveAt, marketStatus: "CLOSE" }]]),
  ).split("\n")[0],
  "[실시간 시세 — 14:23 KST 기준, 장 마감 후 종가, 매수 가능 여부와 ref_qty는 이 값으로 판단]",
);
check(
  "대조군: 하나라도 장중이 아니면 장중이라고 하지 않는다",
  realtimePriceBlock(
    ["446720", "133690"],
    new Map([
      ["446720", { price: 14_110, pricedAt: liveAt, marketStatus: "OPEN" }],
      ["133690", { price: 21_000, pricedAt: liveAt, marketStatus: "CLOSE" }],
    ]),
  ).split("\n")[0].includes("장 마감 후 종가"),
  true,
);
check(
  "장 상태를 모르면 모른다고 적는다",
  realtimePriceBlock(
    ["446720"],
    new Map([["446720", { price: 14_110, pricedAt: liveAt }]]),
  ).split("\n")[0].includes("장 마감 후 종가"),
  true,
);
check(
  "대조군: 하나도 못 받으면 전부 '실시간가 없음'",
  realtimePriceBlock(["446720"], new Map(), liveAt).split("\n")[1],
  "- 446720: 실시간가 없음",
);
check(
  "  머리줄 시각은 조회 시각으로 떨어지고 장 상태는 확인 불가",
  realtimePriceBlock(["446720"], new Map(), liveAt).split("\n")[0],
  "[실시간 시세 — 14:23 KST 기준, 장 상태 확인 불가, 매수 가능 여부와 ref_qty는 이 값으로 판단]",
);
check(
  "UTC 로 들어온 기준 시각도 KST 로 적는다",
  realtimePriceBlock(
    ["446720"],
    new Map([
      ["446720", { price: 14_110, pricedAt: new Date("2026-09-21T05:23:00Z"), marketStatus: "OPEN" }],
    ]),
  ).split("\n")[0],
  "[실시간 시세 — 14:23 KST 기준, 장중, 매수 가능 여부와 ref_qty는 이 값으로 판단]",
);
check(
  "  종목 줄의 시각도 KST",
  realtimePriceBlock(
    ["446720"],
    new Map([
      ["446720", { price: 14_110, pricedAt: new Date("2026-09-21T05:23:00Z"), marketStatus: "OPEN" }],
    ]),
  ).split("\n")[1],
  "- 446720: 14,110원 (14:23)",
);
check(
  "조회 대상이 없으면 빈 줄 대신 안내",
  realtimePriceBlock([], new Map(), liveAt).split("\n")[1],
  "- (조회 대상 종목 없음)",
);

console.log("\n=== 자산성장 pick이 하나면 자리 하나만 차고 그 자리 몫만 배정된다 ===");
const assetBalances = { div_growth: 0, asset_growth: 500_000, high_div: 0 };
const assetPick = normalizePicks(
  {
    picks: [
      { category: "자산성장", action: "buy", ticker: "379800", etf_name: "KODEX 미국S&P500", ref_price: 22_000, ref_qty: 22, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  { balances: assetBalances, injectedDocIds: [], active: ["asset_growth"] },
);
check("1행 + 빈 자리 1행", assetPick.rows.length, 2);
check("자산성장", assetPick.rows[0].category, "asset_growth");
check("자리 몫만 배정 floor(500000×0.5)", assetPick.rows[0].budgetKrw, 250_000);
check("수량 floor(250000/22000)", assetPick.rows[0].refQty, 11);
check(
  "빈 안정적 성장 자리가 건너뜀 행으로 남는다",
  [assetPick.rows.at(1)?.role, assetPick.rows.at(1)?.skipped, assetPick.rows.at(1)?.budgetKrw, assetPick.rows.at(1)?.refQty],
  ["stable", true, 250_000, 0],
);
check(
  "  두 행의 배정 합계가 잔액을 넘지 않는다",
  assetPick.rows.reduce((a, r) => a + r.budgetKrw, 0) <= 500_000,
  true,
);
check(
  "사유 2건(자리 자동 배정 + 빈 자리 이월)",
  assetPick.dropped,
  [
    "자산성장 pick에 role이 없어 공격적 성장 자리로 배정 — 379800",
    "자산성장 자리 1개가 비어 그 몫은 자산성장 잔액으로 이월",
  ],
);

console.log("\n=== 형식 지시문: 세 개 활성이면 HEAD 원문 스냅샷과 같다 ===");
// git show HEAD:web/src/domain/docFormat.ts 의 buildFormatInstruction 을 아래 인자로 돌린 출력
// 활성 카테고리를 지정해도 소제목·예시 행 말고는 바뀌지 않는다는 것을 보는 대조군 스냅샷.
// 기준은 커밋 9b2b83d + 이번 회차에 고친 total_return_1y·nav_trend 정의 2줄이며,
// 여기 문자열은 고정이다(빌드 시점 HEAD 를 읽어 오면 HEAD 가 바뀔 때마다 검사가 깨진다).
//
// 2026-09-21 갱신 사유: ①②가 데이터 표 note 에 자리를 적으려면 자리 이름의 뜻이 문서에
// 있어야 한다(전에는 ③ 출력 규칙에만 있었다). 그래서 자산성장이 보이는 문서에는 ## 3 안내
// 뒤에 [자리 정의] 4줄이 붙는다 — 세 카테고리가 모두 활성이어도 자산성장이 있으니 붙는다.
// 자산성장이 없는 문서(고배당만 등)에는 붙지 않는다(아래 대조군).
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

[자리 정의] 공격적 성장: 변동이 크더라도 장기 기대 수익이 높은 성장 지수 / 안정적 성장: 여러 업종에 분산하여 특정 업종·종목 의존도를 낮추는 주식 지수
- 자산성장으로 분류한 행은 ## 4 데이터 표의 note 첫머리에 자리(공격 / 안정 / 미정)와 환헤지 여부(H / 비H)를 적는다.
- 상품 전략을 충분히 확인하지 못해 자리를 정할 수 없으면 "미정"으로 두고 그 사유를 note에 적는다. 억지로 한쪽에 넣지 마라.
- 자산성장이 아닌 카테고리로 분류한 행에는 자리를 적지 않는다.

## 4. 데이터 표
| ticker | name | category | price | dist_yield | total_return_1y | nav_trend | yield_basis | premium | note |
|---|---|---|---|---|---|---|---|---|---|
| 446720 | SOL 미국배당다우존스 | 배당성장 | 12345 | 3.5 | 14.2 | up | trailing12m | 0.1 | 비고 |

이 표 규칙(가장 중요):
- 컬럼은 위 10개 그대로, 순서도 그대로.
- ticker는 앞의 0을 보존한 6자리 문자열.
- price는 원 단위 정수만 (쉼표·"원" 금지). 나머지 비율은 % 기호 없는 숫자만.
- category는 배당성장 / 자산성장 / 고배당 중 하나.
- **total_return_1y**: 최근 12개월, NAV 기준, 분배금 재투자 가정 총수익률. 운용사·거래소 공시값을 우선 쓰고,
  공시값이 없으면 계산 근거를 note에 적어라. 시장가 기준이거나 분배금을 현금으로 합산한 방식이면 note에 명시한다.
  분배율과 나란히 비교하기 위한 값이다.
- **nav_trend**: 최근 12개월 NAV 방향을 up / flat / down 중 하나로. 기간은 12개월로 고정이며,
  6개월만 관찰한 경우에는 그 사실을 note에 적어라. 확인 불가면 NA.
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

console.log("\n=== [자리 정의]는 자산성장이 보이는 문서에만 붙는다 ===");
const seatDefLine = "[자리 정의] 공격적 성장: 변동이 크더라도 장기 기대 수익이 높은 성장 지수 / 안정적 성장: 여러 업종에 분산하여 특정 업종·종목 의존도를 낮추는 주식 지수";
check("세 개 활성", buildFormatInstruction({ ...fmtBase, categories: ALL }).includes(seatDefLine), true);
check("자산성장만", fmtAsset.includes(seatDefLine), true);
check("지정 없음(④ 경로)", buildFormatInstruction(fmtBase).includes(seatDefLine), true);
check("note 규칙도 함께", fmtAsset.includes('자리를 정할 수 없으면 "미정"으로 두고'), true);
check("자산성장 밖 행에는 적지 않는다", fmtAsset.includes("자산성장이 아닌 카테고리로 분류한 행에는 자리를 적지 않는다"), true);
check(
  "대조군: 고배당만이면 붙지 않는다",
  buildFormatInstruction({ ...fmtBase, categories: ["high_div"] }).includes("[자리 정의]"),
  false,
);
check(
  "대조군: 배당성장+고배당이어도 붙지 않는다",
  buildFormatInstruction({ ...fmtBase, categories: ["div_growth", "high_div"] }).includes("[자리 정의]"),
  false,
);
// 예시 행은 첫 활성 카테고리를 따라 바뀌므로 양쪽 모두에서 지우고 비교한다
const stripExample = (s: string) => s.replace(/^\| \d{6} .*$/m, "(예시 행)");
check(
  "대조군: 자리 정의 4줄 말고는 고배당만 문서와 같다",
  stripExample(
    buildFormatInstruction({ ...fmtBase, categories: ["asset_growth", "high_div"] }),
  )
    .replace(/\n\[자리 정의\][\s\S]*?자리를 적지 않는다\.\n/, "")
    .replace("### 자산성장\n### 고배당", "### 고배당") ===
    stripExample(buildFormatInstruction({ ...fmtBase, categories: ["high_div"] })),
  true,
);

// ── 자산성장 두 자리(공격·안정) 나눠 담기 ──────────────────
// 금액·종목은 전부 합성 값이다 (실제 잔액·보유가 아님).

console.log("\n=== 자산성장 두 자리: 잔액을 50:50으로 나눠 배정 ===");
const seatBalances: Record<Category, number> = {
  div_growth: 0,
  asset_growth: 500_000,
  high_div: 0,
};
const seatCtx = {
  balances: seatBalances,
  injectedDocIds: [],
  active: ["asset_growth"] as Category[],
};
const pick = (over: Record<string, unknown>) => ({
  category: "자산성장",
  action: "buy",
  etf_name: "합성 ETF",
  ref_qty: 0,
  rationale: "",
  source_doc_ids: [],
  source_urls: [],
  ...over,
});

const twoSeats = normalizePicks(
  {
    picks: [
      pick({ role: "aggressive", ticker: "133690", ref_price: 21_000 }),
      pick({ role: "stable", ticker: "379800", ref_price: 22_000 }),
    ],
  },
  seatCtx,
);
check("2행", twoSeats.rows.length, 2);
check("버린 것 없음", twoSeats.dropped.length, 0);
check("자리 기록", twoSeats.rows.map((r) => r.role), ["aggressive", "stable"]);
check("비중 기록", twoSeats.rows.map((r) => r.weight), [0.5, 0.5]);
check("공격 배정 floor(500000×0.5)", twoSeats.rows[0].budgetKrw, 250_000);
check("안정 배정 floor(500000×0.5)", twoSeats.rows[1].budgetKrw, 250_000);
check("공격 수량 floor(250000/21000)", twoSeats.rows[0].refQty, 11);
check("안정 수량 floor(250000/22000)", twoSeats.rows[1].refQty, 11);
check("배정 합계 = 잔액", twoSeats.rows.reduce((a, r) => a + r.budgetKrw, 0), 500_000);
const twoSeatsSpend = twoSeats.rows.reduce(
  (a, r) => a + r.refQty * (r.refPrice ?? 0),
  0,
);
check("매수 합계가 잔액 이내", twoSeatsSpend <= seatBalances.asset_growth, true);
check("  합계", twoSeatsSpend, 11 * 21_000 + 11 * 22_000);

console.log("\n=== 대조군: 나누지 않고 옛 방식(두 pick 모두 잔액 전액)이면 합계가 잔액을 넘는다 ===");
// 카테고리당 1종목 전제였던 HEAD는 같은 카테고리 pick마다 budgets[category]를 그대로 줬다.
const oldWayQty = [
  computeRefQty(seatBalances.asset_growth, 0, 21_000),
  computeRefQty(seatBalances.asset_growth, 0, 22_000),
];
const oldWaySpend = oldWayQty[0] * 21_000 + oldWayQty[1] * 22_000;
check("옛 방식 수량", oldWayQty, [23, 22]);
check("옛 방식 합계가 잔액 초과", oldWaySpend > seatBalances.asset_growth, true);
check("  초과분", oldWaySpend - seatBalances.asset_growth, 467_000);
check("나눈 쪽은 초과하지 않는다", twoSeatsSpend > seatBalances.asset_growth, false);

console.log("\n=== 자리 비중은 설정값을 따른다 (40:60) ===");
const skewed = normalizePicks(
  {
    picks: [
      pick({ role: "aggressive", ticker: "133690", ref_price: 21_000 }),
      pick({ role: "stable", ticker: "379800", ref_price: 22_000 }),
    ],
  },
  { ...seatCtx, roleWeights: { aggressive: 0.4, stable: 0.6 } },
);
check("공격 배정 floor(500000×0.4)", skewed.rows[0].budgetKrw, 200_000);
check("안정 배정 floor(500000×0.6)", skewed.rows[1].budgetKrw, 300_000);
check("공격 수량 floor(200000/21000)", skewed.rows[0].refQty, 9);
check("안정 수량 floor(300000/22000)", skewed.rows[1].refQty, 13);
check(
  "합계가 잔액 이내",
  skewed.rows.reduce((a, r) => a + r.refQty * (r.refPrice ?? 0), 0) <= 500_000,
  true,
);

console.log("\n=== 깨진 자리 비중은 기본 50:50으로 되돌린다 ===");
check("정상값 통과", normalizeRoleWeights({ aggressive: 0.4, stable: 0.6 }), { aggressive: 0.4, stable: 0.6 });
check("합 1.00 정규화", normalizeRoleWeights({ aggressive: 0.495, stable: 0.495 }), { aggressive: 0.5, stable: 0.5 });
check("합이 크게 어긋나면 기본값", normalizeRoleWeights({ aggressive: 0.9, stable: 0.9 }), { aggressive: 0.5, stable: 0.5 });
check("0은 자리가 아니다 → 기본값", normalizeRoleWeights({ aggressive: 0, stable: 1 }), { aggressive: 0.5, stable: 0.5 });
check("값이 없으면 기본값", normalizeRoleWeights(null), { aggressive: 0.5, stable: 0.5 });
check("숫자가 아니면 기본값", normalizeRoleWeights({ aggressive: "반", stable: "반" }), { aggressive: 0.5, stable: 0.5 });

console.log("\n=== 두 자리에 같은 종목을 내면 낸 순서와 무관하게 공격적 성장 자리만 남는다 ===");
const sameTicker = normalizePicks(
  {
    picks: [
      pick({ role: "aggressive", ticker: "133690", ref_price: 22_000 }),
      pick({ role: "stable", ticker: "133690", ref_price: 22_000 }),
    ],
  },
  seatCtx,
);
check("1행 + 빈 자리 1행", sameTicker.rows.length, 2);
check("공격적 성장 자리만 앉는다", sameTicker.rows[0].role, "aggressive");
check(
  "비운 안정적 성장 자리는 사유가 적힌 건너뜀 행으로 남는다",
  [sameTicker.rows.at(1)?.role, sameTicker.rows.at(1)?.skipped, sameTicker.rows.at(1)?.budgetKrw, sameTicker.rows.at(1)?.rationale],
  ["stable", true, 250_000, "두 자리에 같은 종목 — 안정적 성장 자리 비움"],
);
check("자리 몫만 배정", sameTicker.rows[0].budgetKrw, 250_000);
check("비중도 자리 비중", sameTicker.rows[0].weight, 0.5);
check("수량 floor(250000/22000)", sameTicker.rows[0].refQty, 11);
check(
  "사유 기록",
  sameTicker.dropped.some((d) => d.includes("안정적 성장 자리 비움")),
  true,
);
check(
  "빈 자리 몫 이월 사유도 남는다",
  sameTicker.dropped.some((d) => d.includes("자리 1개가 비어")),
  true,
);
// 대조군: stable 을 먼저 내도 결과가 같아야 한다 — 코드는 GROWTH_ROLES 순서로 고르지
// 모델이 낸 순서로 고르지 않는다. 비중을 70:30으로 벌려 어느 자리 몫인지 눈에 보이게 한다.
const sameTickerStableFirst = normalizePicks(
  {
    picks: [
      pick({ role: "stable", ticker: "133690", ref_price: 22_000 }),
      pick({ role: "aggressive", ticker: "133690", ref_price: 22_000 }),
    ],
  },
  { ...seatCtx, roleWeights: { aggressive: 0.7, stable: 0.3 } },
);
check("대조군(stable 먼저): 1행 + 빈 자리 1행", sameTickerStableFirst.rows.length, 2);
check(
  "  남는 자리는 여전히 공격적 성장",
  sameTickerStableFirst.rows[0].role,
  "aggressive",
);
check(
  "  배정도 공격 자리 몫 floor(500000×0.7)",
  [sameTickerStableFirst.rows[0].budgetKrw, sameTickerStableFirst.rows[0].weight],
  [350_000, 0.7],
);
check(
  "  사유도 안정적 성장 자리 비움",
  sameTickerStableFirst.dropped.some((d) => d.includes("안정적 성장 자리 비움")),
  true,
);
check(
  "  대조군의 대조군: 종목이 다르면 두 자리가 다 찬다 (350,000 / 150,000)",
  normalizePicks(
    {
      picks: [
        pick({ role: "stable", ticker: "379800", ref_price: 22_000 }),
        pick({ role: "aggressive", ticker: "133690", ref_price: 22_000 }),
      ],
    },
    { ...seatCtx, roleWeights: { aggressive: 0.7, stable: 0.3 } },
  ).rows.map((r) => [r.role, r.budgetKrw]),
  // 행 순서는 모델이 낸 순서 그대로다 — 자리 선택만 GROWTH_ROLES 순서를 따른다
  [
    ["stable", 150_000],
    ["aggressive", 350_000],
  ],
);

console.log("\n=== 한 자리를 건너뛰면 그 자리 몫만 이월된다 (다른 자리로 넘기지 않는다) ===");
const oneSeatSkipped = normalizePicks(
  {
    picks: [
      pick({ role: "aggressive", action: "skip", ticker: null, etf_name: null, ref_price: null, rationale: "후보 없음" }),
      pick({ role: "stable", ticker: "379800", ref_price: 22_000 }),
    ],
  },
  seatCtx,
);
check("2행", oneSeatSkipped.rows.length, 2);
check("공격 자리 건너뜀", oneSeatSkipped.rows[0].skipped, true);
check("  이월액은 그 자리 몫뿐", oneSeatSkipped.rows[0].budgetKrw, 250_000);
check("안정 자리 배정은 그대로 반쪽", oneSeatSkipped.rows[1].budgetKrw, 250_000);
check("  수량 floor(250000/22000)", oneSeatSkipped.rows[1].refQty, 11);
check(
  "대조군: 건너뛴 자리 몫이 넘어갔다면 수량이 22주가 된다",
  computeRefQty(500_000, 0, 22_000),
  22,
);

console.log("\n=== role을 안 적으면 남은 자리에 순서대로 앉힌다 ===");
const noRole = normalizePicks(
  {
    picks: [
      pick({ ticker: "133690", ref_price: 21_000 }),
      pick({ ticker: "379800", ref_price: 22_000 }),
    ],
  },
  seatCtx,
);
check("자리 배정", noRole.rows.map((r) => r.role), ["aggressive", "stable"]);
check("비중 50:50", noRole.rows.map((r) => r.weight), [0.5, 0.5]);
check("사유 2건", noRole.dropped.filter((d) => d.includes("role이 없어")).length, 2);
check("대조군: pick이 하나뿐이면 role이 없어도 남은 자리에 앉힌다", assetPick.rows[0].role, "aggressive");
check("  그 pick도 그 자리 몫만 받는다", assetPick.rows[0].budgetKrw, 250_000);
check("  비중도 기록", assetPick.rows[0].weight, 0.5);

console.log("\n=== 같은 자리에 pick이 둘이면 먼저 나온 것만 쓴다 ===");
const dupRole = normalizePicks(
  {
    picks: [
      pick({ role: "aggressive", ticker: "133690", ref_price: 21_000 }),
      pick({ role: "aggressive", ticker: "379800", ref_price: 22_000 }),
    ],
  },
  seatCtx,
);
check("1행 + 빈 자리 1행", dupRole.rows.length, 2);
check("먼저 나온 종목", dupRole.rows[0].ticker, "133690");
check(
  "  모델이 내지 않은 안정적 성장 자리는 건너뜀 행",
  [dupRole.rows.at(1)?.role, dupRole.rows.at(1)?.skipped, dupRole.rows.at(1)?.rationale],
  ["stable", true, "모델이 이 자리를 내지 않음"],
);
check("자리가 하나 비어도 앉은 자리 몫만", dupRole.rows[0].budgetKrw, 250_000);
check(
  "사유 기록",
  dupRole.dropped.some((d) => d.includes("공격적 성장 자리에 pick이 둘")),
  true,
);
check(
  "  빈 자리 몫은 이월",
  dupRole.dropped.some(
    (d) => d === "자산성장 자리 1개가 비어 그 몫은 자산성장 잔액으로 이월",
  ),
  true,
);

console.log("\n=== 자리보다 많이 내면 나머지는 버린다 ===");
const threePicks = normalizePicks(
  {
    picks: [
      pick({ role: "aggressive", ticker: "133690", ref_price: 21_000 }),
      pick({ role: "stable", ticker: "379800", ref_price: 22_000 }),
      pick({ ticker: "360750", ref_price: 26_000 }),
    ],
  },
  seatCtx,
);
check("2행", threePicks.rows.length, 2);
check("남은 종목", threePicks.rows.map((r) => r.ticker), ["133690", "379800"]);
check(
  "사유 기록",
  threePicks.dropped.some((d) => d.includes("자리 2개가 이미 차서 제외")),
  true,
);
check(
  "배정 합계가 잔액 이내",
  threePicks.rows.reduce((a, r) => a + r.budgetKrw, 0) <= 500_000,
  true,
);

console.log("\n=== 한 자리 pick을 생략해도 남은 자리가 전액을 먹지 않는다 ===");
// 모델이 stable pick 자체를 빼먹는 경우. action=skip 으로 보낼 때와 같은 몫이어야 한다.
const seatOmitted = normalizePicks(
  { picks: [pick({ role: "aggressive", ticker: "133690", ref_price: 21_000 })] },
  seatCtx,
);
check("1행 + 빈 자리 1행", seatOmitted.rows.length, 2);
check("공격 자리 몫만 배정", seatOmitted.rows[0].budgetKrw, 250_000);
check("비중 기록", seatOmitted.rows[0].weight, 0.5);
check("수량 floor(250000/21000)", seatOmitted.rows[0].refQty, 11);
check(
  "빈 자리 몫은 이월 사유로 남는다",
  seatOmitted.dropped,
  ["자산성장 자리 1개가 비어 그 몫은 자산성장 잔액으로 이월"],
);
check(
  "대조군: 같은 자리를 action=skip 으로 보내도 배정액이 같다",
  normalizePicks(
    {
      picks: [
        pick({ role: "aggressive", ticker: "133690", ref_price: 21_000 }),
        pick({ role: "stable", action: "skip", ticker: null, etf_name: null, ref_price: null }),
      ],
    },
    seatCtx,
  ).rows.map((r) => r.budgetKrw),
  [250_000, 250_000],
);
check(
  "대조군: 전액을 받았다면 수량이 22주가 된다",
  computeRefQty(500_000, 0, 22_000),
  22,
);
check(
  "대조군: 두 자리가 같은 종목이어도 전액을 몰아주지 않는다",
  [sameTicker.rows[0].budgetKrw, sameTicker.rows[0].weight],
  [250_000, 0.5],
);
check(
  "  다른 자리에 넣었다면 두 자리가 다 찬다",
  normalizePicks(
    {
      picks: [
        pick({ role: "aggressive", ticker: "133690", ref_price: 22_000 }),
        pick({ role: "stable", ticker: "379800", ref_price: 22_000 }),
      ],
    },
    seatCtx,
  ).rows.map((r) => r.budgetKrw),
  [250_000, 250_000],
);

console.log("\n=== 나눈 뒤 실시간가로 갈아끼워도 자리 예산을 넘지 않는다 ===");
const seatPriced = applyRealtimePrices(
  twoSeats.rows,
  new Map([
    ["133690", { price: 18_000, pricedAt }],
    ["379800", { price: 25_000, pricedAt }],
  ]),
);
check("적용 2/2", [seatPriced.applied, seatPriced.eligible], [2, 2]);
check("공격 수량 floor(250000/18000)", seatPriced.rows[0].refQty, 13);
check("안정 수량 floor(250000/25000)", seatPriced.rows[1].refQty, 10);
check("자리 예산은 그대로", seatPriced.rows.map((r) => r.budgetKrw), [250_000, 250_000]);
check(
  "각 자리의 매수액이 그 자리 예산 이내",
  seatPriced.rows.every((r) => r.refQty * (r.refPrice ?? 0) <= r.budgetKrw),
  true,
);
check(
  "매수 합계가 잔액 이내",
  seatPriced.rows.reduce((a, r) => a + r.refQty * (r.refPrice ?? 0), 0) <= 500_000,
  true,
);

console.log("\n=== 자리를 두지 않는 카테고리는 한 종목만 담는다 ===");
const twoInDivGrowth = normalizePicks(
  {
    picks: [
      { category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14_000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] },
      { category: "배당성장", action: "buy", ticker: "402970", etf_name: "B", ref_price: 12_000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] },
    ],
  },
  { balances, injectedDocIds: [] },
);
check("1행", twoInDivGrowth.rows.length, 1);
check("전액 배정", twoInDivGrowth.rows[0].budgetKrw, 350_000);
check("자리 없음", twoInDivGrowth.rows[0].role, null);
check(
  "사유 기록",
  twoInDivGrowth.dropped.some((d) => d.includes("배당성장은 한 종목만 담는다")),
  true,
);

console.log("\n=== 대조군: 두 자리가 다 차면 빈 자리 행이 생기지 않는다 ===");
check("2행 그대로", twoSeats.rows.length, 2);
check("건너뜀 행 없음", twoSeats.rows.filter((r) => r.skipped).length, 0);
check(
  "대조군: 자리를 두지 않는 카테고리만 비어도 빈 자리 행은 없다",
  normalizePicks(
    { picks: [{ category: "배당성장", action: "buy", ticker: "446720", etf_name: "A", ref_price: 14_000, ref_qty: 1, rationale: "", source_doc_ids: [], source_urls: [] }] },
    { balances, injectedDocIds: [], active: ["div_growth"] as Category[] },
  ).rows.length,
  1,
);
check(
  "대조군: 자산성장이 비활성이면 빈 자리 행을 만들지 않는다",
  normalizePicks(
    { picks: [pick({ role: "aggressive", ticker: "133690", ref_price: 21_000 })] },
    { balances: seatBalances, injectedDocIds: [], active: ["high_div"] as Category[] },
  ).rows.map((r) => [r.role, r.skipped]),
  [["aggressive", true]],
);

console.log("\n=== 대조군: 자리를 두지 않는 카테고리는 자리 도입 전과 같다 ===");
check("3행 + 빈 자리 1행", buy.rows.length, 4);
check("배당성장·고배당은 자리·비중 없음", [buy.rows[0].role, buy.rows[0].weight, buy.rows[2].role, buy.rows[2].weight], [null, null, null, null]);
check("  배정액 = 각 카테고리 잔액", [buy.rows[0].budgetKrw, buy.rows[2].budgetKrw], [350_000, 140_000]);
check("  수량도 그대로", [buy.rows[0].refQty, buy.rows[2].refQty], [24, 15]);
check("자산성장만 자리 몫으로 줄어든다", [buy.rows[1].role, buy.rows[1].budgetKrw, buy.rows[1].refQty], ["aggressive", 105_000, 3]);
check("  대조군: 전액이었다면 floor(210000/26335)", computeRefQty(210_000, 0, 26_335), 7);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
