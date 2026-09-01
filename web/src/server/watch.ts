import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, holdingAlerts, researchDocs } from "@/db/schema";
import { buildFormatInstruction, parseResearchDoc } from "@/domain/docFormat";
import { checkDocument, issuesToProblems } from "@/domain/dataChecks";
import { getHoldings } from "@/domain/purchases";
import { getPrompt } from "@/domain/prompts";
import { extractJson } from "@/domain/recommendation";
import { CATEGORY_LABEL, Category, dateKeyKST } from "@/domain/money";
import { researchPath } from "./paths";

/**
 * ④ 보유 점검 — 매일 13:00.
 *
 * ①②③과 완전히 분리돼 있다:
 * - 문서 종류가 `watch`라 ③ 추천의 주입 대상에서 빠진다(매일 쌓여도 정기 조사를 밀어내지 않는다)
 * - 결과는 `holding_alerts`에 남고, 대시보드가 그것만 읽는다
 *
 * 매도까지 제안한다 — ③은 "앞으로 살 것"만 정하고, 팔지 말지는 여기서 본다.
 */

const ALERT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    alerts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ticker: { type: "string" },
          etf_name: { type: "string" },
          severity: { type: "string", enum: ["info", "warn", "danger"] },
          action: {
            type: "string",
            enum: ["hold", "stop_buying", "sell"],
          },
          issue: { type: "string" },
          replacement_ticker: { type: ["string", "null"] },
          replacement_name: { type: ["string", "null"] },
          rationale: { type: "string" },
          source_urls: { type: "array", items: { type: "string" } },
        },
        required: [
          "ticker",
          "etf_name",
          "severity",
          "action",
          "issue",
          "replacement_ticker",
          "replacement_name",
          "rationale",
          "source_urls",
        ],
      },
    },
  },
  required: ["alerts"],
} as const;

const SEVERITY = new Set(["info", "warn", "danger"]);
const ACTION = new Set(["hold", "stop_buying", "sell"]);

export type WatchOutcome = {
  runId: number;
  docId: number | null;
  alerts: number;
  danger: number;
  /** 보유가 없어서 아무것도 하지 않은 경우 */
  skipped: boolean;
};

/** ④의 프롬프트 뒤에 붙는 출력 계약 */
function buildAlertInstruction(
  holdings: { ticker: string; etfName: string; category: Category; qty: number; avgPrice: number }[],
): string {
  const lines = holdings
    .map(
      (h) =>
        `- ${CATEGORY_LABEL[h.category]} | ${h.ticker} ${h.etfName} | ${h.qty}주 | 평단가 ${h.avgPrice.toLocaleString("ko-KR")}원`,
    )
    .join("\n");

  return `
────────────────────────────────
[점검 대상 — 지금 보유 중인 종목 전체]
${lines}

[판정 규칙]
- 종목마다 정확히 하나씩 판정을 낸다. 빠뜨리지 마라.
- severity: info(문제 없음) / warn(지켜볼 것) / danger(지금 조치 필요)
- action: hold(그대로 둔다) / stop_buying(신규 매수만 중단) / sell(팔고 갈아탄다)
- **action=sell은 근거가 분명할 때만 써라.** 단기 가격 하락은 매도 사유가 아니다.
  상장폐지·거래정지, 운용전략의 중대한 변경, 분배 재원이 원금을 깎고 있다는 확인된 신호,
  순자산 급감으로 유동성이 위험한 경우처럼 구조적 문제일 때만 해당한다.
- action=sell이면 replacement_ticker/replacement_name에 **같은 카테고리**의 대체 종목을 넣어라.
  대체 후보를 못 찾으면 둘 다 null로 두고 rationale에 이유를 적어라.
- sell이 아니면 replacement는 둘 다 null이다.
- issue는 무엇이 문제인지 한 줄. 문제가 없으면 "이상 없음"이라고 쓴다.
- rationale에는 판정 근거를 수치와 함께 적는다. 추측이면 추측이라고 밝혀라.
- source_urls에는 그 판정을 뒷받침하는 실제 URL만 넣는다.
- 매도는 세금·재매수 비용이 따르는 되돌리기 어려운 행동이다. 확신이 없으면 warn/hold로 둬라.

반드시 지정된 JSON 스키마로만 응답하라.`.trim();
}

/** 모델 출력에서 유효한 경고만 골라낸다 */
export function normalizeAlerts(
  raw: unknown,
  holdings: { ticker: string; etfName: string; category: Category }[],
): { rows: Omit<typeof holdingAlerts.$inferInsert, "runId" | "docId">[]; dropped: string[] } {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { alerts?: unknown[] } | null)?.alerts ?? []);
  const byTicker = new Map(holdings.map((h) => [h.ticker, h]));
  const dropped: string[] = [];
  const rows: Omit<typeof holdingAlerts.$inferInsert, "runId" | "docId">[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(list) ? list : []) {
    const a = (item ?? {}) as Record<string, unknown>;
    const ticker = String(a.ticker ?? "").replace(/[^0-9A-Za-z]/g, "");
    const held = byTicker.get(ticker);

    // 보유하지 않은 종목에 대한 판정은 버린다 — 점검 대상이 아니다
    if (!held) {
      dropped.push(`보유하지 않은 종목: ${String(a.ticker)}`);
      continue;
    }
    if (seen.has(ticker)) {
      dropped.push(`중복 판정: ${ticker}`);
      continue;
    }
    seen.add(ticker);

    const severity = String(a.severity ?? "").trim();
    const action = String(a.action ?? "").trim();
    if (!SEVERITY.has(severity) || !ACTION.has(action)) {
      dropped.push(`알 수 없는 판정값: ${ticker} ${severity}/${action}`);
      continue;
    }

    const isSell = action === "sell";
    const rt = String(a.replacement_ticker ?? "").replace(/[^0-9A-Za-z]/g, "");

    rows.push({
      ticker,
      etfName: held.etfName,
      category: held.category,
      severity: severity as "info" | "warn" | "danger",
      action: action as "hold" | "stop_buying" | "sell",
      issue: String(a.issue ?? "").slice(0, 500) || "이상 없음",
      replacementTicker: isSell && rt ? rt : null,
      replacementName:
        isSell && rt ? String(a.replacement_name ?? "") || null : null,
      rationale: String(a.rationale ?? ""),
      sourceUrls: Array.isArray(a.source_urls)
        ? a.source_urls.filter((u): u is string => typeof u === "string")
        : [],
    });
  }

  return { rows, dropped };
}

export type WatchDeps = {
  claim: (
    agent: "watch" | "consolidate",
    trigger: "schedule" | "user",
  ) => Promise<{ id: number }>;
  finish: (
    runId: number,
    status: "done" | "failed" | "auth_failed" | "timeout",
    exitCode: number | null,
    logPath: string | null,
    note?: string,
    startedAtMs?: number,
    beforePercent?: number | null,
  ) => Promise<void>;
  checkAuth: () => Promise<boolean>;
  run: (o: { runId: number; prompt: string; outputSchema?: unknown }) => Promise<{
    ok: boolean;
    exitCode: number | null;
    timedOut: boolean;
    output: string;
    logPath: string;
  }>;
  beforePercent: () => Promise<number | null>;
  notify: (title: string, message: string) => Promise<void>;
};

export async function runHoldingWatch(
  deps: WatchDeps,
  trigger: "schedule" | "user" = "schedule",
): Promise<WatchOutcome> {
  const holdings = await getHoldings();
  if (!holdings.length) {
    return { runId: 0, docId: null, alerts: 0, danger: 0, skipped: true };
  }

  const run = await deps.claim("watch", trigger);
  const startedAtMs = Date.now();
  const beforePercent = await deps.beforePercent();

  try {
    if (!(await deps.checkAuth())) {
      await deps.finish(run.id, "auth_failed", null, null);
      return { runId: run.id, docId: null, alerts: 0, danger: 0, skipped: false };
    }

    const dateKey = dateKeyKST();
    const { body } = await getPrompt("watch");
    const prompt = [
      body,
      buildFormatInstruction({
        type: "watch",
        dateKey,
        runId: run.id,
        tickers: holdings.map((h) => h.ticker),
      }),
      buildAlertInstruction(holdings),
    ].join("\n\n");

    const res = await deps.run({
      runId: run.id,
      prompt,
      outputSchema: ALERT_SCHEMA,
    });

    if (!res.ok || !res.output.trim()) {
      await deps.finish(
        run.id,
        res.timedOut ? "timeout" : "failed",
        res.exitCode,
        res.logPath,
        undefined,
        startedAtMs,
        beforePercent,
      );
      await deps.notify("보유 점검 실패", `보유 점검이 실패했습니다 (run ${run.id}).`);
      return { runId: run.id, docId: null, alerts: 0, danger: 0, skipped: false };
    }

    const parsedJson = extractJson(res.output);
    const { rows, dropped } = normalizeAlerts(parsedJson, holdings);

    // 판정 근거를 사람이 읽을 수 있게 문서로도 남긴다 (type=watch — ③ 주입 대상 아님)
    const md = [
      `# 보유 점검 ${dateKey}`,
      "",
      ...rows.map(
        (r) =>
          `## ${r.ticker} ${r.etfName} — ${r.severity} / ${r.action}\n\n` +
          `${r.issue}\n\n${r.rationale}\n` +
          (r.replacementTicker
            ? `\n대체 후보: ${r.replacementTicker} ${r.replacementName ?? ""}\n`
            : "") +
          ((r.sourceUrls as string[]) ?? []).map((u) => `- ${u}`).join("\n"),
      ),
    ].join("\n");

    const filePath = researchPath(dateKey, "watch", run.id);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, md, "utf8");

    const [doc] = await db
      .insert(researchDocs)
      .values({
        runId: run.id,
        docDate: dateKey,
        type: "watch",
        title: `보유 점검 ${dateKey}`,
        content: md,
        parseProblems: dropped.length ? dropped : null,
        filePath,
      })
      .returning();

    // 이전 미해소 경고는 닫고 새 판정으로 교체한다
    await db
      .update(holdingAlerts)
      .set({ resolvedAt: new Date() })
      .where(isNull(holdingAlerts.resolvedAt));

    if (rows.length) {
      await db
        .insert(holdingAlerts)
        .values(rows.map((r) => ({ ...r, runId: run.id, docId: doc.id })));
    }

    const danger = rows.filter((r) => r.severity === "danger").length;
    await deps.finish(
      run.id,
      "done",
      res.exitCode,
      res.logPath,
      dropped.length ? `버려진 판정 ${dropped.length}건:\n- ${dropped.join("\n- ")}` : undefined,
      startedAtMs,
      beforePercent,
    );

    if (danger > 0) {
      const names = rows
        .filter((r) => r.severity === "danger")
        .map((r) => r.etfName)
        .join(", ");
      await deps.notify("보유 종목 위험", `${names} — 사이트에서 확인하세요.`);
    }

    return {
      runId: run.id,
      docId: doc.id,
      alerts: rows.length,
      danger,
      skipped: false,
    };
  } catch (e) {
    await deps.finish(run.id, "failed", null, null, `예외: ${String(e)}`);
    throw e;
  }
}

/** 지금 열려 있는 경고 */
export async function openAlerts() {
  return db
    .select()
    .from(holdingAlerts)
    .where(isNull(holdingAlerts.resolvedAt))
    .orderBy(desc(holdingAlerts.severity), holdingAlerts.ticker);
}
