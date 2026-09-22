/** 수치 자가검증 게이트 검증 — pnpm run check:data */
import {
  checkRow, checkPremiumIdentity, checkWeightsSum, checkDistributionSum, checkDocument,
} from "../src/domain/dataChecks";
import { DataRow, ParsedDoc } from "../src/domain/docFormat";

let failed = 0;
function check(l: string, ok: boolean, d = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`);
}
const row = (o: Partial<DataRow>): DataRow => ({
  ticker: "446720", name: "테스트", category: "고배당", price: 10000,
  distYield: 3, totalReturn1y: 10, returnBasis: "1y", navTrend: "up", yieldBasis: "trailing12m",
  premium: 0.1, note: "비용:실부담",
  aumBn: 12_000, costPct: 0.19, turnoverBn: 35, mdd1yPct: -12.4,
  hasEvidenceColumns: true,
  ...o,
});
const has = (rs: ReturnType<typeof checkRow>, f: string) => rs.some((i) => i.field === f);

console.log("=== 정상 행은 통과 ===");
check("문제 없음", checkRow(row({})).length === 0);

console.log("\n=== 자릿수 실수 ===");
check("가격이 너무 작으면 오류", has(checkRow(row({ price: 12 })), "price"));
check("가격이 너무 크면 오류", has(checkRow(row({ price: 9_000_000 })), "price"));
check("정상 가격은 통과", !has(checkRow(row({ price: 179_030 })), "price"));

console.log("\n=== 분배율 ===");
check("음수 분배율", has(checkRow(row({ distYield: -1 })), "dist_yield"));
check("비현실적 분배율(50%)", has(checkRow(row({ distYield: 50 })), "dist_yield"));
check("커버드콜 17%는 통과", !has(checkRow(row({ distYield: 17, totalReturn1y: 12 })), "dist_yield"));

console.log("\n=== 리서치 핵심: 분배율 vs 총수익률 ===");
check("분배율 17%인데 총수익 -5% → 경고",
  has(checkRow(row({ distYield: 17, totalReturn1y: -5 })), "total_return_1y"));
check("분배율 17%인데 총수익 3% → 경고",
  has(checkRow(row({ distYield: 17, totalReturn1y: 3 })), "total_return_1y"));
check("분배율 17%에 총수익 15% → 통과",
  !has(checkRow(row({ distYield: 17, totalReturn1y: 15 })), "total_return_1y"));
check("분배율 낮으면(3%) 검사 안 함",
  !has(checkRow(row({ distYield: 3, totalReturn1y: -5 })), "total_return_1y"));

console.log("\n=== NAV 하락 + 고분배 ===");
check("분배율 17% + NAV down → 경고",
  has(checkRow(row({ distYield: 17, navTrend: "down", totalReturn1y: 12 })), "nav_trend"));
check("분배율 3% + NAV down → 경고 없음",
  !has(checkRow(row({ distYield: 3, navTrend: "down" })), "nav_trend"));

console.log("\n=== 분배율 산출 기준 ===");
check("target 기준이면 비교 주의", has(checkRow(row({ yieldBasis: "target" })), "yield_basis"));
check("annualized_1m도 주의", has(checkRow(row({ yieldBasis: "annualized_1m" })), "yield_basis"));
check("trailing12m은 통과", !has(checkRow(row({ yieldBasis: "trailing12m" })), "yield_basis"));

console.log("\n=== 순자산 하한 (내부 보수 기준 — KRX 지정요건 자체가 아니다) ===");
check("50억 미만이면 주의", has(checkRow(row({ aumBn: 40 })), "aum_bn"));
const aumMsg = checkRow(row({ aumBn: 40 })).find((i) => i.field === "aum_bn")?.message ?? "";
check("  문구에 관리종목·상장폐지",
  aumMsg.includes("관리종목") && aumMsg.includes("상장폐지"));
check("  내부 보수 기준임을 밝힌다", aumMsg.includes("내부 보수 기준"));
check("  KRX 지정요건은 신탁원본액까지 함께 본다고 적는다",
  aumMsg.includes("신탁원본액") && aumMsg.includes("상장 1년 경과"));
check("대조군: 50억이면 통과", !has(checkRow(row({ aumBn: 50 })), "aum_bn"));
check("대조군: 1조 2천억은 통과", !has(checkRow(row({ aumBn: 12_000 })), "aum_bn"));
check("대조군: NA(null)면 검사 안 함", !has(checkRow(row({ aumBn: null })), "aum_bn"));

console.log("\n=== 비용 기준 표기 (외부 검토 8차: 누락 = 총보수만) ===");
const costFlag = (note: string, costPct: number | null = 0.19) =>
  checkRow(row({ note, costPct })).find((i) => i.field === "cost_pct");
check("플래그가 없으면 주의", costFlag("미정 / H, 2026-09-21 확인")?.severity === "warn");
check("  문구는 총보수만으로 취급한다고 알린다",
  costFlag("")?.message.includes("비용 기준 표기 누락 — 총보수만으로 취급") === true);
check("  적어야 할 플래그 셋을 문구에 넣는다",
  costFlag("")?.message.includes('"비용:실부담"') === true &&
  costFlag("")?.message.includes('"비용:합성총보수"') === true &&
  costFlag("")?.message.includes('"비용:총보수만"') === true);
check('대조군: "비용:실부담"이면 통과', costFlag("공격 / 비H / 비용:실부담") === undefined);
check('대조군: "비용:합성총보수"면 통과', costFlag("안정 / H / 비용:합성총보수") === undefined);
check('대조군: "비용:총보수만"이면 통과', costFlag("비용:총보수만, 2026-09-21 확인") === undefined);
check("대조군: cost_pct 가 NA 면 검사하지 않는다", costFlag("", null) === undefined);

// 외부 검토 9차: 표기 변형도 watch 와 같은 함수(costFlag.parseCostFlag)로 읽는다 — 한쪽만 알아보면 안 된다.
check('대조군: "비용: 실부담"(콜론 뒤 공백)도 통과', costFlag("공격 / 비H / 비용: 실부담") === undefined);
check('대조군: "비용 : 실부담"(콜론 앞뒤 공백)도 통과', costFlag("공격 / 비H / 비용 : 실부담") === undefined);
check('대조군: "비용:실부담비용"(뒤에 설명)도 통과', costFlag("공격 / 비H / 비용:실부담비용") === undefined);
check('대조군: "비용 : 합성총보수"도 통과', costFlag("안정 / H / 비용 : 합성총보수") === undefined);
check('대조군: "비용 : 총보수만"도 통과', costFlag("안정 / H / 비용 : 총보수만") === undefined);
check("셋 중 어느 것도 아닌 플래그면 주의", costFlag("공격 / 비H / 비용:미확인")?.severity === "warn");

console.log("\n=== 괴리율 2단계 (절댓값 기준) ===");
const prem = (v: number) => checkRow(row({ premium: v })).find((i) => i.field === "premium");
check("5% 이하는 통과", prem(4.9) === undefined);
check("대조군: -4.9% 도 통과", prem(-4.9) === undefined);
check("5% 초과는 LP 관리범위 문구", prem(6)?.message.includes("LP 관리범위") === true);
check("-6% 도 같은 문구(절댓값)", prem(-6)?.message.includes("LP 관리범위") === true);
check("  문구가 절댓값 기준임을 밝힌다", prem(-6)?.message.includes("절댓값") === true);
check("-12% 도 2단계로 올라간다(절댓값)", prem(-12)?.message.includes("투자유의종목") === true);
check("10% 초과는 투자유의종목 문구", prem(12)?.message.includes("투자유의종목") === true);
check("  10% 초과 문구에 LP 관리범위는 안 쓴다", prem(12)?.message.includes("LP 관리범위") === false);
check("대조군: 10%는 아직 1단계", prem(10)?.message.includes("LP 관리범위") === true);
check("둘 다 severity=warn", prem(6)?.severity === "warn" && prem(12)?.severity === "warn");

console.log("\n=== 괴리율 항등식 ===");
check("계산과 일치하면 통과", checkPremiumIdentity("A", 10100, 10000, 1.0) === null);
check("계산과 다르면 오류", checkPremiumIdentity("A", 10100, 10000, 5.0) !== null);
check("NAV 없으면 검사 안 함", checkPremiumIdentity("A", 10100, null, 1.0) === null);
check("NAV 0이면 나눗셈 안 함", checkPremiumIdentity("A", 10100, 0, 1.0) === null);

console.log("\n=== 비중 합 ===");
check("100%면 통과", checkWeightsSum([50, 30, 20]) === null);
check("반올림 오차(99.7)는 허용", checkWeightsSum([49.9, 29.9, 19.9]) === null);
check("크게 어긋나면 경고", checkWeightsSum([50, 30, 5]) !== null);
check("빈 배열은 검사 안 함", checkWeightsSum([]) === null);

console.log("\n=== 분배금 합 항등식 ===");
check("월별 합과 같으면 통과", checkDistributionSum("A", [100, 100, 100], 300) === null);
check("다르면 오류", checkDistributionSum("A", [100, 100, 100], 500) !== null);
check("1원 오차는 허용", checkDistributionSum("A", [100, 100, 100], 301) === null);

console.log("\n=== 문서 전체: 같은 종목이 두 카테고리 ===");
const doc = { frontmatter: {}, sections: {}, problems: [],
  dataRows: [row({ category: "고배당" }), row({ category: "배당성장" })] } as ParsedDoc;
check("카테고리 충돌 감지", checkDocument(doc).some((i) => i.field === "category"));

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
