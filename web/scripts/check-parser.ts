/** 조사 문서 파서 검증 (기획서 §5.4) — pnpm run check:parser */
import { parseResearchDoc, tickersOf } from "../src/domain/docFormat";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`      기대=${JSON.stringify(expected)}\n      실제=${JSON.stringify(actual)}`);
}

const GOOD = `---
run_id: 7
date: 2026-08-27
type: scheduled
tickers: [446720, 133690]
model: gpt-5
---

## 1. 요약
세 줄 요약.

## 2. 시장 개관
| 지수 | 값 |
|---|---|
| 코스피 | 6,808 |

## 3. 카테고리별 ETF 현황
### 배당성장
내용

## 4. 데이터 표
| ticker | name | category | price | dist_yield | premium | note |
|--------|------|----------|-------|------------|---------|------|
| 446720 | SOL 미국배당다우존스 | 배당성장 | 12,345 | 3.5% | 0.12 | 정상 |
| 133690 | TIGER 미국나스닥100 | 자산성장 | 179030 | 0.3 | -0.05 |  |
| 486290 | 미확인 ETF | 고배당 |  |  |  | 가격 확인 실패 |

## 5. 이벤트·뉴스
- 2026-08-25 분배금 공시

## 6. 리스크 신호
없음

## 7. 출처
- https://example.com/a
`;

const parsed = parseResearchDoc(GOOD);
check("형식 위반 없음", parsed.problems, []);
check("frontmatter tickers", parsed.frontmatter.tickers, ["446720", "133690"]);
check("데이터 표 행 수", parsed.dataRows.length, 3);
check("쉼표 포함 가격 파싱", parsed.dataRows[0].price, 12345);
check("퍼센트 기호 제거", parsed.dataRows[0].distYield, 3.5);
check("음수 괴리율", parsed.dataRows[1].premium, -0.05);
check("빈 값은 null", parsed.dataRows[2].price, null);
check("빈 note 유지", parsed.dataRows[1].note, "");
check("종목 유니온", tickersOf(parsed).sort(), ["133690", "446720", "486290"]);

const NO_FM = GOOD.replace(/^---[\s\S]*?---\n/, "");
const p2 = parseResearchDoc(NO_FM);
check("frontmatter 없음 감지", p2.problems.includes("frontmatter가 없습니다"), true);
check("frontmatter 없어도 표는 파싱", p2.dataRows.length, 3);

const NO_TABLE = GOOD.replace(/## 4\. 데이터 표[\s\S]*?(?=## 5\.)/, "## 4. 데이터 표\n표를 만들지 못했습니다.\n\n");
const p3 = parseResearchDoc(NO_TABLE);
check("표 없음 감지", p3.problems.length > 0, true);
check("표 없으면 행 0", p3.dataRows.length, 0);

const MISSING_SECTION = GOOD.replace(/## 6\. 리스크 신호\n없음\n\n/, "");
const p4 = parseResearchDoc(MISSING_SECTION);
check("섹션 누락 감지", p4.problems.some((x) => x.includes("6")), true);

const WRONG_COLS = GOOD.replace(
  "| ticker | name | category | price | dist_yield | premium | note |",
  "| 종목코드 | 이름 | 구분 | 가격 |",
);
const p5 = parseResearchDoc(WRONG_COLS);
check("컬럼명 위반 감지", p5.problems.some((x) => x.includes("ticker")), true);
check("컬럼 깨져도 크래시 없음", Array.isArray(p5.dataRows), true);

// ── 코드 리뷰에서 나온 회귀 케이스 ────────────────────────────

console.log("\n--- 회귀: 표가 두 개일 때 헤더 줄이 데이터로 새면 안 됨 ---");
const TWO_TABLES = GOOD.replace(
  "## 5. 이벤트·뉴스",
  `| ticker | name | category | price | dist_yield | premium | note |
|---|---|---|---|---|---|---|
| 999999 | 추가표 ETF | 고배당 | 1000 | 1 | 0 | 두 번째 표 |

## 5. 이벤트·뉴스`,
);
const p6 = parseResearchDoc(TWO_TABLES);
check("유령 헤더 행 없음", p6.dataRows.some((r) => r.ticker.toLowerCase() === "ticker"), false);
check("두 번째 표의 진짜 행은 살아남음", p6.dataRows.some((r) => r.ticker === "999999"), true);
check("종목 유니온에 'ticker' 없음", tickersOf(p6).includes("ticker"), false);

console.log("\n--- 회귀: 같은 섹션 번호가 두 번 나와도 앞 표가 사라지지 않음 ---");
const DUP_SECTION = GOOD.replace("## 5. 이벤트·뉴스", "## 4. 데이터 표\n(추가 설명)\n\n## 5. 이벤트·뉴스");
const p7 = parseResearchDoc(DUP_SECTION);
check("중복 섹션에도 원래 행 유지", p7.dataRows.length, 3);

console.log("\n--- 회귀: 통화기호·군더더기 있는 가격 ---");
const CURRENCY = GOOD.replace("| 12,345 |", "| ₩12,345 |").replace("| 179030 |", "| 약 179,030원 |");
const p8 = parseResearchDoc(CURRENCY);
check("₩ 제거", p8.dataRows[0].price, 12345);
check("'약'과 '원' 제거", p8.dataRows[1].price, 179030);

console.log("\n--- 회귀: 뜻을 알 수 없는 가격은 경고로 남음 ---");
const BAD_PRICE = GOOD.replace("| 12,345 |", "| 12,3x45 |");
const p9 = parseResearchDoc(BAD_PRICE);
check("가격 파싱 실패 경고", p9.problems.some((x) => x.includes("숫자로 읽지 못했")), true);

console.log("\n--- 프롬프트 계약: NA는 정상 결측이라 경고하지 않음 ---");
for (const mark of ["NA", "N/A", "없음", "미확인", "-"]) {
  const doc = parseResearchDoc(GOOD.replace("| 12,345 |", `| ${mark} |`));
  check(`'${mark}' 경고 없음`, doc.problems.some((x) => x.includes("숫자로 읽지 못했")), false);
  check(`'${mark}' → null`, doc.dataRows[0].price, null);
}

console.log("\n--- 회귀: 문서 전체가 코드펜스로 감싸여도 frontmatter 유지 ---");
const FENCED = "```markdown\n" + GOOD + "\n```";
const p10 = parseResearchDoc(FENCED);
check("펜스 안 frontmatter 파싱", p10.frontmatter.run_id, "7");
check("펜스 안 데이터 표 파싱", p10.dataRows.length, 3);

console.log("\n--- 회귀: 마지막 헤딩에 개행이 없어도 본문에 헤딩이 섞이지 않음 ---");
const NO_TRAILING = GOOD.replace(/## 7\. 출처\n- https:\/\/example\.com\/a\n$/, "## 7. 출처");
const p11 = parseResearchDoc(NO_TRAILING);
check("빈 섹션이 자기 헤딩을 담지 않음", (p11.sections["7"] ?? "").includes("## 7."), false);

console.log("\n--- 회귀: 중복 종목 행 ---");
const DUP_TICKER = GOOD.replace(
  "| 486290 | 미확인 ETF | 고배당 |  |  |  | 가격 확인 실패 |",
  "| 446720 | SOL 미국배당다우존스 | 배당성장 | 14000 | 3.5 | 0.1 | 중복 |",
);
const p12 = parseResearchDoc(DUP_TICKER);
check("중복 종목은 한 번만", p12.dataRows.filter((r) => r.ticker === "446720").length, 1);
check("중복 경고 있음", p12.problems.some((x) => x.includes("중복")), true);

console.log("\n--- 새 열: 총수익률·NAV추이·산출기준 ---");
const WIDE = GOOD.replace(
  "| ticker | name | category | price | dist_yield | premium | note |",
  "| ticker | name | category | price | dist_yield | total_return_1y | nav_trend | yield_basis | premium | note |",
)
  .replace("|--------|------|----------|-------|------------|---------|------|",
           "|---|---|---|---|---|---|---|---|---|---|")
  .replace("| 446720 | SOL 미국배당다우존스 | 배당성장 | 12,345 | 3.5% | 0.12 | 정상 |",
           "| 446720 | SOL 미국배당다우존스 | 배당성장 | 12,345 | 3.5% | 14.2 | up | trailing12m | 0.12 | 정상 |")
  .replace("| 133690 | TIGER 미국나스닥100 | 자산성장 | 179030 | 0.3 | -0.05 |  |",
           "| 133690 | TIGER 미국나스닥100 | 자산성장 | 179030 | 0.3 | 22.1 | up | trailing12m | -0.05 |  |")
  .replace("| 486290 | 미확인 ETF | 고배당 |  |  |  | 가격 확인 실패 |",
           "| 486290 | 미확인 ETF | 고배당 | 9000 | 17.3 | -4.5 | down | target |  | NAV 하락 |");
const w = parseResearchDoc(WIDE);
check("총수익률 파싱", w.dataRows[0].totalReturn1y, 14.2);
check("NAV 추이 파싱", w.dataRows[0].navTrend, "up");
check("산출 기준 파싱", w.dataRows[0].yieldBasis, "trailing12m");
check("음수 총수익률", w.dataRows[2].totalReturn1y, -4.5);
check("분배율 높은데 NAV down", w.dataRows[2].navTrend, "down");
check("새 열 있어도 형식 경고 없음", w.problems.length, 0);
check("10컬럼 문서는 구 형식으로 표시", w.dataRows[0].hasEvidenceColumns, false);
check("  핵심 증거 4열은 null", [
  w.dataRows[0].aumBn, w.dataRows[0].costPct, w.dataRows[0].turnoverBn, w.dataRows[0].mdd1yPct,
], [null, null, null, null]);

console.log("\n--- 핵심 증거 4열: 14컬럼 파싱 ---");
// ③ 게이트가 보는 열. 순자산(억원 정수)·실부담비용(%)·거래대금(억원)·1년 최대낙폭(음수 %)
const WIDE14 = GOOD.replace(
  "| ticker | name | category | price | dist_yield | premium | note |",
  "| ticker | name | category | price | dist_yield | total_return_1y | nav_trend | yield_basis | premium | note | aum_bn | cost_pct | turnover_bn | mdd_1y_pct |",
)
  .replace("|--------|------|----------|-------|------------|---------|------|",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
  .replace("| 446720 | SOL 미국배당다우존스 | 배당성장 | 12,345 | 3.5% | 0.12 | 정상 |",
           "| 446720 | SOL 미국배당다우존스 | 배당성장 | 12,345 | 3.5% | 14.2 | up | trailing12m | 0.12 | 정상 | 12000 | 0.19 | 35.0 | -12.4 |")
  .replace("| 133690 | TIGER 미국나스닥100 | 자산성장 | 179030 | 0.3 | -0.05 |  |",
           "| 133690 | TIGER 미국나스닥100 | 자산성장 | 179030 | 0.3 | 22.1 | up | trailing12m | -0.05 |  | 40 | NA | 120.5 | -18.2 |")
  .replace("| 486290 | 미확인 ETF | 고배당 |  |  |  | 가격 확인 실패 |",
           "| 486290 | 미확인 ETF | 고배당 | 9000 | 17.3 | -4.5 | down | target |  | NAV 하락 | NA | 0.35 | NA | NA |");
const w14 = parseResearchDoc(WIDE14);
check("형식 경고 없음", w14.problems, []);
check("순자산(억원 정수)", w14.dataRows[0].aumBn, 12000);
check("실부담비용(%)", w14.dataRows[0].costPct, 0.19);
check("거래대금(억원, 소수 1자리)", w14.dataRows[0].turnoverBn, 35);
check("최대 낙폭(음수 %)", w14.dataRows[0].mdd1yPct, -12.4);
check("14컬럼이면 구 형식이 아니다", w14.dataRows[0].hasEvidenceColumns, true);
check("NA 는 null (cost_pct)", w14.dataRows[1].costPct, null);
check("NA 여도 형식 경고 아님", w14.problems.length, 0);
check("NA 3개 행도 구 형식은 아니다", [
  w14.dataRows[2].aumBn, w14.dataRows[2].turnoverBn, w14.dataRows[2].mdd1yPct,
  w14.dataRows[2].hasEvidenceColumns,
], [null, null, null, true]);
check("빈 칸도 null", w14.dataRows[1].costPct, null);
check("기존 10컬럼 값은 그대로", [
  w14.dataRows[0].totalReturn1y, w14.dataRows[0].navTrend, w14.dataRows[0].premium,
], [14.2, "up", 0.12]);
check("return_basis 열이 없으면 빈 문자열", w14.dataRows[0].returnBasis, "");

console.log("\n--- 수익률 기간 기준: 15컬럼 파싱 ---");
// total_return_1y 숫자는 그대로 두고 그 값이 잰 기간만 return_basis 가 정한다.
const WIDE15 = GOOD.replace(
  "| ticker | name | category | price | dist_yield | premium | note |",
  "| ticker | name | category | price | dist_yield | total_return_1y | return_basis | nav_trend | yield_basis | premium | note | aum_bn | cost_pct | turnover_bn | mdd_1y_pct |",
)
  .replace("|--------|------|----------|-------|------------|---------|------|",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
  .replace("| 446720 | SOL 미국배당다우존스 | 배당성장 | 12,345 | 3.5% | 0.12 | 정상 |",
           "| 446720 | SOL 미국배당다우존스 | 배당성장 | 12,345 | 3.5% | 14.2 | 1y | up | trailing12m | 0.12 | 정상 | 12000 | 0.19 | 35.0 | -12.4 |")
  .replace("| 133690 | TIGER 미국나스닥100 | 자산성장 | 179030 | 0.3 | -0.05 |  |",
           "| 133690 | TIGER 미국나스닥100 | 자산성장 | 179030 | 0.3 | 5.1 | since_listing:3 | up | trailing12m | -0.05 | 2026-06-30 상장 | 40 | 0.1 | 120.5 | -18.2 |")
  .replace("| 486290 | 미확인 ETF | 고배당 |  |  |  | 가격 확인 실패 |",
           "| 486290 | 미확인 ETF | 고배당 | 9000 | 17.3 | NA | NA | down | target |  | 상장 이후 실적 확인 불가 | 3000 | 0.35 | 25.0 | NA |");
const w15 = parseResearchDoc(WIDE15);
check("형식 경고 없음", w15.problems, []);
check("1y 그대로", w15.dataRows[0].returnBasis, "1y");
check("상장 N개월", w15.dataRows[1].returnBasis, "since_listing:3");
check("  총수익률 숫자는 그 기간의 값", w15.dataRows[1].totalReturn1y, 5.1);
check("둘 다 NA 면 수치는 null, 기준은 'na'",
  [w15.dataRows[2].totalReturn1y, w15.dataRows[2].returnBasis], [null, "na"]);
check("대문자·공백은 소문자로 정규화",
  parseResearchDoc(WIDE15.replace("| 1y |", "|  1Y  |")).dataRows[0].returnBasis, "1y");

console.log("\n--- 같은 지수의 비대표 행도 그대로 받는다 (표 행 수 제한 없음) ---");
// ①이 대표 1개만 후보로 두되 비대표 상품도 표에 남기므로, 같은 지수 행이 여럿 온다.
// 파서가 행 수를 제한하거나 note 내용을 보고 거르면 그 상품은 ②·③에서 사라진다.
const NON_REP = GOOD.replace(
  "| 486290 | 미확인 ETF | 고배당 |  |  |  | 가격 확인 실패 |",
  [
    "| 486290 | 미확인 ETF | 고배당 |  |  |  | 가격 확인 실패 |",
    "| 111110 | 대표 성장 ETF | 자산성장 | 20000 | 0.8 | 0.05 | 공격 / 비H, 대표 |",
    "| 222220 | 같은지수 성장 ETF | 자산성장 | 21000 | 0.7 | 0.06 | 공격 / 비H, 동일 지수 비대표(대표: 111110) |",
    "| 333330 | 자리 미정 ETF | 자산성장 | 19000 | 0.9 | 0.04 | 미정 / H, 운용전략 확인 불가 |",
  ].join("\n"),
);
const rep = parseResearchDoc(NON_REP);
check("행이 모두 살아남는다", rep.dataRows.length, 6);
check("형식 경고 없음", rep.problems, []);
check("비대표 note 보존", rep.dataRows[4].note, "공격 / 비H, 동일 지수 비대표(대표: 111110)");
check("자리 미정 note 보존", rep.dataRows[5].note, "미정 / H, 운용전략 확인 불가");
check("종목 유니온에 비대표 포함", tickersOf(rep).includes("222220"), true);

console.log("\n--- 예전 문서(새 열 없음)는 여전히 정상 ---");
const old = parseResearchDoc(GOOD);
check("형식 경고 없음", old.problems.length, 0);
check("새 열은 null/빈문자", [
  old.dataRows[0].totalReturn1y, old.dataRows[0].returnBasis, old.dataRows[0].navTrend,
], [null, "", ""]);
check("핵심 증거 4열도 null", [
  old.dataRows[0].aumBn, old.dataRows[0].costPct,
  old.dataRows[0].turnoverBn, old.dataRows[0].mdd1yPct,
], [null, null, null, null]);
check("구 형식으로 표시된다", old.dataRows[0].hasEvidenceColumns, false);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
