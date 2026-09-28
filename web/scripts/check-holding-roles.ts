/**
 * 보유 종목 자리 수동 지정 — 저장값 정규화·추천 자리와의 병합 검증 (DB 불필요)
 *   pnpm run check:holding-roles
 * 종목코드는 전부 합성 값이다.
 */
import {
  GrowthRole,
  mergeHoldingRoles,
  normalizeHoldingRoles,
} from "../src/domain/recommendation";

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

const sorted = (m: Map<string, GrowthRole>) =>
  Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));

console.log("=== 대조군: 올바른 저장값은 그대로 읽힌다 ===");
const good = {
  "asset_growth::251350": "aggressive",
  "asset_growth::133690": "stable",
};
check("두 종목 모두 남는다", normalizeHoldingRoles(good), good);

console.log("\n=== 자산성장이 아닌 카테고리 키는 버린다 ===");
check(
  "배당성장·고배당 키 제거",
  normalizeHoldingRoles({
    "div_growth::446720": "aggressive",
    "high_div::133690": "stable",
    "asset_growth::251350": "stable",
  }),
  { "asset_growth::251350": "stable" },
);
check(
  "없는 카테고리 키 제거",
  normalizeHoldingRoles({ "bond::251350": "aggressive" }),
  {},
);

console.log("\n=== 자리가 아닌 값은 버린다 ===");
check(
  "알 수 없는 문자열·숫자·null·배열·객체 제거",
  normalizeHoldingRoles({
    "asset_growth::251350": "bogus",
    "asset_growth::133690": 1,
    "asset_growth::446720": null,
    "asset_growth::111111": ["aggressive"],
    "asset_growth::222222": { role: "stable" },
    "asset_growth::333333": "aggressive",
  }),
  { "asset_growth::333333": "aggressive" },
);

console.log("\n=== 키 모양이 틀리면 버린다 ===");
check(
  "구분자 없음·빈 종목코드 제거",
  normalizeHoldingRoles({
    "asset_growth251350": "aggressive",
    "asset_growth::": "stable",
    "asset_growth::   ": "stable",
    "::251350": "stable",
  }),
  {},
);
check(
  "종목코드 앞뒤 공백은 떼고 남긴다",
  normalizeHoldingRoles({ "asset_growth:: 251350 ": "stable" }),
  { "asset_growth::251350": "stable" },
);

console.log("\n=== 저장값 자체가 객체가 아니면 빈 값 ===");
for (const [label, raw] of [
  ["undefined", undefined],
  ["null", null],
  ["문자열", "aggressive"],
  ["숫자", 3],
  ["배열", [["asset_growth::251350", "aggressive"]]],
] as [string, unknown][]) {
  check(`${label} → {}`, normalizeHoldingRoles(raw), {});
}

console.log("\n=== 병합: 추천 자리 위에 수동 지정이 덮인다 ===");
const derived = new Map<string, GrowthRole>([
  ["asset_growth::133690", "aggressive"],
  ["asset_growth::446720", "stable"],
]);
const merged = mergeHoldingRoles(derived, {
  "asset_growth::133690": "stable",
  "asset_growth::251350": "aggressive",
});
check("같은 종목이면 수동 지정이 이긴다", merged.get("asset_growth::133690"), "stable");
check("추천에만 있는 종목은 그대로", merged.get("asset_growth::446720"), "stable");
check("수동 지정에만 있는 종목이 더해진다", merged.get("asset_growth::251350"), "aggressive");
check("원래 추천 자리 맵은 바뀌지 않는다", sorted(derived), {
  "asset_growth::133690": "aggressive",
  "asset_growth::446720": "stable",
});

console.log("\n--- 대조군: 수동 지정이 없으면 추천 자리 그대로 ---");
check("빈 수동 지정", sorted(mergeHoldingRoles(derived, {})), sorted(derived));
check(
  "둘 다 비면 빈 맵",
  mergeHoldingRoles(new Map(), {}).size,
  0,
);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
