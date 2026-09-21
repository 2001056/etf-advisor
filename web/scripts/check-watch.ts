/** ④ 보유 점검 판정 정규화 검증 — pnpm run check:watch (DB 불필요) */
import {
  alertsToNotify,
  buildAlertInstruction,
  buildWatchPrompt,
  FORCED_HOLD_PREFIX,
  normalizeAlerts,
} from "../src/server/watch";
import { Category } from "../src/domain/money";
import { GrowthRole } from "../src/domain/recommendation";

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
  replacement_ticker: "446720", replacement_name: "SOL 미국배당다우존스",
  issue: "분배 재원이 원금 잠식", source_urls: ["https://a", 5, null],
})] }, HOLD);
check("대체 종목 유지", sell.rows[0].replacementTicker === "446720");
check("대체 종목명 유지", sell.rows[0].replacementName === "SOL 미국배당다우존스");
check("URL 중 문자열만", JSON.stringify(sell.rows[0].sourceUrls) === '["https://a"]');

console.log("\n=== sell이 아니면 대체 종목은 버린다 ===");
const noSell = normalizeAlerts({ alerts: [a({ action: "hold", replacement_ticker: "446720", replacement_name: "X" })] }, HOLD);
check("replacement null", noSell.rows[0].replacementTicker === null && noSell.rows[0].replacementName === null);

console.log("\n=== sell인데 대체를 못 찾은 경우 ===");
const sellNoRep = normalizeAlerts({ alerts: [a({ severity: "danger", action: "sell" })] }, HOLD);
check("판정은 살아남음", sellNoRep.rows.length === 1);
check("replacement null 허용", sellNoRep.rows[0].replacementTicker === null);

console.log("\n=== 적립 중단 카테고리 보유는 action=hold 로 고정하고 대체 종목을 비운다 ===");
const SELL = { severity: "danger", action: "sell", issue: "분배 재원이 원금 잠식", replacement_ticker: "446720", replacement_name: "SOL 미국배당다우존스" };
const inactive = normalizeAlerts({ alerts: [a(SELL)] }, HOLD, ["high_div"]);
check("판정은 그대로 살아남는다", inactive.rows.length === 1);
check("severity 는 그대로 danger", inactive.rows[0].severity === "danger");
check("action 은 hold 로 고정", inactive.rows[0].action === "hold");
check("issue 앞에 고정 사유 접두", inactive.rows[0].issue === `${FORCED_HOLD_PREFIX}분배 재원이 원금 잠식`);
check("replacement 비움", inactive.rows[0].replacementTicker === null && inactive.rows[0].replacementName === null);
check("대체 종목 제외 사유 기록", inactive.dropped.some((d) => d.includes("적립 중단 카테고리라 대체 종목 제외")));
check("hold 고정 사유 기록", inactive.dropped.some((d) => d.includes("적립 중단 카테고리라 action=sell → hold 고정: 446720")));
check("stop_buying 도 hold 로 고정",
  normalizeAlerts({ alerts: [a({ severity: "warn", action: "stop_buying" })] }, HOLD, ["high_div"]).rows[0].action === "hold");
check("이미 hold 면 접두를 붙이지 않는다",
  normalizeAlerts({ alerts: [a({ severity: "warn", action: "hold", issue: "지켜보는 중" })] }, HOLD, ["high_div"]).rows[0].issue === "지켜보는 중");
check("  고정 사유도 남기지 않는다",
  normalizeAlerts({ alerts: [a({ severity: "warn", action: "hold" })] }, HOLD, ["high_div"]).dropped.length === 0);

const activeSell = normalizeAlerts({ alerts: [a(SELL)] }, HOLD, ["div_growth", "high_div"]);
check("대조군: 활성 카테고리면 action=sell 그대로", activeSell.rows[0].action === "sell");
check("  대체 종목도 그대로", activeSell.rows[0].replacementTicker === "446720");
check("  issue 에 접두 없음", activeSell.rows[0].issue === "분배 재원이 원금 잠식");
const noActiveList = normalizeAlerts({ alerts: [a(SELL)] }, HOLD);
check("대조군: 활성 목록을 안 주면 예전처럼 그대로",
  noActiveList.rows[0].action === "sell" && noActiveList.rows[0].replacementTicker === "446720");
check("  issue 도 그대로", noActiveList.rows[0].issue === "분배 재원이 원금 잠식");

console.log("\n=== 점검 대상 줄에 자리와 적립 중단 표시 ===");
const HOLD_FULL = [
  { ticker: "379800", etfName: "KODEX 미국S&P500", category: "asset_growth" as Category, qty: 10, avgPrice: 20_000 },
  { ticker: "490600", etfName: "RISE 커버드콜", category: "high_div" as Category, qty: 5, avgPrice: 10_000 },
];
const instruction = buildAlertInstruction(HOLD_FULL, {
  roles: new Map([["asset_growth::379800", "stable" as GrowthRole]]),
  active: ["asset_growth"],
});
check("자리 표시", instruction.includes("379800 KODEX 미국S&P500 | 10주 | 평단가 20,000원 | 안정적 성장 자리"));
check("적립 중단 표시", instruction.includes("490600 RISE 커버드콜 | 5주 | 평단가 10,000원 (적립 중단 카테고리)"));
check("활성 카테고리에는 표시 없음", !instruction.includes("자리 (적립 중단 카테고리)"));
check("적립 중단 보유는 action=hold 규칙이 들어 있다",
  instruction.includes("위험 판정(severity)은 동일하게 하되 action은 hold로 두고"));
check("매도 사유는 issue 에 적으라고 한다", instruction.includes("그 이유를 issue에 적는다(대체 종목 없음)"));
check("자산성장은 같은 자리에서 고른다", instruction.includes("같은 자리**에서 고른다"));
check("대조군: 자리·활성 정보를 안 주면 줄이 예전 그대로",
  buildAlertInstruction(HOLD_FULL).includes("- 고배당 | 490600 RISE 커버드콜 | 5주 | 평단가 10,000원\n"));

console.log("\n=== 확인 불가(severity=unknown)는 조치를 hold 로 고정한다 ===");
const unknownSell = normalizeAlerts({ alerts: [a({
  severity: "unknown", action: "sell", issue: "순자산·분배 재원을 확인하지 못함",
  replacement_ticker: "490600", replacement_name: "RISE 커버드콜",
})] }, HOLD);
check("판정은 살아남는다", unknownSell.rows.length === 1);
check("severity 는 unknown 그대로", unknownSell.rows[0].severity === "unknown");
check("action 은 hold 로 고정", unknownSell.rows[0].action === "hold");
check("replacement 비움",
  unknownSell.rows[0].replacementTicker === null && unknownSell.rows[0].replacementName === null);
check("hold 고정 사유 기록",
  unknownSell.dropped.some((d) => d.includes("확인 불가(severity=unknown)라 action=sell → hold 고정: 446720")));
check("대체 종목 제외 사유 기록",
  unknownSell.dropped.some((d) => d.includes("확인 불가(severity=unknown) 판정이라 대체 종목 제외")));
check("issue 에 적립 중단 접두를 붙이지 않는다",
  unknownSell.rows[0].issue === "순자산·분배 재원을 확인하지 못함");
check("stop_buying 도 hold 로 고정",
  normalizeAlerts({ alerts: [a({ severity: "unknown", action: "stop_buying" })] }, HOLD).rows[0].action === "hold");
check("이미 hold 면 사유를 남기지 않는다",
  normalizeAlerts({ alerts: [a({ severity: "unknown", action: "hold" })] }, HOLD).dropped.length === 0);
check("대조군: danger + sell 은 그대로 매도·대체 유지",
  normalizeAlerts({ alerts: [a(SELL)] }, HOLD).rows[0].action === "sell" &&
  normalizeAlerts({ alerts: [a(SELL)] }, HOLD).rows[0].replacementTicker === "446720");

console.log("\n=== 확인 불가는 맥 알림 대상이 아니다 ===");
const notifyRows = normalizeAlerts({ alerts: [
  a({ severity: "unknown", action: "hold" }),
  a({ ticker: "490600", severity: "danger", action: "hold", issue: "상장폐지 예정" }),
] }, HOLD).rows;
check("두 건 다 저장은 된다", notifyRows.length === 2);
check("알림은 danger 한 건만", alertsToNotify(notifyRows).length === 1);
check("  알릴 종목은 danger 쪽", alertsToNotify(notifyRows)[0].ticker === "490600");
check("대조군: unknown 만 있으면 알림 없음",
  alertsToNotify(normalizeAlerts({ alerts: [a({ severity: "unknown" })] }, HOLD).rows).length === 0);
check("대조군: warn 도 알림 없음",
  alertsToNotify(normalizeAlerts({ alerts: [a({ severity: "warn" })] }, HOLD).rows).length === 0);

console.log("\n=== 판정 규칙에 unknown 등급이 들어 있다 ===");
check("severity 4단계",
  instruction.includes("unknown(판정에 필요한 핵심 자료를 확인하지 못함 — **문제 없음이 아니다**)"));
check("unknown 이면 hold 규칙",
  instruction.includes("**severity=unknown이면 action은 반드시 hold다.**"));
check("자료 부족은 unknown 으로 연결",
  instruction.includes('위험 판정 대신 severity=unknown("확인 불가")으로 남기고 hold로 둬라'));

console.log("\n=== ④ 프롬프트에는 조사 문서 형식 지시문이 붙지 않는다 ===");
const watchPrompt = buildWatchPrompt("(프롬프트 본문)", HOLD_FULL, {
  roles: new Map([["asset_growth::379800", "stable" as GrowthRole]]),
  active: ["asset_growth"],
});
check("'## 1. 요약' 없음", !watchPrompt.includes("## 1. 요약"));
check("'frontmatter' 없음", !watchPrompt.toLowerCase().includes("frontmatter"));
check("  frontmatter 블록(run_id/type) 없음", !/^(run_id|type): /m.test(watchPrompt));
check("'## 4. 데이터 표' 없음", !watchPrompt.includes("## 4. 데이터 표"));
check("'[출력 형식' 없음", !watchPrompt.includes("[출력 형식"));
check("JSON 하나뿐이라고 못박는다",
  watchPrompt.includes("출력은 JSON 하나뿐이며 마크다운 보고서를 쓰지 않는다"));
check("대조군: 본문과 판정 계약은 그대로 들어 있다",
  watchPrompt.startsWith("(프롬프트 본문)\n\n") &&
  watchPrompt.includes("[점검 대상 — 지금 보유 중인 종목 전체]") &&
  watchPrompt.endsWith("반드시 지정된 JSON 스키마로만 응답하라."));

console.log("\n=== 비정상 입력 ===");
check("빈 배열", normalizeAlerts({ alerts: [] }, HOLD).rows.length === 0);
check("null", normalizeAlerts(null, HOLD).rows.length === 0);
check("배열만 와도 처리", normalizeAlerts([a({})], HOLD).rows.length === 1);
check("issue 비면 기본값", normalizeAlerts({ alerts: [a({ issue: "" })] }, HOLD).rows[0].issue === "이상 없음");

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
