export const CATEGORIES = ["div_growth", "asset_growth", "high_div"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  div_growth: "배당성장",
  asset_growth: "자산성장",
  high_div: "고배당",
};

// 기획서 §2.1 기본값. settings에 저장되며 화면에서 변경 가능.
export const DEFAULT_MONTHLY_TOPUP: Record<Category, number> = {
  div_growth: 350_000,
  asset_growth: 210_000,
  high_div: 140_000,
};

/** KST 기준 YYYY-MM. 서버 타임존과 무관하게 한국 달을 쓴다. */
export function monthKeyKST(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
  }).format(d);
}

/** KST 기준 YYYY-MM-DD. */
export function dateKeyKST(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * KRX 정규장(평일 09:00~15:30, KST) 안인지.
 * 공휴일은 판별하지 않는다 — 휴장일에도 true가 나올 수 있다.
 */
export function isMarketOpenKST(d: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const weekday = get("weekday");
  if (weekday === "Sat" || weekday === "Sun") return false;

  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  if (!Number.isFinite(minutes)) return false;
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

/** "2026-08" → "2026-09" */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12
    ? `${y + 1}-01`
    : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** a < b 이면 음수. 문자열 비교로 충분(고정 폭 YYYY-MM). */
export function compareMonth(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * from(제외) 다음 달부터 to(포함)까지의 달 목록.
 * 충전 누락분 보정(§2.2-3)에 사용.
 */
export function monthsAfter(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = nextMonth(from);
  while (compareMonth(cur, to) <= 0) {
    out.push(cur);
    cur = nextMonth(cur);
    if (out.length > 240) break; // 20년치 안전장치
  }
  return out;
}

export function formatKRW(amount: number): string {
  return `${amount.toLocaleString("ko-KR")}원`;
}
