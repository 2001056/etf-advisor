/**
 * 금액가중수익률(XIRR).
 *
 * 적립식에서는 "돈이 얼마나 오래 일했는지"가 수익률에 반영돼야 한다.
 * (평가손익 + 분배금) ÷ 매입원금 방식은 3년 전 납입과 이번 달 납입을 같은 무게로
 * 나누기 때문에 연환산 수익률을 체계적으로 과소표시한다.
 *
 * Σ CF_k / (1+r)^((d_k − d_0)/365) = 0 을 r에 대해 푼다 (Act/365, 연환산).
 */

export type CashFlow = {
  /** YYYY-MM-DD */
  date: string;
  /** 나가는 돈은 음수(매입·납입), 들어오는 돈은 양수(분배금·평가액) */
  amount: number;
};

const DAY_MS = 24 * 3600 * 1000;

function toMs(d: string): number {
  // 시간대 영향을 없애려고 UTC 자정으로 고정한다
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, (m ?? 1) - 1, day ?? 1);
}

function npv(flows: { t: number; amount: number }[], rate: number): number {
  return flows.reduce((s, f) => s + f.amount / Math.pow(1 + rate, f.t), 0);
}

export type XirrResult = {
  /** 연환산 수익률(소수). 0.1482 = 14.82% */
  rate: number;
  /** 계산에 쓴 현금흐름 수 */
  flowCount: number;
  /** 첫 흐름 ~ 마지막 흐름 일수 */
  days: number;
};

/**
 * XIRR. 계산할 수 없으면 null.
 *
 * 뉴턴법은 부호가 여러 번 바뀌는 벡터에서 발산할 수 있어 이분법을 쓴다 —
 * 느리지만 이 규모(수십~수백 건)에서는 차이가 없고 항상 수렴한다.
 */
export function xirr(flows: CashFlow[]): XirrResult | null {
  if (flows.length < 2) return null;

  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const d0 = toMs(sorted[0].date);
  const norm = sorted.map((f) => ({
    t: (toMs(f.date) - d0) / DAY_MS / 365,
    amount: f.amount,
  }));

  // 부호가 섞여 있지 않으면 해가 없다 (전부 지출이거나 전부 수입)
  const hasNeg = norm.some((f) => f.amount < 0);
  const hasPos = norm.some((f) => f.amount > 0);
  if (!hasNeg || !hasPos) return null;

  const days = Math.round(
    (toMs(sorted[sorted.length - 1].date) - d0) / DAY_MS,
  );
  // 하루짜리 구간은 연환산이 폭주한다
  if (days < 1) return null;

  let lo = -0.9999;
  let hi = 10;
  let fLo = npv(norm, lo);
  let fHi = npv(norm, hi);

  // 구간 안에 부호 변화가 없으면 상한을 넓혀본다
  if (fLo * fHi > 0) {
    hi = 100;
    fHi = npv(norm, hi);
    if (fLo * fHi > 0) return null;
  }

  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(norm, mid);
    if (!Number.isFinite(fMid)) return null;
    if (fLo * fMid <= 0) {
      hi = mid;
      fHi = fMid;
    } else {
      lo = mid;
      fLo = fMid;
    }
    if (hi - lo < 1e-9) break;
  }

  const rate = (lo + hi) / 2;
  if (!Number.isFinite(rate)) return null;
  return { rate, flowCount: sorted.length, days };
}

/**
 * 일가중 평균투자금 대비 수익(ROAI) — Ghostfolio가 쓰는 방식.
 * XIRR이 수렴하지 않을 때의 폴백이자, 기간이 짧을 때 더 안정적이다.
 *
 * ROAI = 총수익 ÷ (Σ 투자원금×보유일수 ÷ 전체일수)
 */
export function roai(
  flows: CashFlow[],
  endDate: string,
  totalReturn: number,
): number | null {
  const invest = flows.filter((f) => f.amount < 0);
  if (!invest.length) return null;

  const end = toMs(endDate);
  const start = Math.min(...invest.map((f) => toMs(f.date)));
  const totalDays = (end - start) / DAY_MS;
  if (totalDays <= 0) return null;

  const weighted = invest.reduce((s, f) => {
    const held = (end - toMs(f.date)) / DAY_MS;
    return s + -f.amount * held;
  }, 0);

  const avgInvested = weighted / totalDays;
  if (avgInvested <= 0) return null;
  return totalReturn / avgInvested;
}
