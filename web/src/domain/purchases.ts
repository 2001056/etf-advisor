import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledger, purchases, recommendations, sales } from "@/db/schema";
import { Category, CATEGORY_LABEL, dateKeyKST } from "./money";
import {
  applyHoldingRoleChangesTx,
  clearHoldingRolesTx,
  getHoldingRoleOverrides,
  lockHoldingRolesTx,
  Tx,
} from "./ledger";
import {
  GROWTH_ROLE_LABEL,
  GrowthRole,
  mergeHoldingRoles,
  ROLE_CATEGORY,
  toGrowthRole,
} from "./recommendation";

export type PurchaseInput = {
  boughtAt: string; // YYYY-MM-DD
  category: Category;
  ticker: string;
  etfName: string;
  qty: number;
  unitPrice: number;
  recommendationId?: number | null;
  // 갈아타기의 매수 쪽이면 sales 와 같은 값. 일반 매수는 생략(NULL).
  switchGroupId?: string | null;
  memo?: string | null;
  /**
   * 온보딩에서 기존 보유분을 입력할 때 true.
   * 시작 잔액(§2.2-2)에 이미 반영된 과거 매입이므로 원장에서 다시 차감하지 않는다.
   */
  skipLedger?: boolean;
};

/**
 * 매입 기록 + 원장 차감을 한 트랜잭션으로 (§7).
 * 잔액은 저장하지 않으므로 여기서 재계산할 것이 없다.
 */
async function insertPurchaseTx(tx: Tx, input: PurchaseInput, amount: number) {
  const [row] = await tx
    .insert(purchases)
    .values({
      boughtAt: input.boughtAt,
      category: input.category,
      ticker: input.ticker.trim(),
      etfName: input.etfName.trim(),
      qty: input.qty,
      unitPrice: input.unitPrice,
      amountKrw: amount,
      recommendationId: input.recommendationId ?? null,
      switchGroupId: input.switchGroupId ?? null,
      memo: input.memo ?? null,
    })
    .returning();

  // 자리를 가진 추천으로 샀으면 그 자리가 이 종목의 자리다 — 예전 수동 지정이 이기지 않게 지운다
  if (row.recommendationId !== null && row.category === ROLE_CATEGORY) {
    const [rec] = await tx
      .select({ role: recommendations.role })
      .from(recommendations)
      .where(eq(recommendations.id, row.recommendationId))
      .limit(1);
    if (toGrowthRole(rec?.role)) {
      await clearHoldingRolesTx(tx, [`${row.category}::${row.ticker}`]);
    }
  }
  return row;
}

/** (카테고리, 종목) 보유 수량 — 트랜잭션 안에서 purchases − sales 로 파생 */
async function heldQtyTx(tx: Tx, category: Category, ticker: string) {
  const [bought] = await tx
    .select({ qty: sql<number>`coalesce(sum(${purchases.qty}), 0)::int` })
    .from(purchases)
    .where(and(eq(purchases.category, category), eq(purchases.ticker, ticker)));
  const [sold] = await tx
    .select({ qty: sql<number>`coalesce(sum(${sales.qty}), 0)::int` })
    .from(sales)
    .where(and(eq(sales.category, category), eq(sales.ticker, ticker)));
  return Number(bought?.qty ?? 0) - Number(sold?.qty ?? 0);
}

/**
 * 보유가 0이 된 종목의 자리 수동 지정을 같은 트랜잭션에서 지운다 (자리를 두는 카테고리만).
 * 판 종목의 옛 자리가 남으면 설정 화면(보유 종목만 보인다)에 보이지 않은 채
 * 나중에 다시 샀을 때 새 추천 자리를 이긴다.
 */
async function dropSeatsOfEmptyHoldingsTx(
  tx: Tx,
  slots: { category: Category; ticker: string }[],
) {
  const keys = new Set<string>();
  for (const s of slots) {
    if (s.category !== ROLE_CATEGORY) continue;
    if ((await heldQtyTx(tx, s.category, s.ticker)) <= 0) {
      keys.add(`${s.category}::${s.ticker}`);
    }
  }
  await clearHoldingRolesTx(tx, [...keys]);
}

/** 지금 자리 = 수동 지정 ?? 추천으로 산 가장 최근 매입의 자리 — holdingRoles 와 같은 규칙을 트랜잭션 안에서 */
async function effectiveSeatTx(
  tx: Tx,
  category: Category,
  ticker: string,
): Promise<GrowthRole | null> {
  const overrides = await lockHoldingRolesTx(tx);
  const manual = overrides[`${category}::${ticker}`];
  if (manual) return manual;
  const rows = await tx
    .select({ role: recommendations.role })
    .from(purchases)
    .innerJoin(recommendations, eq(purchases.recommendationId, recommendations.id))
    .where(
      and(
        eq(purchases.category, category),
        eq(purchases.ticker, ticker),
        isNotNull(recommendations.role),
      ),
    )
    .orderBy(desc(purchases.boughtAt), desc(purchases.id));
  for (const r of rows) {
    const role = toGrowthRole(r.role);
    if (role) return role;
  }
  return null;
}

/**
 * 매입·갈아타기 폼에서 고른 자리 확인 — 트랜잭션 맨 앞에서, 아무것도 쓰기 전에 부른다.
 * 폼은 아직 자리가 없는 종목에만 자리를 붙인다(이미 있는 자리를 바꾸는 건 설정 화면).
 * 이미 자리가 있는데 다른 값이면 거부하고, 같은 값이면 쓸 것이 없다. 새로 써야 하면 true.
 */
async function formSeatNeedsWriteTx(
  tx: Tx,
  category: Category,
  ticker: string,
  role: GrowthRole | null,
): Promise<boolean> {
  if (!role) return false;
  if (category !== ROLE_CATEGORY) {
    throw new Error(
      `자리는 ${CATEGORY_LABEL[ROLE_CATEGORY]} 매수에만 지정할 수 있습니다`,
    );
  }
  const existing = await effectiveSeatTx(tx, category, ticker);
  if (existing && existing !== role) {
    throw new Error(
      `${ticker}는 이미 ${GROWTH_ROLE_LABEL[existing]} 자리입니다 — 자리는 설정 화면에서 바꾸세요`,
    );
  }
  return !existing;
}

async function insertPurchaseLedgerTx(
  tx: Tx,
  input: PurchaseInput,
  amount: number,
  purchaseId: number,
) {
  await tx.insert(ledger).values({
    type: "purchase",
    category: input.category,
    amountKrw: -amount,
    refPurchaseId: purchaseId,
    memo: `${input.etfName} ${input.qty}주`,
  });
}

async function categoryBalanceTx(tx: Tx, c: Category) {
  const [row] = await tx
    .select({
      v: sql<number>`coalesce(sum(${ledger.amountKrw}), 0)::int`,
    })
    .from(ledger)
    .where(eq(ledger.category, c));
  return Number(row?.v ?? 0);
}

/** 매입 코어 — 주어진 트랜잭션 안에서 실행한다 (addPurchase 가 감싼다). */
export async function addPurchaseTx(tx: Tx, input: PurchaseInput) {
  const amount = input.qty * input.unitPrice;
  const row = await insertPurchaseTx(tx, input, amount);
  if (!input.skipLedger) {
    await insertPurchaseLedgerTx(tx, input, amount, row.id);
  }
  return row;
}

export async function addPurchase(input: PurchaseInput) {
  return db.transaction((tx) => addPurchaseTx(tx, input));
}

/**
 * 수기 폼 매입 (§5 A2). 잔액을 넘는 금액은 명시적으로 허용했을 때만 통과시킨다.
 *
 * - 검증과 기록을 한 트랜잭션에 두어 확인한 잔액과 차감이 어긋나지 않게 한다.
 * - 기존 보유분(skipLedger)은 원장을 건드리지 않으므로 잔액과 무관하다.
 * - 허용을 켜면 잔액이 음수가 될 수 있다 — 고배당 건너뜀 달의 재배분 매입을
 *   수기로 넣는 경우가 그렇다. 추천 수락 경로(addPurchaseWithHighDivTransfer)와 달리
 *   여기서는 고배당에서 옮겨오지 않는다.
 * - role(자리)은 아직 자리가 없는 종목에만 붙고, 매입과 같은 트랜잭션에 저장된다 —
 *   매입이 실패하면 자리도 남지 않는다.
 */
export async function addManualPurchase(
  input: PurchaseInput,
  opts: { allowOverBalance: boolean; role?: GrowthRole | null },
) {
  const amount = input.qty * input.unitPrice;
  const role = opts.role ?? null;

  return db.transaction(async (tx) => {
    const writeSeat = await formSeatNeedsWriteTx(
      tx,
      input.category,
      input.ticker.trim(),
      role,
    );

    if (!input.skipLedger && !opts.allowOverBalance) {
      const [row] = await tx
        .select({
          v: sql<number>`coalesce(sum(${ledger.amountKrw}), 0)::int`,
        })
        .from(ledger)
        .where(eq(ledger.category, input.category));
      const balance = Number(row?.v ?? 0);

      if (amount > balance) {
        throw new Error(
          `${CATEGORY_LABEL[input.category]} 잔액(${balance.toLocaleString("ko-KR")}원)보다 큰 금액입니다. 초과 매입이 맞으면 "잔액 초과 허용"을 켜세요`,
        );
      }
    }

    const row = await addPurchaseTx(tx, input);
    if (writeSeat && role) {
      await applyHoldingRoleChangesTx(tx, [
        { category: input.category, ticker: row.ticker, role },
      ]);
    }
    return row;
  });
}

/**
 * 같은 추천을 두 번 확정했을 때의 유니크 위반(purchases_one_per_recommendation)이면
 * 한국어 안내를, 아니면 null.
 *
 * drizzle이 pg 에러를 감싸므로 code는 cause에만 있다 — orchestrator.claim()과 같은 판별이다.
 * 감싼 쪽 message는 실행한 SQL 원문이라 그대로 돌려주면 사용자에게 노출된다.
 */
export function duplicateRecommendationMessage(e: unknown): string | null {
  const cause = (e as { cause?: { code?: string; constraint?: string } })?.cause;
  return cause?.code === "23505" &&
    cause?.constraint === "purchases_one_per_recommendation"
    ? "이 추천은 이미 매입으로 기록되었습니다"
    : null;
}

/**
 * 추천을 매입으로 확정하기 전 선확인 — 막아야 하면 한국어 사유, 통과면 null.
 *
 * 갈아타기 재확정은 매도 단계가 먼저 터져 "보유분이 없습니다"류로 새는 탓에 여기서 끊는다.
 * DB 유니크(purchases_one_per_recommendation)는 동시 제출용 최종 방어로 그대로 둔다.
 *
 * 화면(acceptRecommendationAction)과 검증(check-accept.ts)이 같은 함수를 불러야
 * "검증은 통과인데 화면은 다른 메시지"가 생기지 않는다.
 */
export function acceptBlockReason(
  rec: {
    skipped: boolean;
    ticker: string | null;
    sellTicker: string | null;
  },
  alreadyAccepted: boolean,
): string | null {
  if (rec.skipped || !rec.ticker) {
    return "건너뛴 추천은 매입 기록으로 옮길 수 없습니다";
  }
  if (rec.sellTicker) {
    return "옛 갈아타기 추천입니다. /switch 화면에서 직접 기록하세요";
  }
  if (alreadyAccepted) {
    return "이 추천은 이미 매입으로 기록되었습니다";
  }
  return null;
}

/**
 * 보유 종목이 어느 자리(공격·안정)로 산 것인지. 키는 `카테고리::종목코드`.
 *
 * 먼저 ③ 추천을 통해 기록된 매입에서 자리를 거슬러 올라가고(같은 종목을 여러 자리로
 * 산 적이 있으면 가장 최근 매입의 자리), 그 위에 사람이 직접 지정한 자리
 * (settings.holding_roles — 설정 화면·매입/갈아타기 폼)를 덮는다.
 * 둘 다 없는 종목은 자리를 알 수 없는 것으로 다뤄야 한다(⑤가 임의로 통합 대상에 넣으면 안 된다).
 */
export async function holdingRoles(): Promise<Map<string, GrowthRole>> {
  const [rows, overrides] = await Promise.all([
    db
      .select({
        category: purchases.category,
        ticker: purchases.ticker,
        role: recommendations.role,
      })
      .from(purchases)
      .innerJoin(
        recommendations,
        eq(purchases.recommendationId, recommendations.id),
      )
      .where(isNotNull(recommendations.role))
      .orderBy(purchases.boughtAt, purchases.id),
    getHoldingRoleOverrides(),
  ]);

  const derived = new Map<string, GrowthRole>();
  for (const r of rows) {
    const role = toGrowthRole(r.role);
    if (role) derived.set(`${r.category}::${r.ticker}`, role);
  }
  return mergeHoldingRoles(derived, overrides);
}

/** 이미 매입으로 기록된 추천 id — 추천 화면에서 확정 폼 대신 완료 표시를 띄운다 */
export async function acceptedRecommendationIds(ids: number[]) {
  if (ids.length === 0) return [] as number[];
  const rows = await db
    .selectDistinct({ id: purchases.recommendationId })
    .from(purchases)
    .where(inArray(purchases.recommendationId, ids));
  return rows
    .map((r) => r.id)
    .filter((id): id is number => id !== null);
}

/**
 * 고배당을 건너뛴 회차에 한해, 배당성장·자산성장 매입의 부족분을 고배당에서 옮겨온다 (§2.2 예외).
 *
 * 이동은 매입을 실제로 기록할 때만, 모자란 만큼만 일어난다. 추천만 받고 안 사면
 * 고배당 잔액은 그대로 남는다.
 */
export async function addPurchaseWithHighDivTransfer(
  input: PurchaseInput,
  opts: { allowTransfer: boolean },
) {
  return db.transaction((tx) =>
    addPurchaseWithTransferTx(tx, input, {
      allowTransfer: opts.allowTransfer,
      overMessage: (own) =>
        `${CATEGORY_LABEL[input.category]} 잔액(${own.toLocaleString("ko-KR")}원)보다 큰 금액입니다 — 수량을 1주 줄이거나 실제 체결금액에 맞추세요`,
    }),
  );
}

type TransferPurchaseOpts = {
  allowTransfer: boolean;
  overMessage: (balance: number, amount: number) => string;
};

export async function addPurchaseWithTransferTx(
  tx: Tx,
  input: PurchaseInput,
  opts: TransferPurchaseOpts,
) {
  const amount = input.qty * input.unitPrice;
  const own = await categoryBalanceTx(tx, input.category);
  const shortfall = amount - own;

  if (shortfall > 0) {
    if (!opts.allowTransfer || input.category === "high_div") {
      throw new Error(opts.overMessage(own, amount));
    }
    const pool = await categoryBalanceTx(tx, "high_div");
    if (pool < shortfall) {
      throw new Error(
        `고배당 잔액(${pool.toLocaleString("ko-KR")}원)으로도 부족합니다`,
      );
    }
  }

  const row = await insertPurchaseTx(tx, input, amount);

  if (shortfall > 0) {
    // 이동은 두 행으로 남겨 어디서 왔는지 원장만 봐도 알 수 있게 한다.
    // 매입 뒤에 넣어 refPurchaseId 를 채운다 — 매입을 지우면 이전도 함께 되돌아간다.
    await tx.insert(ledger).values([
      {
        type: "adjust" as const,
        category: "high_div" as const,
        amountKrw: -shortfall,
        refPurchaseId: row.id,
        memo: `고배당 건너뜀 → ${CATEGORY_LABEL[input.category]} 이전`,
      },
      {
        type: "adjust" as const,
        category: input.category,
        amountKrw: shortfall,
        refPurchaseId: row.id,
        memo: "고배당 건너뜀분 이전받음",
      },
    ]);
  }

  await insertPurchaseLedgerTx(tx, input, amount, row.id);

  return row;
}

export const SWITCH_EDIT_MESSAGE =
  "갈아타기 묶음의 매입은 개별 수정할 수 없습니다. 갈아타기 화면에서 묶음을 취소하세요";

/** 매입 수정 — 연결된 원장 행을 같은 트랜잭션에서 함께 고친다. */
export async function updatePurchase(id: number, input: PurchaseInput) {
  const amount = input.qty * input.unitPrice;

  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({
        switchGroupId: purchases.switchGroupId,
        category: purchases.category,
        ticker: purchases.ticker,
      })
      .from(purchases)
      .where(eq(purchases.id, id))
      .limit(1);
    if (!before) throw new Error(`매입 기록 ${id}를 찾을 수 없습니다`);
    // 갈아타기 매수는 매도·매도대금 이전과 한 묶음이다 — 카테고리·금액만 바꾸면 이전 쌍이 따로 논다
    if (before.switchGroupId) throw new Error(SWITCH_EDIT_MESSAGE);

    const [row] = await tx
      .update(purchases)
      .set({
        boughtAt: input.boughtAt,
        category: input.category,
        ticker: input.ticker.trim(),
        etfName: input.etfName.trim(),
        qty: input.qty,
        unitPrice: input.unitPrice,
        amountKrw: amount,
        memo: input.memo ?? null,
      })
      .where(eq(purchases.id, id))
      .returning();

    if (!row) throw new Error(`매입 기록 ${id}를 찾을 수 없습니다`);

    // 원장 행이 없는 기존 보유분(skipLedger)이면 update가 0행에 적용되고 끝난다 — 의도된 동작.
    // 같은 매입을 가리키는 고배당 이전(adjust) 쌍은 매입 금액이 아니므로 건드리지 않는다.
    await tx
      .update(ledger)
      .set({
        category: input.category,
        amountKrw: -amount,
        memo: `${input.etfName} ${input.qty}주`,
      })
      .where(and(eq(ledger.refPurchaseId, id), eq(ledger.type, "purchase")));

    // 종목·구분을 바꿔 옛 종목 보유가 0이 됐으면 그 자리 지정도 지운다
    await dropSeatsOfEmptyHoldingsTx(tx, [before]);

    return row;
  });
}

export const SWITCH_DELETE_MESSAGE =
  "갈아타기 묶음의 매입은 개별 삭제할 수 없습니다. 갈아타기 화면에서 묶음을 취소하세요";

export async function deletePurchase(id: number) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        switchGroupId: purchases.switchGroupId,
        category: purchases.category,
        ticker: purchases.ticker,
      })
      .from(purchases)
      .where(eq(purchases.id, id))
      .limit(1);

    // 짝인 매도·sell 원장이 남으면 잔액이 과대해진다 — 묶음 단위로만 되돌린다 (§5 A3)
    if (row?.switchGroupId) throw new Error(SWITCH_DELETE_MESSAGE);

    await tx.delete(ledger).where(eq(ledger.refPurchaseId, id));
    await tx.delete(purchases).where(eq(purchases.id, id));
    if (row) await dropSeatsOfEmptyHoldingsTx(tx, [row]);
  });
}

/**
 * 갈아타기 묶음 취소 — 같은 switchGroupId 의 매수·매도와 그 원장 행을 한 트랜잭션에서 지운다.
 *
 * 잔액은 원장 SUM 파생이므로 행을 지우면 실행 전 값으로 그대로 돌아간다.
 * 카테고리를 넘은 갈아타기의 매도대금 이전(adjust 쌍)도 refPurchaseId 로 매입에 달려 있어
 * 함께 지워지고, 잔액 음수 확인은 지우는 원장 행이 걸친 모든 카테고리에 적용된다.
 * 다만 매수분을 되돌리면 보유가 줄어드는데, 그 뒤 같은 종목을 또 팔았다면 보유가
 * 음수가 되므로 그 경우에는 거부한다.
 */
export async function cancelSwitch(groupId: string) {
  if (!groupId.trim()) throw new Error("갈아타기 묶음을 지정하세요");

  return db.transaction(async (tx) => {
    const buys = await tx
      .select()
      .from(purchases)
      .where(eq(purchases.switchGroupId, groupId));
    const sells = await tx
      .select()
      .from(sales)
      .where(eq(sales.switchGroupId, groupId));

    if (buys.length === 0 && sells.length === 0) {
      throw new Error("갈아타기 묶음을 찾을 수 없습니다");
    }

    for (const b of buys) {
      const cat = b.category as Category;
      const [bought] = await tx
        .select({ qty: sql<number>`coalesce(sum(${purchases.qty}), 0)::int` })
        .from(purchases)
        .where(and(eq(purchases.category, cat), eq(purchases.ticker, b.ticker)));
      const [sold] = await tx
        .select({ qty: sql<number>`coalesce(sum(${sales.qty}), 0)::int` })
        .from(sales)
        .where(and(eq(sales.category, cat), eq(sales.ticker, b.ticker)));

      const sameSlot = (r: { category: string; ticker: string }) =>
        r.category === cat && r.ticker === b.ticker;
      const undoBuy = buys.filter(sameSlot).reduce((n, r) => n + r.qty, 0);
      const undoSell = sells.filter(sameSlot).reduce((n, r) => n + r.qty, 0);

      const after =
        Number(bought?.qty ?? 0) - undoBuy - (Number(sold?.qty ?? 0) - undoSell);
      if (after < 0) {
        throw new Error(
          `${CATEGORY_LABEL[cat]} ${b.ticker}를 이미 매도한 뒤라 이 갈아타기를 취소할 수 없습니다`,
        );
      }
    }

    const buyIds = buys.map((r) => r.id);
    const sellIds = sells.map((r) => r.id);

    // 잔액이 바뀌는 카테고리 = 지울 원장 행의 카테고리. 매수·매도 행의 지금 카테고리로 세면
    // 고배당·매도대금 이전 쌍이나, 매입 행과 원장 행의 카테고리가 어긋난 옛 기록을 놓친다.
    const refs = [
      ...(buyIds.length ? [inArray(ledger.refPurchaseId, buyIds)] : []),
      ...(sellIds.length ? [inArray(ledger.refSaleId, sellIds)] : []),
    ];
    const touched = (
      await tx
        .selectDistinct({ category: ledger.category })
        .from(ledger)
        .where(or(...refs))
    ).map((r) => r.category);

    if (buyIds.length) {
      await tx.delete(ledger).where(inArray(ledger.refPurchaseId, buyIds));
    }
    if (sellIds.length) {
      await tx.delete(ledger).where(inArray(ledger.refSaleId, sellIds));
    }
    await tx.delete(purchases).where(eq(purchases.switchGroupId, groupId));
    await tx.delete(sales).where(eq(sales.switchGroupId, groupId));
    // 이 묶음으로 처음 산 종목은 되돌리면 보유가 0이 된다 — 그때 붙인 자리 지정도 지운다
    await dropSeatsOfEmptyHoldingsTx(tx, buys);

    // 매도대금을 이미 다른 매입에 써버렸다면 되돌릴 재원이 없다 — 지운 뒤 잔액으로 확인하고
    // 음수면 던져서 트랜잭션째 되돌린다.
    for (const c of touched) {
      const [row] = await tx
        .select({
          v: sql<number>`coalesce(sum(${ledger.amountKrw}), 0)::int`,
        })
        .from(ledger)
        .where(eq(ledger.category, c));
      const after = Number(row?.v ?? 0);
      if (after < 0) {
        throw new Error(
          `취소하면 ${CATEGORY_LABEL[c]} 잔액이 ${Math.abs(after).toLocaleString("ko-KR")}원 음수가 됩니다. 먼저 다른 매입을 정리하세요`,
        );
      }
    }

    return { purchases: buyIds.length, sales: sellIds.length };
  });
}

export async function listPurchases(limit = 200) {
  return db
    .select()
    .from(purchases)
    .orderBy(desc(purchases.boughtAt), desc(purchases.id))
    .limit(limit);
}

export type Holding = {
  category: Category;
  ticker: string;
  etfName: string;
  qty: number;
  avgPrice: number; // 평단가 (원, 소수점 반올림)
  costKrw: number; // 매입 원금 합계
};

export type SaleInput = {
  soldAt: string; // YYYY-MM-DD
  category: Category;
  ticker: string;
  etfName?: string | null; // 생략 시 매입 기록의 이름을 그대로 쓴다
  qty: number; // 매도 수량(양수)
  unitPrice: number; // 매도 체결 단가
  recommendationId?: number | null;
  switchGroupId?: string | null;
  memo?: string | null;
};

/**
 * 매도 기록 + 대금 환입을 한 트랜잭션으로 (addPurchase 대칭).
 *
 * - 보유(purchases − sales)를 (category, ticker) 단위로 트랜잭션 안에서 다시 계산해,
 *   매도 수량이 보유를 넘으면 거부한다.
 * - 원가 차감액(costBasisKrw)은 매도 시점 평단가 스냅샷으로 박는다. 전량 매도면 남은
 *   원가 전부를 넣어 반올림 오차 없이 보유 원가가 0이 되게 한다.
 * - 매도대금(amountKrw)은 type='sell' +행으로 원장에 들어가 같은 카테고리 잔액이 되어
 *   대체 매수 재원이 된다.
 */
/** 매도 코어 — 주어진 트랜잭션 안에서 실행한다 (executeSwitch 가 재사용). */
export async function addSaleTx(tx: Tx, input: SaleInput) {
  const qty = input.qty;
  const ticker = input.ticker.trim();
  if (qty <= 0) throw new Error("매도 수량은 1주 이상이어야 합니다");

  const amount = qty * input.unitPrice;

  {
    // 트랜잭션 안에서 현재 보유(수량·원가)를 파생 — getHoldings 와 같은 평균원가법
    const [bought] = await tx
      .select({
        qty: sql<number>`coalesce(sum(${purchases.qty}), 0)::int`,
        cost: sql<number>`coalesce(sum(${purchases.amountKrw}), 0)::int`,
        name: sql<string>`max(${purchases.etfName})`,
      })
      .from(purchases)
      .where(
        and(eq(purchases.category, input.category), eq(purchases.ticker, ticker)),
      );

    const [soldSoFar] = await tx
      .select({
        qty: sql<number>`coalesce(sum(${sales.qty}), 0)::int`,
        cost: sql<number>`coalesce(sum(${sales.costBasisKrw}), 0)::int`,
      })
      .from(sales)
      .where(and(eq(sales.category, input.category), eq(sales.ticker, ticker)));

    const heldQty = Number(bought?.qty ?? 0) - Number(soldSoFar?.qty ?? 0);
    const heldCost = Number(bought?.cost ?? 0) - Number(soldSoFar?.cost ?? 0);

    if (heldQty <= 0) {
      throw new Error(
        `${CATEGORY_LABEL[input.category]} ${ticker} 보유분이 없습니다`,
      );
    }
    if (qty > heldQty) {
      throw new Error(
        `보유 수량(${heldQty}주)보다 많이 팔 수 없습니다 (요청 ${qty}주)`,
      );
    }

    const avgPrice = Math.round(heldCost / heldQty);
    // 전량 매도면 남은 원가를 통째로 빼 잔여 원가가 정확히 0이 되게 한다
    const costBasisKrw = qty === heldQty ? heldCost : Math.round(avgPrice * qty);
    const realizedPnlKrw = amount - costBasisKrw;
    const etfName = input.etfName?.trim() || String(bought?.name ?? ticker);

    const [row] = await tx
      .insert(sales)
      .values({
        soldAt: input.soldAt,
        category: input.category,
        ticker,
        etfName,
        qty,
        unitPrice: input.unitPrice,
        amountKrw: amount,
        costBasisKrw,
        realizedPnlKrw,
        switchGroupId: input.switchGroupId ?? null,
        recommendationId: input.recommendationId ?? null,
        memo: input.memo ?? null,
      })
      .returning();

    await tx.insert(ledger).values({
      type: "sell",
      category: input.category,
      amountKrw: amount, // +: 매도대금 환입
      refSaleId: row.id,
      memo: `${etfName} ${qty}주 매도`,
    });

    // 전량 매도(갈아타기 매도 포함)면 그 종목의 자리 지정도 여기서 끝난다
    if (qty === heldQty) {
      await dropSeatsOfEmptyHoldingsTx(tx, [{ category: input.category, ticker }]);
    }

    return row;
  }
}

export async function addSale(input: SaleInput) {
  return db.transaction((tx) => addSaleTx(tx, input));
}

export type SwitchLeg = {
  ticker: string;
  etfName?: string | null;
  qty: number;
  unitPrice: number;
};

export type SwitchInput = {
  category: Category; // 매도 카테고리 — 매도대금이 먼저 환입되는 곳
  // 매수 카테고리 (기본 = category). 다르면 매도대금 전액을 이 카테고리로 옮긴 뒤 산다
  buyCategory?: Category;
  executedAt?: string; // YYYY-MM-DD, 매도·매수 같은 날 (기본 오늘 KST)
  sell: SwitchLeg;
  buy: SwitchLeg & { etfName: string }; // 새로 살 종목 이름은 필수
  recommendationId?: number | null;
  memo?: string | null;
  allowHighDivTransfer?: boolean;
  // 새로 사는 종목의 자리(폼에서 고른 값). 아직 자리가 없는 종목에만 붙는다
  role?: GrowthRole | null;
};

/**
 * 갈아타기 실행: A 매도 → B 매수를 한 트랜잭션·한 switchGroupId 로 묶는다.
 *
 * - 원자성: 매도가 실패(보유 부족 등)하거나 매수가 실패하면 둘 다 롤백된다. "팔았는데 못 삼"이 없다.
 * - 재원: 매도대금이 sell(+) 원장 행으로 매도 카테고리 잔액에 환입돼 매수 재원이 된다.
 *   매수 카테고리가 다르면 매도대금 전액을 adjust 쌍(−/+)으로 매수 카테고리에 옮긴다 —
 *   매수에 쓰고 남은 돈도 매수 카테고리에 남는다.
 * - 추적: sales·purchases 두 행이 같은 switchGroupId 를 가져 한 번의 교체로 묶인다.
 */
export async function executeSwitch(input: SwitchInput) {
  if (input.sell.ticker.trim() === input.buy.ticker.trim()) {
    throw new Error("같은 종목으로는 갈아탈 수 없습니다");
  }
  const date = input.executedAt ?? dateKeyKST();
  // 같은 밀리초에 두 번 실행해도 묶음이 섞이지 않게 난수를 붙인다
  const switchGroupId = `sw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const buyCategory = input.buyCategory ?? input.category;
  const role = input.role ?? null;

  return db.transaction(async (tx) => {
    // 자리 확인은 아무것도 쓰기 전에 — 다른 자리를 고르면 매도도 남기지 않고 거부한다
    const writeSeat = await formSeatNeedsWriteTx(
      tx,
      buyCategory,
      input.buy.ticker.trim(),
      role,
    );

    const sale = await addSaleTx(tx, {
      soldAt: date,
      category: input.category,
      ticker: input.sell.ticker,
      etfName: input.sell.etfName ?? null,
      qty: input.sell.qty,
      unitPrice: input.sell.unitPrice,
      switchGroupId,
      recommendationId: input.recommendationId ?? null,
      memo: input.memo ?? "갈아타기 매도",
    });

    // 매도대금 이전은 매입보다 먼저 넣는다 — 매수 잔액 검증이 옮겨 온 돈까지 세야 하기 때문.
    // 매입 id 는 아직 없으므로 매입 뒤에 refPurchaseId 를 채운다(취소가 매입과 함께 지운다).
    // 같은 트랜잭션이라 ts(now())가 같아 성과 집계에서 −/+ 가 상쇄된다 — 외부 유입이 아니다.
    const moved =
      buyCategory === input.category
        ? []
        : await tx
            .insert(ledger)
            .values([
              {
                type: "adjust" as const,
                category: input.category,
                amountKrw: -sale.amountKrw,
                memo: `갈아타기 매도대금 → ${CATEGORY_LABEL[buyCategory]} 이전`,
              },
              {
                type: "adjust" as const,
                category: buyCategory,
                amountKrw: sale.amountKrw,
                memo: `${CATEGORY_LABEL[input.category]} 갈아타기 매도대금 이전받음`,
              },
            ])
            .returning({ id: ledger.id });

    const purchase = await addPurchaseWithTransferTx(
      tx,
      {
        boughtAt: date,
        category: buyCategory,
        ticker: input.buy.ticker,
        etfName: input.buy.etfName,
        qty: input.buy.qty,
        unitPrice: input.buy.unitPrice,
        switchGroupId,
        recommendationId: input.recommendationId ?? null,
        memo: input.memo ?? "갈아타기 매수",
      },
      {
        allowTransfer: input.allowHighDivTransfer ?? false,
        overMessage: (available, amount) =>
          `${CATEGORY_LABEL[buyCategory]} 잔액+매도대금(${available.toLocaleString("ko-KR")}원)보다 큰 매수입니다 (매수 ${amount.toLocaleString("ko-KR")}원) — 수량을 줄이세요`,
      },
    );

    if (moved.length) {
      await tx
        .update(ledger)
        .set({ refPurchaseId: purchase.id })
        .where(inArray(ledger.id, moved.map((r) => r.id)));
    }

    if (writeSeat && role) {
      await applyHoldingRoleChangesTx(tx, [
        { category: buyCategory, ticker: purchase.ticker, role },
      ]);
    }

    return { switchGroupId, sale, purchase };
  });
}

export async function listSales(limit = 10_000) {
  return db
    .select()
    .from(sales)
    .orderBy(desc(sales.soldAt), desc(sales.id))
    .limit(limit);
}

/**
 * 보유 현황. (category, ticker) 단위 집계 — 같은 티커를 두 카테고리에서 사면 따로 표시 (§6).
 * 현재금액·배당금 예상액은 조사 문서에서 파생하므로 M2에서 붙인다.
 *
 * 매도(sales)는 평균원가법으로 차감한다: 매도분 원가(costBasisKrw)를 매도 시점 평단가
 * 기준으로 박아뒀으므로, qty 와 costKrw 를 함께 빼면 남은 보유의 평단가가 그대로 유지된다.
 */
export async function getHoldings(): Promise<Holding[]> {
  const [buys, sells] = await Promise.all([
    listPurchases(10_000),
    listSales(10_000),
  ]);
  const map = new Map<string, Holding>();

  const slot = (category: Category, ticker: string, etfName: string) => {
    const key = `${category}::${ticker}`;
    const cur =
      map.get(key) ??
      ({
        category,
        ticker,
        etfName,
        qty: 0,
        avgPrice: 0,
        costKrw: 0,
      } satisfies Holding);
    map.set(key, cur);
    return cur;
  };

  for (const r of buys) {
    const cur = slot(r.category as Category, r.ticker, r.etfName);
    cur.qty += r.qty;
    cur.costKrw += r.amountKrw;
    cur.etfName = r.etfName; // 최신 이름으로 갱신
  }

  for (const s of sells) {
    const cur = slot(s.category as Category, s.ticker, s.etfName);
    cur.qty -= s.qty;
    cur.costKrw -= s.costBasisKrw;
  }

  return [...map.values()]
    .filter((h) => h.qty > 0)
    .map((h) => ({ ...h, avgPrice: Math.round(h.costKrw / h.qty) }));
}
