import { desc } from "drizzle-orm";
import { db } from "@/db";
import { researchDocs } from "@/db/schema";
import { parseResearchDoc } from "./docFormat";
import { getHoldings } from "./purchases";
import { Category, CATEGORIES } from "./money";

export type TickerCandidate = {
  ticker: string;
  name: string;
  /** 알 수 있으면 카테고리도 — 고를 때 구분까지 자동으로 채운다 */
  category: Category | null;
  /** 보유 중인 종목이면 위로 올린다 */
  held: boolean;
};

const KO_TO_CATEGORY: Record<string, Category> = {
  배당성장: "div_growth",
  자산성장: "asset_growth",
  고배당: "high_div",
};

/**
 * 종목 입력칸에서 고를 수 있는 후보.
 * 보유 종목 + 조사 문서에 등장한 종목을 합친다 — 조사에 나온 건 곧 살 수도 있는 것들이다.
 */
export async function tickerCandidates(): Promise<TickerCandidate[]> {
  const [holdings, docs] = await Promise.all([
    getHoldings(),
    db
      .select({ content: researchDocs.content })
      .from(researchDocs)
      .orderBy(desc(researchDocs.docDate), desc(researchDocs.id))
      .limit(8),
  ]);

  const map = new Map<string, TickerCandidate>();

  // 조사 문서 먼저 넣고, 보유 종목으로 덮어쓴다 (보유 쪽 이름이 사용자가 쓴 것이라 우선)
  for (const d of docs) {
    for (const row of parseResearchDoc(d.content).dataRows) {
      if (map.has(row.ticker)) continue;
      map.set(row.ticker, {
        ticker: row.ticker,
        name: row.name || row.ticker,
        category: KO_TO_CATEGORY[row.category?.trim()] ?? null,
        held: false,
      });
    }
  }

  for (const h of holdings) {
    map.set(h.ticker, {
      ticker: h.ticker,
      name: h.etfName || h.ticker,
      category: h.category,
      held: true,
    });
  }

  return [...map.values()].sort((a, b) => {
    if (a.held !== b.held) return a.held ? -1 : 1;
    const ca = a.category ? CATEGORIES.indexOf(a.category) : 99;
    const cb = b.category ? CATEGORIES.indexOf(b.category) : 99;
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name, "ko");
  });
}
