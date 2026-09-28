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
  getMonthlyTopup,
  isOnboarded,
  seedInitialBalances,
  runLazyTopup,
  setMonthlyTopup,
  setGrowthRoleWeights,
  setHoldingRoles,
  type HoldingRoleChange,
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
  activeCategories,
  GROWTH_ROLES,
  GrowthRole,
  ROLE_CATEGORY,
  toGrowthRole,
} from "@/domain/recommendation";
import {
  deleteAllResearchDocs,
  deleteResearchDocs,
} from "@/domain/research";
import { addDividend, deleteDividend } from "@/domain/dividends";
import {
  acceptBlockReason,
  acceptedRecommendationIds,
  addManualPurchase,
  addPurchaseWithHighDivTransfer,
  cancelSwitch,
  deletePurchase,
  duplicateRecommendationMessage,
  executeSwitch,
  getHoldings,
  updatePurchase,
} from "@/domain/purchases";
import {
  category,
  parsePurchaseForm,
  parseSwitchForm,
  positiveNum,
} from "@/domain/formInput";
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

/** 비워둬도 되는 숫자 칸 */
function optionalNum(v: FormDataEntryValue | null): number | null {
  const raw = String(v ?? "").trim();
  if (!raw) return null;
  const n = Number(raw.replace(/[,\s원]/g, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
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
    // 폼 값 검증(자리 포함)이 먼저, 자리는 매입과 같은 트랜잭션에 저장된다
    const p = parsePurchaseForm(formData, dateKeyKST());
    await addManualPurchase(p.input, {
      allowOverBalance: p.allowOverBalance,
      role: p.role,
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  revalidatePath("/purchases");
  revalidatePath("/settings");
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
 * 갈아타기: A 매도 → B 매수를 한 번에 (executeSwitch).
 * 매수 카테고리가 매도 카테고리와 다르면 매도대금 전액이 매수 카테고리로 옮겨진다.
 * 실패 가능(보유 부족·동일 종목)하므로 에러를 문자열로 돌려 폼에 띄운다.
 */
export async function switchAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireSession();
  try {
    // 폼 값 검증(매도 종목·매수 카테고리·이전 확인·자리)이 먼저 — 틀리면 아무것도 쓰지 않는다
    await executeSwitch(parseSwitchForm(formData, dateKeyKST()));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "갈아타기에 실패했습니다" };
  }

  revalidatePath("/switch");
  revalidatePath("/purchases");
  revalidatePath("/settings");
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

/** 자산성장 두 자리(공격·안정)의 비중. 합이 1이 아니면 배정액이 잔액을 벗어난다 */
export async function saveGrowthRolesAction(formData: FormData) {
  await requireSession();

  const entries = GROWTH_ROLES.map((r) => {
    const raw = String(formData.get(r) ?? "").trim();
    const n = Number(raw.replace(/[,\s%]/g, ""));
    if (!raw || !Number.isFinite(n) || n <= 0 || n >= 100) {
      throw new Error("자리 비중은 0보다 크고 100보다 작은 숫자여야 합니다");
    }
    return [r, n / 100] as const;
  });

  // 여기는 사람이 방금 입력한 값이라 100%를 정확히 맞추게 한다.
  // normalizeRoleWeights(0.02)는 이미 저장된 값을 읽을 때의 완화된 기준이다.
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  if (Math.abs(sum - 1) > 0.001) {
    throw new Error(
      `두 자리의 비중 합이 100%가 되어야 합니다 (지금 ${Math.round(sum * 100)}%)`,
    );
  }

  await setGrowthRoleWeights(
    Object.fromEntries(entries) as Record<GrowthRole, number>,
  );
  revalidatePath("/settings");
  revalidatePath("/recommend");
  return { ok: true };
}

/**
 * 보유 종목 자리 수동 지정 (설정 화면). 칸 이름은 `seat:카테고리::종목코드`, 값은 자리 또는 빈칸(미정).
 * 같은 줄의 `orig:카테고리::종목코드` 는 화면을 그릴 때의 값이다.
 *
 * 화면을 그릴 때 값에서 사람이 바꾼 줄만 저장한다 — 저장 시점의 값과 비교하면, 화면을 연 뒤
 * 다른 경로(매입 폼 등)로 바뀐 줄을 손대지 않았는데도 옛 화면 값으로 덮어쓴다.
 * 미정은 수동 지정을 지우는 것이라, 추천으로 산 기록이 있으면 그 자리로 돌아간다.
 */
export async function saveHoldingRolesAction(
  formData: FormData,
): Promise<{ ok?: true; error?: string }> {
  await requireSession();
  const holdings = await getHoldings();

  const changes: HoldingRoleChange[] = [];
  for (const h of holdings) {
    if (h.category !== ROLE_CATEGORY) continue;
    const key = `${h.category}::${h.ticker}`;
    const v = formData.get(`seat:${key}`);
    const orig = formData.get(`orig:${key}`);
    if (v === null || orig === null) continue; // 화면을 연 뒤에 새로 생긴 보유 — 이번 저장과 무관
    const raw = String(v).trim();
    if (raw === String(orig).trim()) continue; // 손대지 않은 줄
    const role = raw ? toGrowthRole(raw) : null;
    if (raw && !role) return { error: `알 수 없는 자리: ${raw}` };
    changes.push({ category: h.category, ticker: h.ticker, role });
  }

  try {
    await setHoldingRoles(changes);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
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
  const blocked = acceptBlockReason(
    rec,
    (await acceptedRecommendationIds([rec.id])).length > 0,
  );
  if (blocked) return { error: blocked };
  // ticker 없음은 acceptBlockReason이 이미 걸렀다 — 여기서는 타입만 좁힌다
  const ticker = rec.ticker!;

  // 같은 회차에서 고배당을 건너뛰었다면 그 잔액을 끌어와 쓸 수 있다 (§2.2 예외).
  // 고배당이 비활성이면 그 잔돈은 이번 회차 재원이 아니므로 끌어오지 않는다.
  const highDivSkipped =
    (await wasHighDivSkipped(rec.runId)) &&
    activeCategories(await getMonthlyTopup()).includes("high_div");

  try {
    await addPurchaseWithHighDivTransfer(
      {
        boughtAt: String(formData.get("boughtAt") || dateKeyKST()),
        category: rec.category as Category,
        ticker,
        etfName: rec.etfName ?? ticker,
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
