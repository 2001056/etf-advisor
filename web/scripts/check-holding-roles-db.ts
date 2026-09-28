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
  applyHoldingRoleChangesTx,
  getBalances,
  getHoldingRoleOverrides,
  seedInitialBalances,
  setHoldingRole,
  setHoldingRoles,
  Tx,
} from "../src/domain/ledger";
import {
  addManualPurchase,
  addPurchase,
  addPurchaseWithHighDivTransfer,
  addSale,
  cancelSwitch,
  deletePurchase,
  executeSwitch,
  getHoldings,
  holdingRoles,
} from "../src/domain/purchases";
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

async function rowCounts() {
  const r = await db.execute<{ p: number; s: number; l: number }>(sql`select
      (select count(*) from purchases)::int as p,
      (select count(*) from sales)::int as s,
      (select count(*) from ledger)::int as l`);
  return r.rows[0];
}

async function newRec(ticker: string, role: string | null) {
  const [row] = await db
    .insert(recommendations)
    .values({
      month: "2026-09",
      category: "asset_growth",
      role,
      ticker,
      etfName: `합성 ${ticker}`,
      budgetKrw: 100_000,
      rationale: "검증용",
    })
    .returning();
  return row;
}

const assetBuy = (ticker: string, qty: number, extra: object = {}) => ({
  boughtAt: "2026-09-10",
  category: "asset_growth" as const,
  ticker,
  etfName: `합성 ${ticker}`,
  qty,
  unitPrice: 20_000,
  ...extra,
});

/** 다른 연결이 락을 기다리기 시작할 때까지 (최대 5초) */
async function waitForLockWaiter() {
  for (let i = 0; i < 250; i++) {
    const r = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (r.rows[0].n >= 1) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}

/**
 * holding_roles 행이 없는 상태에서 첫 저장 두 건을 겹치게 한다:
 * T1 이 쓰고 커밋하지 않은 채 멈춘 동안 T2 를 시작하고, T2 가 락을 기다리는 걸 확인한 뒤 T1 을 커밋한다.
 */
async function overlappedFirstWrites(
  first: (tx: Tx) => Promise<void>,
  second: () => Promise<unknown>,
) {
  await db.delete(settings).where(eq(settings.key, "holding_roles"));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let wrote!: () => void;
  const firstWrote = new Promise<void>((r) => (wrote = r));
  const t1 = db.transaction(async (tx) => {
    await first(tx);
    wrote();
    await gate;
  });
  await firstWrote;
  const t2 = second();
  const blocked = await waitForLockWaiter();
  release();
  await Promise.all([t1, t2]);
  return { blocked, stored: await storedValue() };
}

/** 고치기 전 저장 방식 그대로 — 없는 행에 FOR UPDATE 를 걸고 upsert 로 덮어쓴다 (대조군) */
async function legacySetTx(tx: Tx, key: string, role: string) {
  const [row] = await tx
    .select()
    .from(settings)
    .where(eq(settings.key, "holding_roles"))
    .limit(1)
    .for("update");
  const value = { ...((row?.value as Record<string, string>) ?? {}), [key]: role };
  await tx
    .insert(settings)
    .values({ key: "holding_roles", value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
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

  // ── 자리 지정의 수명: 보유가 0이 되면 지운다 ──
  console.log("\n=== 전량 매도하면 그 종목의 자리 지정도 지워진다 ===");
  await truncateAll();
  await seedInitialBalances({ div_growth: 0, asset_growth: 1_000_000, high_div: 0 });
  await addPurchase(assetBuy("251350", 10));
  await setHoldingRole("asset_growth", "251350", "stable");
  const sale = { soldAt: "2026-09-20", category: "asset_growth" as const, ticker: "251350", unitPrice: 21_000 };
  await addSale({ ...sale, qty: 4 });
  check("대조군: 일부 매도는 자리 유지", await getHoldingRoleOverrides(), {
    "asset_growth::251350": "stable",
  });
  await addSale({ ...sale, qty: 6 });
  check("전량 매도 뒤 수동 지정 없음", await getHoldingRoleOverrides(), {});
  check("자리 없음", await roles(), {});

  console.log("\n=== 갈아타기로 전량 매도해도 지워진다 ===");
  await addPurchase(assetBuy("446720", 5));
  await setHoldingRole("asset_growth", "446720", "aggressive");
  await executeSwitch({
    category: "asset_growth",
    executedAt: "2026-09-21",
    sell: { ticker: "446720", qty: 5, unitPrice: 20_000 },
    buy: { ticker: "133690", etfName: "합성 133690", qty: 5, unitPrice: 20_000 },
  });
  check("판 종목의 수동 지정 없음", await getHoldingRoleOverrides(), {});

  console.log("\n=== 새 종목을 산 갈아타기를 취소하면 그때 붙인 자리도 지워진다 ===");
  await truncateAll();
  await seedInitialBalances({ div_growth: 0, asset_growth: 1_000_000, high_div: 0 });
  await addPurchase(assetBuy("251350", 10));
  const swNew = await executeSwitch({
    category: "asset_growth",
    executedAt: "2026-09-21",
    sell: { ticker: "251350", qty: 5, unitPrice: 20_000 },
    buy: { ticker: "133690", etfName: "합성 133690", qty: 5, unitPrice: 20_000 },
    role: "aggressive",
  });
  check("갈아타기와 같은 트랜잭션에서 자리 저장", await getHoldingRoleOverrides(), {
    "asset_growth::133690": "aggressive",
  });
  await cancelSwitch(swNew.switchGroupId);
  check("취소 뒤 수동 지정 없음", await getHoldingRoleOverrides(), {});
  check("자리 없음", await roles(), {});

  console.log("\n--- 대조군: 이미 들고 있던 종목을 더 산 갈아타기는 취소해도 자리가 남는다 ---");
  await addPurchase(assetBuy("446720", 3));
  await setHoldingRole("asset_growth", "446720", "stable");
  const swMore = await executeSwitch({
    category: "asset_growth",
    executedAt: "2026-09-22",
    sell: { ticker: "251350", qty: 2, unitPrice: 20_000 },
    buy: { ticker: "446720", etfName: "합성 446720", qty: 2, unitPrice: 20_000 },
  });
  await cancelSwitch(swMore.switchGroupId);
  check("보유가 남아 수동 지정 유지", await getHoldingRoleOverrides(), {
    "asset_growth::446720": "stable",
  });

  console.log("\n=== 매입을 지워 보유가 0이 되면 자리 지정도 지운다 ===");
  const firstLot = await addPurchase(assetBuy("133690", 2));
  const secondLot = await addPurchase(assetBuy("133690", 1));
  await setHoldingRole("asset_growth", "133690", "stable");
  await deletePurchase(secondLot.id);
  check("대조군: 남은 매입이 있으면 유지", (await getHoldingRoleOverrides())["asset_growth::133690"], "stable");
  await deletePurchase(firstLot.id);
  check("마지막 매입을 지우면 없음", (await getHoldingRoleOverrides())["asset_growth::133690"], undefined);

  console.log("\n=== 자리를 가진 추천으로 사면 수동 지정이 지워지고 추천 자리가 선다 ===");
  await truncateAll();
  await seedInitialBalances({ div_growth: 0, asset_growth: 1_000_000, high_div: 0 });
  await addPurchase(assetBuy("251350", 5));
  await addPurchase(assetBuy("446720", 5));
  await setHoldingRoles([
    { category: "asset_growth", ticker: "251350", role: "stable" },
    { category: "asset_growth", ticker: "446720", role: "stable" },
  ]);
  const seatRec = await newRec("251350", "aggressive");
  await addPurchaseWithHighDivTransfer(
    assetBuy("251350", 2, { recommendationId: seatRec.id }),
    { allowTransfer: false },
  );
  check("251350 수동 지정 없음", (await getHoldingRoleOverrides())["asset_growth::251350"], undefined);
  check("251350 은 추천 자리(공격)", (await roles())["asset_growth::251350"], "aggressive");
  const noSeatRec = await newRec("446720", null);
  await addPurchaseWithHighDivTransfer(
    assetBuy("446720", 2, { recommendationId: noSeatRec.id }),
    { allowTransfer: false },
  );
  check(
    "대조군: 자리 없는 추천으로 사면 수동 지정 유지",
    (await getHoldingRoleOverrides())["asset_growth::446720"],
    "stable",
  );

  // ── 폼 자리: 아직 자리가 없는 종목에만 ──
  console.log("\n=== 폼 자리가 이미 있는 자리와 다르면 아무것도 쓰지 않고 거부 ===");
  // 지금 251350 = 공격(추천), 446720 = 안정(수동)
  const beforeCounts = await rowCounts();
  const beforeStored = await storedValue();
  const beforeBal = await getBalances();
  check(
    "수기 매입: 추천 자리와 다름",
    await messageOf(() =>
      addManualPurchase(assetBuy("251350", 1), { allowOverBalance: false, role: "stable" }),
    ),
    "251350는 이미 공격적 성장 자리입니다 — 자리는 설정 화면에서 바꾸세요",
  );
  check(
    "갈아타기: 수동 자리와 다름",
    await messageOf(() =>
      executeSwitch({
        category: "asset_growth",
        executedAt: "2026-09-23",
        sell: { ticker: "251350", qty: 1, unitPrice: 20_000 },
        buy: { ticker: "446720", etfName: "합성 446720", qty: 1, unitPrice: 20_000 },
        role: "aggressive",
      }),
    ),
    "446720는 이미 안정적 성장 자리입니다 — 자리는 설정 화면에서 바꾸세요",
  );
  check("행 수 불변(매도도 없음)", await rowCounts(), beforeCounts);
  check("저장값 불변", await storedValue(), beforeStored);
  check("잔액 불변", await getBalances(), beforeBal);

  console.log("\n--- 대조군: 같은 자리를 고르면 통과하고 수동 지정은 새로 생기지 않는다 ---");
  check(
    "예외 없음",
    await messageOf(() =>
      addManualPurchase(assetBuy("251350", 1), { allowOverBalance: false, role: "aggressive" }),
    ),
    null,
  );
  check("저장값 불변", await storedValue(), beforeStored);

  console.log("\n--- 대조군: 자리가 없는 종목에는 매입과 함께 저장된다 ---");
  check(
    "예외 없음",
    await messageOf(() =>
      addManualPurchase(assetBuy("133690", 1), { allowOverBalance: false, role: "stable" }),
    ),
    null,
  );
  check("133690 안정 저장", (await getHoldingRoleOverrides())["asset_growth::133690"], "stable");

  console.log("\n--- 매입이 실패하면 새 종목 자리도 남지 않는다 (같은 트랜잭션) ---");
  const overCounts = await rowCounts();
  check(
    "잔액 초과로 거부",
    (await messageOf(() =>
      addManualPurchase(assetBuy("111111", 1000), { allowOverBalance: false, role: "aggressive" }),
    ))?.startsWith("자산성장 잔액("),
    true,
  );
  check("111111 자리 없음", (await getHoldingRoleOverrides())["asset_growth::111111"], undefined);
  check("행 수 불변", await rowCounts(), overCounts);

  // ── 첫 저장 경합 ──
  console.log("\n=== 행이 없을 때 첫 저장 두 건이 겹쳐도 두 키가 모두 남는다 ===");
  const fixed = await overlappedFirstWrites(
    (tx) =>
      applyHoldingRoleChangesTx(tx, [
        { category: "asset_growth", ticker: "251350", role: "aggressive" },
      ]),
    () => setHoldingRole("asset_growth", "133690", "stable"),
  );
  check("두 번째 저장이 첫 저장을 기다렸다", fixed.blocked, true);
  check("두 키 모두", fixed.stored, {
    "asset_growth::133690": "stable",
    "asset_growth::251350": "aggressive",
  });

  console.log("\n--- 대조군: 고치기 전 방식은 같은 겹침에서 첫 키를 잃는다 ---");
  const legacy = await overlappedFirstWrites(
    (tx) => legacySetTx(tx, "asset_growth::251350", "aggressive"),
    () => db.transaction((tx) => legacySetTx(tx, "asset_growth::133690", "stable")),
  );
  check("두 번째 저장이 기다렸다", legacy.blocked, true);
  check("첫 키가 사라짐", legacy.stored, { "asset_growth::133690": "stable" });

  console.log("\n--- 대조군: 겹치지 않고 차례로 저장하면 두 키 ---");
  await db.delete(settings).where(eq(settings.key, "holding_roles"));
  await setHoldingRole("asset_growth", "251350", "aggressive");
  await setHoldingRole("asset_growth", "133690", "stable");
  check("차례로 저장", await storedValue(), {
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
