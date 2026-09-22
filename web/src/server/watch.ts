import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { holdingAlerts, researchDocs } from "@/db/schema";
import { getMonthlyTopup } from "@/domain/ledger";
import { getHoldings, holdingRoles } from "@/domain/purchases";
import { getPrompt } from "@/domain/prompts";
import { ParsedDoc, parseResearchDoc } from "@/domain/docFormat";
import {
  activeCategories,
  CATEGORY_FROM_KO,
  extractJson,
  GrowthRole,
  GROWTH_ROLE_LABEL,
  ROLE_CATEGORY,
} from "@/domain/recommendation";
import { CATEGORY_LABEL, Category, dateKeyKST } from "@/domain/money";
import { CostBasis, parseCostFlag } from "@/domain/costFlag";
import { researchPath } from "./paths";

/**
 * ④ 보유 점검 — 매일 13:00.
 *
 * ①②③과 완전히 분리돼 있다:
 * - 문서 종류가 `watch`라 ③ 추천의 주입 대상에서 빠진다(매일 쌓여도 정기 조사를 밀어내지 않는다)
 * - 결과는 `holding_alerts`에 남고, 대시보드가 그것만 읽는다
 *
 * 매도까지 제안한다 — ③은 "앞으로 살 것"만 정하고, 팔지 말지는 여기서 본다.
 *
 * 모델이 내놓는 것은 `ALERT_SCHEMA` JSON 하나뿐이다. 조사 문서 형식 지시문
 * (`buildFormatInstruction`)은 붙이지 않는다 — 문서 md는 아래에서 시스템이 판정으로 만든다.
 */

const ALERT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    alerts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ticker: { type: "string" },
          etf_name: { type: "string" },
          severity: {
            type: "string",
            enum: ["info", "warn", "danger", "unknown"],
          },
          action: {
            type: "string",
            enum: ["hold", "stop_buying", "sell"],
          },
          issue: { type: "string" },
          replacement_ticker: { type: ["string", "null"] },
          replacement_name: { type: ["string", "null"] },
          rationale: { type: "string" },
          source_urls: { type: "array", items: { type: "string" } },
        },
        required: [
          "ticker",
          "etf_name",
          "severity",
          "action",
          "issue",
          "replacement_ticker",
          "replacement_name",
          "rationale",
          "source_urls",
        ],
      },
    },
  },
  required: ["alerts"],
} as const;

const SEVERITY = new Set(["info", "warn", "danger", "unknown"]);
const ACTION = new Set(["hold", "stop_buying", "sell"]);

/**
 * 적립 중단 카테고리 보유의 조치를 시스템이 hold로 내렸을 때 issue 앞에 붙이는 표시.
 * 화면에는 "보유 유지"만 보이므로, 그게 모델의 판단이 아니라 시스템 고정임을 알려야 한다.
 */
export const FORCED_HOLD_PREFIX = "[적립 중단 카테고리 — 매도 여부는 직접 판단] ";

/**
 * cost_pct에 들어온 값이 무엇인지 — ① 표의 note 비용 플래그에서 읽는다(@/domain/costFlag).
 * total: 실부담비용("비용:실부담") / synthetic: 합성총보수(= 총보수 + 기타비용) /
 * ter_only: 총보수만(플래그가 없을 때도 이것) / null: cost_pct 자체가 NA.
 * 기준이 다르면 직접 비교가 성립하지 않으므로 후보 줄에 함께 찍는다.
 */
export type { CostBasis };

/** ④가 고를 수 있는 대체 종목 — 최신 ① 문서의 데이터 표에서만 온다 */
export type ReplacementCandidate = {
  ticker: string;
  name: string;
  category: Category;
  /** 자산성장 행의 note 첫머리에 적힌 자리. 미정·비자산성장은 null */
  role: GrowthRole | null;
  /** 아래 5개는 ① 표의 수치 그대로. 없으면 null이고 블록에는 NA로 찍힌다 */
  aumBn: number | null;
  costPct: number | null;
  turnoverBn: number | null;
  totalReturn1y: number | null;
  price: number | null;
  /** costPct가 어느 기준의 값인가. costPct가 null이면 null이다 */
  costBasis: CostBasis | null;
  /** totalReturn1y가 어느 기간을 잰 값인가 — ① 표의 return_basis 그대로 */
  returnBasis: string;
  /** note의 "3y_ann:N%" 표기. 표에 컬럼이 없어 note로만 온다. 없으면 null */
  ann3y: string | null;
  /** note 앞부분(자리·환헤지·비용 플래그)을 뺀 나머지 — 60자에서 자른다 */
  noteSummary: string;
  /** 이 줄이 나온 ① 문서의 research_doc_id. 모르면 null */
  researchDocId: number | null;
};

/**
 * note 첫머리의 "공격 / 안정 / 미정" 표기를 자리로 읽는다 (형식 지시문의 [자리 정의]).
 *
 * 첫 글자만 보면 note 앞에 "비용:총보수만" 같은 표기가 먼저 오는 순간 자리를 놓친다.
 * 앞쪽 몇 조각만 훑어 자리를 찾고, 못 찾으면 null(= 블록에 "자리 미정")이다.
 */
function roleFromNote(note: string): GrowthRole | null {
  for (const seg of note.split(/[,/;|]/).slice(0, 3)) {
    const t = seg.trim();
    if (t.startsWith("공격")) return "aggressive";
    if (t.startsWith("안정")) return "stable";
  }
  return null;
}

/**
 * note 앞부분의 비용 플래그를 읽는다 — 표기 규칙은 parseCostFlag 하나가 정한다.
 *
 * cost_pct 자체가 없으면 null이고, 플래그가 없거나 셋 중 하나가 아니면 "ter_only"다 —
 * 표기 누락을 실부담비용으로 봐주면 가장 비싼 값을 가장 싼 값으로 읽는다(외부 검토 8차).
 */
function costBasisFromNote(
  note: string,
  costPct: number | null,
): CostBasis | null {
  if (costPct === null) return null;
  return parseCostFlag(note) ?? "ter_only";
}

/**
 * note의 "3y_ann:14.2%" 표기를 읽는다 — 3년 연환산 총수익률은 표에 컬럼이 없어 note로만 온다.
 * 기간이 다른 값이라 1년·상장 이후 수익률과 같은 칸에 넣지 않고 따로 찍는다.
 */
function ann3yFromNote(note: string): string | null {
  const m = /3y_ann\s*[:：]\s*(-?\d+(?:\.\d+)?)\s*%?/i.exec(note);
  return m ? `${m[1]}%` : null;
}

/** note 앞부분의 자리 표기 — roleFromNote와 같은 어휘를 본다 */
const SEAT_SEG = /^(공격|안정|미정)/;
/** note 앞부분의 환헤지 표기 — 형식 지시문이 정한 "H / 비H" 두 가지 */
const HEDGE_SEG = /^비?H$/i;

/**
 * note에서 "자리 / 환헤지 / 비용 플래그"를 걷어낸 나머지 — ④ 후보 줄의 비고 칸.
 * 앞에서부터 세 표기만 떼어내므로, 그 표기가 없는 옛 문서는 note가 그대로 남는다.
 */
function noteSummaryFromNote(note: string): string {
  const segs = note.split(/[,/;|]/).map((s) => s.trim());
  let i = 0;
  while (
    i < segs.length &&
    (segs[i] === "" ||
      SEAT_SEG.test(segs[i]) ||
      HEDGE_SEG.test(segs[i]) ||
      parseCostFlag(segs[i]) !== null)
  ) {
    i++;
  }
  const rest = segs.slice(i).filter(Boolean).join(", ");
  return rest.length > 60 ? `${rest.slice(0, 60)}…` : rest;
}

/**
 * 최신 ① 문서의 데이터 표에서 활성 카테고리 행만 골라 대체 종목 후보 목록을 만든다.
 *
 * ④가 웹 검색으로 새 종목을 발굴하면 ①의 후보 구성 규칙(해외 주식형·대표 상품·자리)을
 * 거치지 않은 종목이 보유로 들어온다. 고를 수 있는 목록을 시스템이 정해 준다.
 */
export function replacementCandidates(
  doc: ParsedDoc | null,
  active: Category[],
  /** 그 문서의 research_doc_id. 후보 줄에 출처로 찍는다 */
  researchDocId: number | null = null,
): ReplacementCandidate[] {
  const seen = new Set<string>();
  const out: ReplacementCandidate[] = [];
  for (const r of doc?.dataRows ?? []) {
    const category = CATEGORY_FROM_KO[r.category.trim()];
    if (!category || !active.includes(category)) continue;
    if (seen.has(r.ticker)) continue;
    seen.add(r.ticker);
    out.push({
      ticker: r.ticker,
      name: r.name.trim(),
      category,
      role: category === ROLE_CATEGORY ? roleFromNote(r.note) : null,
      aumBn: r.aumBn,
      costPct: r.costPct,
      turnoverBn: r.turnoverBn,
      totalReturn1y: r.totalReturn1y,
      price: r.price,
      costBasis: costBasisFromNote(r.note, r.costPct),
      returnBasis: r.returnBasis,
      ann3y: ann3yFromNote(r.note),
      noteSummary: noteSummaryFromNote(r.note),
      researchDocId,
    });
  }
  return out;
}

/** 후보 줄의 수치 칸 — 값이 없으면 NA다. undefined가 프롬프트에 찍히는 일이 없어야 한다 */
function numCell(label: string, v: number | null, unit: string): string {
  return `${label} ${v === null ? "NA" : `${v.toLocaleString("ko-KR")}${unit}`}`;
}

const COST_BASIS_LABEL: Record<Exclude<CostBasis, "total">, string> = {
  synthetic: "합성총보수",
  ter_only: "총보수만",
};

/**
 * 비용 칸 — 기준이 다르면 직접 비교가 성립하지 않으므로 무엇을 잰 값인지 함께 찍는다.
 * numCell을 쓰지 않는다: toLocaleString이 소수 3자리에서 끊어 0.0062를 0.006으로 만든다.
 */
function costCell(c: ReplacementCandidate): string {
  if (c.costPct === null) return "비용 NA";
  const basis =
    c.costBasis && c.costBasis !== "total"
      ? `(${COST_BASIS_LABEL[c.costBasis]})`
      : "";
  return `비용 ${c.costPct}%${basis}`;
}

/**
 * 총수익 칸 — 숫자만 찍으면 1년 수익률과 상장 3개월 수익률이 같은 값처럼 읽힌다.
 * 기간을 괄호로 붙인다: `총수익 15%(1년)` / `총수익 15%(상장 3개월)` / `총수익 NA`.
 */
function returnCell(c: ReplacementCandidate): string {
  if (c.totalReturn1y === null) return "총수익 NA";
  const v = `${c.totalReturn1y.toLocaleString("ko-KR")}%`;
  const basis = c.returnBasis.trim().toLowerCase();
  const months = /^since_listing:\s*(\d+)$/.exec(basis)?.[1];
  const period = months
    ? `상장 ${months}개월`
    : basis === "1y"
      ? "1년"
      : "기간 미상";
  return `총수익 ${v}(${period})`;
}

/**
 * 후보 목록 블록 — 주지 않으면 붙지 않는다(옛 조립과 같은 결과).
 * docDate는 그 ① 문서의 조사일 — 문서를 작성·확인한 날이지 수치의 기준일이 아니다(외부 검토 12차).
 * 어느 문서를 인용했는지 밝히려고 찍는 것이고, 수치 기준일은 전달되지 않으므로 조사일로 대체하지 않게 한다.
 * 근거 URL은 ① 문서 출처 절에 있음을 알린다(11차).
 */
function candidateBlock(
  candidates: ReplacementCandidate[],
  docDate: string | null = null,
): string {
  const lines = candidates.map(
    (c) =>
      // 카테고리는 CATEGORY_FROM_KO를 통과한 값만 오지만, 어떤 경로로든 낯선 값이 들어와도
      // 프롬프트에 "undefined"가 찍히면 안 된다
      `- ${CATEGORY_LABEL[c.category] ?? "카테고리 미상"}` +
      (c.category === ROLE_CATEGORY
        ? ` | ${c.role ? `${GROWTH_ROLE_LABEL[c.role]} 자리` : "자리 미정"}`
        : "") +
      ` | ${c.ticker} ${c.name}` +
      ` | ${numCell("순자산", c.aumBn, "억")}` +
      ` | ${costCell(c)}` +
      ` | ${numCell("거래대금", c.turnoverBn, "억")}` +
      ` | ${returnCell(c)}` +
      (c.ann3y ? ` | 3년연환산 ${c.ann3y}` : "") +
      ` | ${numCell("가격", c.price, "원")}` +
      (c.noteSummary ? ` | 비고 ${c.noteSummary}` : "") +
      (c.researchDocId !== null
        ? ` | 출처는 ① 문서 research_doc_id ${c.researchDocId}`
        : ""),
  );
  return [
    "",
    "[대체 종목 후보 — 이 목록에서만 고른다]",
    ...(lines.length
      ? lines
      : ["- (후보 없음 — 대체 종목을 제시하지 말고 replacement는 비워 둔다)"]),
    `이 목록은 최신 정기 조사 문서의 데이터 표에서 시스템이 만든 것이다. 그 문서의 조사일은 ${docDate ?? "미상"}이다.`,
    "줄에 적힌 수치도 그 표의 값이다. 조사일은 그 문서를 작성·확인한 날이지 수치의 기준일이 아니다 —",
    "수치 기준일(원자료의 날짜)은 여기 오지 않으므로 '기준일 미전달'로 적고 조사일로 대체하지 마라.",
    "수치별 근거 URL은 그 문서의 출처 절에 있고 여기에는 오지 않는다.",
    "후보 수치를 판정 근거로 인용할 때는 URL 대신 research_doc_id와 조사일을 적고, 기준일 칸은 '기준일 미전달'로 둬라.",
    "대체 종목 비교는 이 수치로 하고, 웹 검색은 최신 공시 확인에만 쓴다.",
    "총수익 칸의 괄호는 그 값이 잰 기간이다 — 기간이 다른 수익률로 우열을 매기지 마라(1년은 1년끼리, 상장 이후는 상장 이후끼리).",
    "여기에 없는 종목을 replacement로 적으면 시스템이 지운다. 웹 검색으로 새 종목을 발굴하지 마라.",
  ].join("\n");
}

export type WatchOutcome = {
  runId: number;
  docId: number | null;
  alerts: number;
  danger: number;
  /** 보유가 없어서 아무것도 하지 않은 경우 */
  skipped: boolean;
};

/** ④의 프롬프트 뒤에 붙는 출력 계약 */
export function buildAlertInstruction(
  holdings: { ticker: string; etfName: string; category: Category; qty: number; avgPrice: number }[],
  opts: {
    roles?: Map<string, GrowthRole>;
    active?: Category[];
    /** 주면 [대체 종목 후보] 블록이 붙고 그 목록 밖의 replacement는 정규화에서 지워진다 */
    candidates?: ReplacementCandidate[];
    /** 후보가 나온 ① 문서의 doc_date(YYYY-MM-DD). 후보 수치의 기준일로 블록에 찍힌다 */
    candidateDocDate?: string | null;
  } = {},
): string {
  const lines = holdings
    .map((h) => {
      const role = opts.roles?.get(`${h.category}::${h.ticker}`);
      const inactive = opts.active ? !opts.active.includes(h.category) : false;
      return (
        `- ${CATEGORY_LABEL[h.category]} | ${h.ticker} ${h.etfName} | ${h.qty}주 | 평단가 ${h.avgPrice.toLocaleString("ko-KR")}원` +
        (role ? ` | ${GROWTH_ROLE_LABEL[role]} 자리` : "") +
        (inactive ? " (적립 중단 카테고리)" : "")
      );
    })
    .join("\n");

  return `
────────────────────────────────
[점검 대상 — 지금 보유 중인 종목 전체]
${lines}${opts.candidates ? candidateBlock(opts.candidates, opts.candidateDocDate ?? null) : ""}

[판정 규칙]
- 종목마다 정확히 하나씩 판정을 낸다. 빠뜨리지 마라.
- severity: info(문제 없음) / warn(지켜볼 것) / danger(지금 조치 필요) /
  unknown(판정에 필요한 핵심 자료를 확인하지 못함 — **문제 없음이 아니다**)
- action: hold(그대로 둔다) / stop_buying(신규 매수만 중단) / sell(팔고 갈아탄다)
- **severity=unknown이면 action은 반드시 hold다.** 확인하지 못한 것을 근거로 매도·매수중단을 권하지 마라.
  replacement는 둘 다 null로 두고, 무엇을 확인하지 못했는지 issue에 적어라.
- **action=sell은 근거가 분명할 때만 써라.** 단기 가격 하락은 매도 사유가 아니다.
  상장폐지·거래정지, 운용전략의 중대한 변경, 분배 재원이 원금을 깎고 있다는 확인된 신호,
  순자산 급감으로 유동성이 위험한 경우처럼 구조적 문제일 때만 해당한다.
- action=sell이면 replacement_ticker/replacement_name에 **같은 카테고리**의 대체 종목을 넣어라.
  ${CATEGORY_LABEL[ROLE_CATEGORY]} 보유의 대체 종목은 **같은 자리**에서 고른다.
  대체 후보를 못 찾으면 둘 다 null로 두고 rationale에 이유를 적어라.
- **(적립 중단 카테고리)로 표시된 보유는 위험 판정(severity)은 동일하게 하되 action은 hold로 두고,
  매도가 필요해 보이면 그 이유를 issue에 적는다(대체 종목 없음).**
  replacement는 둘 다 null로 두고, 매도·이동 여부는 사람이 결정한다.
- sell이 아니면 replacement는 둘 다 null이다.
- issue는 무엇이 문제인지 한 줄. 문제가 없으면 "이상 없음"이라고 쓴다.
- rationale에는 판정 근거를 수치와 함께 적는다. 추측이면 추측이라고 밝혀라.
- source_urls에는 그 판정을 뒷받침하는 실제 URL만 넣는다.
- 매도는 되돌리기 어려운 행동이고 매도 손익은 계좌 정산에 반영된다(즉시 과세는 아니다). 재매수 비용도 든다.
  자료가 부족해 판단이 서지 않으면 위험 판정 대신 severity=unknown("확인 불가")으로 남기고 hold로 둬라.
- 출력은 JSON 하나뿐이며 마크다운 보고서를 쓰지 않는다.

반드시 지정된 JSON 스키마로만 응답하라.`.trim();
}

/**
 * ④ 프롬프트 조립 — 프롬프트 본문 + 판정 계약.
 * 조사 문서 형식 지시문은 붙지 않는다: ④의 출력 계약은 JSON 하나뿐이다.
 */
export function buildWatchPrompt(
  body: string,
  holdings: Parameters<typeof buildAlertInstruction>[0],
  opts: Parameters<typeof buildAlertInstruction>[1] = {},
): string {
  return [body, buildAlertInstruction(holdings, opts)].join("\n\n");
}

/** 모델 출력에서 유효한 경고만 골라낸다 */
export function normalizeAlerts(
  raw: unknown,
  holdings: { ticker: string; etfName: string; category: Category }[],
  /** 이번 회차 적립이 도는 카테고리. 주면 그 밖의 보유는 대체 종목을 비운다 */
  active?: Category[],
  /**
   * 프롬프트에 넣어 준 대체 종목 후보. 주면 이 목록 밖의 replacement는 지운다 —
   * ④가 ①의 후보 구성 규칙을 거치지 않은 종목을 새로 발굴해 오는 것을 막는다.
   */
  candidates?: ReplacementCandidate[],
): { rows: Omit<typeof holdingAlerts.$inferInsert, "runId" | "docId">[]; dropped: string[] } {
  const list = Array.isArray(raw)
    ? raw
    : ((raw as { alerts?: unknown[] } | null)?.alerts ?? []);
  const byTicker = new Map(holdings.map((h) => [h.ticker, h]));
  const allowedReplacements = candidates
    ? new Set(candidates.map((c) => c.ticker))
    : null;
  const dropped: string[] = [];
  const rows: Omit<typeof holdingAlerts.$inferInsert, "runId" | "docId">[] = [];
  const seen = new Set<string>();

  for (const item of Array.isArray(list) ? list : []) {
    const a = (item ?? {}) as Record<string, unknown>;
    const ticker = String(a.ticker ?? "").replace(/[^0-9A-Za-z]/g, "");
    const held = byTicker.get(ticker);

    // 보유하지 않은 종목에 대한 판정은 버린다 — 점검 대상이 아니다
    if (!held) {
      dropped.push(`보유하지 않은 종목: ${String(a.ticker)}`);
      continue;
    }
    if (seen.has(ticker)) {
      dropped.push(`중복 판정: ${ticker}`);
      continue;
    }
    seen.add(ticker);

    const severity = String(a.severity ?? "").trim();
    const action = String(a.action ?? "").trim();
    if (!SEVERITY.has(severity) || !ACTION.has(action)) {
      dropped.push(`알 수 없는 판정값: ${ticker} ${severity}/${action}`);
      continue;
    }

    const isSell = action === "sell";
    const rt = String(a.replacement_ticker ?? "").replace(/[^0-9A-Za-z]/g, "");
    // 적립을 멈춘 카테고리는 이번 회차 재원이 없다 — 갈아탈 곳을 시스템이 권하지 않는다
    const inactive = active ? !active.includes(held.category) : false;
    // "확인 불가"는 위험을 확인한 게 아니다 — 확인하지 못한 것을 근거로 팔게 두지 않는다
    const unknown = severity === "unknown";
    // 시스템이 준 후보 목록 밖의 종목은 ①의 후보 구성 규칙을 거치지 않은 종목이다
    const offList =
      allowedReplacements !== null && Boolean(rt) && !allowedReplacements.has(rt);
    const keepReplacement =
      isSell && Boolean(rt) && !inactive && !unknown && !offList;
    if (isSell && rt && offList) {
      dropped.push(`대체 종목 후보 목록에 없어 제외: ${ticker} → ${rt}`);
    }
    if (isSell && rt && inactive) {
      dropped.push(`적립 중단 카테고리라 대체 종목 제외: ${ticker}`);
    }
    if (isSell && rt && unknown) {
      dropped.push(`확인 불가(severity=unknown) 판정이라 대체 종목 제외: ${ticker}`);
    }
    // 재원도 대체 종목도 없는 카테고리에 매도·매수중단을 권하면 사람이 따를 길이 없다.
    // 위험 판정(severity)은 그대로 두고 조치만 hold로 내린다 — 팔지 말지는 사람이 정한다.
    const forcedHoldInactive = inactive && action !== "hold";
    if (forcedHoldInactive) {
      dropped.push(`적립 중단 카테고리라 action=${action} → hold 고정: ${ticker}`);
    }
    const forcedHoldUnknown = unknown && action !== "hold";
    if (forcedHoldUnknown) {
      dropped.push(
        `확인 불가(severity=unknown)라 action=${action} → hold 고정: ${ticker}`,
      );
    }
    const issue = String(a.issue ?? "").slice(0, 500) || "이상 없음";

    rows.push({
      ticker,
      etfName: held.etfName,
      category: held.category,
      severity: severity as "info" | "warn" | "danger" | "unknown",
      action: (forcedHoldInactive || forcedHoldUnknown ? "hold" : action) as
        | "hold"
        | "stop_buying"
        | "sell",
      // 접두는 적립 중단 고정에만 붙인다 — unknown은 화면에 "확인 불가" 뱃지로 그대로 읽힌다
      issue: forcedHoldInactive ? `${FORCED_HOLD_PREFIX}${issue}` : issue,
      replacementTicker: keepReplacement ? rt : null,
      replacementName: keepReplacement
        ? String(a.replacement_name ?? "") || null
        : null,
      rationale: String(a.rationale ?? ""),
      sourceUrls: Array.isArray(a.source_urls)
        ? a.source_urls.filter((u): u is string => typeof u === "string")
        : [],
    });
  }

  return { rows, dropped };
}

/**
 * 맥 알림을 띄울 판정 — danger 만.
 * unknown(확인 불가)은 위험을 확인한 게 아니므로 알리지 않는다. 대시보드에는 그대로 남는다.
 */
export function alertsToNotify<T extends { severity: string }>(rows: T[]): T[] {
  return rows.filter((r) => r.severity === "danger");
}

export type WatchDeps = {
  claim: (
    agent: "watch" | "consolidate",
    trigger: "schedule" | "user",
  ) => Promise<{ id: number }>;
  finish: (
    runId: number,
    status: "done" | "failed" | "auth_failed" | "timeout",
    exitCode: number | null,
    logPath: string | null,
    note?: string,
    startedAtMs?: number,
    beforePercent?: number | null,
  ) => Promise<void>;
  checkAuth: () => Promise<boolean>;
  run: (o: { runId: number; prompt: string; outputSchema?: unknown }) => Promise<{
    ok: boolean;
    exitCode: number | null;
    timedOut: boolean;
    output: string;
    logPath: string;
  }>;
  beforePercent: () => Promise<number | null>;
  notify: (title: string, message: string) => Promise<void>;
};

/**
 * 최신 ① 정기 조사 문서. ④의 대체 종목 후보와 ①의 직전 관찰 목록이 여기서 온다.
 * (orchestrator가 import한다 — watch.ts는 orchestrator를 import하지 않아 순환이 없다)
 */
export async function latestScheduledDoc() {
  const [row] = await db
    .select()
    .from(researchDocs)
    .where(eq(researchDocs.type, "scheduled"))
    .orderBy(desc(researchDocs.docDate), desc(researchDocs.id))
    .limit(1);
  return row ?? null;
}

export async function runHoldingWatch(
  deps: WatchDeps,
  trigger: "schedule" | "user" = "schedule",
): Promise<WatchOutcome> {
  const [holdings, roles, active, scheduled] = await Promise.all([
    getHoldings(),
    holdingRoles(),
    getMonthlyTopup().then(activeCategories),
    latestScheduledDoc(),
  ]);
  const candidates = replacementCandidates(
    scheduled ? parseResearchDoc(scheduled.content) : null,
    active,
    scheduled?.id ?? null,
  );
  const candidateDocDate = scheduled?.docDate ?? null;
  if (!holdings.length) {
    return { runId: 0, docId: null, alerts: 0, danger: 0, skipped: true };
  }

  const run = await deps.claim("watch", trigger);
  const startedAtMs = Date.now();
  const beforePercent = await deps.beforePercent();

  try {
    if (!(await deps.checkAuth())) {
      await deps.finish(run.id, "auth_failed", null, null);
      return { runId: run.id, docId: null, alerts: 0, danger: 0, skipped: false };
    }

    const dateKey = dateKeyKST();
    const { body } = await getPrompt("watch");
    const prompt = buildWatchPrompt(body, holdings, {
      roles,
      active,
      candidates,
      candidateDocDate,
    });

    const res = await deps.run({
      runId: run.id,
      prompt,
      outputSchema: ALERT_SCHEMA,
    });

    if (!res.ok || !res.output.trim()) {
      await deps.finish(
        run.id,
        res.timedOut ? "timeout" : "failed",
        res.exitCode,
        res.logPath,
        undefined,
        startedAtMs,
        beforePercent,
      );
      await deps.notify("보유 점검 실패", `보유 점검이 실패했습니다 (run ${run.id}).`);
      return { runId: run.id, docId: null, alerts: 0, danger: 0, skipped: false };
    }

    const parsedJson = extractJson(res.output);
    const { rows, dropped } = normalizeAlerts(
      parsedJson,
      holdings,
      active,
      candidates,
    );

    // 판정 근거를 사람이 읽을 수 있게 문서로도 남긴다 (type=watch — ③ 주입 대상 아님)
    const md = [
      `# 보유 점검 ${dateKey}`,
      "",
      ...rows.map(
        (r) =>
          `## ${r.ticker} ${r.etfName} — ${r.severity} / ${r.action}\n\n` +
          `${r.issue}\n\n${r.rationale}\n` +
          (r.replacementTicker
            ? `\n대체 후보: ${r.replacementTicker} ${r.replacementName ?? ""}\n`
            : "") +
          ((r.sourceUrls as string[]) ?? []).map((u) => `- ${u}`).join("\n"),
      ),
    ].join("\n");

    const filePath = researchPath(dateKey, "watch", run.id);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, md, "utf8");

    const [doc] = await db
      .insert(researchDocs)
      .values({
        runId: run.id,
        docDate: dateKey,
        type: "watch",
        title: `보유 점검 ${dateKey}`,
        content: md,
        parseProblems: dropped.length ? dropped : null,
        filePath,
      })
      .returning();

    // 이전 미해소 경고는 닫고 새 판정으로 교체한다
    await db
      .update(holdingAlerts)
      .set({ resolvedAt: new Date() })
      .where(isNull(holdingAlerts.resolvedAt));

    if (rows.length) {
      await db
        .insert(holdingAlerts)
        .values(rows.map((r) => ({ ...r, runId: run.id, docId: doc.id })));
    }

    const notifiable = alertsToNotify(rows);
    const danger = notifiable.length;
    await deps.finish(
      run.id,
      "done",
      res.exitCode,
      res.logPath,
      dropped.length ? `버려진 판정 ${dropped.length}건:\n- ${dropped.join("\n- ")}` : undefined,
      startedAtMs,
      beforePercent,
    );

    if (danger > 0) {
      const names = notifiable.map((r) => r.etfName).join(", ");
      await deps.notify("보유 종목 위험", `${names} — 사이트에서 확인하세요.`);
    }

    return {
      runId: run.id,
      docId: doc.id,
      alerts: rows.length,
      danger,
      skipped: false,
    };
  } catch (e) {
    await deps.finish(run.id, "failed", null, null, `예외: ${String(e)}`);
    throw e;
  }
}

/**
 * 지금 열려 있는 경고. 급한 것부터 보여준다 — danger > warn > unknown > info.
 * enum 선언 순서(unknown이 맨 뒤)를 그대로 쓰면 "확인 불가"가 "위험" 위로 올라오므로 여기서 정한다.
 */
const SEVERITY_RANK = sql`case ${holdingAlerts.severity}
  when 'danger' then 0 when 'warn' then 1 when 'unknown' then 2 else 3 end`;

export async function openAlerts() {
  return db
    .select()
    .from(holdingAlerts)
    .where(isNull(holdingAlerts.resolvedAt))
    .orderBy(SEVERITY_RANK, holdingAlerts.ticker);
}
