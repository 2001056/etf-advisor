/**
 * 보유 종목 자리 수동 지정 — 저장·병합·해제 검증. 검증용 DB에서만 실행할 것 — 테이블을 비운다.
 *   DATABASE_URL=<test db> pnpm exec tsx scripts/check-holding-roles-db.ts
 * 종목·금액은 전부 합성 값이다.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  agentRuns,
  ledger,
  purchaseCycles,
  purchases,
  recommendations,
  sales,
  settings,
} from "../src/db/schema";
import {
  getHoldingRoleOverrides,
  seedInitialBalances,
  setHoldingRole,
  setHoldingRoles,
} from "../src/domain/ledger";
import { addPurchase, getHoldings, holdingRoles } from "../src/domain/purchases";
import { needsReview } from "../src/server/consolidate";
import { guardAgainstRealData } from "./lib/guard";

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

async function truncateAll() {
  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
}

async function messageOf(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 지금 자리를 정렬된 객체로 — 비교하기 쉽게 */
async function roles() {
  const m = await holdingRoles();
  return Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function storedValue() {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "holding_roles"));
  return row?.value ?? null;
}

async function main() {
  await guardAgainstRealData();
  await truncateAll();
  await seedInitialBalances({ div_growth: 0, asset_growth: 500_000, high_div: 0 });

  // 133690: ③ 공격 자리 추천으로 산 종목 / 251350: 추천 없이 수기로 산 종목
  const [rec] = await db
    .insert(recommendations)
    .values({
      month: "2026-09",
      category: "asset_growth",
      role: "aggressive",
      ticker: "133690",
      etfName: "합성 공격 ETF",
      budgetKrw: 250_000,
      rationale: "검증용",
    })
    .returning();
  await addPurchase({
    boughtAt: "2026-09-10",
    category: "asset_growth",
    ticker: "133690",
    etfName: "합성 공격 ETF",
    qty: 10,
    unitPrice: 20_000,
    recommendationId: rec.id,
  });
  await addPurchase({
    boughtAt: "2026-09-11",
    category: "asset_growth",
    ticker: "251350",
    etfName: "합성 안정 ETF",
    qty: 10,
    unitPrice: 20_000,
  });

  console.log("=== 대조군: 수동 지정 전에는 추천으로 산 종목만 자리를 안다 ===");
  check("추천 자리만", await roles(), { "asset_growth::133690": "aggressive" });
  const holdings = await getHoldings();
  check(
    "⑤ 검토 대상 — 수기 매입 종목의 자리를 몰라 중복일 수 있다",
    needsReview(holdings, await holdingRoles()),
    true,
  );

  console.log("\n=== 지정하면 holdingRoles 에 반영된다 ===");
  await setHoldingRole("asset_growth", "251350", "stable");
  check("수기 매입 종목에 안정 자리", await roles(), {
    "asset_growth::133690": "aggressive",
    "asset_growth::251350": "stable",
  });
  check(
    "⑤ 검토 대상 아님 — 두 자리가 서로 다르다",
    needsReview(holdings, await holdingRoles()),
    false,
  );
  check("저장값", await storedValue(), { "asset_growth::251350": "stable" });

  console.log("\n=== 수동 지정이 추천에서 온 자리를 이긴다 ===");
  await setHoldingRole("asset_growth", "133690", "stable");
  check("133690 은 안정으로", (await roles())["asset_growth::133690"], "stable");
  check(
    "⑤ 검토 대상 — 이제 두 종목이 같은 자리",
    needsReview(holdings, await holdingRoles()),
    true,
  );

  console.log("\n=== null 은 수동 지정을 지운다 ===");
  await setHoldingRole("asset_growth", "133690", null);
  check("133690 은 추천 자리(공격)로 돌아간다", (await roles())["asset_growth::133690"], "aggressive");
  await setHoldingRole("asset_growth", "251350", null);
  check("251350 은 자리 없음으로 돌아간다", await roles(), {
    "asset_growth::133690": "aggressive",
  });
  check("저장값이 비었다", await storedValue(), {});

  console.log("\n=== 자산성장이 아닌 종목은 지정할 수 없다 ===");
  const before = await storedValue();
  check(
    "거부 메시지",
    await messageOf(() => setHoldingRole("div_growth", "446720", "aggressive")),
    "자리는 자산성장 종목에만 지정할 수 있습니다 (배당성장 446720)",
  );
  check("저장값 불변", await storedValue(), before);
  check(
    "묶음 저장도 하나라도 틀리면 아무것도 쓰지 않는다",
    await messageOf(() =>
      setHoldingRoles([
        { category: "asset_growth", ticker: "251350", role: "stable" },
        { category: "high_div", ticker: "446720", role: "stable" },
      ]),
    ),
    "자리는 자산성장 종목에만 지정할 수 있습니다 (고배당 446720)",
  );
  check("저장값 불변", await storedValue(), before);
  check("자리도 불변", await roles(), { "asset_growth::133690": "aggressive" });

  console.log("\n--- 대조군: 같은 묶음에서 틀린 줄을 빼면 저장된다 ---");
  await setHoldingRoles([
    { category: "asset_growth", ticker: "251350", role: "stable" },
    { category: "asset_growth", ticker: "133690", role: "stable" },
  ]);
  check("두 줄 모두 반영", await roles(), {
    "asset_growth::133690": "stable",
    "asset_growth::251350": "stable",
  });

  console.log("\n=== 저장값이 깨져 있어도 자산성장 키·올바른 자리만 읽는다 ===");
  await db
    .update(settings)
    .set({
      value: {
        "div_growth::446720": "aggressive",
        "asset_growth::251350": "bogus",
        "asset_growth::133690": "stable",
      },
    })
    .where(eq(settings.key, "holding_roles"));
  check("수동 지정 읽기", await getHoldingRoleOverrides(), {
    "asset_growth::133690": "stable",
  });
  check("배당성장 키·잘못된 자리는 무시", await roles(), {
    "asset_growth::133690": "stable",
  });
  await setHoldingRole("asset_growth", "251350", "aggressive");
  check("다음 저장 때 깨진 항목이 정리된다", await storedValue(), {
    "asset_growth::133690": "stable",
    "asset_growth::251350": "aggressive",
  });

  await truncateAll();
  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
