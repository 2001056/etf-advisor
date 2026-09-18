import { and, desc, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { researchDocs } from "@/db/schema";
import { parseResearchDoc } from "./docFormat";
import { getHoldings } from "./purchases";

export type Quote = {
  ticker: string;
  price: number | null;
  /** price를 가져온 문서의 날짜 */
  priceAsOf: string | null;
  distYield: number | null;
  distYieldAsOf: string | null;
  /** 표시용 대표 날짜 (price 기준, 없으면 분배율 기준) */
  asOf: string;
  /** 최신 문서가 아닌 과거 문서에서 가져온 값이면 true */
  stale: boolean;
  /** 분배율이 최신 조사 문서가 아닌 과거 문서 값이면 true */
  distYieldStale: boolean;
};

// ④⑤ 문서에는 데이터 표가 없다 — 창에 섞이면 조사 문서가 그만큼 빨리 밀려난다
const NO_TABLE_TYPES = ["watch", "consolidate"] as const;

const TICKER_RE = /^[0-9A-Z]{6}$/i;

/**
 * 종목별 최신 시세 (기획서 §6).
 *
 * 최신 문서가 1순위이되 **필드 단위로** 채운다 — 최신 문서에 분배율만 있고
 * 가격이 비어 있으면 가격은 과거 문서에서 가져온다. 문서 단위로 선점하면
 * 그 종목의 가격을 영영 못 쓰게 된다.
 */
export async function getQuotes(
  opts: { window?: number } = {},
): Promise<Map<string, Quote>> {
  const docs = await db
    .select()
    .from(researchDocs)
    .where(notInArray(researchDocs.type, [...NO_TABLE_TYPES]))
    .orderBy(desc(researchDocs.docDate), desc(researchDocs.id))
    .limit(opts.window ?? 40);

  const out = new Map<string, Quote>();
  if (!docs.length) return out;

  const newestKey = docs[0].docDate;

  const absorb = (doc: (typeof docs)[number], only?: string) => {
    const parsed = parseResearchDoc(doc.content);
    for (const row of parsed.dataRows) {
      if (only && row.ticker !== only) continue;
      const cur: Quote =
        out.get(row.ticker) ??
        ({
          ticker: row.ticker,
          price: null,
          priceAsOf: null,
          distYield: null,
          distYieldAsOf: null,
          asOf: doc.docDate,
          stale: false,
          distYieldStale: false,
        } satisfies Quote);

      if (cur.price === null && row.price !== null) {
        cur.price = row.price;
        cur.priceAsOf = doc.docDate;
      }
      if (cur.distYield === null && row.distYield !== null) {
        cur.distYield = row.distYield;
        cur.distYieldAsOf = doc.docDate;
      }

      cur.asOf = cur.priceAsOf ?? cur.distYieldAsOf ?? doc.docDate;
      cur.stale = cur.asOf !== newestKey;
      cur.distYieldStale =
        cur.distYieldAsOf !== null && cur.distYieldAsOf !== newestKey;

      if (cur.price !== null || cur.distYield !== null) out.set(row.ticker, cur);
    }
  };

  for (const doc of docs) absorb(doc);

  // 조사 대상에서 빠진 보유(비활성 카테고리)는 새 문서에 다시 나오지 않는다 — 창 밖의 마지막 조사 값을 쓴다
  const heldTickers = [...new Set((await getHoldings()).map((h) => h.ticker))]
    .filter((t) => TICKER_RE.test(t))
    .filter((t) => {
      const cur = out.get(t);
      return !(cur && cur.price !== null && cur.distYield !== null);
    });

  const older = await Promise.all(
    heldTickers.map(async (ticker) => ({
      ticker,
      // 본문에 이름만 언급된 문서가 아니라 데이터 표 칸(| 종목코드 |)에 있는 문서만 찾는다
      docs: await db
        .select()
        .from(researchDocs)
        .where(
          and(
            notInArray(researchDocs.type, [...NO_TABLE_TYPES]),
            sql`${researchDocs.content} ~ ('\\|\\s*' || ${ticker}::text || '\\s*\\|')`,
          ),
        )
        .orderBy(desc(researchDocs.docDate), desc(researchDocs.id))
        .limit(5),
    })),
  );
  for (const { ticker, docs: found } of older) {
    for (const doc of found) absorb(doc, ticker);
  }

  return out;
}
