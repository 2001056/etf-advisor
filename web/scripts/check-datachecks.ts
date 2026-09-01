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
  distYield: 3, totalReturn1y: 10, navTrend: "up", yieldBasis: "trailing12m",
  premium: 0.1, note: "", ...o,
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
