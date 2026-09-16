"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  createSession,
  destroySession,
  isPasswordSet,
  recordFailedAttempt,
  requireSession,
  setPassword,
  tooManyAttempts,
  verifyPassword,
} from "@/lib/auth";
import {
  closePurchaseCycle,
  isOnboarded,
  seedInitialBalances,
  runLazyTopup,
  setMonthlyTopup,
  getRecommendation,
  wasHighDivSkipped,
} from "@/domain/ledger";
import {
  BusyError,
  clearStuckRuns,
  getRunningRun,
  runRecommendFlow,
  runWeeklyResearch,
} from "@/server/orchestrator";
import { PromptSlot, savePrompt } from "@/domain/prompts";
import {
  deleteAllResearchDocs,
  deleteResearchDocs,
} from "@/domain/research";
import { addDividend, deleteDividend } from "@/domain/dividends";
import {
  acceptedRecommendationIds,
  addManualPurchase,
  addPurchaseWithHighDivTransfer,
  cancelSwitch,
  deletePurchase,
  duplicateRecommendationMessage,
  executeSwitch,
  updatePurchase,
} from "@/domain/purchases";
import {
  CATEGORIES,
  Category,
  dateKeyKST,
  monthKeyKST,
} from "@/domain/money";

function num(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(/[,\s원]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 폼에서 온 금액·수량. 빈칸이나 0 이하를 조용히 0으로 넘기지 않는다. */
function positiveNum(v: FormDataEntryValue | null, label: string): number {
  const raw = String(v ?? "").trim();
  if (!raw) throw new Error(`${label}을(를) 입력하세요`);
  const n = Number(raw.replace(/[,\s원]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label}은(는) 0보다 커야 합니다`);
  return n;
}

/** 비워둬도 되는 숫자 칸 */
function optionalNum(v: FormDataEntryValue | null): number | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[,\s원]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function category(v: FormDataEntryValue | null): Category {
  const s = String(v ?? "");
  if ((CATEGORIES as readonly string[]).includes(s)) return s as Category;
  throw new Error(`알 수 없는 카테고리: ${s}`);
}

export async function setupAction(formData: FormData) {
  if (await isPasswordSet()) redirect("/login");

  const pw = String(formData.get("password") ?? "");
  const pw2 = String(formData.get("password2") ?? "");
  if (pw !== pw2) return { error: "두 비밀번호가 다릅니다" };
  if (pw.length < 8) return { error: "비밀번호는 8자 이상이어야 합니다" };

  await setPassword(pw);
  await createSession();
  redirect("/onboarding");
}

export async function loginAction(formData: FormData) {
  const h = await headers();
  const origin =
    h.get("x-forwarded-for")?.split(",")[0].trim() ?? h.get("host") ?? "unknown";

  if (tooManyAttempts(origin)) {
    return { error: "로그인 시도가 너무 많습니다. 1분 후 다시 시도하세요." };
  }
  const ok = await verifyPassword(String(formData.get("password") ?? ""));
  if (!ok) {
    recordFailedAttempt(origin);
    return { error: "비밀번호가 맞지 않습니다" };
  }
  await createSession();
  redirect("/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function onboardingAction(formData: FormData) {
  await requireSession();
  // 뒤로가기·더블클릭으로 다시 제출하면 시작 잔액이 두 배가 된다 — 한 번만 허용
  if (await isOnboarded()) redirect("/");

  const balances = {
    div_growth: num(formData.get("div_growth")),
    asset_growth: num(formData.get("asset_growth")),
    high_div: num(formData.get("high_div")),
  };
  await seedInitialBalances(balances);
  revalidatePath("/");
  redirect("/");
}

export async function addPurchaseAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireSession();
  try {
    await addManualPurchase(
      {
        boughtAt: String(formData.get("boughtAt") || dateKeyKST()),
        category: category(formData.get("category")),
        ticker: String(formData.get("ticker") ?? "").trim(),
        etfName: String(formData.get("etfName") ?? "").trim(),
        qty: positiveNum(formData.get("qty"), "수량"),
        unitPrice: positiveNum(formData.get("unitPrice"), "매입 단가"),
        memo: String(formData.get("memo") ?? "") || null,
        skipLedger: formData.get("skipLedger") === "on",
      },
      { allowOverBalance: formData.get("allowOverBalance") === "on" },
    );
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/purchases");
  revalidatePath("/");
  return { ok: true };
}

export async function updatePurchaseAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireSession();
  const id = num(formData.get("id"));
  try {
    await updatePurchase(id, {
      boughtAt: String(formData.get("boughtAt")),
      category: category(formData.get("category")),
      ticker: String(formData.get("ticker") ?? "").trim(),
      etfName: String(formData.get("etfName") ?? "").trim(),
      qty: positiveNum(formData.get("qty"), "수량"),
      unitPrice: positiveNum(formData.get("unitPrice"), "매입 단가"),
      memo: String(formData.get("memo") ?? "") || null,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/purchases");
  revalidatePath("/");
  return { ok: true };
}

export async function deletePurchaseAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireSession();
  try {
    await deletePurchase(num(formData.get("id")));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/purchases");
  revalidatePath("/");
  return { ok: true };
}

/** 갈아타기 묶음 취소 — 매수·매도·원장 행을 함께 되돌린다 (§5 A3) */
export async function cancelSwitchAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireSession();
  try {
    await cancelSwitch(String(formData.get("groupId") ?? ""));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/switch");
  revalidatePath("/purchases");
  revalidatePath("/");
  return { ok: true };
}

/**
 * 갈아타기: 같은 카테고리에서 A 매도 → B 매수를 한 번에 (executeSwitch).
 * 실패 가능(보유 부족·동일 종목)하므로 에러를 문자열로 돌려 폼에 띄운다.
 */
export async function switchAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireSession();

  // 매도 종목 선택값은 "category::ticker" — 카테고리가 매수 쪽에도 그대로 적용된다
  const sellKey = String(formData.get("sell") ?? "");
  const sep = sellKey.indexOf("::");
  if (sep < 0) return { error: "매도할 보유 종목을 고르세요" };
  const cat = category(sellKey.slice(0, sep));
  const sellTicker = sellKey.slice(sep + 2);

  try {
    await executeSwitch({
      category: cat,
      executedAt: String(formData.get("executedAt") || dateKeyKST()),
      sell: {
        ticker: sellTicker,
        qty: positiveNum(formData.get("sellQty"), "매도 수량"),
        unitPrice: positiveNum(formData.get("sellUnitPrice"), "매도 단가"),
      },
      buy: {
        ticker: String(formData.get("buyTicker") ?? "").trim(),
        etfName: String(formData.get("buyEtfName") ?? "").trim(),
        qty: positiveNum(formData.get("buyQty"), "매수 수량"),
        unitPrice: positiveNum(formData.get("buyUnitPrice"), "매수 단가"),
      },
      memo: String(formData.get("memo") ?? "") || null,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "갈아타기에 실패했습니다" };
  }

  revalidatePath("/switch");
  revalidatePath("/purchases");
  revalidatePath("/");
  return { ok: true };
}

/** [이번 달 매입 마감] — 다음날 lazy 충전이 다음 달 몫을 채운다 (§2.2) */
export async function closeCycleAction() {
  await requireSession();
  await closePurchaseCycle(monthKeyKST());
  await runLazyTopup();
  revalidatePath("/purchases");
  revalidatePath("/");
}

// ───────── 분배금 ─────────

export async function addDividendAction(formData: FormData) {
  await requireSession();
  try {
    await addDividend({
      receivedAt: String(formData.get("receivedAt") || dateKeyKST()),
      category: category(formData.get("category")),
      ticker: String(formData.get("ticker") ?? "").trim(),
      etfName: String(formData.get("etfName") ?? "").trim(),
      amountKrw: positiveNum(formData.get("amountKrw"), "분배금"),
      grossKrw: optionalNum(formData.get("grossKrw")),
      taxKrw: optionalNum(formData.get("taxKrw")),
      memo: String(formData.get("memo") ?? "") || null,
      addToBalance: formData.get("addToBalance") === "on",
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/dividends");
  revalidatePath("/");
  return { ok: true };
}

export async function deleteDividendAction(formData: FormData) {
  await requireSession();
  await deleteDividend(num(formData.get("id")));
  revalidatePath("/dividends");
  revalidatePath("/");
  return { ok: true };
}

// ───────── 에이전트 ─────────

/**
 * "매입 추천" — ② 조사 → ③ 추천을 한 흐름으로 (§5.3).
 *
 * 실행은 최대 30분(각 15분 타임아웃)까지 걸릴 수 있으므로 **기다리지 않고 시작만** 한다.
 * 진행 상황은 클라이언트가 /api/status를 폴링해 따라간다 — 브라우저를 닫아도 계속 진행된다.
 */
export async function startRecommendAction(force = false) {
  await requireSession();
  if (await getRunningRun()) {
    return { error: "이미 실행 중인 에이전트가 있습니다. 끝난 뒤 다시 시도하세요." };
  }
  const flow = runRecommendFlow({ force });
  if ("blocked" in flow) return { error: flow.blocked };

  flow.started.catch((e) => {
    if (e instanceof BusyError) return; // 동시 클릭 — DB 유니크 인덱스가 막았다
    console.error("[recommend] 흐름 실패", e);
  });

  return { ok: true };
}

/** 실패한 정기 조사 수동 재실행 (§5.5-8). 위와 같은 이유로 기다리지 않는다. */
export async function rerunWeeklyAction() {
  await requireSession();
  if (await getRunningRun()) {
    return { error: "이미 실행 중인 에이전트가 있습니다." };
  }

  runWeeklyResearch("user").catch((e) => {
    if (e instanceof BusyError) return;
    console.error("[weekly] 조사 실패", e);
  });

  return { ok: true };
}

/** 막힌 실행 해제 — 이게 없으면 running 행 하나가 앱을 영구히 잠근다 */
export async function clearStuckRunsAction() {
  await requireSession();
  const n = await clearStuckRuns();
  revalidatePath("/runs");
  revalidatePath("/recommend");
  revalidatePath("/");
  return { ok: true, cleared: n };
}

/** 조사 문서 삭제 (DB 행 + 맥 로컬 md 사본) */
export async function deleteResearchDocAction(formData: FormData) {
  await requireSession();
  const id = num(formData.get("id"));
  const n = await deleteResearchDocs([id]);
  revalidatePath("/docs");
  revalidatePath("/");
  if (formData.get("redirect") === "list") redirect("/docs");
  return { ok: true, deleted: n };
}

/** 조사 문서 전체 삭제 */
export async function deleteAllResearchDocsAction() {
  await requireSession();
  const n = await deleteAllResearchDocs();
  revalidatePath("/docs");
  revalidatePath("/");
  return { ok: true, deleted: n };
}

export async function savePromptAction(formData: FormData) {
  await requireSession();
  const slot = String(formData.get("slot") ?? "") as PromptSlot;
  if (!["weekly", "purchase", "recommend"].includes(slot)) {
    return { error: "알 수 없는 프롬프트 슬롯" };
  }
  await savePrompt(slot, String(formData.get("body") ?? ""));
  revalidatePath("/settings");
  return { ok: true };
}

export async function saveTopupAction(formData: FormData) {
  await requireSession();

  // 빈칸을 0으로 삼키면 그 달 충전이 0원으로 굳고, 멱등키 때문에 재실행으로 못 고친다
  const entries = CATEGORIES.map((c) => {
    const raw = String(formData.get(c) ?? "").trim();
    const n = Number(raw.replace(/[,\s원]/g, ""));
    if (!raw || !Number.isFinite(n) || n < 0) {
      throw new Error("월 충전액은 0 이상의 숫자여야 합니다");
    }
    return [c, Math.round(n)] as const;
  });

  await setMonthlyTopup(
    Object.fromEntries(entries) as Record<Category, number>,
  );
  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true };
}

/** 추천 결과를 매입 기록으로 옮겨 담기 (§6 화면 4→5) */
export async function acceptRecommendationAction(formData: FormData) {
  await requireSession();
  const id = num(formData.get("recommendationId"));
  const rec = await getRecommendation(id);
  if (!rec) return { error: "추천을 찾을 수 없습니다" };
  if (rec.skipped || !rec.ticker) {
    return { error: "건너뛴 추천은 매입 기록으로 옮길 수 없습니다" };
  }
  // 갈아타기 재확정은 매도 단계가 먼저 터져 "보유분이 없습니다"류로 새는 탓에 여기서 끊는다.
  // DB 유니크는 동시 제출용 최종 방어로 그대로 둔다.
  if ((await acceptedRecommendationIds([rec.id])).length > 0) {
    return { error: "이 추천은 이미 매입으로 기록되었습니다" };
  }

  // 같은 회차에서 고배당을 건너뛰었다면 그 잔액을 끌어와 쓸 수 있다 (§2.2 예외)
  const highDivSkipped = await wasHighDivSkipped(rec.runId);

  // 갈아타기 추천이면 매도→매수를 한 트랜잭션으로 (매도가 실패하면 매수도 안 된다)
  if (rec.sellTicker) {
    try {
      await executeSwitch({
        category: rec.category as Category,
        executedAt: String(formData.get("boughtAt") || dateKeyKST()),
        sell: {
          ticker: rec.sellTicker,
          qty: positiveNum(formData.get("sellQty"), "매도 수량"),
          unitPrice: positiveNum(formData.get("sellUnitPrice"), "매도 체결 단가"),
        },
        buy: {
          ticker: rec.ticker,
          etfName: rec.etfName ?? rec.ticker,
          qty: positiveNum(formData.get("qty"), "수량"),
          unitPrice: positiveNum(formData.get("unitPrice"), "체결 단가"),
        },
        recommendationId: rec.id,
        allowHighDivTransfer: highDivSkipped,
      });
    } catch (e) {
      const dup = duplicateRecommendationMessage(e);
      if (dup) return { error: dup };
      return { error: e instanceof Error ? e.message : String(e) };
    }

    revalidatePath("/purchases");
    revalidatePath("/switch");
    revalidatePath("/");
    return { ok: true };
  }

  try {
    await addPurchaseWithHighDivTransfer(
      {
        boughtAt: String(formData.get("boughtAt") || dateKeyKST()),
        category: rec.category as Category,
        ticker: rec.ticker,
        etfName: rec.etfName ?? rec.ticker,
        qty: positiveNum(formData.get("qty"), "수량"),
        unitPrice: positiveNum(formData.get("unitPrice"), "체결 단가"),
        recommendationId: rec.id,
      },
      { allowTransfer: highDivSkipped },
    );
  } catch (e) {
    const dup = duplicateRecommendationMessage(e);
    if (dup) return { error: dup };
    return { error: e instanceof Error ? e.message : String(e) };
  }

  revalidatePath("/purchases");
  revalidatePath("/");
  return { ok: true };
}
