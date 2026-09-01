import { CATEGORIES, Category } from "./money";

/**
 * 목표 비중 대비 실제 비중 이탈(drift).
 *
 * 계산은 산술적으로 자명하다 — 실제 비중 − 목표 비중.
 * 다만 **"언제 리밸런싱해야 하는가"에 대한 규칙은 넣지 않는다.**
 * 달력 기준·임계값 기준·혼합 중 무엇이 나은지, 신규 매수만으로 맞추는 방식이
 * 실효가 있는지는 조사에서 살아남은 근거가 없었다(관련 주장 전부 기각).
 * 그래서 여기서는 현재 상태만 보여주고 판단은 사람에게 맡긴다.
 */

export type CategoryDrift = {
  category: Category;
  /** 평가액 (현재가 기준) */
  valueKrw: number;
  /** 실제 비중(%) */
  actualPct: number;
  /** 목표 비중(%) */
  targetPct: number;
  /** 이탈(%p) = 실제 − 목표. 양수면 과대, 음수면 과소 */
  driftPp: number;
  /** 목표 비중에 맞추려면 필요한 금액(원). 양수면 더 사야 함 */
  gapKrw: number;
};

export type DriftReport = {
  rows: CategoryDrift[];
  totalValueKrw: number;
  /** 가장 큰 이탈 폭(%p 절대값) */
  maxAbsDriftPp: number;
  /** 평가액이 0이면 비중을 정의할 수 없다 */
  measurable: boolean;
};

/**
 * @param values 카테고리별 평가액 (보유 종목의 현재가 × 수량)
 * @param targets 카테고리별 목표 비중(%) — 설정의 월 충전액에서 유도한다
 */
export function computeDrift(
  values: Record<Category, number>,
  targets: Record<Category, number>,
): DriftReport {
  const total = CATEGORIES.reduce((s, c) => s + (values[c] ?? 0), 0);

  if (total <= 0) {
    return {
      rows: CATEGORIES.map((c) => ({
        category: c,
        valueKrw: 0,
        actualPct: 0,
        targetPct: targets[c] ?? 0,
        driftPp: 0,
        gapKrw: 0,
      })),
      totalValueKrw: 0,
      maxAbsDriftPp: 0,
      measurable: false,
    };
  }

  const rows = CATEGORIES.map((c) => {
    const v = values[c] ?? 0;
    const actualPct = (v / total) * 100;
    const targetPct = targets[c] ?? 0;
    return {
      category: c,
      valueKrw: v,
      actualPct,
      targetPct,
      driftPp: actualPct - targetPct,
      // 목표 비중대로면 얼마여야 하는지와의 차이
      gapKrw: Math.round((targetPct / 100) * total - v),
    };
  });

  return {
    rows,
    totalValueKrw: total,
    maxAbsDriftPp: Math.max(...rows.map((r) => Math.abs(r.driftPp))),
    measurable: true,
  };
}

/** 월 충전액에서 목표 비중(%)을 유도한다 */
export function targetsFromTopup(
  topup: Record<Category, number>,
): Record<Category, number> {
  const sum = CATEGORIES.reduce((s, c) => s + (topup[c] ?? 0), 0);
  if (sum <= 0) {
    return { div_growth: 0, asset_growth: 0, high_div: 0 };
  }
  return Object.fromEntries(
    CATEGORIES.map((c) => [c, ((topup[c] ?? 0) / sum) * 100]),
  ) as Record<Category, number>;
}
