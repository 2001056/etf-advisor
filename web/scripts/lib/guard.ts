/**
 * 검증 스크립트 공용 가드 — 테이블을 비우기 전에 main() 첫 줄에서 부른다.
 *
 * 실제로 쓰고 있는 DB를 가리키면 매입 기록·잔액·조사 문서가 통째로 날아가므로,
 * purchases·settings·research_docs 중 한 행이라도 있으면 exit 2로 끊는다.
 * 검증용 DB를 쓰려면 DATABASE_URL을 그 DB로 지정해서 실행할 것.
 *
 * 회귀 테스트: scripts/check-guard.ts (가짜 카운트로 두 경로를 다 밟는다)
 */
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../../src/db";
import { purchases, researchDocs, settings } from "../../src/db/schema";

export const GUARD_EXIT_CODE = 2;

export function guardMessage(script: string): string {
  return [
    "이 DB에는 이미 데이터가 있습니다. 검증 스크립트는 테이블을 비우므로 중단합니다.",
    "",
    "  검증용 DB로 실행:",
    `    DATABASE_URL=postgresql://etf_advisor:…@localhost:5433/etf_advisor_test pnpm exec tsx ${script}`,
    "",
    "  (정말로 이 DB를 비우려면 ALLOW_WIPE=1)",
  ].join("\n");
}

export async function countRealRows(): Promise<number> {
  const [row] = await db
    .select({
      n: sql<number>`(select count(*) from ${purchases})::int + (select count(*) from ${settings})::int + (select count(*) from ${researchDocs})::int`,
    })
    .from(sql`(select 1) as _`);
  return Number(row?.n ?? 0);
}

export async function guardAgainstRealData(
  deps: {
    countRows?: () => Promise<number>;
    allowWipe?: string;
    exit?: (code: number) => void;
    onMessage?: (message: string) => void;
  } = {},
): Promise<void> {
  const rows = await (deps.countRows ?? countRealRows)();
  const allowWipe = "allowWipe" in deps ? deps.allowWipe : process.env.ALLOW_WIPE;
  if (rows <= 0 || allowWipe === "1") return;

  const script = `scripts/${path.basename(process.argv[1] ?? "check-*.ts")}`;
  (deps.onMessage ?? ((m: string) => console.error(m)))(guardMessage(script));
  (deps.exit ?? ((c: number) => process.exit(c)))(GUARD_EXIT_CODE);
}
