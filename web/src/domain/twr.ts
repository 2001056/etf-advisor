/**
 * 시간가중수익률(TWR).
 *
 * 현금흐름이 있는 날마다 구간을 끊고, 각 구간의 수익률을 곱해서 잇는다.
 * 납입 시점의 영향을 **의도적으로 제거**하므로 "언제 넣었나"와 무관한
 * 순수 종목 선택 성과를 본다. 적립식 개인 계좌에서는 XIRR이 본인 성과에 가깝고
 * TWR은 보조 지표다 — 둘은 서로 다른 질문에 답한다.
 *
 * 구간 수익률: r_i = (V_end − CF_i) / V_start − 1
 *   V_start = 구간 시작 평가액, CF_i = 구간 중 순유입(+), V_end = 구간 끝 평가액
 * 누적: Π(1 + r_i) − 1
 */

export type Valuation = {
  /** YYYY-MM-DD */
  date: string;
  /** 그 시점 보유 평가액 */
  value: number;
  /** 그 날 발생한 순유입(매수 +, 매도 −). 분배금은 현금으로 빠지면 −로 잡는다 */
  netFlow: number;
};

export type TwrResult = {
  /** 누적 수익률(%) */
  cumulativePct: number;
  /** 연환산 수익률(%). 기간이 짧으면 null */
  annualPct: number | null;
  /** 계산에 쓴 구간 수 */
  periods: number;
  days: number;
  /** 구간별 수익률(%) — 추이 그래프용 */
  series: { date: string; cumulativePct: number }[];
};

const DAY_MS = 24 * 3600 * 1000;
const toMs = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, day ?? 1);
};

/**
 * @param points 날짜순 평가 시점들. 최소 2개 필요.
 *   각 point.value는 **그 날 현금흐름이 반영된 뒤**의 평가액이어야 한다.
 */
export function twr(points: Valuation[]): TwrResult | null {
  const pts = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length < 2) return null;

  let factor = 1;
  let periods = 0;
  const series: { date: string; cumulativePct: number }[] = [
    { date: pts[0].date, cumulativePct: 0 },
  ];

  for (let i = 1; i < pts.length; i++) {
    const start = pts[i - 1].value;
    const end = pts[i].value;
    const flow = pts[i].netFlow;

    // 시작 평가액이 0이면 그 구간은 수익률을 정의할 수 없다 (첫 매수 직전 등)
    if (start <= 0) {
      series.push({ date: pts[i].date, cumulativePct: (factor - 1) * 100 });
      continue;
    }

    const r = (end - flow) / start - 1;
    if (!Number.isFinite(r)) continue;
    factor *= 1 + r;
    periods++;
    series.push({ date: pts[i].date, cumulativePct: (factor - 1) * 100 });
  }

  if (periods === 0) return null;

  const days = (toMs(pts[pts.length - 1].date) - toMs(pts[0].date)) / DAY_MS;
  const cumulative = factor - 1;
  // 30일 미만은 연환산이 폭주해 오해를 부른다
  const annual =
    days >= 30 ? Math.pow(factor, 365 / days) - 1 : null;

  return {
    cumulativePct: cumulative * 100,
    annualPct: annual === null ? null : annual * 100,
    periods,
    days: Math.round(days),
    series,
  };
}
