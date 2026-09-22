import { CATEGORIES, CATEGORY_LABEL, Category } from "./money";
import { DataRow, ParsedDoc, isNoValueMark, tickersOf } from "./docFormat";

/**
 * ③ 추천 에이전트의 JSON 출력을 DB 행으로 바꾸는 순수 로직.
 * 모델 출력은 스키마를 줘도 보장이 아니므로 여기서 전부 다시 검증한다.
 */

export const CATEGORY_FROM_KO: Record<string, Category> = {
  배당성장: "div_growth",
  자산성장: "asset_growth",
  고배당: "high_div",
};

/**
 * 자산성장 안의 두 자리. 한 종목에 몰아넣지 않고 성격이 다른 둘로 나눠 담는다.
 * 비중은 모델이 아니라 설정(settings.growth_roles)이 정한다.
 */
export const GROWTH_ROLES = ["aggressive", "stable"] as const;
export type GrowthRole = (typeof GROWTH_ROLES)[number];

/** 자리를 두는 카테고리는 자산성장 하나뿐 — 배당성장·고배당은 예전처럼 1종목이다 */
export const ROLE_CATEGORY: Category = "asset_growth";

export const GROWTH_ROLE_LABEL: Record<GrowthRole, string> = {
  aggressive: "공격적 성장",
  stable: "안정적 성장",
};

export const GROWTH_ROLE_HINT: Record<GrowthRole, string> = {
  aggressive: "변동이 크더라도 장기 기대 수익이 높은 성장 지수",
  stable: "여러 업종에 분산하여 특정 업종·종목 의존도를 낮추는 주식 지수",
};

export const DEFAULT_GROWTH_ROLE_WEIGHTS: Record<GrowthRole, number> = {
  aggressive: 0.5,
  stable: 0.5,
};

export function toGrowthRole(v: unknown): GrowthRole | null {
  const s = String(v ?? "").trim();
  return (GROWTH_ROLES as readonly string[]).includes(s)
    ? (s as GrowthRole)
    : null;
}

/**
 * 설정에 저장된 자리 비중을 읽을 수 있는 값으로 만든다.
 * 한 자리라도 0 이하·1 이상이거나 합이 1에서 벗어나면 기본 50:50으로 되돌린다 —
 * 깨진 설정 하나가 배정액을 잔액 밖으로 밀어내면 안 된다.
 */
export function normalizeRoleWeights(raw: unknown): Record<GrowthRole, number> {
  const v = (raw ?? {}) as Record<string, unknown>;
  const nums = GROWTH_ROLES.map((r) => Number(v[r]));
  if (!nums.every((n) => Number.isFinite(n) && n > 0 && n < 1)) {
    return { ...DEFAULT_GROWTH_ROLE_WEIGHTS };
  }
  const sum = nums.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.02) return { ...DEFAULT_GROWTH_ROLE_WEIGHTS };
  return Object.fromEntries(
    GROWTH_ROLES.map((r, i) => [r, nums[i] / sum]),
  ) as Record<GrowthRole, number>;
}

/** 활성 = 설정 화면의 월 충전액 > 0. 잔액은 보지 않는다 — 갈아타기 차액·분배금 같은 잔돈이 비활성 카테고리를 되살리면 안 된다 */
export function activeCategories(topup: Record<Category, number>): Category[] {
  const active = CATEGORIES.filter((c) => (topup[c] ?? 0) > 0);
  return active.length ? active : [...CATEGORIES];
}

export function activeCategoriesLine(active: Category[]): string {
  return `[이번 회차 활성 카테고리: ${active.map((c) => CATEGORY_LABEL[c]).join("·")}]`;
}

export function researchTickers(
  docs: ParsedDoc[],
  held: { category: Category; ticker: string }[],
  active: Category[],
): string[] {
  const all = CATEGORIES.every((c) => active.includes(c));
  const fromDocs = docs.flatMap((d) =>
    all
      ? tickersOf(d)
      : d.dataRows
          .filter((r) => active.includes(CATEGORY_FROM_KO[r.category.trim()]))
          .map((r) => r.ticker),
  );
  const fromHeld = held
    .filter((h) => all || active.includes(h.category))
    .map((h) => h.ticker);
  return [...new Set([...fromDocs, ...fromHeld])].filter(Boolean);
}

export const INACTIVE_HOLDING_MARK = "(이번 회차 매수 대상 아님)";
export const INACTIVE_BUDGET_MARK = "(이번 회차 매수 안 함)";

export function budgetLine(
  category: Category,
  balance: number,
  active: Category[],
): string {
  return (
    `- ${CATEGORY_LABEL[category]}: ${balance.toLocaleString("ko-KR")}원` +
    (active.includes(category) ? "" : ` ${INACTIVE_BUDGET_MARK}`)
  );
}

/**
 * 자리 몫 = floor(잔액 × 비중). 두 몫의 합은 잔액을 넘지 않는다.
 * 0.7 × 700,000이 489,999.99…로 나오는 부동소수 오차만 걷어낸다.
 */
export function seatBudget(balance: number, weight: number): number {
  const exact = balance * weight;
  const rounded = Math.round(exact);
  return Math.abs(exact - rounded) < 1e-6 ? rounded : Math.floor(exact);
}

/** 자리 비중을 % 문자열로 — 프롬프트 줄과 화면 뱃지가 같은 식을 쓴다 (0.505 → "50.5", 0.5 → "50") */
export function pct(w: number): string {
  const v = Math.round(w * 1000) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 자산성장 잔액 줄 아래에 붙는 자리별 배정액 — 정규화와 같은 식을 쓴다 */
export function roleBudgetLine(
  balance: number,
  weights: Record<GrowthRole, number> = DEFAULT_GROWTH_ROLE_WEIGHTS,
): string {
  return (
    "  · " +
    GROWTH_ROLES.map(
      (r) =>
        `${GROWTH_ROLE_LABEL[r]} 자리 ${pct(weights[r])}%: ${seatBudget(balance, weights[r]).toLocaleString("ko-KR")}원`,
    ).join(" / ")
  );
}

export function holdingLine(
  h: {
    category: Category;
    ticker: string;
    etfName: string;
    qty: number;
    avgPrice: number;
  },
  active: Category[],
): string {
  return (
    `- ${CATEGORY_LABEL[h.category]} | ${h.ticker} ${h.etfName} | ${h.qty}주 | 평단가 ${h.avgPrice.toLocaleString("ko-KR")}원` +
    (active.includes(h.category) ? "" : ` ${INACTIVE_HOLDING_MARK}`)
  );
}

/** 정규화에 넘길 잔액 — 비활성 카테고리에 잔돈이 있어도 0으로 둬 매수가 성립하지 않게 한다 */
export function activeBalances(
  balances: Record<Category, number>,
  active: Category[],
): Record<Category, number> {
  return Object.fromEntries(
    CATEGORIES.map((c) => [c, active.includes(c) ? balances[c] : 0]),
  ) as Record<Category, number>;
}

function hhmmKST(d: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/**
 * ③ 프롬프트에 ② 문서보다 먼저 넣는 실시간 시세 블록.
 * ② 문서의 price는 조사 시점 스냅샷이라 1주 매수 가능 여부가 어긋난다.
 */
export function realtimePriceBlock(
  tickers: string[],
  quotes: Map<string, RealtimeQuote>,
  now: Date = new Date(),
): string {
  const at = [...quotes.values()].reduce<Date | null>(
    (latest, q) => (latest === null || q.pricedAt > latest ? q.pricedAt : latest),
    null,
  );
  const lines = tickers.map((t) => {
    const q = quotes.get(t);
    return q
      ? `- ${t}: ${q.price.toLocaleString("ko-KR")}원 (${hhmmKST(q.pricedAt)})`
      : `- ${t}: 실시간가 없음`;
  });
  const got = tickers.map((t) => quotes.get(t)).filter((q) => q !== undefined);
  // 하나라도 장중이 아니면 종가를 섞어 보는 셈이라 장중이라고 말하지 않는다
  const marketLabel =
    got.length === 0
      ? "장 상태 확인 불가"
      : got.every((q) => q.marketStatus === "OPEN")
        ? "장중"
        : "장 마감 후 종가";
  return [
    `[실시간 시세 — ${hhmmKST(at ?? now)} KST 기준, ${marketLabel}, 매수 가능 여부와 ref_qty는 이 값으로 판단]`,
    ...(lines.length ? lines : ["- (조회 대상 종목 없음)"]),
  ].join("\n");
}

/**
 * ③ 핵심 자료 게이트가 보는 ② 표의 열. 프롬프트의 "핵심 항목 4개"와 짝이 맞아야 한다.
 * `mdd_1y_pct`(하락 위험)와 추적오차는 여기 없다 — 확인 못 해도 매수를 막지 않고 경고만 남긴다.
 */
export const CORE_EVIDENCE_FIELDS = [
  ["costPct", "실부담비용"],
  ["aumBn", "순자산총액"],
  ["turnoverBn", "거래대금"],
  ["totalReturn1y", "1년 총수익률"],
] as const;

/**
 * 장기 총수익 항목은 숫자 하나로 확인된 것이 아니다 — 그 숫자가 어느 기간을 잰 값인지
 * (`return_basis`: 1y / since_listing:N)까지 있어야 다른 후보와 비교할 수 있다.
 * 열이 없던 옛 문서는 빈 문자열이라 여기서 걸린다(이미 다른 열로도 걸린다).
 */
export const RETURN_BASIS_LABEL = "수익률 기간 기준";

/**
 * 순수 매수 pick 하나를 ② 문서의 그 종목 행과 대조한다.
 * 핵심 4항목 중 하나라도 비어 있으면 건너뜀 사유 문자열을, 통과하면 null을 준다.
 *
 * 전에는 "핵심 4항목이 확인되지 않은 후보는 고르지 마라"가 ③ 프롬프트 문구뿐이라
 * 모델이 어기면 그대로 통과했다. 표에 열을 만들고 여기서 기계로 막는다.
 */
export function gateCoreEvidence(
  pick: { ticker: string | null; skipped: boolean },
  row: DataRow | null | undefined,
): string | null {
  if (pick.skipped || !pick.ticker) return null;
  if (!row) return `핵심 자료 미확인(②): ② 문서 데이터 표에 ${pick.ticker} 행이 없음`;

  const missing: string[] = CORE_EVIDENCE_FIELDS.filter(
    ([field]) => !num(row[field]),
  ).map(([, label]) => label);
  // 기간 기준이 없으면 total_return_1y 숫자가 무엇을 잰 값인지 알 수 없다
  if (isNoValueMark(row.returnBasis)) missing.push(RETURN_BASIS_LABEL);
  if (!missing.length) return null;

  // 그 열 자체가 없던 문서와, 열은 있는데 모델이 NA로 둔 문서를 사유에서 구분한다
  const legacy = row.hasEvidenceColumns ? "" : " (구 형식 문서 — 핵심 증거 열이 없음)";
  return `핵심 자료 미확인(②): ${missing.join("·")}${legacy}`;
}

function num(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

/**
 * ④가 신규 매수를 막은 티커를 ③ 프롬프트에 알리는 블록.
 * 미해결(resolved_at null) 경고 중 action이 stop_buying·sell인 것만 온다.
 */
export function stopBuyingBlock(
  alerts: { ticker: string; action: string; issue: string }[],
): string {
  const blocked = alerts.filter(
    (a) => a.action === "stop_buying" || a.action === "sell",
  );
  if (!blocked.length) return "";
  const items = blocked
    .map(
      (a) =>
        `${a.ticker}(${a.action === "sell" ? "매도 권고" : "신규 매수 중단"} — ${a.issue.trim() || "사유 없음"})`,
    )
    .join(", ");
  return [
    `[보유 점검 경고 — 신규 매수 제외: ${items}]`,
    "위 티커는 ④ 보유 점검이 아직 해소되지 않은 경고를 남긴 종목이다. 이번 회차 신규 매수 후보로 고르지 마라.",
  ].join("\n");
}

/** ③ 정규화에 넘길 "신규 매수 금지" 목록 — 티커 → 사유 */
export function blockedBuyTickers(
  alerts: { ticker: string; action: string; issue: string }[],
): Map<string, string> {
  return new Map(
    alerts
      .filter((a) => a.action === "stop_buying" || a.action === "sell")
      .map((a) => [
        a.ticker,
        `${a.action === "sell" ? "매도 권고" : "신규 매수 중단"} — ${a.issue.trim() || "사유 없음"}`,
      ]),
  );
}

/**
 * 건너뜀 사유 분류 — 실행 노트의 집계에만 쓴다.
 * 사유 문자열은 정규화·실시간가 적용부가 rationale에 남긴 문구다.
 */
const SKIP_REASON_RULES: [RegExp, string][] = [
  [/핵심 자료 미확인\(②\)/, "핵심 자료 미확인(②)"],
  [/신규 매수 제외\(④ 보유 점검\)/, "④ 보유 점검 경고"],
  [/조사가와 30% 넘게 차이/, "실시간가 드리프트"],
  [/실시간가 없음/, "실시간가 없음"],
  [/1주도 못 산다/, "1주 매수 불가"],
  [/자리 비움|모델이 이 자리를 내지 않음/, "빈 자리"],
  [/매수 대상이 아닌 카테고리/, "비활성 카테고리"],
];

/**
 * "건너뜀 N/M 자리 (사유별 집계)" 한 줄.
 * 두 회차 연속 건너뜀률이 높으면 게이트가 과한 것이므로 사람이 완화를 검토한다(docs/운영.md).
 */
export function skipTally(
  rows: { skipped: boolean; rationale: string }[],
): string {
  if (!rows.length) return "";
  const skipped = rows.filter((r) => r.skipped);
  const counts = new Map<string, number>();
  for (const r of skipped) {
    const label =
      SKIP_REASON_RULES.find(([re]) => re.test(r.rationale))?.[1] ??
      "모델 판단(skip)";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const detail = [...counts]
    .map(([label, n]) => `${label} ${n}`)
    .join(", ");
  return (
    `건너뜀 ${skipped.length}/${rows.length} 자리` +
    (detail ? ` (${detail})` : "")
  );
}

/**
 * ①이 이전 문서를 받지 않으므로 관찰 목록이 회차마다 통째로 바뀔 수 있다.
 * 최신 ① 문서의 데이터 표(활성 카테고리 행)를 "직전 관찰 목록"으로 되돌려 넣는다.
 */
export function priorWatchlistBlock(
  doc: ParsedDoc | null,
  active: Category[],
): string {
  const rows = (doc?.dataRows ?? []).filter((r) =>
    active.includes(CATEGORY_FROM_KO[r.category.trim()]),
  );
  if (!rows.length) return "";
  const lines = rows.map((r) => {
    const note = r.note.trim();
    const head = note.length > 60 ? `${note.slice(0, 60)}…` : note;
    return `- ${CATEGORY_LABEL[CATEGORY_FROM_KO[r.category.trim()]]} | ${r.ticker} ${r.name} | ${head || "(note 없음)"}`;
  });
  return [
    "[직전 관찰 목록 — 지난 정기 조사 문서의 데이터 표]",
    "여기 있는 종목이 이번 회차의 '기존 대표 상품'이다. 자리 표기와 비고는 그 문서에 적혀 있던 값이다.",
    ...lines,
  ].join("\n");
}

export function recommendOutputRules(active: Category[]): string[] {
  const labels = active.map((c) => CATEGORY_LABEL[c]).join("·");
  // 자산성장은 두 자리를 쓰므로 "각각 한 번씩, 총 N개"가 성립하지 않는다.
  // 개수는 자리를 두지 않는 카테고리만 세고, 자산성장은 아래 자리 규칙에 맡긴다.
  const hasRole = active.includes(ROLE_CATEGORY);
  const others = active.filter((c) => c !== ROLE_CATEGORY);
  const otherLabels = others.map((c) => CATEGORY_LABEL[c]).join("·");
  const roleLabel = CATEGORY_LABEL[ROLE_CATEGORY];

  // 자산성장이 비활성이면 활성은 최대 2개라 "세 카테고리 … 총 3개" 가지는 도달할 수 없다
  const countRule = !hasRole
    ? active.length === 1
      ? `- 이번 회차 활성 카테고리는 ${labels}뿐이다. ${labels} 한 개만 picks에 담아라. 다른 카테고리는 이번 회차에 매수하지 않는다.`
      : `- 이번 회차 활성 카테고리는 ${labels}뿐이다. ${labels} 각각 정확히 한 번씩, 총 ${active.length}개를 picks에 담아라. 다른 카테고리는 이번 회차에 매수하지 않는다.`
    : others.length === 0
      ? `- 이번 회차 활성 카테고리는 ${roleLabel}뿐이다. ${roleLabel}만 picks에 담고, 몇 개를 담을지는 아래 자리 규칙을 따른다. 다른 카테고리는 이번 회차에 매수하지 않는다.`
      : active.length === CATEGORIES.length
        ? `- ${otherLabels}은 각각 정확히 한 번씩 picks에 담고, ${roleLabel}은 아래 자리 규칙을 따른다.`
        : `- 이번 회차 활성 카테고리는 ${labels}뿐이다. ${otherLabels}은 정확히 한 번씩 picks에 담고, ${roleLabel}은 아래 자리 규칙을 따른다. 다른 카테고리는 이번 회차에 매수하지 않는다.`;

  // 자산성장만 두 자리로 나눠 담는다. 앞줄의 개수 규칙에 대한 예외라 바로 뒤에 붙인다.
  const roleRules = active.includes(ROLE_CATEGORY)
    ? [
        `- ${CATEGORY_LABEL[ROLE_CATEGORY]}만은 예외다. ${GROWTH_ROLE_LABEL.aggressive} 자리(role="aggressive", ${GROWTH_ROLE_HINT.aggressive})와 ${GROWTH_ROLE_LABEL.stable} 자리(role="stable", ${GROWTH_ROLE_HINT.stable})에 ETF를 하나씩 골라 ${CATEGORY_LABEL[ROLE_CATEGORY]} pick 2개를 담아라. 두 자리에 같은 종목이나 같은 기초지수를 넣지 마라.`,
        `- role은 ${CATEGORY_LABEL[ROLE_CATEGORY]} pick에만 "aggressive" 또는 "stable"로 적고 다른 카테고리 pick은 null로 둔다. 자리 비중과 자리별 budget_krw는 시스템이 ${CATEGORY_LABEL[ROLE_CATEGORY]} 잔액을 나눠 채우므로 직접 계산하지 마라. 두 자리에 같은 종목을 넣으면 ${GROWTH_ROLE_LABEL.aggressive} 자리만 남고 ${GROWTH_ROLE_LABEL.stable} 자리는 비운다. 건너뛴 자리의 몫은 ${CATEGORY_LABEL[ROLE_CATEGORY]} 잔액으로 이월되어 다음 회차에 다시 자리 비중대로 나뉜다. 다른 카테고리로는 가지 않는다.`,
      ]
    : [];

  return [
    countRule,
    ...roleRules,
    "- action은 buy 또는 skip만 쓴다. 기존 보유분 매도·교체는 이 단계에서 제안하지 않는다(매도·교체 검토는 ④, 중복 보유 정리는 ⑤).",
    "- action=skip이면 ticker·etf_name·ref_price는 null, ref_qty는 0으로 둔다. 값을 지어내지 마라.",
    "- ref_price는 [실시간 시세]의 값만 쓴다. 실시간가가 없는 종목은 이번 회차 후보에서 제외한다 — ② 문서의 price로 대체하지 마라.",
    "- ref_qty: floor(budget_krw ÷ ref_price).",
    "- source_doc_ids에는 위에 표시된 research_doc_id 중 실제로 근거로 쓴 것만 넣어라.",
    "- JSON 밖에는 아무것도 출력하지 마라.",
  ];
}

/**
 * 모델 출력에서 JSON을 꺼낸다.
 * --output-schema를 줘도 코드펜스나 앞머리 산문이 붙어 오는 경우가 있다.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, ""),
  ];

  const braced = text.match(/[{[][\s\S]*[}\]]/);
  if (braced) candidates.push(braced[0]);

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // 다음 후보
    }
  }
  return null;
}

/** DB의 integer 컬럼에 안전하게 넣기 위한 정수 변환 (모델이 3.7 같은 값을 낼 수 있다) */
export function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const t = Math.trunc(n);
  return Math.abs(t) <= 2_147_483_647 ? t : null;
}

export function positiveInt(v: unknown): number | null {
  const n = toInt(v);
  return n !== null && n > 0 ? n : null;
}

export function nonNegativeInt(v: unknown): number | null {
  const n = toInt(v);
  return n !== null && n >= 0 ? n : null;
}

export type NormalizedPick = {
  category: Category;
  /** 자산성장을 나눠 담은 자리. 자리를 두지 않는 카테고리는 null */
  role: GrowthRole | null;
  /** 자리를 둘 다 채웠을 때 그 자리에 준 비중. 한 종목으로 끝나면 null */
  weight: number | null;
  ticker: string | null;
  etfName: string | null;
  budgetKrw: number;
  refPrice: number | null;
  refQty: number;
  /** 갈아타기(action="switch")일 때만 채워진다. buy/skip은 전부 null */
  sellTicker: string | null;
  sellQty: number | null;
  sellRefPrice: number | null;
  /** 조사 문서에 적혀 있던 원래 가격 — refPrice가 실시간가로 바뀌어도 남는다 */
  researchPrice: number | null;
  sellResearchPrice: number | null;
  /** refPrice가 어디서 온 값인지 */
  priceSource: PriceSource;
  /** 실시간가일 때의 기준 시각 */
  pricedAt: Date | null;
  skipped: boolean;
  rationale: string;
  sourceDocIds: number[];
  sourceUrls: string[];
};

export type PriceSource = "realtime" | "research";

/** 실시간 시세 한 건 — server/livePrice.getRealtimePrices의 결과에서 쓰는 부분만 */
export type RealtimeQuote = {
  price: number;
  pricedAt: Date;
  marketStatus?: string | null;
};

export type NormalizeResult = {
  rows: NormalizedPick[];
  dropped: string[];
};

/** 배정액(+매도 예상대금)으로 몇 주를 살 수 있는지 — 정규화·교체·화면이 같은 식을 쓴다 */
export function computeRefQty(
  budget: number,
  proceeds: number,
  price: number,
): number {
  if (!(price > 0)) return 0;
  return Math.floor((budget + proceeds) / price);
}

/**
 * 고배당을 건너뛸 때에만 그 잔액을 배당성장·자산성장에 5:3(기존 50:30 비중)으로 나눈다.
 * 배당성장/자산성장이 건너뛰면 그 몫은 배정하지 않고 고배당에 남겨 이월한다.
 *
 * 배정 금액은 모델 값을 믿지 않고 시스템이 계산한다 — 잔액을 넘겨 쓰는 일이 없어야 한다.
 */
export function allocateBudgets(
  balances: Record<Category, number>,
  skipped: Record<Category, boolean>,
): Record<Category, number> {
  const budgets: Record<Category, number> = { ...balances };
  if (!skipped.high_div) return budgets;

  const pool = balances.high_div;
  if (pool <= 0) return budgets;

  const toDiv = Math.floor((pool * 5) / 8);
  const toAsset = pool - toDiv;

  // 받을 카테고리도 건너뛰면 그 몫은 고배당에 남는다
  if (!skipped.div_growth) budgets.div_growth += toDiv;
  if (!skipped.asset_growth) budgets.asset_growth += toAsset;

  return budgets;
}

/**
 * 모델의 picks를 DB 행으로 정규화한다.
 *
 * - 배정 금액은 모델 값을 믿지 않고 시스템 잔액을 쓴다.
 * - action=skip이거나 종목·가격·수량이 성립하지 않으면 건너뜀으로 저장한다.
 * - source_doc_ids는 실제 주입한 문서 ID만 남긴다.
 */
export function normalizePicks(
  raw: unknown,
  ctx: {
    balances: Record<Category, number>;
    injectedDocIds: number[];
    /** 주면 그 밖의 카테고리 pick은 건너뜀 — 고배당 건너뜀 재배분으로 비활성 카테고리에 돈이 흘러가지 않게 */
    active?: Category[];
    /** 자산성장 자리 비중. 없으면 기본 50:50 */
    roleWeights?: Record<GrowthRole, number>;
    /** ② 최신 문서 데이터 표의 티커→price. researchPrice에 채워 ② 오파싱 탐지의 기준이 된다 */
    researchPrices?: Map<string, number>;
    /**
     * ② 최신 문서 데이터 표의 티커→행 전체. 주면 핵심 자료 게이트(`gateCoreEvidence`)가 돈다.
     * 안 주면 게이트를 돌리지 않는다 — 옛 호출부와 대조군을 그대로 두기 위해서다.
     */
    researchRows?: Map<string, DataRow>;
    /** ④가 신규 매수를 막은 티커 → 사유 (`blockedBuyTickers`) */
    blockedTickers?: Map<string, string>;
  },
): NormalizeResult {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { picks?: unknown[] } | null)?.picks ?? []);

  const injected = new Set(ctx.injectedDocIds);
  const dropped: string[] = [];

  // 1차: 카테고리·종목·가격을 정리하고 건너뜀 여부를 판정한다
  type Draft = {
    category: Category;
    /** 모델이 적어 온 자리. 자리 배정은 아래 2차에서 다시 정한다 */
    role: GrowthRole | null;
    ticker: string | null;
    etfName: string | null;
    refPrice: number | null;
    skipped: boolean;
    /** 모델이 명시적으로 action="skip"이라고 한 경우에만 true */
    explicitSkip: boolean;
    rationale: string;
    sourceDocIds: number[];
    sourceUrls: string[];
  };
  const drafts: Draft[] = [];

  for (const item of Array.isArray(list) ? list : []) {
    const p = (item ?? {}) as Record<string, unknown>;
    const category = CATEGORY_FROM_KO[String(p.category ?? "").trim()];

    if (!category) {
      dropped.push(
        `알 수 없는 카테고리 '${String(p.category)}' — ${String(p.ticker ?? "")}`,
      );
      continue;
    }

    const price = positiveInt(p.ref_price);
    const ticker = String(p.ticker ?? "").replace(/[^0-9A-Za-z]/g, "");
    const action = String(p.action ?? "").trim();
    const explicitSkip = action === "skip";
    const inactive = ctx.active ? !ctx.active.includes(category) : false;
    const preSkipped = explicitSkip || inactive || !ticker || price === null;

    // ④가 아직 해소되지 않은 매수 중단·매도 경고를 남긴 종목은 신규 매수 대상이 아니다
    const blockedReason = preSkipped
      ? null
      : (ctx.blockedTickers?.get(ticker) ?? null);
    // ② 표에서 핵심 4항목을 확인하지 못한 후보는 고를 수 없다 (프롬프트가 아니라 코드가 막는다)
    const gateReason =
      preSkipped || blockedReason
        ? null
        : ctx.researchRows
          ? gateCoreEvidence(
              { ticker, skipped: false },
              ctx.researchRows.get(ticker),
            )
          : null;
    const blockNote = blockedReason
      ? `신규 매수 제외(④ 보유 점검): ${blockedReason}`
      : gateReason;
    const skipped = preSkipped || blockNote !== null;
    if (blockNote) dropped.push(`${blockNote} — ${CATEGORY_LABEL[category]} ${ticker}`);

    // ③은 더 이상 갈아타기를 만들지 않는다 — 옛 형식이 와도 매수로만 받는다
    if (action === "switch") {
      dropped.push(`③은 갈아타기를 쓰지 않음 — 매수로 처리: ${ticker || "?"}`);
    }
    if (inactive && !explicitSkip) {
      dropped.push(
        `이번 회차 매수 대상이 아닌 카테고리라 매수하지 않음 — ${CATEGORY_LABEL[category]} ${ticker || "?"}`,
      );
    }

    drafts.push({
      category,
      role: category === ROLE_CATEGORY ? toGrowthRole(p.role) : null,
      ticker: skipped ? null : ticker,
      etfName: skipped ? null : String(p.etf_name ?? ""),
      refPrice: skipped ? null : price,
      skipped,
      explicitSkip,
      // 게이트·④ 경고로 건너뛴 경우 그 사유를 화면에서도 읽을 수 있게 rationale에 남긴다
      rationale: [String(p.rationale ?? ""), blockNote].filter(Boolean).join("\n"),
      sourceDocIds: Array.isArray(p.source_doc_ids)
        ? p.source_doc_ids.map((n) => Number(n)).filter((n) => injected.has(n))
        : [...injected],
      sourceUrls: Array.isArray(p.source_urls)
        ? p.source_urls.filter((u): u is string => typeof u === "string")
        : [],
    });
  }

  // 2차: 카테고리마다 몇 개를 담을지 정한다.
  //      자산성장은 공격·안정 두 자리, 나머지는 예전처럼 1종목이다.
  //      자리를 안 정하고 같은 카테고리 pick을 여러 개 두면 아래 배정 금액이
  //      pick마다 전액으로 들어가 수량 합계가 잔액을 넘는다.
  const roleWeights = ctx.roleWeights ?? DEFAULT_GROWTH_ROLE_WEIGHTS;
  /** 저장하지 않고 버릴 draft */
  const dead = new Set<Draft>();
  /** 자리 배정 결과 (한 자리만 채워도 기록한다 — 나중에 보유 종목의 자리를 알기 위해) */
  const seatOf = new Map<Draft, GrowthRole>();
  /** 자리에 앉은 pick의 비중. 두 자리를 한 종목으로 합쳤을 때만 비어 있다 */
  const splitOf = new Map<Draft, number>();
  /** 자산성장이 활성일 때 채워지지 않은 자리 — 3차에서 건너뜀 행으로 만든다 */
  const emptySeats: { role: GrowthRole; reason: string }[] = [];
  const roleActive = ctx.active ? ctx.active.includes(ROLE_CATEGORY) : true;

  for (const category of CATEGORIES) {
    const mine = drafts.filter((d) => d.category === category);

    if (category !== ROLE_CATEGORY) {
      for (const d of mine.filter((x) => !x.skipped).slice(1)) {
        dead.add(d);
        dropped.push(
          `${CATEGORY_LABEL[category]}은 한 종목만 담는다 — 두 번째 pick 제외 — ${d.ticker ?? "?"}`,
        );
      }
      continue;
    }

    // 자리를 명시한 pick이 먼저 앉고, 자리를 안 적은 pick이 남은 자리를 채운다
    const seats = new Map<GrowthRole, Draft>();
    const unseated: Draft[] = [];
    for (const d of mine) {
      if (!d.role) {
        unseated.push(d);
        continue;
      }
      if (seats.has(d.role)) {
        dead.add(d);
        dropped.push(
          `${CATEGORY_LABEL[category]} ${GROWTH_ROLE_LABEL[d.role]} 자리에 pick이 둘 — 먼저 나온 것만 씀 — ${d.ticker ?? "?"}`,
        );
        continue;
      }
      seats.set(d.role, d);
    }
    for (const d of unseated) {
      const free = GROWTH_ROLES.find((r) => !seats.has(r));
      if (!free) {
        dead.add(d);
        dropped.push(
          `${CATEGORY_LABEL[category]} 자리 ${GROWTH_ROLES.length}개가 이미 차서 제외 — ${d.ticker ?? "?"}`,
        );
        continue;
      }
      dropped.push(
        `${CATEGORY_LABEL[category]} pick에 role이 없어 ${GROWTH_ROLE_LABEL[free]} 자리로 배정 — ${d.ticker ?? "?"}`,
      );
      seats.set(free, d);
    }

    /** 자리가 빈 사유. 적어 두지 않은 자리는 "모델이 내지 않았다"가 사유다 */
    const emptyReason = new Map<GrowthRole, string>();

    // 두 자리에 같은 종목이면 나눠 담은 게 아니다. filled는 GROWTH_ROLES 순서라
    // 모델이 어느 자리를 먼저 냈든 aggressive가 남고 stable 자리를 비운다.
    // 합쳐서 잔액 전부를 한 종목에 몰아주지 않는다.
    const filled = GROWTH_ROLES.filter((r) => seats.has(r));
    if (filled.length === 2) {
      const [first, second] = filled.map((r) => seats.get(r)!);
      if (
        !first.skipped &&
        !second.skipped &&
        first.ticker &&
        first.ticker === second.ticker
      ) {
        dead.add(second);
        seats.delete(filled[1]);
        emptyReason.set(
          filled[1],
          `두 자리에 같은 종목 — ${GROWTH_ROLE_LABEL[filled[1]]} 자리 비움`,
        );
        dropped.push(
          `${CATEGORY_LABEL[category]} 두 자리에 같은 종목 — ${GROWTH_ROLE_LABEL[filled[1]]} 자리 비움 — ${first.ticker}`,
        );
      }
    }

    for (const [role, d] of seats) seatOf.set(d, role);
    // 자리에 앉은 pick은 자리 수와 무관하게 그 자리 몫만 받는다.
    for (const [role, d] of seats) splitOf.set(d, roleWeights[role]);
    const empty = GROWTH_ROLES.length - seats.size;
    if (seats.size > 0 && empty > 0) {
      dropped.push(
        `${CATEGORY_LABEL[category]} 자리 ${empty}개가 비어 그 몫은 ${CATEGORY_LABEL[category]} 잔액으로 이월`,
      );
      // 사유를 로그에만 남기면 화면에는 그 자리가 통째로 사라져 몫이 어디 갔는지 보이지 않는다.
      if (roleActive) {
        for (const r of GROWTH_ROLES.filter((x) => !seats.has(x))) {
          emptySeats.push({
            role: r,
            reason: emptyReason.get(r) ?? "모델이 이 자리를 내지 않음",
          });
        }
      }
    }
  }

  // 3차: 건너뜀 여부가 다 정해진 뒤에 배정 금액과 수량을 시스템이 계산한다.
  //      (고배당 건너뜀이면 그 잔액이 배당성장·자산성장으로 재배분된다)
  const highDivDrafts = drafts.filter((d) => d.category === "high_div");
  const hasLive = (c: Category) =>
    drafts.some((d) => d.category === c && !d.skipped && !dead.has(d));
  const skippedMap = {
    // 받을 쪽: 살아 있는 pick이 하나도 없으면 쓸 곳이 없으니 배정하지 않는다
    div_growth: !hasLive("div_growth"),
    asset_growth: !hasLive("asset_growth"),
    // 줄 쪽: 모델이 명시적으로 skip이라고 한 경우에만 재배분한다.
    // pick이 없거나(출력 불완전) buy인데 가격이 빠진 경우(데이터 오류)까지
    // 재배분하면 실수로 돈이 조용히 옮겨간다.
    high_div:
      highDivDrafts.length > 0 &&
      highDivDrafts.every((d) => d.skipped) &&
      highDivDrafts.some((d) => d.explicitSkip),
  };
  const budgets = allocateBudgets(ctx.balances, skippedMap);

  const rows: NormalizedPick[] = drafts.filter((d) => !dead.has(d)).map((d) => {
    // 자리에 앉았으면 카테고리 배정액을 비중대로 나눈 몫이 이 pick의 예산이다.
    // 내림이라 두 몫의 합은 배정액을 넘지 않는다 — 남는 잔돈은 다음 달로 이월된다.
    const weight = splitOf.get(d) ?? null;
    const budget =
      weight === null
        ? budgets[d.category]
        : seatBudget(budgets[d.category], weight);
    // 배정 금액으로 1주도 못 사면 결국 건너뜀이다
    const qty =
      d.skipped || d.refPrice === null
        ? 0
        : computeRefQty(budget, 0, d.refPrice);
    const skipped = d.skipped || qty <= 0;

    return {
      category: d.category,
      role: seatOf.get(d) ?? null,
      weight,
      ticker: skipped ? null : d.ticker,
      etfName: skipped ? null : d.etfName,
      // 건너뛴 카테고리는 재배분 전 자기 잔액을 그대로 보여준다(이월액).
      // 자리를 나눈 경우에는 그 자리 몫만 이월된다 — 다른 자리로 넘어가지 않는다.
      budgetKrw: skipped && weight === null ? ctx.balances[d.category] : budget,
      refPrice: skipped ? null : d.refPrice,
      refQty: qty,
      sellTicker: null,
      sellQty: null,
      sellRefPrice: null,
      // 모델이 적어 온 ref_price는 [실시간 시세] 값이라 원값이 아니다.
      // ② 문서 표의 값을 넣어야 isDrift가 ② 오파싱을 잡아낸다.
      researchPrice:
        skipped || !d.ticker ? null : (ctx.researchPrices?.get(d.ticker) ?? null),
      sellResearchPrice: null,
      priceSource: "research",
      pricedAt: null,
      skipped,
      rationale: d.rationale,
      sourceDocIds: d.sourceDocIds,
      sourceUrls: d.sourceUrls,
    };
  });

  // 빈 자리도 행으로 남긴다 — /recommend 의 기존 건너뜀 렌더가 "이 자리 몫 N원 이월"을 보여준다.
  // 폼이 없는 건너뜀 행이라 합계·수락 경로에는 영향이 없다.
  for (const { role, reason } of emptySeats) {
    rows.push({
      category: ROLE_CATEGORY,
      role,
      weight: roleWeights[role],
      ticker: null,
      etfName: null,
      budgetKrw: seatBudget(budgets[ROLE_CATEGORY], roleWeights[role]),
      refPrice: null,
      refQty: 0,
      sellTicker: null,
      sellQty: null,
      sellRefPrice: null,
      researchPrice: null,
      sellResearchPrice: null,
      priceSource: "research",
      pricedAt: null,
      skipped: true,
      rationale: reason,
      sourceDocIds: [],
      sourceUrls: [],
    });
  }

  return { rows, dropped };
}

/** 조사가에서 이만큼 벌어진 실시간가는 오파싱으로 보고 버린다 */
const MAX_PRICE_DRIFT = 0.3;

export function isDrift(price: number, research: number | null): boolean {
  if (research === null || research <= 0) return false;
  return Math.abs(price - research) / research > MAX_PRICE_DRIFT;
}

export type RealtimeApplyResult = {
  rows: NormalizedPick[];
  /** 실시간가를 실제로 갈아끼운 행 수 */
  applied: number;
  /** 갈아끼울 수 있었던 행 수 (건너뛰지 않은 행) */
  eligible: number;
  /** 갈아끼우지 않은 행과 그 이유 */
  excluded: string[];
};

/**
 * 실시간가를 못 쓴 매수 행은 조사가로 대체하지 않고 이번 회차에서 뺀다.
 *
 * 이월액(budgetKrw)은 normalizePicks의 불변식과 같은 값이어야 한다 —
 * 자리를 나누지 않은 행(weight === null)은 재배분 전 자기 카테고리 잔액,
 * 자리에 앉은 행은 그 자리 몫. balances를 안 주면 정규화가 준 값을 그대로 둔다.
 */
function excludeForNoLivePrice(
  r: NormalizedPick,
  reason: string,
  balances?: Record<Category, number>,
): NormalizedPick {
  return {
    ...r,
    ticker: null,
    etfName: null,
    refPrice: null,
    refQty: 0,
    budgetKrw:
      r.weight === null && balances ? balances[r.category] : r.budgetKrw,
    priceSource: "research",
    pricedAt: null,
    skipped: true,
    rationale: r.rationale ? `${r.rationale}\n${reason}` : reason,
  };
}

/**
 * 정규화된 추천의 기준가를 추천 시점의 실시간 체결가로 갈아끼운다.
 *
 * 조사 문서의 price는 ②가 웹을 훑은 시점 값이라 몇 분~몇 시간 묵는다. 증권사 앱은
 * KRX 체결가를 보여주므로 그대로 두면 "몇 주 살 수 있는지"가 어긋난다.
 *
 * ③이 만드는 매수 행은 실시간가가 필수다 — 못 얻었거나 조사가와 30% 넘게 벌어져
 * 버린 경우에는 조사가로 대체하지 않고 그 자리를 이번 회차에서 뺀다(몫은 이월).
 * 옛 갈아타기 행(sell_ticker가 있는 행)은 예전 규칙 그대로 둔다.
 *
 * 갈아끼운 뒤 수량이 0이 되면 그 행은 매수·매도 다리를 모두 되돌린다 —
 * normalizePicks가 세운 "수량 0이면 반드시 건너뜀"을 여기서 깨면 안 되고,
 * 수량 0인 채로 건너뜀이 아닌 행은 잔액 검증이 없는 갈아타기 경로에서 원장을 음수로 만든다.
 */
export function applyRealtimePrices(
  rows: NormalizedPick[],
  quotes: Map<string, RealtimeQuote>,
  /** 정규화에 넘겼던 재배분 전 잔액 — 행을 빼낼 때 이월액을 정규화와 같은 값으로 되돌린다 */
  balances?: Record<Category, number>,
): RealtimeApplyResult {
  const excluded: string[] = [];
  let applied = 0;
  let eligible = 0;

  const out = rows.map((r) => {
    if (r.skipped || r.ticker === null || r.refPrice === null) return r;
    eligible++;

    const buyRaw = quotes.get(r.ticker);
    const sellRaw = r.sellTicker ? quotes.get(r.sellTicker) : undefined;

    // 기준은 ② 문서 표의 가격뿐이다. researchPrice가 없으면(표에 없는 티커) 견줄 원값이
    // 없으므로 드리프트 검사를 건너뛰고 실시간가를 채택한다 —
    // refPrice를 기준으로 삼으면 모델이 적어 온 실시간가끼리 재는 꼴이라 ② 오파싱을 못 잡는다.
    const buyDrift =
      buyRaw !== undefined && isDrift(buyRaw.price, r.researchPrice);
    const sellDrift =
      sellRaw !== undefined &&
      isDrift(sellRaw.price, r.sellResearchPrice ?? r.sellRefPrice);

    const buy = buyRaw && !buyDrift ? buyRaw : null;
    const sell = sellRaw && !sellDrift ? sellRaw : null;

    if (r.sellTicker === null) {
      if (!buy) {
        const reason = buyDrift
          ? `${r.ticker} 실시간가가 조사가와 30% 넘게 차이 — 이번 회차 제외`
          : `${r.ticker} 실시간가 없음 — 이번 회차 제외`;
        excluded.push(reason);
        return excludeForNoLivePrice(r, reason, balances);
      }
      const liveQty = computeRefQty(r.budgetKrw, 0, buy.price);
      if (liveQty <= 0) {
        const reason = `${r.ticker} 실시간가로는 1주도 못 산다 — 이번 회차 제외`;
        excluded.push(reason);
        return excludeForNoLivePrice(r, reason, balances);
      }
      applied++;
      return {
        ...r,
        refPrice: buy.price,
        refQty: liveQty,
        priceSource: "realtime" as PriceSource,
        pricedAt: buy.pricedAt,
      };
    }

    // 새 데이터에서는 도달 불가 — ③이 더 이상 sellTicker를 만들지 않으므로 옛 행 재처리용 보존 경로다
    if (buyDrift) excluded.push(`${r.ticker} 조사가와 30% 넘게 차이`);
    if (sellDrift) excluded.push(`${r.sellTicker} 매도가가 조사가와 30% 넘게 차이`);
    if (!buy && !sell) {
      if (!buyDrift && !sellDrift) excluded.push(`${r.ticker} 실시간가 없음`);
      return r;
    }

    const refPrice = buy ? buy.price : r.refPrice;
    const sellRefPrice = sell ? sell.price : r.sellRefPrice;
    const proceeds =
      r.sellTicker && r.sellQty && sellRefPrice ? r.sellQty * sellRefPrice : 0;
    const refQty = computeRefQty(r.budgetKrw, proceeds, refPrice);

    if (refQty <= 0) {
      excluded.push(`${r.ticker} 실시간가로는 1주도 못 사서 조사가 유지`);
      return r;
    }

    applied++;
    return {
      ...r,
      refPrice,
      sellRefPrice,
      refQty,
      // 매수·매도 어느 다리든 갈아끼웠으면 실시간이다
      priceSource: "realtime" as PriceSource,
      pricedAt: (buy ?? sell)!.pricedAt,
    };
  });

  return { rows: out, applied, eligible, excluded };
}
