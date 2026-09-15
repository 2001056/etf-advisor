/**
 * 갈아타기 묶음 삭제·취소 검증 (§5 A3). 검증용 DB에서만 실행할 것 — 테이블을 비운다.
 *   DATABASE_URL=<test db> pnpm exec tsx scripts/check-switch.ts
 */
import { sql } from "drizzle-orm";
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
import { getBalances, seedInitialBalances } from "../src/domain/ledger";
import {
  addPurchase,
  addPurchaseWithHighDivTransfer,
  addSale,
  cancelSwitch,
  deletePurchase,
  executeSwitch,
  listPurchases,
} from "../src/domain/purchases";

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

async function reset(
  balances = { div_growth: 900_000, asset_growth: 0, high_div: 0 },
) {
  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  await seedInitialBalances(balances);
}

async function newRecommendation(ticker: string) {
  const [row] = await db
    .insert(recommendations)
    .values({
      month: "2026-09",
      category: "div_growth",
      ticker,
      etfName: ticker,
      budgetKrw: 100_000,
      rationale: "검증용",
    })
    .returning();
  return row;
}

/** 한 매입에 달린 원장 행 수 — 고배당 이전 쌍까지 함께 지워졌는지 본다 */
async function ledgerRefCount(purchaseId: number) {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ledger where ref_purchase_id = ${purchaseId}`,
  );
  return r.rows[0].n;
}

/** 고배당 건너뜀 이전(adjust 쌍) 행 수 */
async function transferRowCount() {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from ledger where type='adjust' and memo like '고배당 건너뜀%'`,
  );
  return r.rows[0].n;
}

async function counts(groupId?: string) {
  const g = groupId ?? "";
  const r = await db.execute<{
    p: number;
    s: number;
    lp: number;
    ls: number;
    gp: number;
    gs: number;
  }>(sql`select
      (select count(*) from purchases)::int as p,
      (select count(*) from sales)::int as s,
      (select count(*) from ledger where type='purchase')::int as lp,
      (select count(*) from ledger where type='sell')::int as ls,
      (select count(*) from purchases where switch_group_id = ${g})::int as gp,
      (select count(*) from sales where switch_group_id = ${g})::int as gs`);
  return r.rows[0];
}

/** 묶음에 연결된 원장 행 수 — 취소 뒤 고아가 남지 않았는지 본다 */
async function groupLedgerCount(groupId: string) {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n
      from ledger l
      where l.ref_purchase_id in (select id from purchases where switch_group_id = ${groupId})
         or l.ref_sale_id in (select id from sales where switch_group_id = ${groupId})`);
  return r.rows[0].n;
}

/** 고아 검출 (§9.2) — sell 원장이 가리키는 sales 행이 사라졌으면 잔액이 과대해진다 */
async function orphanCount() {
  const r = await db.execute<{ n: number }>(sql`select count(*)::int as n
      from ledger l
      where (l.ref_sale_id is not null and not exists (select 1 from sales s where s.id = l.ref_sale_id))
         or (l.ref_purchase_id is not null and not exists (select 1 from purchases p where p.id = l.ref_purchase_id))`);
  return r.rows[0].n;
}

async function messageOf(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function main() {
  const [guard] = await db
    .select({
      n: sql<number>`(select count(*) from ${purchases})::int + (select count(*) from ${settings})::int`,
    })
    .from(sql`(select 1) as _`);
  if (Number(guard?.n ?? 0) > 0 && process.env.ALLOW_WIPE !== "1") {
    console.error(
      "데이터가 있는 DB입니다. 검증용 DB(etf_advisor_test)에서 실행하세요.",
    );
    process.exit(2);
  }

  console.log("=== 시나리오 1: 갈아타기 매수 행은 개별 삭제되지 않는다 ===");
  await reset();
  await addPurchase({
    boughtAt: "2026-09-01",
    category: "div_growth",
    ticker: "379800",
    etfName: "KODEX 미국S&P500",
    qty: 20,
    unitPrice: 20_000,
  });
  const balBefore = await getBalances();
  const sw = await executeSwitch({
    category: "div_growth",
    executedAt: "2026-09-16",
    sell: { ticker: "379800", qty: 5, unitPrice: 20_000 },
    buy: {
      ticker: "490600",
      etfName: "PLUS 고배당주",
      qty: 10,
      unitPrice: 10_000,
    },
  });
  const balAfterSwitch = await getBalances();

  const delMsg = await messageOf(() => deletePurchase(sw.purchase.id));
  check(
    "거부 메시지",
    delMsg,
    "갈아타기 묶음의 매입은 개별 삭제할 수 없습니다. 갈아타기 화면에서 묶음을 취소하세요",
  );
  const c1 = await counts(sw.switchGroupId);
  check("purchases 2행 그대로", c1.p, 2);
  check("sales 1행 그대로", c1.s, 1);
  check("ledger purchase 2행 그대로", c1.lp, 2);
  check("ledger sell 1행 그대로", c1.ls, 1);
  check("잔액 불변", await getBalances(), balAfterSwitch);

  console.log("\n=== 시나리오 2: 묶음 취소 → 매수·매도·원장이 함께 사라진다 ===");
  check("취소 전 묶음 원장 행", await groupLedgerCount(sw.switchGroupId), 2);
  const cancelled = await cancelSwitch(sw.switchGroupId);
  check("지운 행 수", cancelled, { purchases: 1, sales: 1 });
  const c2 = await counts(sw.switchGroupId);
  check("묶음 purchases 0행", c2.gp, 0);
  check("묶음 sales 0행", c2.gs, 0);
  check("묶음 원장 0행", await groupLedgerCount(sw.switchGroupId), 0);
  check("고아 원장 0행", await orphanCount(), 0);
  check("잔액이 실행 전과 동일", await getBalances(), balBefore);
  check("남은 매입은 최초 1건", (await listPurchases()).length, 1);

  console.log("\n=== 시나리오 3: 매수 종목을 이미 판 뒤라면 취소를 거부한다 ===");
  await reset();
  await addPurchase({
    boughtAt: "2026-09-01",
    category: "div_growth",
    ticker: "379800",
    etfName: "KODEX 미국S&P500",
    qty: 20,
    unitPrice: 20_000,
  });
  const sw2 = await executeSwitch({
    category: "div_growth",
    executedAt: "2026-09-16",
    sell: { ticker: "379800", qty: 5, unitPrice: 20_000 },
    buy: {
      ticker: "490600",
      etfName: "PLUS 고배당주",
      qty: 10,
      unitPrice: 10_000,
    },
  });
  // 갈아타기로 산 10주를 그 뒤 전량 매도 → 되돌리면 보유가 음수가 된다
  await addSale({
    soldAt: "2026-09-20",
    category: "div_growth",
    ticker: "490600",
    qty: 10,
    unitPrice: 11_000,
  });
  const balBeforeCancel = await getBalances();
  const cancelMsg = await messageOf(() => cancelSwitch(sw2.switchGroupId));
  check(
    "거부 메시지",
    cancelMsg,
    "배당성장 490600를 이미 매도한 뒤라 이 갈아타기를 취소할 수 없습니다",
  );
  const c3 = await counts(sw2.switchGroupId);
  check("묶음 purchases 1행 그대로", c3.gp, 1);
  check("묶음 sales 1행 그대로", c3.gs, 1);
  check("잔액 불변", await getBalances(), balBeforeCancel);

  console.log(
    "\n=== 시나리오 4: 고배당 이전이 붙은 매입을 지우면 이전 두 행도 함께 사라진다 ===",
  );
  await reset({ div_growth: 350_000, asset_growth: 0, high_div: 140_000 });
  const balBeforeBuy = await getBalances();
  const recTransfer = await newRecommendation("446720");
  const transferBuy = {
    boughtAt: "2026-09-16",
    category: "div_growth" as const,
    ticker: "446720",
    etfName: "SOL 미국배당다우존스",
    qty: 31,
    unitPrice: 14_000,
    recommendationId: recTransfer.id,
  };
  // 434,000 중 부족분 84,000을 고배당에서 끌어온다
  const withTransfer = await addPurchaseWithHighDivTransfer(transferBuy, {
    allowTransfer: true,
  });
  check("이전 후 잔액", await getBalances(), {
    div_growth: 0,
    asset_growth: 0,
    high_div: 56_000,
  });
  check(
    "매입에 달린 원장 3행(purchase 1 + adjust 2)",
    await ledgerRefCount(withTransfer.id),
    3,
  );
  check("이전 행 2건", await transferRowCount(), 2);

  await deletePurchase(withTransfer.id);
  check("삭제 후 매입에 달린 원장 0행", await ledgerRefCount(withTransfer.id), 0);
  check("삭제 후 이전 행 0건", await transferRowCount(), 0);
  check("잔액이 이전 전으로 복원", await getBalances(), balBeforeBuy);
  check("고아 원장 0행", await orphanCount(), 0);

  // 삭제로 추천이 다시 열려도, 잔액이 원래대로라 부족분이 같아 이전은 한 번만 남는다
  const redone = await addPurchaseWithHighDivTransfer(transferBuy, {
    allowTransfer: true,
  });
  check("재확정 후 잔액", await getBalances(), {
    div_growth: 0,
    asset_growth: 0,
    high_div: 56_000,
  });
  check("재확정 후에도 이전 행 2건", await transferRowCount(), 2);
  check("재확정 매입에 달린 원장 3행", await ledgerRefCount(redone.id), 3);

  console.log(
    "\n=== 시나리오 5: 매도대금을 이미 다른 매입에 쓴 뒤 취소하면 거부 ===",
  );
  await reset();
  await addPurchase({
    boughtAt: "2026-09-01",
    category: "div_growth",
    ticker: "379800",
    etfName: "KODEX 미국S&P500",
    qty: 20,
    unitPrice: 20_000,
  });
  const sw3 = await executeSwitch({
    category: "div_growth",
    executedAt: "2026-09-16",
    sell: { ticker: "379800", qty: 10, unitPrice: 20_000 },
    buy: {
      ticker: "490600",
      etfName: "PLUS 고배당주",
      qty: 5,
      unitPrice: 20_000,
    },
  });
  // 매도로 늘어난 잔액(10만)까지 다른 종목에 써버린다 → 취소하면 되돌릴 재원이 없다
  const spender = await addPurchase({
    boughtAt: "2026-09-18",
    category: "div_growth",
    ticker: "446720",
    etfName: "SOL 미국배당다우존스",
    qty: 6,
    unitPrice: 100_000,
  });
  check("쓰고 난 잔액 0원", (await getBalances()).div_growth, 0);
  const balSpent = await getBalances();
  const spentMsg = await messageOf(() => cancelSwitch(sw3.switchGroupId));
  check(
    "거부 메시지",
    spentMsg,
    "취소하면 배당성장 잔액이 100,000원 음수가 됩니다. 먼저 다른 매입을 정리하세요",
  );
  const c5 = await counts(sw3.switchGroupId);
  check("묶음 purchases 1행 그대로", c5.gp, 1);
  check("묶음 sales 1행 그대로", c5.gs, 1);
  check("묶음 원장 2행 그대로", await groupLedgerCount(sw3.switchGroupId), 2);
  check("잔액 불변", await getBalances(), balSpent);

  console.log("\n--- 대조군: 쓴 매입을 정리하면 같은 취소가 통과한다 ---");
  await deletePurchase(spender.id);
  const freedMsg = await messageOf(() => cancelSwitch(sw3.switchGroupId));
  check("예외 없음", freedMsg, null);
  check("취소 후 잔액", (await getBalances()).div_growth, 500_000);
  check("묶음 원장 0행", await groupLedgerCount(sw3.switchGroupId), 0);
  check("고아 원장 0행", await orphanCount(), 0);

  console.log("\n=== 대조군: 갈아타기가 아닌 일반 매입은 그대로 삭제된다 ===");
  await reset();
  const plain = await addPurchase({
    boughtAt: "2026-09-02",
    category: "div_growth",
    ticker: "446720",
    etfName: "SOL 미국배당다우존스",
    qty: 1,
    unitPrice: 100_000,
  });
  check("매입 후 잔액", (await getBalances()).div_growth, 800_000);
  const plainMsg = await messageOf(() => deletePurchase(plain.id));
  check("예외 없음", plainMsg, null);
  const c4 = await counts();
  check("purchases 0행", c4.p, 0);
  check("ledger purchase 0행", c4.lp, 0);
  check("잔액 복원", (await getBalances()).div_growth, 900_000);
  check("고아 원장 0행", await orphanCount(), 0);

  await db.execute(
    sql`truncate ${ledger}, ${purchases}, ${sales}, ${purchaseCycles}, ${settings}, ${recommendations}, ${agentRuns} restart identity cascade`,
  );
  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
