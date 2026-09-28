/**
 * 갈아타기·수기 매입 폼 값 검증 (DB 불필요) — pnpm run check:form-parse
 * 서버 액션이 부르는 순수 함수(src/domain/formInput.ts)를 그대로 검사한다.
 * 종목·금액은 전부 합성 값이다.
 */
import { parsePurchaseForm, parseSwitchForm } from "../src/domain/formInput";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(
      `      기대=${JSON.stringify(expected)}\n      실제=${JSON.stringify(actual)}`,
    );
  }
}

function messageOf(fn: () => unknown) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function form(fields: Record<string, string | undefined>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, v);
  return fd;
}

const TODAY = "2026-09-28";

// 배당성장 251350 을 팔아 같은 카테고리 446720 을 사는 정상 폼
const sameCat = {
  sell: "div_growth::251350",
  sellQty: "10",
  sellUnitPrice: "12000",
  buyCategory: "div_growth",
  buyTicker: "446720",
  buyEtfName: "합성 분산 ETF",
  buyQty: "12",
  buyUnitPrice: "10000",
  executedAt: "2026-09-16",
  memo: "",
};
// 매수 카테고리를 자산성장으로 — 화면 경고와 함께 crossConfirm 이 실린다
const crossCat = {
  ...sameCat,
  buyCategory: "asset_growth",
  buyTicker: "133690",
  buyEtfName: "합성 성장 ETF",
  crossConfirm: "div_growth>asset_growth",
};
const switchMsg = (f: Record<string, string | undefined>) =>
  messageOf(() => parseSwitchForm(form(f), TODAY));

console.log("=== 대조군: 정상 갈아타기 폼 ===");
check("같은 카테고리", parseSwitchForm(form(sameCat), TODAY), {
  category: "div_growth",
  buyCategory: "div_growth",
  executedAt: "2026-09-16",
  sell: { ticker: "251350", qty: 10, unitPrice: 12_000 },
  buy: { ticker: "446720", etfName: "합성 분산 ETF", qty: 12, unitPrice: 10_000 },
  memo: null,
  role: null,
});
const crossOk = parseSwitchForm(form(crossCat), TODAY);
check("카테고리 이전 + 확인값 일치", [crossOk.category, crossOk.buyCategory], [
  "div_growth",
  "asset_growth",
]);
check(
  "매수 카테고리 칸이 없는 옛 폼은 매도 카테고리 그대로",
  parseSwitchForm(form({ ...sameCat, buyCategory: undefined }), TODAY).buyCategory,
  "div_growth",
);
check("실행일이 비면 오늘", parseSwitchForm(form({ ...sameCat, executedAt: "" }), TODAY).executedAt, TODAY);

console.log("\n=== 매도 종목 값이 조작되면 폼 오류로 돌려준다 ===");
check("구분자 없음", switchMsg({ ...sameCat, sell: "251350" }), "매도할 보유 종목을 고르세요");
check("종목코드 빈칸", switchMsg({ ...sameCat, sell: "div_growth::" }), "매도할 보유 종목을 고르세요");
check("칸 자체가 없음", switchMsg({ ...sameCat, sell: undefined }), "매도할 보유 종목을 고르세요");
check("없는 카테고리", switchMsg({ ...sameCat, sell: "bogus::251350" }), "알 수 없는 카테고리: bogus");

console.log("\n=== 매수 카테고리 ===");
check(
  "없는 카테고리",
  switchMsg({ ...sameCat, buyCategory: "bond" }),
  "알 수 없는 매수 카테고리: bond",
);

console.log("\n=== 화면 경고(crossConfirm)와 제출값이 어긋나면 거부 ===");
check(
  "다른 카테고리인데 확인값 없음",
  switchMsg({ ...crossCat, crossConfirm: undefined }),
  "매도대금 이전(배당성장 → 자산성장)이 화면에서 확인되지 않았습니다. 화면을 새로 고쳐 다시 실행하세요",
);
check(
  "확인값이 다른 이전을 가리킴",
  switchMsg({ ...crossCat, crossConfirm: "div_growth>high_div" }),
  "매도대금 이전(배당성장 → 자산성장)이 화면에서 확인되지 않았습니다. 화면을 새로 고쳐 다시 실행하세요",
);
check(
  "매도 종목이 화면과 다름(확인값의 매도 카테고리 불일치)",
  switchMsg({ ...crossCat, sell: "high_div::251350" }),
  "매도대금 이전(고배당 → 자산성장)이 화면에서 확인되지 않았습니다. 화면을 새로 고쳐 다시 실행하세요",
);
check(
  "같은 카테고리인데 확인값이 실림",
  switchMsg({ ...sameCat, crossConfirm: "div_growth>asset_growth" }),
  "화면에는 매도대금 이전이 표시됐지만 매수 카테고리가 매도와 같습니다. 화면을 새로 고쳐 다시 실행하세요",
);
check("대조군: 같은 카테고리 + 확인값 없음은 통과", switchMsg(sameCat), null);
check("대조군: 다른 카테고리 + 확인값 일치는 통과", switchMsg(crossCat), null);

console.log("\n=== 자리 ===");
check("없는 자리", switchMsg({ ...crossCat, role: "bogus" }), "알 수 없는 자리: bogus");
check(
  "자산성장이 아닌 매수에 자리",
  switchMsg({ ...sameCat, role: "aggressive" }),
  "자리는 자산성장 매수에만 지정할 수 있습니다",
);
check(
  "대조군: 자산성장 매수에 자리",
  parseSwitchForm(form({ ...crossCat, role: "aggressive" }), TODAY).role,
  "aggressive",
);
check(
  "대조군: 빈칸은 지정 안 함",
  parseSwitchForm(form({ ...crossCat, role: "" }), TODAY).role,
  null,
);

console.log("\n=== 수기 매입 폼 ===");
const buy = {
  boughtAt: "2026-09-16",
  category: "div_growth",
  ticker: " 446720 ",
  etfName: "합성 분산 ETF",
  qty: "3",
  unitPrice: "10,000",
  memo: "",
};
const purchaseMsg = (f: Record<string, string | undefined>) =>
  messageOf(() => parsePurchaseForm(form(f), TODAY));
check("대조군: 정상 폼", parsePurchaseForm(form(buy), TODAY), {
  input: {
    boughtAt: "2026-09-16",
    category: "div_growth",
    ticker: "446720",
    etfName: "합성 분산 ETF",
    qty: 3,
    unitPrice: 10_000,
    memo: null,
    skipLedger: false,
  },
  allowOverBalance: false,
  role: null,
});
check(
  "체크박스",
  (() => {
    const p = parsePurchaseForm(
      form({ ...buy, skipLedger: "on", allowOverBalance: "on" }),
      TODAY,
    );
    return [p.input.skipLedger, p.allowOverBalance];
  })(),
  [true, true],
);
check("없는 카테고리", purchaseMsg({ ...buy, category: "bond" }), "알 수 없는 카테고리: bond");
check(
  "없는 자리",
  purchaseMsg({ ...buy, category: "asset_growth", role: "bogus" }),
  "알 수 없는 자리: bogus",
);
check(
  "자산성장이 아닌 매입에 자리",
  purchaseMsg({ ...buy, role: "stable" }),
  "자리는 자산성장 매수에만 지정할 수 있습니다",
);
check(
  "대조군: 자산성장 매입에 자리",
  parsePurchaseForm(form({ ...buy, category: "asset_growth", role: "stable" }), TODAY).role,
  "stable",
);
check("수량 0 거부", purchaseMsg({ ...buy, qty: "0" }), "수량은(는) 0보다 커야 합니다");

console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
process.exit(failed === 0 ? 0 : 1);
