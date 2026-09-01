/** ④ 보유 점검 판정 정규화 검증 — pnpm run check:watch (DB 불필요) */
import { normalizeAlerts } from "../src/server/watch";
import { Category } from "../src/domain/money";

let failed = 0;
function check(l: string, ok: boolean, d = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`);
}
const HOLD = [
  { ticker: "446720", etfName: "SOL 미국배당다우존스", category: "div_growth" as Category },
  { ticker: "490600", etfName: "RISE 커버드콜", category: "high_div" as Category },
];
const a = (o: Record<string, unknown>) => ({
  ticker: "446720", etf_name: "SOL", severity: "info", action: "hold",
  issue: "이상 없음", replacement_ticker: null, replacement_name: null,
  rationale: "근거", source_urls: [], ...o,
});

console.log("=== 정상 판정 ===");
const ok1 = normalizeAlerts({ alerts: [a({}), a({ ticker: "490600", severity: "warn", action: "stop_buying" })] }, HOLD);
check("2건 통과", ok1.rows.length === 2);
check("버려진 것 없음", ok1.dropped.length === 0);
check("종목명은 보유 기록 기준", ok1.rows[0].etfName === "SOL 미국배당다우존스");
check("카테고리도 보유 기준", ok1.rows[1].category === "high_div");

console.log("\n=== 보유하지 않은 종목 판정은 버린다 ===");
const ghost = normalizeAlerts({ alerts: [a({ ticker: "999999" })] }, HOLD);
check("행 0", ghost.rows.length === 0);
check("버린 이유 기록", ghost.dropped.some((d) => d.includes("보유하지 않은")));

console.log("\n=== 중복 판정 ===");
const dup = normalizeAlerts({ alerts: [a({}), a({})] }, HOLD);
check("한 번만", dup.rows.length === 1);
check("중복 기록", dup.dropped.some((d) => d.includes("중복")));

console.log("\n=== 알 수 없는 값 ===");
check("잘못된 severity 버림", normalizeAlerts({ alerts: [a({ severity: "critical" })] }, HOLD).rows.length === 0);
check("잘못된 action 버림", normalizeAlerts({ alerts: [a({ action: "panic" })] }, HOLD).rows.length === 0);

console.log("\n=== 매도 제안 ===");
const sell = normalizeAlerts({ alerts: [a({
  severity: "danger", action: "sell",
  replacement_ticker: "458730", replacement_name: "TIGER 미국배당다우존스",
  issue: "분배 재원이 원금 잠식", source_urls: ["https://a", 5, null],
})] }, HOLD);
check("대체 종목 유지", sell.rows[0].replacementTicker === "458730");
check("대체 종목명 유지", sell.rows[0].replacementName === "TIGER 미국배당다우존스");
check("URL 중 문자열만", JSON.stringify(sell.rows[0].sourceUrls) === '["https://a"]');

console.log("\n=== sell이 아니면 대체 종목은 버린다 ===");
const noSell = normalizeAlerts({ alerts: [a({ action: "hold", replacement_ticker: "458730", replacement_name: "X" })] }, HOLD);
check("replacement null", noSell.rows[0].replacementTicker === null && noSell.rows[0].replacementName === null);

console.log("\n=== sell인데 대체를 못 찾은 경우 ===");
const sellNoRep = normalizeAlerts({ alerts: [a({ severity: "danger", action: "sell" })] }, HOLD);
check("판정은 살아남음", sellNoRep.rows.length === 1);
check("replacement null 허용", sellNoRep.rows[0].replacementTicker === null);

console.log("\n=== 비정상 입력 ===");
check("빈 배열", normalizeAlerts({ alerts: [] }, HOLD).rows.length === 0);
check("null", normalizeAlerts(null, HOLD).rows.length === 0);
check("배열만 와도 처리", normalizeAlerts([a({})], HOLD).rows.length === 1);
check("issue 비면 기본값", normalizeAlerts({ alerts: [a({ issue: "" })] }, HOLD).rows[0].issue === "이상 없음");

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
