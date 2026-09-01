/** 비중 이탈 계산 검증 — pnpm run check:drift (DB 불필요) */
import { computeDrift, targetsFromTopup } from "../src/domain/drift";
import { Category } from "../src/domain/money";

let failed = 0;
function near(l: string, a: number, e: number, tol = 0.01) {
  const ok = Math.abs(a - e) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}  ${a.toFixed(2)} (기대 ${e.toFixed(2)})`);
}
function check(l: string, ok: boolean, d = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`);
}
const T = targetsFromTopup({ div_growth: 350_000, asset_growth: 210_000, high_div: 140_000 });
const pick = (r: ReturnType<typeof computeDrift>, c: Category) => r.rows.find((x) => x.category === c)!;

console.log("=== 목표 비중 유도 (35/21/14만 → 50/30/20) ===");
near("배당성장", T.div_growth, 50);
near("자산성장", T.asset_growth, 30);
near("고배당", T.high_div, 20);

console.log("\n=== 정확히 목표대로면 이탈 0 ===");
const perfect = computeDrift({ div_growth: 500_000, asset_growth: 300_000, high_div: 200_000 }, T);
near("배당성장 이탈", pick(perfect, "div_growth").driftPp, 0);
near("최대 이탈", perfect.maxAbsDriftPp, 0);
check("모든 gap 0", perfect.rows.every((r) => r.gapKrw === 0));

console.log("\n=== 배당성장이 오르면 과대비중이 된다 ===");
// 배당성장만 60만으로 상승 → 총 110만, 실제 54.5% vs 목표 50%
const up = computeDrift({ div_growth: 600_000, asset_growth: 300_000, high_div: 200_000 }, T);
near("실제 비중", pick(up, "div_growth").actualPct, 54.55);
near("이탈 +4.55%p", pick(up, "div_growth").driftPp, 4.55);
check("gap 음수(덜 사야 함)", pick(up, "div_growth").gapKrw < 0, String(pick(up, "div_growth").gapKrw));
check("다른 쪽은 gap 양수", pick(up, "asset_growth").gapKrw > 0);

console.log("\n=== 비중 합은 항상 100% ===");
const sum = up.rows.reduce((s, r) => s + r.actualPct, 0);
near("합계", sum, 100);
const gapSum = up.rows.reduce((s, r) => s + r.gapKrw, 0);
check("gap 합은 0에 가까움(반올림 오차만)", Math.abs(gapSum) <= 3, String(gapSum));

console.log("\n=== 보유 없음 ===");
const empty = computeDrift({ div_growth: 0, asset_growth: 0, high_div: 0 }, T);
check("측정 불가 표시", empty.measurable === false);
check("나눗셈 안 함(전부 0)", empty.rows.every((r) => r.actualPct === 0));

console.log("\n=== 한 카테고리만 보유 ===");
const one = computeDrift({ div_growth: 1_000_000, asset_growth: 0, high_div: 0 }, T);
near("100%", pick(one, "div_growth").actualPct, 100);
near("이탈 +50%p", pick(one, "div_growth").driftPp, 50);
near("고배당은 -20%p", pick(one, "high_div").driftPp, -20);

console.log("\n=== 충전액이 0이면 목표 비중 0 ===");
const zero = targetsFromTopup({ div_growth: 0, asset_growth: 0, high_div: 0 });
check("나눗셈 안 함", zero.div_growth === 0);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
