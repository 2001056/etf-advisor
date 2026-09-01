import { desc } from "drizzle-orm";
import { db } from "@/db";
import { researchDocs } from "@/db/schema";
import { parseResearchDoc } from "./docFormat";

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
};

/**
 * 종목별 최신 시세 (기획서 §6).
 *
 * 최신 문서가 1순위이되 **필드 단위로** 채운다 — 최신 문서에 분배율만 있고
 * 가격이 비어 있으면 가격은 과거 문서에서 가져온다. 문서 단위로 선점하면
 * 그 종목의 가격을 영영 못 쓰게 된다.
 */
export async function getQuotes(): Promise<Map<string, Quote>> {
  const docs = await db
    .select()
    .from(researchDocs)
    .orderBy(desc(researchDocs.docDate), desc(researchDocs.id))
    .limit(40);

  const out = new Map<string, Quote>();
  if (!docs.length) return out;

  const newestKey = docs[0].docDate;

  for (const doc of docs) {
    const parsed = parseResearchDoc(doc.content);
    for (const row of parsed.dataRows) {
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

      if (cur.price !== null || cur.distYield !== null) out.set(row.ticker, cur);
    }
  }

  return out;
}
