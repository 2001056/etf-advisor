/** ⑤ 종목 정리 제안 정규화 검증 — pnpm run check:consolidate (DB 불필요) */
import {
  buildInstruction,
  needsReview,
  normalizeSuggestions,
} from "../src/server/consolidate";
import { Category } from "../src/domain/money";
import { GrowthRole } from "../src/domain/recommendation";

let failed = 0;
function check(l: string, ok: boolean, d = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${l}${d ? "  " + d : ""}`);
}
const HOLD = [
  { ticker: "446720", category: "div_growth" as Category },
  { ticker: "251350", category: "div_growth" as Category },
  { ticker: "402970", category: "div_growth" as Category },
  { ticker: "133690", category: "asset_growth" as Category },
];
const s = (o: Record<string, unknown>) => ({
  category: "배당성장", tickers: ["446720", "251350"],
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
const three = normalizeSuggestions({ suggestions: [s({ tickers: ["446720", "251350", "402970"] })] }, HOLD);
check("3개 유지", (three.rows[0].tickers as string[]).length === 3);

console.log("\n=== 남길 종목이 대상에 없으면 null ===");
const badKeep = normalizeSuggestions({ suggestions: [s({ keep_ticker: "402970", tickers: ["446720", "251350"] })] }, HOLD);
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


console.log("\n=== 자산성장 자리 표시: 일부러 나눠 담은 것은 통합 대상이 아니다 ===");
// 금액·수량은 전부 합성 값이다 (실제 보유가 아님).
const seatHoldings = [
  { ticker: "133690", etfName: "공격 합성 ETF", category: "asset_growth" as Category, qty: 10, avgPrice: 21_000, costKrw: 210_000 },
  { ticker: "379800", etfName: "안정 합성 ETF", category: "asset_growth" as Category, qty: 10, avgPrice: 22_000, costKrw: 220_000 },
];
const seatRoles = new Map<string, GrowthRole>([
  ["asset_growth::133690", "aggressive"],
  ["asset_growth::379800", "stable"],
]);
const withSeats = buildInstruction(seatHoldings, seatRoles);
check("공격 자리 표시", withSeats.includes("133690 공격 합성 ETF | 10주 | 평단가 21,000원 | 원금 210,000원 | 자리: 공격적 성장"));
check("안정 자리 표시", withSeats.includes("379800 안정 합성 ETF | 10주 | 평단가 22,000원 | 원금 220,000원 | 자리: 안정적 성장"));
check("자리가 다르면 통합 대상 아님 규칙", withSeats.includes("자리가 서로 다른 두 종목은 통합 대상이 아니다"));

const partialSeats = buildInstruction(
  seatHoldings,
  new Map<string, GrowthRole>([["asset_growth::133690", "aggressive"]]),
);
check("자리를 모르는 매입은 판단 보류로 표시", partialSeats.includes("| 자리: 확인 불가(자리 도입 전 매입 또는 수기 매입)"));
check("  보류 규칙 문구", partialSeats.includes('자리가 "확인 불가"인 종목은 판단을 보류'));

console.log("\n=== 대조군: 자리 정보가 없으면 지시문이 예전과 같다 ===");
const noSeats = buildInstruction(seatHoldings);
check("자리 표시 없음", !noSeats.includes("자리:"));
check("자리 규칙도 없음", !noSeats.includes("통합 대상이 아니다"));
check("보유 줄은 예전 형식", noSeats.includes("133690 공격 합성 ETF | 10주 | 평단가 21,000원 | 원금 210,000원\n"));
check(
  "배당성장 보유에는 자리 표시가 붙지 않는다",
  !buildInstruction(
    [{ ticker: "446720", etfName: "배당 합성 ETF", category: "div_growth" as Category, qty: 5, avgPrice: 14_000, costKrw: 70_000 }],
    seatRoles,
  ).includes("자리:"),
);

console.log("\n=== 검토 대상 판정: 자리가 서로 다른 자산성장 2종목은 매달 부를 이유가 없다 ===");
const seatHeld = [
  { ticker: "133690", category: "asset_growth" as Category },
  { ticker: "379800", category: "asset_growth" as Category },
];
check("자리가 서로 다르면 검토 대상 아님", needsReview(seatHeld, seatRoles) === false);
check(
  "대조군: 같은 자리 2종목이면 검토 대상",
  needsReview(
    seatHeld,
    new Map<string, GrowthRole>([
      ["asset_growth::133690", "aggressive"],
      ["asset_growth::379800", "aggressive"],
    ]),
  ),
);
check(
  "대조군: 한쪽 자리를 모르면 검토 대상",
  needsReview(
    seatHeld,
    new Map<string, GrowthRole>([["asset_growth::133690", "aggressive"]]),
  ),
);
check("대조군: 자리 정보가 아예 없으면 검토 대상", needsReview(seatHeld));
check(
  "대조군: 자리를 두지 않는 카테고리는 2종목이면 늘 검토 대상",
  needsReview(
    [
      { ticker: "446720", category: "div_growth" as Category },
      { ticker: "251350", category: "div_growth" as Category },
    ],
    seatRoles,
  ),
);
check(
  "자산성장 3종목이면 자리가 달라도 검토 대상",
  needsReview(
    [...seatHeld, { ticker: "360750", category: "asset_growth" as Category }],
    seatRoles,
  ),
);
check("1종목뿐이면 검토 대상 아님", needsReview([seatHeld[0]], seatRoles) === false);

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
