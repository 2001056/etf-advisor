/** XIRR·ROAI 검증 — pnpm run check:xirr (DB 불필요) */
import { xirr, roai, CashFlow } from "../src/domain/xirr";

let failed = 0;
function near(l: string, actual: number | null | undefined, expected: number, tol = 0.0005) {
  const ok = actual != null && Math.abs(actual - expected) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}  ${actual == null ? "null" : (actual * 100).toFixed(2) + "%"} (기대 ${(expected * 100).toFixed(2)}%)`);
}
function check(l: string, ok: boolean, d = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`);
}

console.log("=== 기본: 1년에 정확히 10% ===");
near("1년 10%", xirr([
  { date: "2025-01-01", amount: -1000 },
  { date: "2026-01-01", amount: 1100 },
])?.rate, 0.1, 0.002);

console.log("\n=== 손실도 계산된다 ===");
near("1년 -20%", xirr([
  { date: "2025-01-01", amount: -1000 },
  { date: "2026-01-01", amount: 800 },
])?.rate, -0.2, 0.002);

console.log("\n=== 리서치 예시 재현: 월 70만 × 12회 → 900만 ===");
const flows: CashFlow[] = [];
for (let i = 0; i < 12; i++) {
  const d = new Date(Date.UTC(2025, 8 + i, 15));
  flows.push({ date: d.toISOString().slice(0, 10), amount: -700_000 });
}
flows.push({ date: "2026-08-28", amount: 9_000_000 });
const r = xirr(flows);
console.log(`   납입 ${(700_000*12).toLocaleString("ko-KR")} → 평가 9,000,000`);
console.log(`   기존 방식: ${((600_000/8_400_000)*100).toFixed(2)}%`);
near("XIRR ≈ 14.8%", r?.rate, 0.1482, 0.01);
check("기존 방식보다 크다", (r?.rate ?? 0) > 600_000 / 8_400_000);

console.log("\n=== 분배금이 있는 경우 ===");
const withDiv = xirr([
  { date: "2025-01-01", amount: -1_000_000 },
  { date: "2025-07-01", amount: 30_000 },
  { date: "2026-01-01", amount: 1_050_000 },
]);
check("계산됨", withDiv !== null, withDiv ? (withDiv.rate * 100).toFixed(2) + "%" : "");
check("분배금 덕에 8% 초과", (withDiv?.rate ?? 0) > 0.08);

console.log("\n=== 계산 불가 상황은 null ===");
check("흐름 1건", xirr([{ date: "2025-01-01", amount: -100 }]) === null);
check("전부 지출", xirr([
  { date: "2025-01-01", amount: -100 },
  { date: "2026-01-01", amount: -100 },
]) === null);
check("전부 수입", xirr([
  { date: "2025-01-01", amount: 100 },
  { date: "2026-01-01", amount: 100 },
]) === null);
check("같은 날짜뿐", xirr([
  { date: "2025-01-01", amount: -100 },
  { date: "2025-01-01", amount: 110 },
]) === null);
check("빈 배열", xirr([]) === null);

console.log("\n=== 순서가 섞여 있어도 같은 결과 ===");
const a = xirr([
  { date: "2026-01-01", amount: 1100 },
  { date: "2025-01-01", amount: -1000 },
]);
near("정렬 무관", a?.rate, 0.1, 0.002);

console.log("\n=== 극단값 ===");
const big = xirr([
  { date: "2025-01-01", amount: -1000 },
  { date: "2026-01-01", amount: 5000 },
]);
check("400% 수익도 수렴", big !== null && big.rate > 3.9 && big.rate < 4.1,
  big ? (big.rate * 100).toFixed(0) + "%" : "");
const wipe = xirr([
  { date: "2025-01-01", amount: -1000 },
  { date: "2026-01-01", amount: 1 },
]);
check("거의 전손도 수렴", wipe !== null && wipe.rate < -0.99);

console.log("\n=== ROAI 폴백 ===");
const roaiFlows: CashFlow[] = [
  { date: "2025-09-15", amount: -700_000 },
  { date: "2026-08-15", amount: -700_000 },
];
const rv = roai(roaiFlows, "2026-08-28", 200_000);
check("계산됨", rv !== null, rv ? (rv * 100).toFixed(2) + "%" : "");
check("단순 원금대비(14.3%)보다 크다", (rv ?? 0) > 200_000 / 1_400_000);
check("투자 없으면 null", roai([{ date: "2025-01-01", amount: 100 }], "2026-01-01", 10) === null);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
