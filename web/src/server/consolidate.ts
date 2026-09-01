import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { desc, isNull } from "drizzle-orm";
import { db } from "@/db";
import { consolidationSuggestions, researchDocs } from "@/db/schema";
import { getHoldings } from "@/domain/purchases";
import { getPrompt } from "@/domain/prompts";
import { extractJson } from "@/domain/recommendation";
import { CATEGORY_LABEL, CATEGORIES, Category, dateKeyKST } from "@/domain/money";
import { researchPath } from "./paths";
import type { WatchDeps } from "./watch";

/**
 * ⑤ 종목 정리 검토 — 월 1회.
 *
 * ③이 매달 자유롭게 고르기 때문에 같은 카테고리에 비슷한 ETF가 쌓인다.
 * 거의 같은 지수를 추종하면 분산 효과는 없으면서 관리만 번거로워지므로
 * "묶을 만한 것"을 찾아 제안한다. 실행 여부는 사람이 정한다.
 *
 * ④와 마찬가지로 문서 종류가 별도(consolidate)라 ③ 추천에 주입되지 않는다.
 */

const CONSOLIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: { type: "string", enum: ["배당성장", "자산성장", "고배당"] },
          tickers: { type: "array", items: { type: "string" } },
          keep_ticker: { type: ["string", "null"] },
          keep_name: { type: ["string", "null"] },
          overlap: { type: "string" },
          cost_note: { type: "string" },
          rationale: { type: "string" },
          source_urls: { type: "array", items: { type: "string" } },
        },
        required: [
          "category",
          "tickers",
          "keep_ticker",
          "keep_name",
          "overlap",
          "cost_note",
          "rationale",
          "source_urls",
        ],
      },
    },
  },
  required: ["suggestions"],
} as const;

const KO_TO_CATEGORY: Record<string, Category> = {
  배당성장: "div_growth",
  자산성장: "asset_growth",
  고배당: "high_div",
};

export type ConsolidateOutcome = {
  runId: number;
  docId: number | null;
  suggestions: number;
  /** 카테고리마다 종목이 1개뿐이라 검토할 게 없었던 경우 */
  skipped: boolean;
};

function buildInstruction(
  holdings: {
    ticker: string;
    etfName: string;
    category: Category;
    qty: number;
    avgPrice: number;
    costKrw: number;
  }[],
): string {
  const byCat = CATEGORIES.map((c) => {
    const hs = holdings.filter((h) => h.category === c);
    if (!hs.length) return null;
    const lines = hs
      .map(
        (h) =>
          `  - ${h.ticker} ${h.etfName} | ${h.qty}주 | 평단가 ${h.avgPrice.toLocaleString("ko-KR")}원 | 원금 ${h.costKrw.toLocaleString("ko-KR")}원`,
      )
      .join("\n");
    return `[${CATEGORY_LABEL[c]}] ${hs.length}종목\n${lines}`;
  })
    .filter(Boolean)
    .join("\n\n");

  return `
────────────────────────────────
[현재 보유 — 카테고리별]
${byCat}

[검토 규칙]
- **종목이 2개 이상인 카테고리만** 검토한다. 1개뿐이면 그 카테고리는 제안하지 마라.
- 같은 카테고리 안에서 **실질적으로 같은 것을 사고 있는지** 본다.
  기초지수가 같거나 거의 같은지, 상위 편입 종목이 크게 겹치는지, 최근 수익률이 나란히 움직이는지.
- 겹침이 크지 않으면(예: 서로 다른 지수·다른 전략) **통합을 제안하지 마라.** 그건 정상적인 분산이다.
- 통합을 제안한다면 keep_ticker에 **남길 종목 하나**를 고르고, 왜 그쪽인지 적어라
  (비용, 추적 품질, 유동성, 순자산 규모 기준).
- cost_note에는 **지금 옮기면 생기는 비용**을 반드시 적어라 — 매도에 따른 실현손익,
  ISA 계좌의 과세·한도 영향, 거래비용, 재매수 시 가격 차이. 모르면 모른다고 적어라.
- 통합이 이득이라고 단정하지 마라. **"묶을 만하다"와 "지금 묶어야 한다"는 다르다.**
  적립을 계속하면 자연히 한쪽으로 쏠릴 수 있으므로, 굳이 팔 필요 없이 신규 매수만
  한쪽으로 모으는 선택지도 함께 제시하라.
- 검토할 게 없으면 suggestions를 빈 배열로 두고 끝내라. 억지로 만들지 마라.

반드시 지정된 JSON 스키마로만 응답하라.`.trim();
}

export function normalizeSuggestions(
  raw: unknown,
  holdings: { ticker: string; category: Category }[],
): {
  rows: Omit<typeof consolidationSuggestions.$inferInsert, "runId" | "docId">[];
  dropped: string[];
} {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { suggestions?: unknown[] } | null)?.suggestions ?? []);
  const held = new Map(holdings.map((h) => [h.ticker, h.category]));
  const dropped: string[] = [];
  const rows: Omit<
    typeof consolidationSuggestions.$inferInsert,
    "runId" | "docId"
  >[] = [];

  for (const item of Array.isArray(list) ? list : []) {
    const s = (item ?? {}) as Record<string, unknown>;
    const category = KO_TO_CATEGORY[String(s.category ?? "").trim()];
    if (!category) {
      dropped.push(`알 수 없는 카테고리: ${String(s.category)}`);
      continue;
    }

    // 실제로 보유 중이고 그 카테고리에 속한 종목만 남긴다
    const tickers = (Array.isArray(s.tickers) ? s.tickers : [])
      .map((t) => String(t).replace(/[^0-9A-Za-z]/g, ""))
      .filter((t) => held.get(t) === category);

    // 2개 미만이면 "정리"라는 말이 성립하지 않는다
    if (tickers.length < 2) {
      dropped.push(
        `${CATEGORY_LABEL[category]}: 대상 종목이 ${tickers.length}개뿐 — 정리 대상 아님`,
      );
      continue;
    }

    const keep = String(s.keep_ticker ?? "").replace(/[^0-9A-Za-z]/g, "");
    const keepValid = tickers.includes(keep);
    if (keep && !keepValid) {
      dropped.push(`${CATEGORY_LABEL[category]}: 남길 종목 ${keep}이 대상에 없음`);
    }

    rows.push({
      category,
      tickers,
      keepTicker: keepValid ? keep : null,
      keepName: keepValid ? String(s.keep_name ?? "") || null : null,
      overlap: String(s.overlap ?? "").slice(0, 800),
      costNote: String(s.cost_note ?? "").slice(0, 800),
      rationale: String(s.rationale ?? ""),
      sourceUrls: Array.isArray(s.source_urls)
        ? s.source_urls.filter((u): u is string => typeof u === "string")
        : [],
    });
  }

  return { rows, dropped };
}

export async function runConsolidateReview(
  deps: WatchDeps,
  trigger: "schedule" | "user" = "schedule",
): Promise<ConsolidateOutcome> {
  const holdings = await getHoldings();

  // 카테고리마다 2종목 이상인 곳이 하나도 없으면 부를 이유가 없다
  const hasMulti = CATEGORIES.some(
    (c) => holdings.filter((h) => h.category === c).length >= 2,
  );
  if (!hasMulti) {
    return { runId: 0, docId: null, suggestions: 0, skipped: true };
  }

  const run = await deps.claim("consolidate", trigger);
  const startedAtMs = Date.now();
  const beforePercent = await deps.beforePercent();

  try {
    if (!(await deps.checkAuth())) {
      await deps.finish(run.id, "auth_failed", null, null);
      return { runId: run.id, docId: null, suggestions: 0, skipped: false };
    }

    const dateKey = dateKeyKST();
    const { body } = await getPrompt("consolidate");
    const prompt = [body, buildInstruction(holdings)].join("\n\n");

    const res = await deps.run({
      runId: run.id,
      prompt,
      outputSchema: CONSOLIDATE_SCHEMA,
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
      return { runId: run.id, docId: null, suggestions: 0, skipped: false };
    }

    const { rows, dropped } = normalizeSuggestions(
      extractJson(res.output),
      holdings,
    );

    const md = [
      `# 종목 정리 검토 ${dateKey}`,
      "",
      rows.length
        ? rows
            .map(
              (r) =>
                `## ${CATEGORY_LABEL[r.category as Category]} — ${(r.tickers as string[]).join(", ")}\n\n` +
                `**겹침** ${r.overlap}\n\n**옮길 때 비용** ${r.costNote}\n\n${r.rationale}\n` +
                (r.keepTicker ? `\n남길 종목: ${r.keepTicker} ${r.keepName ?? ""}\n` : "") +
                ((r.sourceUrls as string[]) ?? []).map((u) => `- ${u}`).join("\n"),
            )
            .join("\n\n")
        : "정리할 만한 중복이 없습니다.",
    ].join("\n");

    const filePath = researchPath(dateKey, "consolidate", run.id);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, md, "utf8");

    const [doc] = await db
      .insert(researchDocs)
      .values({
        runId: run.id,
        docDate: dateKey,
        type: "consolidate",
        title: `종목 정리 검토 ${dateKey}`,
        content: md,
        parseProblems: dropped.length ? dropped : null,
        filePath,
      })
      .returning();

    await db
      .update(consolidationSuggestions)
      .set({ resolvedAt: new Date() })
      .where(isNull(consolidationSuggestions.resolvedAt));

    if (rows.length) {
      await db
        .insert(consolidationSuggestions)
        .values(rows.map((r) => ({ ...r, runId: run.id, docId: doc.id })));
    }

    await deps.finish(
      run.id,
      "done",
      res.exitCode,
      res.logPath,
      dropped.length ? `버려진 제안 ${dropped.length}건:\n- ${dropped.join("\n- ")}` : undefined,
      startedAtMs,
      beforePercent,
    );

    return {
      runId: run.id,
      docId: doc.id,
      suggestions: rows.length,
      skipped: false,
    };
  } catch (e) {
    await deps.finish(run.id, "failed", null, null, `예외: ${String(e)}`);
    throw e;
  }
}

export async function openConsolidations() {
  return db
    .select()
    .from(consolidationSuggestions)
    .where(isNull(consolidationSuggestions.resolvedAt))
    .orderBy(desc(consolidationSuggestions.id));
}
