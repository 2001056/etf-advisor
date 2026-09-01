/** 조사 문서 삭제 검증 — 검증용 DB에서만 실행 */
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { researchDocs, purchases } from "../src/db/schema";
import { deleteResearchDocs, deleteAllResearchDocs } from "../src/domain/research";

let failed = 0;
function check(l: string, ok: boolean, d = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`);
}
const exists = async (p: string) => access(p).then(() => true).catch(() => false);

async function main() {
  const guard = await db.select({ n: sql<number>`(select count(*) from ${purchases})::int` }).from(sql`(select 1) as _`);
  if (Number(guard[0]?.n ?? 0) > 0 && process.env.ALLOW_WIPE !== "1") {
    console.error("데이터가 있는 DB입니다. 검증용 DB에서 실행하세요."); process.exit(2);
  }
  await db.execute(sql`truncate ${researchDocs} restart identity cascade`);

  const dir = path.join(os.tmpdir(), "etf-doc-del-test");
  await mkdir(dir, { recursive: true });
  const f1 = path.join(dir, "a.md");
  const f2 = path.join(dir, "b.md");
  await writeFile(f1, "문서1"); await writeFile(f2, "문서2");

  const [d1] = await db.insert(researchDocs).values({
    docDate: "2026-08-01", type: "scheduled", title: "문서1", content: "x", filePath: f1,
  }).returning();
  const [d2] = await db.insert(researchDocs).values({
    docDate: "2026-08-02", type: "ondemand", title: "문서2", content: "y", filePath: f2,
  }).returning();
  // 파일 경로가 없는 문서도 하나
  await db.insert(researchDocs).values({
    docDate: "2026-08-03", type: "scheduled", title: "문서3", content: "z",
  });

  console.log("=== 1건 삭제 ===");
  const n1 = await deleteResearchDocs([d1.id]);
  check("1건 반환", n1 === 1, String(n1));
  check("DB에서 사라짐", (await db.select().from(researchDocs)).length === 2);
  check("로컬 md도 삭제됨", !(await exists(f1)));
  check("다른 문서 파일은 남음", await exists(f2));

  console.log("\n=== 없는 id·잘못된 id ===");
  check("없는 id는 0건", (await deleteResearchDocs([99999])) === 0);
  check("음수·0·소수는 0건", (await deleteResearchDocs([-1, 0, 1.5])) === 0);
  check("빈 배열은 0건", (await deleteResearchDocs([])) === 0);
  check("문서 수 그대로", (await db.select().from(researchDocs)).length === 2);

  console.log("\n=== 파일이 이미 없어도 DB는 지워진다 ===");
  const [d4] = await db.insert(researchDocs).values({
    docDate: "2026-08-04", type: "scheduled", title: "문서4", content: "w",
    filePath: path.join(dir, "없는파일.md"),
  }).returning();
  check("삭제 성공", (await deleteResearchDocs([d4.id])) === 1);

  console.log("\n=== 전체 삭제 ===");
  const n = await deleteAllResearchDocs();
  check("남은 2건 삭제", n === 2, String(n));
  check("DB 비었음", (await db.select().from(researchDocs)).length === 0);
  check("남은 로컬 md도 삭제됨", !(await exists(f2)));
  check("빈 상태에서 전체삭제는 0건", (await deleteAllResearchDocs()) === 0);

  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
