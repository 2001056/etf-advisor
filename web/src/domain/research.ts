import { desc, eq, inArray } from "drizzle-orm";
import { rm } from "node:fs/promises";
import { db } from "@/db";
import { researchDocs } from "@/db/schema";

/**
 * 조사 문서 삭제. DB 행과 맥 로컬 md 사본을 함께 지운다.
 *
 * 추천(recommendations.source_doc_ids)이 문서 ID를 참조하지만 FK가 아니라
 * 문서를 지워도 추천 기록은 남는다 — 근거 링크만 깨진다.
 */
export async function deleteResearchDocs(ids: number[]): Promise<number> {
  const valid = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (!valid.length) return 0;

  const rows = await db
    .select({ id: researchDocs.id, filePath: researchDocs.filePath })
    .from(researchDocs)
    .where(inArray(researchDocs.id, valid));

  if (!rows.length) return 0;

  await db.delete(researchDocs).where(
    inArray(
      researchDocs.id,
      rows.map((r) => r.id),
    ),
  );

  // 로컬 사본은 지워지지 않아도 DB 삭제를 되돌리지 않는다 — 조용히 넘어간다
  await Promise.all(
    rows
      .filter((r) => r.filePath)
      .map((r) => rm(r.filePath as string, { force: true }).catch(() => {})),
  );

  return rows.length;
}

/** 문서 전체 삭제 (정리용) */
export async function deleteAllResearchDocs(): Promise<number> {
  const rows = await db
    .select({ id: researchDocs.id })
    .from(researchDocs)
    .orderBy(desc(researchDocs.id));
  return deleteResearchDocs(rows.map((r) => r.id));
}

export { eq };
