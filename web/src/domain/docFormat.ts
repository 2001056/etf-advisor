import { CATEGORIES, CATEGORY_LABEL, Category } from "./money";
import {
  GROWTH_ROLES,
  GROWTH_ROLE_HINT,
  GROWTH_ROLE_LABEL,
  ROLE_CATEGORY,
} from "./recommendation";

/**
 * 조사 문서 표준 형식 (기획서 §5.4).
 * 사용자가 쓰는 프롬프트 뒤에 시스템이 이 지시문을 자동으로 붙인다 —
 * 사용자는 "무엇을 조사할지"만 쓰면 되고 형식은 신경 쓰지 않는다.
 */

export const DOC_HEADINGS = [
  "## 1. 요약",
  "## 2. 시장 개관",
  "## 3. 카테고리별 ETF 현황",
  "## 4. 데이터 표",
  "## 5. 이벤트·뉴스",
  "## 6. 리스크 신호",
  "## 7. 출처",
] as const;

export const DATA_TABLE_COLUMNS = [
  "ticker",
  "name",
  "category",
  "price",
  "dist_yield",
  // 같은 기간 총투자수익률(기준가격 변동 + 분배금). 분배율만 보면 실수령을 과대평가한다
  "total_return_1y",
  // 위 수치가 어느 기간을 잰 값인가: 1y | since_listing:N(상장 N개월) | NA.
  // 열 이름은 total_return_1y 그대로지만 의미는 이 열이 정한다(2026-09-22 추가, 옛 문서에는 없다)
  "return_basis",
  // NAV 추이: up | flat | down (금감원 소비자경보 2024-26호가 지적한 원금잠식 신호)
  "nav_trend",
  // 분배율 산출 기준: trailing12m | annualized_1m | target | unknown
  "yield_basis",
  "premium",
  "note",
  // ── 여기부터 ③ 핵심 증거 4열 (2026-09-21 추가). 옛 문서에는 없어 null이 된다 ──
  // 순자산총액(억원 정수). 50억 미만은 KRX 관리종목 지정 요건
  "aum_bn",
  // 실부담비용(%) = 총보수 + 기타비용 + 매매·중개수수료율.
  // 못 찾으면 차선을 넣고, 값을 넣었으면 note에 비용 플래그로 무엇을 넣었는지 반드시 밝힌다 —
  // 실부담비용이면 "비용:실부담", 합성총보수(= 총보수 + 기타비용)면 "비용:합성총보수",
  // 총보수만이면 "비용:총보수만". 플래그가 없으면 총보수만으로 취급된다
  "cost_pct",
  // 최근 평균 거래대금(억원, 소수 1자리 허용)
  "turnover_bn",
  // 최근 1년 최대 낙폭(%) — 음수
  "mdd_1y_pct",
] as const;

/**
 * ③ 핵심 증거 게이트가 쓰는 열. 표 헤더에 이 중 하나도 없으면 구 형식 문서다.
 * REQUIRED_COLUMNS에는 넣지 않는다 — 옛 문서를 형식 위반으로 잡으면 경고가 의미를 잃는다.
 */
export const EVIDENCE_COLUMNS = [
  "aum_bn",
  "cost_pct",
  "turnover_bn",
  "mdd_1y_pct",
] as const;

/** 없으면 문서가 못 쓰이는 컬럼 */
export const REQUIRED_COLUMNS = [
  "ticker",
  "name",
  "category",
  "price",
  "dist_yield",
  "premium",
  "note",
] as const;

export type DataRow = {
  ticker: string;
  name: string;
  category: string;
  price: number | null;
  distYield: number | null;
  /** 같은 기간 총투자수익률(%) — 분배율과 나란히 봐야 한다. 기간은 returnBasis가 정한다 */
  totalReturn1y: number | null;
  /**
   * totalReturn1y가 어느 기간을 잰 값인가 — "1y" / "since_listing:N"(상장 N개월) / "na"(확인 불가).
   * 옛 문서에는 열 자체가 없어 빈 문자열이다. 기간이 다른 수익률끼리 숫자로 비교하면 안 되므로
   * ③ 게이트는 totalReturn1y와 이 값을 둘 다 봐야 "장기 총수익 확인"으로 인정한다.
   */
  returnBasis: string;
  /** NAV 추이 (up/flat/down). 분배율이 높은데 down이면 경고 대상 */
  navTrend: string;
  /** 분배율 산출 기준 — 다르면 종목 간 비교가 성립하지 않는다 */
  yieldBasis: string;
  premium: number | null;
  note: string;
  /** 순자산총액(억원). 50억 미만이면 관리종목 지정 요건 — dataChecks가 주의로 잡는다 */
  aumBn: number | null;
  /**
   * 실부담비용(%) — 총보수 + 기타비용 + 매매·중개수수료율.
   * 못 찾으면 차선이 들어오고 note에 비용 플래그가 적힌다 —
   * 실부담비용이면 "비용:실부담", 합성총보수(= 총보수 + 기타비용, 매매·중개수수료 제외)면
   * "비용:합성총보수", 총보수만이면 "비용:총보수만".
   * 플래그가 없으면 총보수만으로 취급한다 — 누락을 실부담비용으로 봐주면 가장 비싼 값을
   * 가장 싼 값으로 읽게 된다. dataChecks가 이 누락을 주의로 잡는다.
   * NA로 두면 게이트가 그 종목을 통째로 건너뛰어 과잉 기권이 된다. 셋 다 못 찾았을 때만 NA다.
   */
  costPct: number | null;
  /** 최근 평균 거래대금(억원) */
  turnoverBn: number | null;
  /** 최근 1년 최대 낙폭(%) — 음수. 게이트 대상이 아니라 경고 대상이다 */
  mdd1yPct: number | null;
  /** 표 헤더에 핵심 증거 4열이 하나라도 있었는가. false면 구 형식(10컬럼) 문서다 */
  hasEvidenceColumns: boolean;
};

export type ParsedDoc = {
  frontmatter: Record<string, unknown>;
  sections: Record<string, string>;
  dataRows: DataRow[];
  /** 형식 위반 목록 — 비어 있지 않으면 대시보드에 경고를 띄운다 */
  problems: string[];
};

// 예시 행은 형식을 보여주기 위한 값이다. 모델이 예시 종목을 실제 후보로 베껴 쓰는 경향이 있어
// 자산성장 예시는 존재하지 않는 코드·이름으로 둔다(아래 표 규칙에도 "실제 표에 넣지 마라"를 적는다).
const EXAMPLE_ROW: Record<Category, string> = {
  div_growth:
    "| 446720 | SOL 미국배당다우존스 | 배당성장 | 12345 | 3.5 | 14.2 | 1y | up | trailing12m | 0.1 | 비고 | 12000 | 0.19 | 35.0 | -12.4 |",
  asset_growth:
    "| 999999 | 예시 ETF(가짜 코드) | 자산성장 | 12345 | 1.1 | 18.3 | 1y | up | trailing12m | 0.1 | 비고 | 12000 | 0.09 | 120.5 | -18.2 |",
  high_div:
    "| 161510 | PLUS 고배당주 | 고배당 | 12345 | 6.2 | 12.4 | 1y | flat | trailing12m | 0.1 | 비고 | 3000 | 0.35 | 25.0 | -15.1 |",
};

/**
 * 프롬프트 뒤에 붙는 출력 형식 지시문 — 조사 문서(①·②)에만 붙는다.
 * ④·⑤는 마크다운 문서가 아니라 JSON으로 답하므로 이 지시문을 받지 않는다.
 */
export function buildFormatInstruction(opts: {
  type: "scheduled" | "ondemand";
  dateKey: string;
  runId: number;
  tickers?: string[];
  categories?: Category[];
}): string {
  const tickerLine = opts.tickers?.length
    ? `\n조사 대상 종목(전원 빠짐없이 ## 4 표에 포함할 것): ${opts.tickers.join(", ")}`
    : "";
  const shown = CATEGORIES.filter(
    (c) => !opts.categories?.length || opts.categories.includes(c),
  );
  const subheadings = shown.map((c) => `### ${CATEGORY_LABEL[c]}`).join("\n");
  // 예시 행 카테고리를 모델이 그대로 따라 쓰는 경향이 있다 — 첫 활성 카테고리로 맞춘다
  const exampleRow = EXAMPLE_ROW[shown[0]];
  // 자리 이름의 뜻은 ③ 출력 규칙에만 있었다 — ①②가 note에 자리를 적으려면 여기에도 있어야
  // 문서마다 다른 기준으로 자리를 부여하지 않는다. 정의는 recommendation.ts 한 곳에서 온다.
  const seatBlock = shown.includes(ROLE_CATEGORY)
    ? `
[자리 정의] ${GROWTH_ROLES.map((r) => `${GROWTH_ROLE_LABEL[r]}: ${GROWTH_ROLE_HINT[r]}`).join(" / ")}
- ${CATEGORY_LABEL[ROLE_CATEGORY]}으로 분류한 행은 ## 4 데이터 표의 note 첫머리에 자리(공격 / 안정 / 미정)와 환헤지 여부(H / 비H)를 적는다. note 앞부분은 "자리 / 환헤지 / 비용 플래그" 순으로 " / "로 구분해 적고, 그 뒤에 나머지를 적는다.
- 상품 전략을 충분히 확인하지 못해 자리를 정할 수 없으면 "미정"으로 두고 그 사유를 note에 적는다. 억지로 한쪽에 넣지 마라.
- ${CATEGORY_LABEL[ROLE_CATEGORY]}이 아닌 카테고리로 분류한 행에는 자리를 적지 않는다.
`
    : "";

  return `
────────────────────────────────
[출력 형식 — 반드시 지킬 것]

아래 형식으로만 출력하라. 헤딩 문구를 한 글자도 바꾸지 말고, 순서도 그대로 유지하라.
프로그램이 이 문서를 기계적으로 읽으므로 형식이 틀리면 사용할 수 없다.${tickerLine}

---
run_id: ${opts.runId}
date: ${opts.dateKey}
type: ${opts.type}
tickers: [종목코드를 쉼표로 구분해 나열]
model: (사용한 모델명)
---

## 1. 요약
(3줄 이내)

## 2. 시장 개관
(코스피·S&P500·나스닥·원달러 환율·미 금리를 표로)

## 3. 카테고리별 ETF 현황
${subheadings}
(각 항목에 ETF별 현재가·최근 분배금·분배율·괴리율·특이사항)
${seatBlock}
## 4. 데이터 표
| ticker | name | category | price | dist_yield | total_return_1y | return_basis | nav_trend | yield_basis | premium | note | aum_bn | cost_pct | turnover_bn | mdd_1y_pct |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${exampleRow}

이 표 규칙(가장 중요):
- 컬럼은 위 15개 그대로, 순서도 그대로.
- 위 예시 행은 형식을 보여주는 가짜 값이다. 이 행은 예시이며 실제 표에는 넣지 않는다.
- ticker는 앞의 0을 보존한 6자리 문자열.
- price는 원 단위 정수만 (쉼표·"원" 금지). 나머지 비율은 % 기호 없는 숫자만.
- category는 배당성장 / 자산성장 / 고배당 중 하나.
- **total_return_1y**: NAV 기준, 분배금 재투자 가정 총수익률. 운용사·거래소 공시값을 우선 쓰고,
  공시값이 없으면 계산 근거를 note에 적어라. 시장가 기준이거나 분배금을 현금으로 합산한 방식이면 note에 명시한다.
  분배율과 나란히 비교하기 위한 값이다.
  **어느 기간을 잰 값인지는 return_basis가 정한다** — 이 칸에는 그 기간의 총수익률 숫자만 넣어라.
  상장 12개월 미만이라 1년 수익률이 없으면 **상장 이후 총수익률로 대체한다**.
  NA는 **해당 기간의 실적**을 공시값·원자료 어느 것도 확인하지 못했을 때뿐이다 —
  상장 12개월 이상이면 최근 12개월 실적, 12개월 미만이면 상장 이후 실적. 그때는 사유를 note에 적어라.
- **return_basis**: total_return_1y가 어느 기간을 잰 값인지. 셋 중 하나다.
  **1y** — 최근 12개월. 상장 12개월 이상이면 이 값만 쓴다.
  **since_listing:N** — 상장 N개월(12 미만)의 상장 이후 총수익률. 예: 상장 3개월이면 \`since_listing:3\`.
  **NA** — 해당 기간(12개월 이상은 최근 12개월, 미만은 상장 이후)의 실적을 확인하지 못한 경우. 이때는 total_return_1y도 함께 NA다(둘 다 NA).
  total_return_1y가 값이 있는데 return_basis가 NA이거나 그 반대인 조합은 만들지 마라.
  기간이 다른 수익률을 같은 숫자처럼 비교하는 것을 막으려는 열이다.
- **nav_trend**: 최근 12개월 NAV 방향을 up / flat / down 중 하나로. 기간은 12개월로 고정이며,
  6개월만 관찰한 경우에는 그 사실을 note에 적어라. 확인 불가면 NA.
- **yield_basis**: 그 분배율이 어떤 기준으로 산출된 값인지.
  trailing12m(후행 12개월 실지급) / annualized_1m(직전월 연율화) / target(목표분배율) / unknown 중 하나.
  기준이 다르면 종목 간 분배율 비교가 성립하지 않으므로 반드시 확인해서 적어라.
- **aum_bn**: 순자산총액을 **억원 단위 정수**로. 예: 1조 2,000억원이면 12000. 확인 불가면 NA.
- **cost_pct**: **실부담비용**(총보수 + 기타비용 + 매매·중개수수료율)을 % 기호 없는 숫자로. 예: 0.19.
  실부담비용을 우선하되, 못 찾으면 차선을 넣어라.
  **cost_pct에 값을 넣었으면 그 값이 무엇인지 note에 비용 플래그로 반드시 밝혀라 — 셋 중 하나다.**
  **실부담비용**을 넣었으면 note에 "비용:실부담",
  **합성총보수**(= 총보수 + 기타비용. 매매·중개수수료는 빠져 있다)를 넣었으면 note에 "비용:합성총보수",
  **총보수만** 확인했으면 그 값을 넣고 note에 "비용:총보수만"을 적어라.
  플래그를 빠뜨리면 시스템이 그 값을 **총보수만**으로 취급한다 — 누락을 실부담비용으로 봐주지 않는다.
  NA로 두지 마라 — NA면 그 종목은 이번 회차 후보에서 통째로 빠진다.
  셋 다 확인하지 못했을 때만 NA로 두고 그 사유를 note에 적어라.
- **turnover_bn**: 최근 평균 거래대금을 **억원 단위**로(소수 첫째 자리까지 허용). 예: 35.0.
  어느 기간의 평균인지 note에 적어라. 확인 불가면 NA.
- **핵심 증거 4항목(total_return_1y+return_basis·aum_bn·cost_pct·turnover_bn)**은 후속 추천이 후보를 거르는 데 쓴다.
  장기 총수익 항목은 total_return_1y와 return_basis가 **둘 다** 값이 있어야 확인된 것으로 인정한다.
  넷 중 하나라도 NA면 그 종목은 이번 회차 후보에서 통째로 빠진다.
- **mdd_1y_pct**: 최근 1년 최대 낙폭을 **음수** % 숫자로. 예: -18.2. 확인 불가면 NA.
- **note**: 앞부분은 **"자리 / 환헤지 / 비용 플래그" 순으로 " / "로 구분해** 적고, 그 뒤에 나머지를 적어라.
  자리는 자산성장 행에만 적고, 비용 플래그는 cost_pct가 NA가 아니면 언제나 적는다 — 없는 칸은 건너뛰고 순서만 지킨다.
  예: "공격 / 비H / 비용:합성총보수, 2026-09-21 확인".
  **3년 연환산 총수익률은 표에 컬럼이 없다** — 확인했으면 note에 \`3y_ann:14.2%\` 형태로만 적어라
  (기간이 다르므로 total_return_1y 칸에 넣지 마라).
- 확인하지 못한 값은 지어내지 말고 NA로 적고, note에 이유와 마지막 확인일을 남겨라.

## 5. 이벤트·뉴스
(ETF별 bullet, 날짜 명기)

## 6. 리스크 신호
(없으면 "없음"이라고 명시)

## 7. 출처
(수치마다 근거 URL. 웹 검색으로 실제 확인한 것만 적을 것)
`.trim();
}

/** 모델이 문서 전체를 코드펜스로 감싸는 경우가 있다 — 벗겨낸다. */
function stripOuterFence(md: string): string {
  const t = md.trim();
  if (!t.startsWith("```")) return md;
  return t
    .replace(/^```[a-zA-Z]*\s*\r?\n/, "")
    .replace(/\r?\n```\s*$/, "");
}

function parseFrontmatter(md: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const m = md.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { frontmatter: {}, body: md };

  const fm: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      fm[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      fm[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return { frontmatter: fm, body: md.slice(m[0].length) };
}

function splitSections(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  // "## 1. 요약" ~ 다음 "## " 직전까지
  const re = /^##\s+(\d)\.\s*(.+?)\s*$/gm;
  const marks: { num: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    marks.push({ num: m[1], start: m.index, end: body.length });
    if (marks.length > 1) marks[marks.length - 2].end = m.index;
  }
  for (const mark of marks) {
    const chunk = body.slice(mark.start, mark.end);
    // 마지막 헤딩에 개행이 없을 수 있으므로 \n을 optional로
    const stripped = chunk.replace(/^##\s+\d\.\s*.*?(\r?\n|$)/, "").trim();
    // 같은 번호가 두 번 나오면 이어 붙인다 — 먼저 나온 진짜 표가 사라지지 않게
    out[mark.num] = out[mark.num] ? `${out[mark.num]}\n\n${stripped}` : stripped;
  }
  return out;
}

function toNumber(raw: string): number | null {
  // 통화기호·단위·공백 제거. "약 12,000원", "₩12,345", "$1.5" 모두 수용
  const cleaned = raw
    .replace(/[,%\s]/g, "")
    .replace(/[₩$￦]/g, "")
    .replace(/원$/, "")
    .replace(/^약/, "")
    .trim();
  if (!cleaned || NO_VALUE.has(cleaned.toUpperCase())) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "확인 불가"를 뜻하는 표기들 — 형식 위반이 아니라 정상적인 결측이다. */
const NO_VALUE = new Set([
  "-",
  "—",
  "NA",
  "N/A",
  "없음",
  "미확인",
  "확인불가",
  "확인불가능",
  "NULL",
  "TBD",
]);

export function isNoValueMark(raw: string): boolean {
  const t = raw.replace(/[,%\s]/g, "").trim().toUpperCase();
  return !t || NO_VALUE.has(t);
}

/** 한국 상장 종목코드는 숫자 6자리. 표 헤더 줄이 데이터 행으로 새는 것을 막는다. */
function isPlausibleTicker(raw: string): boolean {
  return /^[0-9A-Z]{5,12}$/.test(raw) && raw.toLowerCase() !== "ticker";
}

function parseDataTable(section: string): {
  rows: DataRow[];
  problems: string[];
} {
  const problems: string[] = [];
  const lines = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));

  if (lines.length < 2) {
    return { rows: [], problems: ["## 4. 데이터 표에서 표를 찾지 못했습니다"] };
  }

  const cells = (line: string) =>
    line
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());

  const header = cells(lines[0]).map((h) => h.toLowerCase());
  // 필수 컬럼만 검사한다. 나중에 추가한 열(총수익률·NAV추이·산출기준)이 없다고
  // 예전 문서를 형식 위반으로 잡으면 경고가 의미를 잃는다.
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) problems.push(`데이터 표에 '${col}' 컬럼이 없습니다`);
  }

  const idx = (col: string) => header.indexOf(col);
  // 핵심 증거 4열이 헤더에 하나도 없으면 구 형식(10컬럼) 문서다 — 값이 null인 이유가
  // "확인 실패"가 아니라 "그 열 자체가 없던 문서"임을 ③ 게이트가 사유에 적을 수 있어야 한다.
  const hasEvidenceColumns = EVIDENCE_COLUMNS.some((c) => header.includes(c));
  const rows: DataRow[] = [];
  const seen = new Set<string>();

  for (const line of lines.slice(1)) {
    // 구분선(|---|---|) 건너뛰기
    if (/^\|?[\s:-]+\|/.test(line) && !/[가-힣A-Za-z0-9]/.test(line.replace(/[-:|\s]/g, ""))) {
      continue;
    }
    const c = cells(line);
    const rawTicker = (c[idx("ticker")] ?? "").replace(/[^0-9A-Za-z]/g, "");
    if (!rawTicker) continue;

    // 표가 두 개 이어져 있으면 두 번째 헤더 줄이 데이터로 새어 들어온다.
    // 이 유령 행은 다음 조사 프롬프트의 대상 종목으로까지 전파되므로 여기서 막는다.
    if (!isPlausibleTicker(rawTicker.toUpperCase())) {
      problems.push(`데이터 표에 종목코드로 볼 수 없는 값: '${rawTicker}'`);
      continue;
    }
    if (seen.has(rawTicker)) {
      problems.push(`데이터 표에 중복 종목: ${rawTicker}`);
      continue;
    }
    seen.add(rawTicker);

    const priceCell = c[idx("price")] ?? "";
    const price = toNumber(priceCell);
    // NA 같은 명시적 결측은 정상 — 프롬프트가 지어내지 말고 NA를 쓰라고 지시한다
    if (price === null && !isNoValueMark(priceCell)) {
      problems.push(`가격을 숫자로 읽지 못했습니다: ${rawTicker} '${priceCell}'`);
    }

    rows.push({
      ticker: rawTicker,
      name: c[idx("name")] ?? "",
      category: c[idx("category")] ?? "",
      price,
      distYield: toNumber(c[idx("dist_yield")] ?? ""),
      totalReturn1y: toNumber(c[idx("total_return_1y")] ?? ""),
      returnBasis: (c[idx("return_basis")] ?? "").trim().toLowerCase(),
      navTrend: (c[idx("nav_trend")] ?? "").trim().toLowerCase(),
      yieldBasis: (c[idx("yield_basis")] ?? "").trim().toLowerCase(),
      premium: toNumber(c[idx("premium")] ?? ""),
      note: c[idx("note")] ?? "",
      aumBn: toNumber(c[idx("aum_bn")] ?? ""),
      costPct: toNumber(c[idx("cost_pct")] ?? ""),
      turnoverBn: toNumber(c[idx("turnover_bn")] ?? ""),
      mdd1yPct: toNumber(c[idx("mdd_1y_pct")] ?? ""),
      hasEvidenceColumns,
    });
  }

  if (!rows.length) problems.push("데이터 표에 유효한 행이 없습니다");
  return { rows, problems };
}

export function parseResearchDoc(rawMd: string): ParsedDoc {
  const md = stripOuterFence(rawMd);
  const { frontmatter, body } = parseFrontmatter(md);
  const sections = splitSections(body);
  const problems: string[] = [];

  if (!Object.keys(frontmatter).length) problems.push("frontmatter가 없습니다");
  for (let i = 1; i <= 7; i++) {
    if (!(String(i) in sections)) problems.push(`## ${i}. 섹션이 없습니다`);
  }

  const { rows, problems: tableProblems } = sections["4"]
    ? parseDataTable(sections["4"])
    : { rows: [] as DataRow[], problems: ["## 4. 데이터 표가 없습니다"] };

  return {
    frontmatter,
    sections,
    dataRows: rows,
    problems: [...problems, ...tableProblems],
  };
}

/** 문서에 등장한 종목 코드 (frontmatter tickers ∪ 데이터 표 ticker) */
export function tickersOf(doc: ParsedDoc): string[] {
  const fmTickers = Array.isArray(doc.frontmatter.tickers)
    ? (doc.frontmatter.tickers as unknown[])
        .map((t) => String(t).replace(/[^0-9A-Za-z]/g, ""))
        .filter((t) => isPlausibleTicker(t.toUpperCase()))
    : [];
  return [...new Set([...fmTickers, ...doc.dataRows.map((r) => r.ticker)])].filter(
    Boolean,
  );
}

/** parse_problems 를 형식 문제와 데이터 자가검증 주의로 나눈다. 데이터 점검 항목은 "[주의]" 접두어를 갖는다. */
export function splitProblems(problems: string[] | null | undefined): {
  format: string[];
  data: string[];
} {
  const format: string[] = [];
  const data: string[] = [];
  for (const p of problems ?? []) (p.startsWith("[주의]") ? data : format).push(p);
  return { format, data };
}
