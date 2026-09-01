/** ⑤ 종목 정리 제안 정규화 검증 — pnpm run check:consolidate (DB 불필요) */
import { normalizeSuggestions } from "../src/server/consolidate";
import { Category } from "../src/domain/money";

let failed = 0;
function check(l: string, ok: boolean, d = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`);
}
const HOLD = [
  { ticker: "446720", category: "div_growth" as Category },
  { ticker: "458730", category: "div_growth" as Category },
  { ticker: "402970", category: "div_growth" as Category },
  { ticker: "133690", category: "asset_growth" as Category },
];
const s = (o: Record<string, unknown>) => ({
  category: "배당성장", tickers: ["446720", "458730"],
  keep_ticker: "446720", keep_name: "SOL 미국배당다우존스",
  overlap: "같은 지수", cost_note: "실현손익 발생",
  rationale: "근거", source_urls: [], ...o,
});

console.log("=== 정상 제안 ===");
const ok1 = normalizeSuggestions({ suggestions: [s({})] }, HOLD);
check("1건 통과", ok1.rows.length === 1);
check("남길 종목 유지", ok1.rows[0].keepTicker === "446720");
check("대상 2종목", (ok1.rows[0].tickers as string[]).length === 2);

console.log("\n=== 보유하지 않은 종목은 걸러낸다 ===");
const ghost = normalizeSuggestions({ suggestions: [s({ tickers: ["446720", "999999"] })] }, HOLD);
check("1개만 남아 제안 자체가 버려짐", ghost.rows.length === 0);
check("이유 기록", ghost.dropped.some((d) => d.includes("1개뿐")));

console.log("\n=== 카테고리가 다른 종목은 섞이지 않는다 ===");
const mixed = normalizeSuggestions({ suggestions: [s({ tickers: ["446720", "133690"] })] }, HOLD);
check("자산성장 종목 제외됨", mixed.rows.length === 0, JSON.stringify(mixed.dropped));

console.log("\n=== 3종목 통합 ===");
const three = normalizeSuggestions({ suggestions: [s({ tickers: ["446720", "458730", "402970"] })] }, HOLD);
check("3개 유지", (three.rows[0].tickers as string[]).length === 3);

console.log("\n=== 남길 종목이 대상에 없으면 null ===");
const badKeep = normalizeSuggestions({ suggestions: [s({ keep_ticker: "402970", tickers: ["446720", "458730"] })] }, HOLD);
check("keep null", badKeep.rows[0].keepTicker === null);
check("경고 기록", badKeep.dropped.some((d) => d.includes("남길 종목")));

console.log("\n=== 남길 종목을 안 정한 경우도 허용 ===");
const noKeep = normalizeSuggestions({ suggestions: [s({ keep_ticker: null, keep_name: null })] }, HOLD);
check("제안은 살아남음", noKeep.rows.length === 1);
check("keep null", noKeep.rows[0].keepTicker === null);

console.log("\n=== 알 수 없는 카테고리 ===");
check("버림", normalizeSuggestions({ suggestions: [s({ category: "채권" })] }, HOLD).rows.length === 0);

console.log("\n=== 정리할 게 없으면 빈 결과 ===");
check("빈 배열", normalizeSuggestions({ suggestions: [] }, HOLD).rows.length === 0);
check("null", normalizeSuggestions(null, HOLD).rows.length === 0);
check("배열만 와도 처리", normalizeSuggestions([s({})], HOLD).rows.length === 1);

console.log("\n=== 비용 안내는 반드시 남는다 ===");
check("cost_note 보존", normalizeSuggestions({ suggestions: [s({ cost_note: "ISA 비과세 한도 소진" })] }, HOLD).rows[0].costNote.includes("ISA"));

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
