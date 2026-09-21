import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentRuns,
  recommendations,
  researchDocs,
  purchases,
} from "@/db/schema";
import {
  buildFormatInstruction,
  parseResearchDoc,
} from "@/domain/docFormat";
import {
  dateKeyKST,
  isMarketOpenKST,
  monthKeyKST,
  CATEGORIES,
  Category,
} from "@/domain/money";
import {
  getBalances,
  getGrowthRoleWeights,
  getMonthlyTopup,
} from "@/domain/ledger";
import { getHoldings } from "@/domain/purchases";
// JSON 추출·정수 변환·pick 정규화는 순수 로직이라 분리했다.
// 회귀 테스트: scripts/check-recommend.ts
import {
  activeBalances,
  activeCategories,
  activeCategoriesLine,
  applyRealtimePrices,
  budgetLine,
  extractJson,
  holdingLine,
  normalizePicks,
  realtimePriceBlock,
  recommendOutputRules,
  researchTickers,
  roleBudgetLine,
  ROLE_CATEGORY,
} from "@/domain/recommendation";
import { getPrompt } from "@/domain/prompts";
import { checkDocument, issuesToProblems } from "@/domain/dataChecks";
import { checkCodexAuth, runCodex, tailLog } from "./codex";
import { getRealtimePrices } from "./livePrice";
import { researchPath } from "./paths";
import { notify } from "./notify";
import { runHoldingWatch } from "./watch";
import { runConsolidateReview } from "./consolidate";
import { currentWeeklyUsage, usageSince } from "./usage";

export class BusyError extends Error {
  constructor() {
    super("이미 실행 중인 에이전트가 있습니다");
    this.name = "BusyError";
  }
}

/** running 행은 최대 1개 — DB partial unique index가 강제한다 (§5.5-2) */
async function claim(
  agent: "weekly" | "purchase" | "recommend" | "watch" | "consolidate",
  trigger: "schedule" | "user",
  actionId: string | null,
) {
  try {
    const [row] = await db
      .insert(agentRuns)
      .values({ agent, trigger, actionId, status: "running" })
      .returning();
    return row;
  } catch (e) {
    // drizzle이 pg 에러를 DrizzleQueryError로 감싸므로 제약조건 정보는 cause에만 있다.
    // message 문자열 검사로는 절대 잡히지 않는다.
    const cause = (e as { cause?: { code?: string; constraint?: string } })?.cause;
    if (cause?.code === "23505") throw new BusyError();
    throw e;
  }
}

async function finish(
  runId: number,
  status: "done" | "failed" | "auth_failed" | "timeout",
  exitCode: number | null,
  logPath: string | null,
  note?: string,
  startedAtMs?: number,
  beforePercent?: number | null,
) {
  const tail = logPath && status !== "done" ? await tailLog(logPath) : null;
  const logTail = [note, tail].filter(Boolean).join("\n\n") || null;

  // 이 실행이 쓴 토큰과 주간 한도 소진율을 codex 세션 기록에서 수집한다.
  // 증가분은 "직전 앱 실행 대비"가 아니라 "이 실행 직전 대비"로 재야
  // 터미널 등 다른 세션에서 쓴 양이 섞이지 않는다.
  let usage = null;
  let deltaPercent: number | null = null;
  if (startedAtMs) {
    usage = await usageSince(startedAtMs);
    if (
      usage?.weeklyUsedPercent != null &&
      beforePercent != null &&
      Number.isFinite(beforePercent)
    ) {
      deltaPercent = Math.max(0, usage.weeklyUsedPercent - beforePercent);
    }
  }

  await db
    .update(agentRuns)
    .set({
      status,
      exitCode,
      finishedAt: new Date(),
      // logPath가 null이면 이미 기록된 경로를 지우지 않는다 —
      // 로그가 가장 필요한 실패 상황에서 경로를 날려버리면 원인을 못 찾는다.
      ...(logPath ? { logPath } : {}),
      ...(logTail ? { logTail } : {}),
      ...(usage
        ? {
            totalTokens: usage.totalTokens,
            outputTokens: usage.outputTokens,
            weeklyBeforePercent: beforePercent ?? null,
            weeklyUsedPercent: usage.weeklyUsedPercent,
            weeklyDeltaPercent: deltaPercent,
            weeklyResetsAt: usage.weeklyResetsAt,
          }
        : {}),
    })
    .where(eq(agentRuns.id, runId));
}

/** 서버 시작 시 남아 있는 running 행 정리 (§5.5-7) */
export async function reapOrphanRuns() {
  const rows = await db
    .update(agentRuns)
    .set({
      status: "failed",
      finishedAt: new Date(),
      logTail: "서버가 재시작되어 중단된 실행입니다",
    })
    .where(eq(agentRuns.status, "running"))
    .returning({ id: agentRuns.id });
  if (rows.length) {
    console.warn(`[orchestrator] 고아 실행 ${rows.length}건 정리`);
  }
  return rows.length;
}

/** ① 정기 조사 / ② 매입 시점 조사 공통 실행부 */
async function runResearch(opts: {
  slot: "weekly" | "purchase";
  trigger: "schedule" | "user";
  actionId: string | null;
  tickers?: string[];
  categories?: Category[];
}): Promise<{ runId: number; docId: number | null }> {
  const run = await claim(opts.slot, opts.trigger, opts.actionId);
  const startedAtMs = Date.now();
  // 실행 직전의 주간 소진율 — 이 실행이 얼마나 올렸는지 재는 기준선
  const beforePercent = (await currentWeeklyUsage())?.weeklyUsedPercent ?? null;

  try {
    if (!(await checkCodexAuth())) {
      await finish(run.id, "auth_failed", null, null);
      await notify(
        "Codex 로그인 만료",
        "codex login 을 다시 실행해야 조사가 재개됩니다.",
      );
      return { runId: run.id, docId: null };
    }

    const dateKey = dateKeyKST();
    const type = opts.slot === "weekly" ? "scheduled" : "ondemand";
    const [{ body }, categories] = await Promise.all([
      getPrompt(opts.slot),
      opts.categories ?? getMonthlyTopup().then(activeCategories),
    ]);

    const prompt = [
      body,
      ...(opts.slot === "purchase" ? [activeCategoriesLine(categories)] : []),
      buildFormatInstruction({
        type,
        dateKey,
        runId: run.id,
        tickers: opts.tickers,
        categories,
      }),
    ].join("\n\n");

    const res = await runCodex({ runId: run.id, prompt });

    if (!res.ok || !res.output.trim()) {
      await finish(
        run.id,
        res.timedOut ? "timeout" : "failed",
        res.exitCode,
        res.logPath,
        undefined,
        startedAtMs,
        beforePercent,
      );
      await notify(
        "조사 실패",
        `${type === "scheduled" ? "정기" : "매입시점"} 조사가 실패했습니다 (run ${run.id}).`,
      );
      return { runId: run.id, docId: null };
    }

    const parsed = parseResearchDoc(res.output);

    // 수치 자가검증 — LLM이 뽑은 값을 그대로 믿지 않는다 (§ 리서치 근거)
    const issues = checkDocument(parsed);
    parsed.problems.push(...issuesToProblems(issues));

    // ②는 입력 티커를 하나도 빠뜨리면 안 된다 (프롬프트 ②의 성공 조건).
    // 빠진 종목은 보유 현황 평가액이 조용히 낡는 원인이 되므로 문서에 경고로 남긴다.
    if (opts.tickers?.length) {
      const found = new Set(parsed.dataRows.map((r) => r.ticker));
      const missing = opts.tickers.filter((t) => !found.has(t));
      if (missing.length) {
        parsed.problems.push(
          `조사 대상인데 데이터 표에 없는 종목 ${missing.length}개: ${missing.join(", ")}`,
        );
      }
    }

    // 맥 로컬 md 사본 (§5.1 — DB가 유일 원본이 되지 않도록)
    const filePath = researchPath(dateKey, type, run.id);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, res.output, "utf8");

    const [doc] = await db
      .insert(researchDocs)
      .values({
        runId: run.id,
        docDate: dateKey,
        type,
        title: `${type === "scheduled" ? "정기 조사" : "매입시점 조사"} ${dateKey}`,
        content: res.output,
        parseProblems: parsed.problems.length ? parsed.problems : null,
        filePath,
      })
      .returning();

    await finish(
      run.id,
      "done",
      res.exitCode,
      res.logPath,
      undefined,
      startedAtMs,
      beforePercent,
    );
    return { runId: run.id, docId: doc.id };
  } catch (e) {
    await finish(run.id, "failed", null, null, `예외: ${String(e)}`);
    throw e;
  }
}

export async function runWeeklyResearch(trigger: "schedule" | "user" = "schedule") {
  return runResearch({ slot: "weekly", trigger, actionId: null });
}

/**
 * ④ 보유 점검 — 매일 13:00.
 * 실행 인프라(잠금·사용량 기록·알림)는 여기 것을 그대로 쓰고,
 * 판정 로직은 server/watch.ts에 분리해 테스트 가능하게 뒀다.
 */
const watchDeps = () => ({
  claim: (agent: "watch" | "consolidate", tg: "schedule" | "user") =>
    claim(agent, tg, null),
  finish,
  checkAuth: checkCodexAuth,
  run: (o: Parameters<typeof runCodex>[0]) => runCodex(o),
  beforePercent: async () =>
    (await currentWeeklyUsage())?.weeklyUsedPercent ?? null,
  notify,
});

/** ⑤ 종목 정리 검토 — 매월 1회 */
export async function runConsolidate(
  trigger: "schedule" | "user" = "schedule",
) {
  return runConsolidateReview(watchDeps(), trigger);
}

export async function runWatch(trigger: "schedule" | "user" = "schedule") {
  return runHoldingWatch(
    {
      claim: (agent, tg) => claim(agent, tg, null),
      finish,
      checkAuth: checkCodexAuth,
      run: (o) => runCodex(o),
      beforePercent: async () =>
        (await currentWeeklyUsage())?.weeklyUsedPercent ?? null,
      notify,
    },
    trigger,
  );
}

/**
 * 추천 결과 JSON 스키마 — codex --output-schema로 강제 (§5.3).
 *
 * 건너뜀(action=skip)일 때 종목·가격을 지어내지 않아도 되도록 nullable로 둔다.
 * 필드명은 프롬프트 ③의 출력 계약과 일치해야 한다.
 */
const RECOMMEND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            type: "string",
            enum: ["배당성장", "자산성장", "고배당"],
          },
          action: { type: "string", enum: ["buy", "skip"] },
          // 자산성장 pick만: 어느 자리인지. 다른 카테고리는 null
          role: { type: ["string", "null"], enum: ["aggressive", "stable", null] },
          ticker: { type: ["string", "null"] },
          etf_name: { type: ["string", "null"] },
          budget_krw: { type: "integer" },
          ref_price: { type: ["integer", "null"] },
          ref_qty: { type: "integer" },
          rationale: { type: "string" },
          source_doc_ids: { type: "array", items: { type: "integer" } },
          source_urls: { type: "array", items: { type: "string" } },
        },
        required: [
          "category",
          "action",
          "role",
          "ticker",
          "etf_name",
          "budget_krw",
          "ref_price",
          "ref_qty",
          "rationale",
          "source_doc_ids",
          "source_urls",
        ],
      },
    },
  },
  required: ["picks"],
} as const;


/** 추천 시 주입할 조사 문서 (마지막 매입일 이후, 상한 12건 — §5.3) */
export async function docsForRecommendation() {
  const lastPurchase = await db
    .select({ boughtAt: purchases.boughtAt })
    .from(purchases)
    .orderBy(desc(purchases.boughtAt))
    .limit(1);

  const since = lastPurchase.length
    ? lastPurchase[0].boughtAt
    : // 첫 달 폴백: 최근 1개월치 (§12-3)
      new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  return db
    .select()
    .from(researchDocs)
    // doc_date는 일 단위라 gt를 쓰면 매입 당일에 만든 문서가 통째로 빠진다 (gte)
    // watch 문서는 매일 쌓이므로 주입 상한 12건을 금방 채워 정기 조사를 밀어낸다.
    // ④는 보유 점검 전용이고 ③의 판단 근거가 아니므로 제외한다.
    .where(
      and(
        gte(researchDocs.docDate, since),
        notInArray(researchDocs.type, ["watch", "consolidate"]),
      ),
    )
    .orderBy(desc(researchDocs.docDate), desc(researchDocs.id))
    .limit(12);
}

/** ②가 조사할 종목 = 주입 창 문서의 활성 카테고리 종목 ∪ 활성 카테고리 보유 종목 (§5.2) */
export async function tickersToResearch(active?: Category[]): Promise<string[]> {
  const [docs, held, categories] = await Promise.all([
    docsForRecommendation(),
    db
      .selectDistinct({ category: purchases.category, ticker: purchases.ticker })
      .from(purchases),
    active ?? getMonthlyTopup().then(activeCategories),
  ]);

  return researchTickers(
    docs.map((d) => parseResearchDoc(d.content)),
    held,
    categories,
  );
}

export type RecommendFlowResult = {
  actionId: string;
  researchRunId: number;
  recommendRunId: number | null;
};

export const MARKET_CLOSED_MESSAGE =
  "장 운영시간(평일 09:00~15:30)이 아닙니다 — 지금 조사한 가격으로는 살 수 없어 내일 가격과 달라집니다";

/**
 * 장마감 가드는 흐름의 입구에서 한 번만 판정한다 — 화면·스크립트가 늘어도 빠지지 않게.
 * 막히면 { blocked }, 시작하면 { started }(30분까지 걸리는 promise)를 준다.
 */
export function runRecommendFlow(
  opts: { force?: boolean } = {},
): { blocked: string } | { started: Promise<RecommendFlowResult> } {
  if (!opts.force && !isMarketOpenKST()) return { blocked: MARKET_CLOSED_MESSAGE };
  return { started: recommendFlow() };
}

/**
 * "매입 추천" 액션: ② 조사 → ③ 추천을 한 흐름으로 (§5.3).
 * 같은 action_id로 묶여 UI에서 하나의 진행 상태로 보인다.
 */
async function recommendFlow(): Promise<RecommendFlowResult> {
  const actionId = `act-${Date.now()}`;
  // ② 조사 대상과 ③ 잔액·보유 표시·정규화가 같은 기준을 보도록 흐름 입구에서 한 번만 정한다
  const active = activeCategories(await getMonthlyTopup());
  const tickers = await tickersToResearch(active);

  const research = await runResearch({
    slot: "purchase",
    trigger: "user",
    actionId,
    tickers,
    categories: active,
  });

  if (!research.docId) {
    return { actionId, researchRunId: research.runId, recommendRunId: null };
  }

  const run = await claim("recommend", "user", actionId);
  const startedAtMs = Date.now();
  const beforePercent = (await currentWeeklyUsage())?.weeklyUsedPercent ?? null;

  try {
    if (!(await checkCodexAuth())) {
      await finish(run.id, "auth_failed", null, null);
      return {
        actionId,
        researchRunId: research.runId,
        recommendRunId: run.id,
      };
    }

    const [freshDoc] = await db
      .select()
      .from(researchDocs)
      .where(eq(researchDocs.id, research.docId!));

    const priorDocs = (await docsForRecommendation()).filter(
      (d) => d.id !== research.docId,
    );

    const [balances, holdings, { body }, roleWeights] = await Promise.all([
      getBalances(),
      getHoldings(),
      getPrompt("recommend"),
      getGrowthRoleWeights(),
    ]);

    const budgetLines = CATEGORIES.flatMap((c) => [
      budgetLine(c, balances[c], active),
      ...(c === ROLE_CATEGORY && active.includes(c)
        ? [roleBudgetLine(balances[c], roleWeights)]
        : []),
    ]).join("\n");

    const holdingLines = holdings.length
      ? holdings.map((h) => holdingLine(h, active)).join("\n")
      : "- (보유 종목 없음 — 이번이 첫 매입입니다)";

    // ② 문서의 price는 조사 시점 값이다. 모델이 1주 매수 가능 여부와 ref_qty를
    // 증권사 앱과 같은 값으로 판단하도록 조립 전에 실시간 시세를 먼저 받아 앞에 붙인다.
    const freshParsed = parseResearchDoc(freshDoc.content);
    const liveTickers = researchTickers([freshParsed], holdings, active);
    const liveBlock = realtimePriceBlock(
      liveTickers,
      liveTickers.length ? await getRealtimePrices(liveTickers) : new Map(),
    );

    const prompt = [
      body,
      "",
      "────────────────────────────────",
      activeCategoriesLine(active),
      "[이번 회차 카테고리별 현재 잔액 = budget_krw. 이월 잔액이 포함된 값이다]",
      budgetLines,
      "",
      "[현재 보유 현황]",
      holdingLines,
      "",
      liveBlock,
      "",
      `[매입 시점 조사 결과 — research_doc_id: ${freshDoc.id}, 가장 최신. 이것을 기준선으로 삼을 것]`,
      freshDoc.content,
      "",
      priorDocs.length
        ? [
            "[참고: 이전 조사 문서]",
            ...priorDocs.map(
              (d) =>
                `--- research_doc_id: ${d.id} | ${d.title} ---\n${d.content.slice(0, 4000)}`,
            ),
          ].join("\n\n")
        : "",
      "",
      "────────────────────────────────",
      "[출력 규칙]",
      ...recommendOutputRules(active),
    ].join("\n");

    const res = await runCodex({
      runId: run.id,
      prompt,
      outputSchema: RECOMMEND_SCHEMA,
    });

    if (!res.ok || !res.output.trim()) {
      await finish(
        run.id,
        res.timedOut ? "timeout" : "failed",
        res.exitCode,
        res.logPath,
        undefined,
        startedAtMs,
        beforePercent,
      );
      await notify("추천 실패", `추천 에이전트가 실패했습니다 (run ${run.id}).`);
      return { actionId, researchRunId: research.runId, recommendRunId: run.id };
    }

    const picks = extractJson(res.output);
    if (!picks) {
      await finish(
        run.id,
        "failed",
        res.exitCode,
        res.logPath,
        `JSON 파싱 실패:\n${res.output.slice(0, 2000)}`,
        startedAtMs,
        beforePercent,
      );
      return { actionId, researchRunId: research.runId, recommendRunId: run.id };
    }

    const month = monthKeyKST();
    // 모델의 ref_price는 [실시간 시세] 값이다. research_price에는 ② 문서 표의 가격을
    // 넣어야 applyRealtimePrices의 ±30% 검사가 ② 오파싱을 잡아낸다.
    const researchPrices = new Map(
      freshParsed.dataRows
        .filter((r) => r.price !== null && r.price > 0)
        .map((r) => [r.ticker, r.price!] as const),
    );
    // 재배분 전 잔액 — 정규화와 applyRealtimePrices가 같은 값을 써야 이월액이 어긋나지 않는다
    const normalizeBalances = activeBalances(balances, active);
    const { rows: normalized, dropped } = normalizePicks(picks, {
      balances: normalizeBalances,
      injectedDocIds: [research.docId!, ...priorDocs.map((d) => d.id)],
      active,
      roleWeights,
      researchPrices,
    });

    // 조사 문서의 가격은 이미 묵은 값이다. 증권사 앱과 같은 값으로 사려면
    // 추천 시점의 체결가로 기준가를 갈아끼우고 수량을 다시 센다 (원값은 researchPrice에).
    const quoteTickers = [
      ...new Set(
        normalized.map((r) => r.ticker).filter((t): t is string => Boolean(t)),
      ),
    ];
    const priced = applyRealtimePrices(
      normalized,
      quoteTickers.length ? await getRealtimePrices(quoteTickers) : new Map(),
      normalizeBalances,
    );

    const rows = priced.rows.map((r) => ({ ...r, runId: run.id, month }));

    // insert 실패가 15분짜리 실행 전체를 날리지 않게 분리한다
    let insertError: string | null = null;
    if (rows.length) {
      try {
        await db.insert(recommendations).values(rows);
      } catch (e) {
        insertError = `추천 저장 실패: ${String(e)}`;
        console.error("[recommend]", insertError);
      }
    }

    const notes = [
      priced.eligible
        ? `실시간가 적용 ${priced.applied}/${priced.eligible}건` +
          (priced.excluded.length ? ` (제외 사유: ${priced.excluded.join(", ")})` : "")
        : "",
      dropped.length ? `버려진 추천 ${dropped.length}건:\n- ${dropped.join("\n- ")}` : "",
      rows.length === 0 ? `유효한 추천이 없습니다. 원본:\n${res.output.slice(0, 1500)}` : "",
      insertError ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");

    await finish(
      run.id,
      insertError ? "failed" : "done",
      res.exitCode,
      res.logPath,
      notes || undefined,
      startedAtMs,
      beforePercent,
    );
    return { actionId, researchRunId: research.runId, recommendRunId: run.id };
  } catch (e) {
    await finish(run.id, "failed", null, null, `예외: ${String(e)}`);
    throw e;
  }
}

/**
 * 막힌 실행을 사람이 직접 해제한다 (§5.5-7의 보완).
 * 서버가 살아 있는 채로 codex 자식이 죽는 등 자동 정리가 못 잡는 경우의 탈출구.
 */
export async function clearStuckRuns(): Promise<number> {
  const rows = await db
    .update(agentRuns)
    .set({
      status: "failed",
      finishedAt: new Date(),
      logTail: "사용자가 직접 해제한 실행입니다",
    })
    .where(eq(agentRuns.status, "running"))
    .returning({ id: agentRuns.id });
  return rows.length;
}

export async function getRunningRun() {
  const rows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.status, "running"))
    .limit(1);
  return rows[0] ?? null;
}

export async function getActionRuns(actionId: string) {
  return db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.actionId, actionId))
    .orderBy(agentRuns.id);
}

export async function latestRecommendation() {
  const [latestRun] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.agent, "recommend"), eq(agentRuns.status, "done")))
    .orderBy(desc(agentRuns.id))
    .limit(1);

  if (!latestRun) return null;

  const picks = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.runId, latestRun.id));

  return { run: latestRun, picks };
}

export { sql, or, isNull, inArray };
