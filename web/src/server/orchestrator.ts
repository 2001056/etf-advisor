import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
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
  tickersOf,
} from "@/domain/docFormat";
import {
  dateKeyKST,
  isMarketOpenKST,
  monthKeyKST,
  CATEGORIES,
  Category,
} from "@/domain/money";
import { getBalances } from "@/domain/ledger";
import { getHoldings } from "@/domain/purchases";
// JSON 추출·정수 변환·pick 정규화는 순수 로직이라 분리했다.
// 회귀 테스트: scripts/check-recommend.ts
import {
  applyRealtimePrices,
  extractJson,
  normalizePicks,
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
    const { body } = await getPrompt(opts.slot);

    const prompt = [
      body,
      buildFormatInstruction({
        type,
        dateKey,
        runId: run.id,
        tickers: opts.tickers,
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
          action: { type: "string", enum: ["buy", "skip", "switch"] },
          ticker: { type: ["string", "null"] },
          etf_name: { type: ["string", "null"] },
          budget_krw: { type: "integer" },
          ref_price: { type: ["integer", "null"] },
          ref_qty: { type: "integer" },
          // action="switch"일 때만: 팔 보유 종목·수량·조사가. buy/skip은 null
          sell_ticker: { type: ["string", "null"] },
          sell_qty: { type: ["integer", "null"] },
          sell_ref_price: { type: ["integer", "null"] },
          rationale: { type: "string" },
          source_doc_ids: { type: "array", items: { type: "integer" } },
          source_urls: { type: "array", items: { type: "string" } },
        },
        required: [
          "category",
          "action",
          "ticker",
          "etf_name",
          "budget_krw",
          "ref_price",
          "ref_qty",
          "sell_ticker",
          "sell_qty",
          "sell_ref_price",
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

/** ②가 조사할 종목 = 주입 창 문서의 종목 ∪ 현재 보유 종목 (§5.2) */
export async function tickersToResearch(): Promise<string[]> {
  const docs = await docsForRecommendation();
  const fromDocs = docs.flatMap((d) => tickersOf(parseResearchDoc(d.content)));

  const held = await db
    .selectDistinct({ ticker: purchases.ticker })
    .from(purchases);

  return [...new Set([...fromDocs, ...held.map((h) => h.ticker)])].filter(Boolean);
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
  const tickers = await tickersToResearch();

  const research = await runResearch({
    slot: "purchase",
    trigger: "user",
    actionId,
    tickers,
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

    const [balances, holdings, { body }] = await Promise.all([
      getBalances(),
      getHoldings(),
      getPrompt("recommend"),
    ]);

    const KO: Record<Category, string> = {
      div_growth: "배당성장",
      asset_growth: "자산성장",
      high_div: "고배당",
    };

    const budgetLines = CATEGORIES.map(
      (c) => `- ${KO[c]}: ${balances[c].toLocaleString("ko-KR")}원`,
    ).join("\n");

    const holdingLines = holdings.length
      ? holdings
          .map(
            (h) =>
              `- ${KO[h.category]} | ${h.ticker} ${h.etfName} | ${h.qty}주 | 평단가 ${h.avgPrice.toLocaleString("ko-KR")}원`,
          )
          .join("\n")
      : "- (보유 종목 없음 — 이번이 첫 매입입니다)";

    const prompt = [
      body,
      "",
      "────────────────────────────────",
      "[이번 회차 카테고리별 현재 잔액 = budget_krw. 이월 잔액이 포함된 값이다]",
      budgetLines,
      "",
      "[현재 보유 현황]",
      holdingLines,
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
      "- 세 카테고리(배당성장·자산성장·고배당) 각각 정확히 한 번씩, 총 3개를 picks에 담아라.",
      "- 매수면 action=\"buy\", 건너뜀이면 action=\"skip\", 보유 종목을 팔고 다른 종목으로 교체하는 게 낫다고 판단되면 action=\"switch\".",
      "- action=skip이면 ticker·etf_name·ref_price는 null, ref_qty는 0으로 둔다. 값을 지어내지 마라.",
      "- action=switch이면 sell_ticker=팔 보유 종목 코드, sell_qty=팔 수량(위 보유 현황의 수량 이내), sell_ref_price=그 종목의 조사 가격. ticker·etf_name·ref_price에는 새로 살 종목을 적는다. 갈아타기의 근거(왜 파는지, 왜 그 종목으로 가는지)를 rationale에 조사 수치를 인용해 설명하라.",
      "- action이 buy나 skip이면 sell_ticker·sell_qty·sell_ref_price는 null로 둔다.",
      "- 보유하지 않은 종목을 팔라고 하지 마라. 갈아타기는 위 [현재 보유 현황]에 있는 종목만 대상으로 한다.",
      "- ref_price는 위 매입 시점 조사 문서의 price를 그대로 쓴다.",
      "- ref_qty: buy면 floor(budget_krw ÷ ref_price), switch면 floor((budget_krw + sell_qty×sell_ref_price) ÷ ref_price).",
      "- source_doc_ids에는 위에 표시된 research_doc_id 중 실제로 근거로 쓴 것만 넣어라.",
      "- JSON 밖에는 아무것도 출력하지 마라.",
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
    const { rows: normalized, dropped } = normalizePicks(picks, {
      balances,
      injectedDocIds: [research.docId!, ...priorDocs.map((d) => d.id)],
      // 갈아타기 제안의 매도 종목·수량을 실제 보유와 대조하기 위해 넘긴다
      holdings: holdings.map((h) => ({
        category: h.category,
        ticker: h.ticker,
        qty: h.qty,
      })),
    });

    // 조사 문서의 가격은 이미 묵은 값이다. 증권사 앱과 같은 값으로 사려면
    // 추천 시점의 체결가로 기준가를 갈아끼우고 수량을 다시 센다 (원값은 researchPrice에).
    const quoteTickers = [
      ...new Set(
        normalized
          .flatMap((r) => [r.ticker, r.sellTicker])
          .filter((t): t is string => Boolean(t)),
      ),
    ];
    const priced = applyRealtimePrices(
      normalized,
      quoteTickers.length ? await getRealtimePrices(quoteTickers) : new Map(),
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
