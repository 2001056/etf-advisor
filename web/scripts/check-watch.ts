/** ④ 보유 점검 판정 정규화 검증 — pnpm run check:watch (DB 불필요) */
import {
  alertsToNotify,
  buildAlertInstruction,
  buildWatchPrompt,
  FORCED_HOLD_PREFIX,
  normalizeAlerts,
  replacementCandidates,
} from "../src/server/watch";
import { Category } from "../src/domain/money";
import { parseResearchDoc } from "../src/domain/docFormat";
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

// ── 대체 종목 출처 제한 (외부 검토 5차) ─────────────────────
// ④가 웹에서 새 종목을 발굴하면 ①의 후보 구성 규칙(해외 주식형·대표 상품·자리)을 거치지 않은
// 종목이 보유로 들어온다. 고를 수 있는 목록을 최신 ① 문서의 데이터 표에서 시스템이 만들어 준다.
console.log("\n=== 최신 ① 문서에서 대체 종목 후보를 뽑는다 ===");
const SCHEDULED = parseResearchDoc(`---
run_id: 1
date: 2026-09-18
type: scheduled
tickers: [111110, 222220, 333330, 444440]
model: x
---

## 1. 요약
요약

## 2. 시장 개관
개관

## 3. 카테고리별 ETF 현황
### 자산성장
내용

## 4. 데이터 표
| ticker | name | category | price | dist_yield | total_return_1y | return_basis | nav_trend | yield_basis | premium | note | aum_bn | cost_pct | turnover_bn | mdd_1y_pct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 111110 | 합성 대표 성장 | 자산성장 | 20000 | 0.8 | 18.1 | 1y | up | trailing12m | 0.05 | 공격 / 비H / 비용:실부담, 대표 | 12000 | 0.09 | 120.5 | -18.2 |
| 222220 | 합성 분산 성장 | 자산성장 | 21000 | 0.7 | 15.2 | since_listing:3 | up | trailing12m | 0.06 | 안정 / H | 8000 | 0.12 | 60.0 | -14.1 |
| 333330 | 합성 자리 미정 | 자산성장 | 19000 | 0.9 | 14.0 | 1y | up | trailing12m | 0.04 | 미정 / H, 운용전략 확인 불가 | 900 | 0.15 | 10.0 | -16.0 |
| 444440 | 합성 고배당 | 고배당 | 9000 | 7.1 | 6.2 | 1y | flat | trailing12m | 0.2 | 커버드콜 | 3000 | 0.35 | 25.0 | -15.1 |

## 5. 이벤트·뉴스
없음

## 6. 리스크 신호
없음

## 7. 출처
- https://example.com
`);
const cands = replacementCandidates(SCHEDULED, ["asset_growth"], 7);
check("활성 카테고리 행만", cands.map((c) => c.ticker).join(",") === "111110,222220,333330");
check("  고배당 행은 빠진다", !cands.some((c) => c.ticker === "444440"));
check("note 첫머리에서 자리를 읽는다",
  cands.map((c) => c.role).join(",") === "aggressive,stable,");
check("  '미정'은 자리 없음(null)", cands[2].role === null);
check("이름도 담는다", cands[0].name === "합성 대표 성장");
check("① 표 수치도 함께 담는다",
  cands[0].aumBn === 12000 && cands[0].costPct === 0.09 &&
  cands[0].turnoverBn === 120.5 && cands[0].totalReturn1y === 18.1 && cands[0].price === 20000);
check('"비용:실부담" 플래그면 실부담비용(total)', cands[0].costBasis === "total");
check("  플래그가 없으면 총보수만으로 취급(ter_only)",
  cands[1].costBasis === "ter_only" && cands[2].costBasis === "ter_only");
check("수익률 기간 기준도 표에서 그대로 담는다",
  cands[0].returnBasis === "1y" && cands[1].returnBasis === "since_listing:3");
check("note 요약은 자리·환헤지·비용 플래그를 뺀 나머지",
  cands[0].noteSummary === "대표" && cands[2].noteSummary === "운용전략 확인 불가");
check("  뺄 것만 있으면 요약은 빈 문자열", cands[1].noteSummary === "");
check("문서 id 를 담는다", cands[0].researchDocId === 7);
check("대조군: 문서가 없으면 빈 목록", replacementCandidates(null, ["asset_growth"]).length === 0);
check("대조군: 고배당만 활성이면 고배당 행만",
  replacementCandidates(SCHEDULED, ["high_div"]).map((c) => c.ticker).join(",") === "444440");

console.log("\n=== 후보 목록이 [점검 대상] 뒤에 블록으로 붙는다 ===");
const withCands = buildAlertInstruction(HOLD_FULL, {
  roles: new Map([["asset_growth::379800", "stable" as GrowthRole]]),
  active: ["asset_growth"],
  candidates: cands,
  candidateDocDate: "2026-09-15",
});
check("머리줄", withCands.includes("[대체 종목 후보 — 이 목록에서만 고른다]"));
check("조사일이 찍힌다", withCands.includes("그 문서의 조사일은 2026-09-15이다"));
check("조사일을 기준일로 대체하지 말라는 문장", withCands.includes("'기준일 미전달'로 적고 조사일로 대체하지 마라"));
check("대조군: 조사일을 기준일로 부르는 문장이 없다", !withCands.includes("기준일은 그 조사일"));
check("후보 수치 인용은 research_doc_id·조사일로 하라는 문장",
  withCands.includes("URL 대신 research_doc_id와 조사일을 적고, 기준일 칸은 '기준일 미전달'로 둬라"));
check("buildWatchPrompt 도 조사일을 그대로 넘긴다",
  buildWatchPrompt("본문", HOLD_FULL, { candidates: cands, candidateDocDate: "2026-09-15" }).includes("그 문서의 조사일은 2026-09-15이다"));
check("대조군: 조사일을 안 주면 미상으로 찍힌다",
  buildAlertInstruction(HOLD_FULL, { candidates: cands }).includes("조사일은 미상이다"));
check("자리 표시", withCands.includes("- 자산성장 | 공격적 성장 자리 | 111110 합성 대표 성장"));
check("  자리 미정도 표시", withCands.includes("- 자산성장 | 자리 미정 | 333330 합성 자리 미정"));
check("① 표 수치가 줄에 실린다",
  withCands.includes("- 자산성장 | 공격적 성장 자리 | 111110 합성 대표 성장 | 순자산 12,000억 | 비용 0.09% | 거래대금 120.5억 | 총수익 18.1%(1년) | 가격 20,000원 | 비고 대표 | 출처는 ① 문서 research_doc_id 7"));
check("상장 12개월 미만이면 기간이 그렇게 찍힌다",
  withCands.includes("222220 합성 분산 성장 | 순자산 8,000억 | 비용 0.12%(총보수만) | 거래대금 60억 | 총수익 15.2%(상장 3개월) | 가격 21,000원 | 출처는 ① 문서 research_doc_id 7"));
check("  뺄 것만 있던 note 는 비고 칸이 아예 없다",
  !withCands.split("\n").find((l) => l.includes("222220"))?.includes("비고"));
check("기간이 다른 수익률로 우열을 매기지 말라는 문장",
  withCands.includes("기간이 다른 수익률로 우열을 매기지 마라"));
check("대조군: 문서 id 를 안 주면 줄 끝 출처 표기가 없다(머리말의 인용 규칙 문장은 남는다)",
  !buildAlertInstruction(HOLD_FULL, {
    candidates: replacementCandidates(SCHEDULED, ["asset_growth"]),
  }).includes("출처는 ① 문서 research_doc_id"));
check("대조군: 실부담비용이면 비용 뒤에 기준 표기가 없다", !withCands.includes("비용 0.09%("));
check("이 수치로 비교하라는 문장", withCands.includes("대체 종목 비교는 이 수치로 하고, 웹 검색은 최신 공시 확인에만 쓴다"));
check("블록 어디에도 undefined 가 없다", !withCands.includes("undefined"));
check("목록 밖 금지 문구", withCands.includes("웹 검색으로 새 종목을 발굴하지 마라"));
check("후보가 없으면 그렇게 적는다",
  buildAlertInstruction(HOLD_FULL, { candidates: [] })
    .includes("(후보 없음 — 대체 종목을 제시하지 말고 replacement는 비워 둔다)"));
const sameOpts = {
  roles: new Map([["asset_growth::379800", "stable" as GrowthRole]]),
  active: ["asset_growth"] as Category[],
};
check("대조군: candidates 를 안 주면 블록이 붙지 않는다",
  !buildAlertInstruction(HOLD_FULL, sameOpts).includes("[대체 종목 후보"));
check("대조군: 안 주면 조립 결과가 후보 블록만 뺀 것과 같다",
  buildAlertInstruction(HOLD_FULL, sameOpts) ===
    withCands.replace(/\n\[대체 종목 후보[\s\S]*?발굴하지 마라\.\n/, "\n"));

// note 첫머리에 "비용:총보수만"이 먼저 오는 문서(외부 검토 6차의 cost_pct 폴백)에서도
// 자리를 읽어야 한다. 못 읽으면 "자리 미정"이지 undefined 가 아니다.
console.log("\n=== note 앞에 다른 표기가 와도 자리를 읽는다 ===");
const docOf = (rows: string, header: string) => parseResearchDoc(`---
run_id: 2
date: 2026-09-20
type: scheduled
tickers: []
model: x
---

## 1. 요약
요약

## 2. 시장 개관
개관

## 3. 카테고리별 ETF 현황
### 자산성장
내용

## 4. 데이터 표
${header}
${rows}

## 5. 이벤트·뉴스
없음

## 6. 리스크 신호
없음

## 7. 출처
- https://example.com
`);
// return_basis 가 없던 14열 문서. 수치는 그대로 읽되 총수익 칸의 기간은 "기간 미상"이 된다.
const H14 = `| ticker | name | category | price | dist_yield | total_return_1y | nav_trend | yield_basis | premium | note | aum_bn | cost_pct | turnover_bn | mdd_1y_pct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`;
const costOnly = replacementCandidates(
  docOf("| 555550 | 합성 총보수만 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 비용:총보수만(0.09) / 공격 / 비H | 5000 | 0.09 | 40.0 | -13.0 |", H14),
  ["asset_growth"],
);
check("앞에 '비용:총보수만'이 와도 공격 자리로 읽는다", costOnly[0].role === "aggressive");
check("  블록에도 자리로 찍힌다",
  buildAlertInstruction(HOLD_FULL, { candidates: costOnly })
    .includes("- 자산성장 | 공격적 성장 자리 | 555550 합성 총보수만 | 순자산 5,000억 | 비용 0.09%(총보수만) | 거래대금 40억 | 총수익 12%(기간 미상) | 가격 18,000원"));
check("  return_basis 가 없는 14열 문서는 기간 미상", costOnly[0].returnBasis === "");

// 비용 플래그 세 갈래 (외부 검토 7차 → 8차). 총보수만·합성총보수·실부담비용은 서로 거리가 달라
// 같은 기준끼리만 비교해야 한다 — 후보 줄에 무엇을 잰 값인지 함께 찍는다.
// 8차: 플래그가 아예 없는 행은 실부담비용이 아니라 총보수만으로 읽는다(누락 = 최하 등급).
console.log("\n=== 비용 기준을 후보 줄에 표기한다 ===");
const basisDoc = docOf(
  [
    "| 555550 | 합성 총보수만 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 공격 / 비H / 비용:총보수만 | 5000 | 0.0062 | 40.0 | -13.0 |",
    "| 555551 | 합성 합성총보수 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 안정 / H / 비용:합성총보수 | 5000 | 0.0888 | 40.0 | -13.0 |",
    "| 555552 | 합성 실부담 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 미정 / H / 비용:실부담, 2026-09-21 확인 | 5000 | 0.23 | 40.0 | -13.0 |",
    "| 555553 | 합성 무표기 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 미정 / H, 2026-09-21 확인 | 5000 | 0.5 | 40.0 | -13.0 |",
  ].join("\n"),
  H14,
);
const basis = replacementCandidates(basisDoc, ["asset_growth"]);
check("총보수만 → ter_only", basis[0].costBasis === "ter_only");
check("합성총보수 → synthetic", basis[1].costBasis === "synthetic");
check('대조군: "비용:실부담" 플래그면 total', basis[2].costBasis === "total");
check("플래그가 아예 없으면 ter_only — 누락을 실부담으로 봐주지 않는다",
  basis[3].costBasis === "ter_only");
check("  자리·환헤지 뒤에 와도 플래그를 읽는다", basis[0].role === "aggressive" && basis[1].role === "stable");
const basisBlock = buildAlertInstruction(HOLD_FULL, { candidates: basis });
check("줄에 (총보수만) 표기", basisBlock.includes("555550 합성 총보수만 | 순자산 5,000억 | 비용 0.0062%(총보수만) |"));
check("  소수 4자리가 잘리지 않는다", !basisBlock.includes("0.006%"));
check("줄에 (합성총보수) 표기", basisBlock.includes("555551 합성 합성총보수 | 순자산 5,000억 | 비용 0.0888%(합성총보수) |"));
check("대조군: 실부담비용은 표기 없이 비용만", basisBlock.includes("555552 합성 실부담 | 순자산 5,000억 | 비용 0.23% | 거래대금"));
check("  실부담 줄에 괄호 표기 없음", !basisBlock.includes("비용 0.23%("));
check("플래그 누락 줄은 (총보수만) 으로 찍힌다",
  basisBlock.includes("555553 합성 무표기 | 순자산 5,000억 | 비용 0.5%(총보수만) |"));

// 외부 검토 9차: 표기 변형. 공백 위치가 다르거나 뒤에 설명이 붙어도 같은 기준으로 읽어야 한다.
// 읽는 규칙은 src/domain/costFlag.ts parseCostFlag 하나뿐이고 dataChecks 도 같은 함수를 쓴다.
console.log("\n=== 비용 플래그 표기 변형 ===");
const variant = replacementCandidates(
  docOf(
    [
      "| 555560 | 콜론 뒤 공백 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 공격 / 비H / 비용: 실부담 | 5000 | 0.1 | 40.0 | -13.0 |",
      "| 555561 | 콜론 앞뒤 공백 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 공격 / 비H / 비용 : 실부담 | 5000 | 0.1 | 40.0 | -13.0 |",
      "| 555562 | 뒤에 설명 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 공격 / 비H / 비용:실부담비용 | 5000 | 0.1 | 40.0 | -13.0 |",
      "| 555563 | 합성 공백 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 안정 / H / 비용 : 합성총보수 | 5000 | 0.1 | 40.0 | -13.0 |",
      "| 555564 | 총보수만 공백 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 안정 / H / 비용 : 총보수만 | 5000 | 0.1 | 40.0 | -13.0 |",
      "| 555565 | 총보수만 부연 | 자산성장 | 18000 | 0.5 | 12.0 | up | trailing12m | 0.03 | 안정 / H / 비용:총보수만(실부담 미확인) | 5000 | 0.1 | 40.0 | -13.0 |",
    ].join("\n"),
    H14,
  ),
  ["asset_growth"],
);
check('"비용: 실부담" → total', variant[0].costBasis === "total");
check('"비용 : 실부담" → total', variant[1].costBasis === "total");
check('"비용:실부담비용" → total', variant[2].costBasis === "total");
check('"비용 : 합성총보수" → synthetic', variant[3].costBasis === "synthetic");
check('대조군: "비용 : 총보수만" → ter_only', variant[4].costBasis === "ter_only");
// 접두 일치라야 한다 — 부분 포함으로 읽으면 이 줄이 실부담(가장 싼 등급)으로 올라간다
check('"비용:총보수만(실부담 미확인)" → ter_only', variant[5].costBasis === "ter_only");

// 지금 DB의 최신 ① 문서가 이 모양이다(구 10컬럼). 수치가 전부 없어도 NA 로 찍혀야 한다.
console.log("\n=== 구 형식(10컬럼) ① 문서면 수치는 NA, 자리는 미정 ===");
const H10 = `| ticker | name | category | price | dist_yield | total_return_1y | nav_trend | yield_basis | premium | note |
|---|---|---|---|---|---|---|---|---|---|`;
const legacy = replacementCandidates(
  docOf("| 666660 | 합성 구형식 | 자산성장 | 17000 | 0.4 | 11.0 | up | trailing12m | 0.02 | 2026-09-18; TTM 직접계산 |", H10),
  ["asset_growth"],
);
check("자리를 못 읽으면 null", legacy[0].role === null);
check("수치는 null", legacy[0].aumBn === null && legacy[0].costPct === null && legacy[0].turnoverBn === null);
check("cost_pct 가 없으면 비용 기준도 null", legacy[0].costBasis === null);
const legacyBlock = buildAlertInstruction(HOLD_FULL, { candidates: legacy });
check("블록에는 NA 로 찍힌다",
  legacyBlock.includes("- 자산성장 | 자리 미정 | 666660 합성 구형식 | 순자산 NA | 비용 NA | 거래대금 NA | 총수익 11%(기간 미상) | 가격 17,000원 | 비고 2026-09-18, TTM 직접계산"));
check("undefined 는 없다", !legacyBlock.includes("undefined"));

// 15열 문서: 기간과 3년 연환산이 후보 줄에 따로 찍힌다. 3년 연환산은 표 컬럼이 없어 note 표기로만 온다.
console.log("\n=== 총수익 기간·3년 연환산 표기 ===");
const H15 = `| ticker | name | category | price | dist_yield | total_return_1y | return_basis | nav_trend | yield_basis | premium | note | aum_bn | cost_pct | turnover_bn | mdd_1y_pct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`;
const basisRows = replacementCandidates(
  docOf(
    [
      "| 777770 | 합성 1년 | 자산성장 | 18000 | 0.5 | 12.0 | 1y | up | trailing12m | 0.03 | 공격 / 비H / 비용:실부담, 3y_ann:14.2%, 대표 | 5000 | 0.1 | 40.0 | -13.0 |",
      "| 777771 | 합성 신규상장 | 자산성장 | 18000 | 0.5 | 4.0 | since_listing:3 | up | trailing12m | 0.03 | 안정 / H / 비용:실부담, 2026-06-30 상장 | 5000 | 0.1 | 40.0 | -13.0 |",
      "| 777772 | 합성 수익률 미확인 | 자산성장 | 18000 | 0.5 | NA | NA | up | trailing12m | 0.03 | 미정 / H / 비용:실부담, 상장 이후 실적 확인 불가 | 5000 | 0.1 | 40.0 | -13.0 |",
    ].join("\n"),
    H15,
  ),
  ["asset_growth"],
  12,
);
check("3y_ann 표기를 읽는다", basisRows[0].ann3y === "14.2%");
check("  대조군: 표기가 없으면 null", basisRows[1].ann3y === null);
const basisLines = buildAlertInstruction(HOLD_FULL, { candidates: basisRows });
check("1년이면 (1년)",
  basisLines.includes("총수익 12%(1년) | 3년연환산 14.2% | 가격 18,000원 | 비고 3y_ann:14.2%, 대표 | 출처는 ① 문서 research_doc_id 12"));
check("상장 3개월이면 (상장 3개월)",
  basisLines.includes("총수익 4%(상장 3개월) | 가격 18,000원 | 비고 2026-06-30 상장"));
check("  3년 연환산이 없으면 그 칸이 아예 없다",
  !(basisLines.split("\n").find((l) => l.includes("777771")) ?? "").includes("3년연환산"));
check("둘 다 NA 면 총수익 NA",
  basisLines.includes("777772 합성 수익률 미확인 | 순자산 5,000억 | 비용 0.1% | 거래대금 40억 | 총수익 NA | 가격 18,000원"));

console.log("\n=== 목록 밖 대체 종목은 지운다 ===");
const HOLD_ASSET = [
  { ticker: "379800", etfName: "합성 보유 성장", category: "asset_growth" as Category },
];
const sellOff = normalizeAlerts({ alerts: [a({
  ticker: "379800", severity: "danger", action: "sell", issue: "기초지수 변경",
  replacement_ticker: "888880", replacement_name: "웹에서 새로 찾은 ETF",
})] }, HOLD_ASSET, ["asset_growth"], cands);
check("판정은 살아남는다", sellOff.rows.length === 1);
check("action 은 sell 그대로", sellOff.rows[0].action === "sell");
check("replacement 비움",
  sellOff.rows[0].replacementTicker === null && sellOff.rows[0].replacementName === null);
check("사유 기록",
  sellOff.dropped.some((d) => d.includes("대체 종목 후보 목록에 없어 제외: 379800 → 888880")));

const sellOn = normalizeAlerts({ alerts: [a({
  ticker: "379800", severity: "danger", action: "sell", issue: "기초지수 변경",
  replacement_ticker: "111110", replacement_name: "합성 대표 성장",
})] }, HOLD_ASSET, ["asset_growth"], cands);
check("대조군: 목록 안이면 그대로 유지", sellOn.rows[0].replacementTicker === "111110");
check("  이름도 유지", sellOn.rows[0].replacementName === "합성 대표 성장");
check("  사유 없음", sellOn.dropped.length === 0);
check("대조군: candidates 를 안 주면 예전처럼 목록 밖도 통과",
  normalizeAlerts({ alerts: [a({
    ticker: "379800", severity: "danger", action: "sell", issue: "기초지수 변경",
    replacement_ticker: "888880", replacement_name: "웹에서 새로 찾은 ETF",
  })] }, HOLD_ASSET, ["asset_growth"]).rows[0].replacementTicker === "888880");

console.log("\n=== 비정상 입력 ===");
check("빈 배열", normalizeAlerts({ alerts: [] }, HOLD).rows.length === 0);
check("null", normalizeAlerts(null, HOLD).rows.length === 0);
check("배열만 와도 처리", normalizeAlerts([a({})], HOLD).rows.length === 1);
check("issue 비면 기본값", normalizeAlerts({ alerts: [a({ issue: "" })] }, HOLD).rows[0].issue === "이상 없음");

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
