/** TWR 검증 — pnpm run check:twr (DB 불필요) */
import { twr, Valuation } from "../src/domain/twr";

let failed = 0;
function near(l: string, a: number | null | undefined, e: number, tol = 0.01) {
  const ok = a != null && Math.abs(a - e) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}  ${a == null ? "null" : a.toFixed(2) + "%"} (기대 ${e.toFixed(2)}%)`);
}
function check(l: string, ok: boolean, d = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`);
}

console.log("=== 흐름 없이 10% 상승 ===");
near("누적 10%", twr([
  { date: "2025-01-01", value: 1000, netFlow: 0 },
  { date: "2026-01-01", value: 1100, netFlow: 0 },
])?.cumulativePct, 10);

console.log("\n=== 핵심: 납입 타이밍이 결과를 바꾸지 않는다 ===");
// 1000 → 1100 (10%) 후 1000 추가 납입 → 2100, 다시 10% → 2310
const withFlow = twr([
  { date: "2025-01-01", value: 1000, netFlow: 0 },
  { date: "2025-07-01", value: 2100, netFlow: 1000 },
  { date: "2026-01-01", value: 2310, netFlow: 0 },
]);
near("납입 있어도 21%", withFlow?.cumulativePct, 21);
check("구간 2개", withFlow?.periods === 2);
// 같은 수익률인데 납입액만 10배 → TWR은 동일해야 한다
const bigFlow = twr([
  { date: "2025-01-01", value: 1000, netFlow: 0 },
  { date: "2025-07-01", value: 11100, netFlow: 10000 },
  { date: "2026-01-01", value: 12210, netFlow: 0 },
]);
near("납입액 10배여도 동일", bigFlow?.cumulativePct, 21);

console.log("\n=== 손실 구간 ===");
near("−20%", twr([
  { date: "2025-01-01", value: 1000, netFlow: 0 },
  { date: "2026-01-01", value: 800, netFlow: 0 },
])?.cumulativePct, -20);

console.log("\n=== 연환산 ===");
const half = twr([
  { date: "2025-01-01", value: 1000, netFlow: 0 },
  { date: "2025-07-02", value: 1100, netFlow: 0 },
]);
near("반년 10% → 연 21%대", half?.annualPct, 21.0, 0.6);
const short = twr([
  { date: "2026-08-01", value: 1000, netFlow: 0 },
  { date: "2026-08-10", value: 1100, netFlow: 0 },
]);
check("30일 미만은 연환산 없음", short !== null && short.annualPct === null);
check("누적은 나온다", (short?.cumulativePct ?? 0) > 9);

console.log("\n=== 첫 매수 직전(평가액 0) 구간은 건너뛴다 ===");
const fromZero = twr([
  { date: "2025-01-01", value: 0, netFlow: 0 },
  { date: "2025-01-15", value: 1000, netFlow: 1000 },
  { date: "2026-01-15", value: 1200, netFlow: 0 },
]);
near("0 구간 제외하고 20%", fromZero?.cumulativePct, 20);

console.log("\n=== 추이 시계열 ===");
check("series 길이 = 시점 수", withFlow?.series.length === 3);
check("첫 값은 0%", withFlow?.series[0].cumulativePct === 0);
near("마지막 = 누적", withFlow?.series[2].cumulativePct, 21);

console.log("\n=== 계산 불가 ===");
check("시점 1개면 null", twr([{ date: "2025-01-01", value: 100, netFlow: 0 }]) === null);
check("빈 배열", twr([]) === null);

console.log("\n=== 순서가 섞여도 동일 ===");
near("정렬 무관", twr([
  { date: "2026-01-01", value: 1100, netFlow: 0 },
  { date: "2025-01-01", value: 1000, netFlow: 0 },
])?.cumulativePct, 10);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
