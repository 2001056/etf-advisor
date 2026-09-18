import { CATEGORIES, CATEGORY_LABEL, Category } from "./money";

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
  // NAV 추이: up | flat | down (금감원 소비자경보 2024-26호가 지적한 원금잠식 신호)
  "nav_trend",
  // 분배율 산출 기준: trailing12m | annualized_1m | target | unknown
  "yield_basis",
  "premium",
  "note",
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
  /** 같은 기간 총투자수익률(%) — 분배율과 나란히 봐야 한다 */
  totalReturn1y: number | null;
  /** NAV 추이 (up/flat/down). 분배율이 높은데 down이면 경고 대상 */
  navTrend: string;
  /** 분배율 산출 기준 — 다르면 종목 간 비교가 성립하지 않는다 */
  yieldBasis: string;
  premium: number | null;
  note: string;
};

export type ParsedDoc = {
  frontmatter: Record<string, unknown>;
  sections: Record<string, string>;
  dataRows: DataRow[];
  /** 형식 위반 목록 — 비어 있지 않으면 대시보드에 경고를 띄운다 */
  problems: string[];
};

const EXAMPLE_ROW: Record<Category, string> = {
  div_growth:
    "| 446720 | SOL 미국배당다우존스 | 배당성장 | 12345 | 3.5 | 14.2 | up | trailing12m | 0.1 | 비고 |",
  asset_growth:
    "| 360750 | TIGER 미국S&P500 | 자산성장 | 12345 | 1.1 | 18.3 | up | trailing12m | 0.1 | 비고 |",
  high_div:
    "| 161510 | PLUS 고배당주 | 고배당 | 12345 | 6.2 | 12.4 | flat | trailing12m | 0.1 | 비고 |",
};

/** 프롬프트 뒤에 붙는 출력 형식 지시문. */
export function buildFormatInstruction(opts: {
  type: "scheduled" | "ondemand" | "watch";
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

## 4. 데이터 표
| ticker | name | category | price | dist_yield | total_return_1y | nav_trend | yield_basis | premium | note |
|---|---|---|---|---|---|---|---|---|---|
${exampleRow}

이 표 규칙(가장 중요):
- 컬럼은 위 10개 그대로, 순서도 그대로.
- ticker는 앞의 0을 보존한 6자리 문자열.
- price는 원 단위 정수만 (쉼표·"원" 금지). 나머지 비율은 % 기호 없는 숫자만.
- category는 배당성장 / 자산성장 / 고배당 중 하나.
- **total_return_1y**: 최근 1년 총투자수익률(기준가격 변동 + 분배금). 분배율과 나란히 비교하기 위한 값이다.
- **nav_trend**: 최근 6~12개월 NAV 방향을 up / flat / down 중 하나로. 확인 불가면 NA.
- **yield_basis**: 그 분배율이 어떤 기준으로 산출된 값인지.
  trailing12m(후행 12개월 실지급) / annualized_1m(직전월 연율화) / target(목표분배율) / unknown 중 하나.
  기준이 다르면 종목 간 분배율 비교가 성립하지 않으므로 반드시 확인해서 적어라.
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
      navTrend: (c[idx("nav_trend")] ?? "").trim().toLowerCase(),
      yieldBasis: (c[idx("yield_basis")] ?? "").trim().toLowerCase(),
      premium: toNumber(c[idx("premium")] ?? ""),
      note: c[idx("note")] ?? "",
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
