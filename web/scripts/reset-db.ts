import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { ledger, purchases, purchaseCycles, settings, agentRuns, researchDocs, recommendations, prompts } from "../src/db/schema";
async function main() {
  await db.execute(sql`truncate ${ledger}, ${purchases}, ${purchaseCycles}, ${settings}, ${recommendations}, ${researchDocs}, ${agentRuns}, ${prompts} restart identity cascade`);
  console.log("검증 데이터 삭제 완료 — 최초 설정 화면부터 다시 시작합니다");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
