import { parseCostFlag } from "./costFlag";
import { DataRow, ParsedDoc } from "./docFormat";

/**
 * 수집한 수치의 산술 자가검증 (리서치 근거: ICAIF'25).
 *
 * 정답 데이터셋 없이도 항등식만으로 기계 검증이 가능하다. 프런티어 모델에
 * 도메인 프롬프트를 다 넣은 파이프라인도 산술 정합성 검사 통과율이 84%였다 —
 * 6건 중 1건은 틀린다는 뜻이라, 검증 없이 원장·추천에 넣으면 안 된다.
 *
 * 실패한 값은 버리지 않고 '미확정'으로 표시해 사람이 판단하게 한다.
 */

export type CheckSeverity = "error" | "warn";

export type DataIssue = {
  ticker: string;
  field: string;
  severity: CheckSeverity;
  message: string;
};

/** 비중 합처럼 반올림·현금 때문에 정확히 100이 안 되는 값에 쓰는 허용오차 */
const PCT_EPSILON = 1.0;

/** 국내 ETF 가격의 상식 범위 — 자릿수 실수(원↔천원)를 잡는다 */
const PRICE_MIN = 100;
const PRICE_MAX = 5_000_000;

/** 분배율 상식 범위. 국내 커버드콜도 20%대가 상한선이다 */
const YIELD_MAX = 40;
/**
 * 괴리율 2단계 — **절댓값** 기준이다(음수 괴리율도 같은 선에서 잡는다).
 * - |괴리율| 5% 초과: 해외 ETF의 LP 호가 관리범위를 넘는다 → 주의
 * - |괴리율| 10% 초과: 투자유의종목 지정예고 요건 → 같은 주의지만 문구를 강화한다
 * 출처: 금융위원회 2026년 8월 안내 https://www.fsc.go.kr/po010106/87512
 */
const PREMIUM_ABS_MAX = 5;
const PREMIUM_ABS_SEVERE = 10;

/**
 * 순자산총액 하한(억원) — **이 도우미의 내부 보수 기준**이다.
 * KRX 관리종목 지정요건은 상장 1년 경과 ETF가 반기말 기준 신탁원본액과 순자산총액을
 * 모두 50억 미만으로 둘 때이고(출처: 한국거래소 안내
 * https://www.krx.co.kr/contents/LST/06/06010500/LST06010500.jsp),
 * 여기서는 순자산 하나만 보므로 지정요건 자체가 아니라 그보다 보수적인 선이다.
 */
const AUM_BN_MIN = 50;

function num(v: number | null): v is number {
  return v !== null && Number.isFinite(v);
}

/** 행 하나에 대한 범위·정합성 검사 */
export function checkRow(r: DataRow): DataIssue[] {
  const out: DataIssue[] = [];
  const add = (field: string, severity: CheckSeverity, message: string) =>
    out.push({ ticker: r.ticker, field, severity, message });

  if (num(r.price)) {
    if (r.price < PRICE_MIN || r.price > PRICE_MAX) {
      add("price", "error", `가격 ${r.price.toLocaleString("ko-KR")}원은 상식 범위를 벗어납니다 (자릿수 확인 필요)`);
    }
    if (!Number.isInteger(r.price)) {
      add("price", "warn", `가격이 정수가 아닙니다: ${r.price}`);
    }
  }

  if (num(r.distYield)) {
    if (r.distYield < 0) add("dist_yield", "error", `분배율이 음수입니다: ${r.distYield}`);
    else if (r.distYield > YIELD_MAX) {
      add("dist_yield", "error", `분배율 ${r.distYield}%는 비현실적입니다 (소수점·단위 확인 필요)`);
    }
  }

  if (num(r.premium) && Math.abs(r.premium) > PREMIUM_ABS_MAX) {
    add(
      "premium",
      "warn",
      Math.abs(r.premium) > PREMIUM_ABS_SEVERE
        ? `괴리율 ${r.premium}%는 절댓값이 ${PREMIUM_ABS_SEVERE}%를 넘어 투자유의종목 지정예고 요건에 해당합니다 — 이 가격으로 사면 NAV와 크게 벌어진 값에 거래합니다`
        : `괴리율 ${r.premium}%는 절댓값이 ${PREMIUM_ABS_MAX}%를 넘어 해외 ETF LP 관리범위를 벗어납니다`,
    );
  }

  // 순자산이 작으면 상품 자체가 없어질 수 있다 — 장기 적립에 치명적이다
  if (num(r.aumBn) && r.aumBn < AUM_BN_MIN) {
    add(
      "aum_bn",
      "warn",
      `순자산총액 ${r.aumBn}억원은 ${AUM_BN_MIN}억 미만입니다 — 순자산 하나만 보는 내부 보수 기준입니다. ` +
        `KRX 관리종목 지정요건은 상장 1년 경과 ETF가 반기말 기준 신탁원본액과 순자산총액 모두 ${AUM_BN_MIN}억 미만일 때이며, ` +
        "다음 반기말까지 해소하지 못하면 상장폐지 대상이 됩니다",
    );
  }

  // 비용 플래그가 없으면 cost_pct가 무엇을 잰 값인지 알 수 없다 — 가장 보수적으로 총보수만으로 읽는다.
  // 실부담비용을 넣고 플래그만 빠뜨린 행도 ③에서 비용 점수가 최하로 깎이므로 사람이 채워야 한다.
  // 플래그가 셋 중 하나로 읽히는지까지 본다 — 읽는 쪽(watch.ts)과 같은 함수를 쓴다
  if (num(r.costPct) && parseCostFlag(r.note) === null) {
    add(
      "cost_pct",
      "warn",
      '비용 기준 표기 누락 — 총보수만으로 취급 (note에 "비용:실부담" / "비용:합성총보수" / "비용:총보수만" 중 하나를 적어야 합니다)',
    );
  }

  // 리서치 핵심: 분배율이 높은데 총수익률이 그에 못 미치고 NAV가 하락 중이면
  // 명목 분배율이 실수령을 과대평가하는 전형적 형태다.
  if (num(r.distYield) && num(r.totalReturn1y) && r.distYield >= 6) {
    if (r.totalReturn1y < 0) {
      add("total_return_1y", "warn",
        `분배율 ${r.distYield}%인데 1년 총수익률이 ${r.totalReturn1y}%입니다 — 분배가 원금을 깎고 있을 수 있습니다`);
    } else if (r.totalReturn1y < r.distYield / 2) {
      add("total_return_1y", "warn",
        `분배율 ${r.distYield}%에 비해 총수익률 ${r.totalReturn1y}%가 크게 낮습니다`);
    }
  }

  if (r.navTrend === "down" && num(r.distYield) && r.distYield >= 6) {
    add("nav_trend", "warn",
      `분배율 ${r.distYield}%인데 NAV가 하락 추세입니다 — 명목 분배율이 실수령을 과대평가합니다`);
  }

  // 산출 기준이 다르면 종목 간 분배율 비교가 성립하지 않는다
  if (num(r.distYield) && r.yieldBasis && r.yieldBasis !== "trailing12m" && r.yieldBasis !== "na") {
    add("yield_basis", "warn",
      `분배율 산출 기준이 ${r.yieldBasis}입니다 — 후행 12개월 기준 종목과 직접 비교하면 안 됩니다`);
  }

  return out;
}

/**
 * 괴리율 항등식: premium ≈ (시장가격 − NAV) / NAV × 100.
 * NAV를 별도로 아는 경우에만 검증할 수 있다(현재 문서 표에는 NAV 열이 없어 선택적).
 */
export function checkPremiumIdentity(
  ticker: string,
  price: number | null,
  nav: number | null,
  reportedPremium: number | null,
): DataIssue | null {
  if (!num(price) || !num(nav) || !num(reportedPremium) || nav <= 0) return null;
  const computed = ((price - nav) / nav) * 100;
  const diff = Math.abs(computed - reportedPremium);
  if (diff <= 0.15) return null;
  return {
    ticker,
    field: "premium",
    severity: "error",
    message: `괴리율이 계산값과 다릅니다: 표시 ${reportedPremium}% vs 계산 ${computed.toFixed(2)}%`,
  };
}

/** 보유 비중 합 = 100% (현금·반올림 때문에 오차를 허용) */
export function checkWeightsSum(
  weights: number[],
  label = "보유 비중",
): DataIssue | null {
  if (!weights.length) return null;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) <= PCT_EPSILON) return null;
  return {
    ticker: "-",
    field: "weights",
    severity: "warn",
    message: `${label} 합이 ${sum.toFixed(2)}%입니다 (100%에서 ${(sum - 100).toFixed(2)}%p 벗어남)`,
  };
}

/** 후행 12개월 분배금 = 월별 분배금 합 */
export function checkDistributionSum(
  ticker: string,
  monthly: number[],
  reportedTrailing: number | null,
): DataIssue | null {
  if (!monthly.length || !num(reportedTrailing)) return null;
  const sum = monthly.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - reportedTrailing) <= 1) return null;
  return {
    ticker,
    field: "dist_12m",
    severity: "error",
    message: `후행 12개월 분배금 ${reportedTrailing}이 월별 합 ${sum}과 다릅니다`,
  };
}

/** 문서 전체 검증 — 조사 문서를 저장하기 직전에 돌린다 */
export function checkDocument(doc: ParsedDoc): DataIssue[] {
  const issues = doc.dataRows.flatMap(checkRow);

  // 같은 종목이 서로 다른 카테고리로 분류되면 추천이 엉킨다
  const byTicker = new Map<string, Set<string>>();
  for (const r of doc.dataRows) {
    if (!r.category) continue;
    const set = byTicker.get(r.ticker) ?? new Set();
    set.add(r.category);
    byTicker.set(r.ticker, set);
  }
  for (const [ticker, cats] of byTicker) {
    if (cats.size > 1) {
      issues.push({
        ticker,
        field: "category",
        severity: "error",
        message: `카테고리가 여러 개입니다: ${[...cats].join(", ")}`,
      });
    }
  }

  return issues;
}

/** 문서 경고 목록에 넣을 사람이 읽는 문장으로 */
export function issuesToProblems(issues: DataIssue[]): string[] {
  return issues.map(
    (i) => `[${i.severity === "error" ? "오류" : "주의"}] ${i.ticker} ${i.field}: ${i.message}`,
  );
}
