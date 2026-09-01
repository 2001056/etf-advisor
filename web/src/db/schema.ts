import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// 기획서 §7 데이터 설계. 금액은 전부 원 단위 정수.

export const categoryEnum = pgEnum("category", [
  "div_growth",
  "asset_growth",
  "high_div",
]);

export const agentEnum = pgEnum("agent_kind", [
  "weekly", // ① 정기 조사
  "purchase", // ② 매입 시점 조사
  "recommend", // ③ 추천
  "watch", // ④ 보유 점검 (매일 13:00)
  "consolidate", // ⑤ 종목 정리 검토 (월 1회)
]);

export const triggerEnum = pgEnum("trigger_kind", ["schedule", "user"]);

export const runStatusEnum = pgEnum("run_status", [
  "running",
  "done",
  "failed",
  "auth_failed",
  "timeout",
]);

// watch 문서는 ③ 추천의 주입 대상에서 제외된다 — 매일 쌓여서 정기 조사를 밀어내면 안 된다
export const docTypeEnum = pgEnum("doc_type", [
  "scheduled",
  "ondemand",
  "watch",
  "consolidate",
]);

export const ledgerTypeEnum = pgEnum("ledger_type", [
  "topup",
  "purchase",
  "adjust",
  // 갈아타기/매도 대금 환입(+). 카테고리 잔액으로 되돌아와 대체 매수 재원이 된다.
  "sell",
]);

export const promptSlotEnum = pgEnum("prompt_slot", [
  "weekly",
  "purchase",
  "recommend",
  "watch",
  "consolidate",
]);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    actionId: text("action_id"), // ②③ 묶음, ①은 NULL
    agent: agentEnum("agent").notNull(),
    trigger: triggerEnum("trigger").notNull(),
    status: runStatusEnum("status").notNull(),
    logPath: text("log_path"),
    logTail: text("log_tail"), // 실패 시 UI에 보여줄 로그 꼬리
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    exitCode: integer("exit_code"),
    // codex 사용량 (세션 기록에서 수집 — server/usage.ts)
    totalTokens: integer("total_tokens"),
    outputTokens: integer("output_tokens"),
    // 주간(10080분) 한도 소진율 %. 실행 직전/직후 값
    weeklyBeforePercent: integer("weekly_before_percent"),
    weeklyUsedPercent: integer("weekly_used_percent"),
    // 이 실행이 올린 소진율 = 직후 − 직전. 앱 실행분만 반영된다
    weeklyDeltaPercent: integer("weekly_delta_percent"),
    weeklyResetsAt: timestamp("weekly_resets_at", { withTimezone: true }),
  },
  (t) => [
    // 동시 실행 1개 강제 (§5.5) — running 행은 최대 1개
    uniqueIndex("agent_runs_one_running")
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const researchDocs = pgTable("research_docs", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").references(() => agentRuns.id),
  docDate: date("doc_date").notNull(),
  type: docTypeEnum("type").notNull(),
  title: text("title").notNull(), // "{type} {doc_date}" 자동 생성
  content: text("content").notNull(),
  filePath: text("file_path"), // 맥 로컬 md 사본 경로
  parseProblems: jsonb("parse_problems"), // 표준 형식 위반 목록 (있으면 대시보드 경고)
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const recommendations = pgTable("recommendations", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").references(() => agentRuns.id),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  month: text("month").notNull(), // YYYY-MM
  category: categoryEnum("category").notNull(),
  // 건너뜀(skipped)일 때는 종목이 없다 — 지어내지 않도록 nullable
  ticker: text("ticker"),
  etfName: text("etf_name"),
  budgetKrw: integer("budget_krw").notNull(), // 그 시점 카테고리 잔액 스냅샷
  refPrice: integer("ref_price"), // ②의 조사 가격 스냅샷
  refQty: integer("ref_qty"),
  // 갈아타기 제안(action="switch")일 때만: 이 보유 종목을 팔아 재원을 만든 뒤 ticker를 사라는 뜻.
  // buy/skip 추천은 셋 다 NULL.
  sellTicker: text("sell_ticker"),
  sellQty: integer("sell_qty"),
  sellRefPrice: integer("sell_ref_price"), // 매도 종목의 조사 가격 스냅샷 (대금 추정용)
  skipped: boolean("skipped").notNull().default(false), // 1주도 못 사서 이월
  rationale: text("rationale").notNull(),
  sourceDocIds: jsonb("source_doc_ids"),
  sourceUrls: jsonb("source_urls"),
});

export const alertSeverityEnum = pgEnum("alert_severity", [
  "info",
  "warn",
  "danger",
]);

export const alertActionEnum = pgEnum("alert_action", [
  "hold", // 그대로 두기
  "stop_buying", // 신규 매수만 중단
  "sell", // 매도하고 갈아타기
]);

/**
 * ④ 보유 점검이 남기는 경고. 매일 13:00에 갱신된다.
 *
 * 같은 종목의 이전 경고는 새 실행에서 resolvedAt이 찍히고 새 행이 들어온다 —
 * 지금 상태만 보는 게 아니라 "언제부터 위험했는지"를 되짚을 수 있어야 하기 때문.
 */
export const holdingAlerts = pgTable("holding_alerts", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").references(() => agentRuns.id),
  docId: integer("doc_id").references(() => researchDocs.id),
  ticker: text("ticker").notNull(),
  etfName: text("etf_name").notNull(),
  category: categoryEnum("category").notNull(),
  severity: alertSeverityEnum("severity").notNull(),
  action: alertActionEnum("action").notNull(),
  /** 무엇이 문제인지 한 줄 */
  issue: text("issue").notNull(),
  /** 갈아탈 대상 (action=sell 이고 대안을 찾은 경우) */
  replacementTicker: text("replacement_ticker"),
  replacementName: text("replacement_name"),
  rationale: text("rationale").notNull(),
  sourceUrls: jsonb("source_urls"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** 다음 점검에서 해소됐으면 그때 시각 */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/**
 * ⑤ 종목 정리 검토가 남기는 제안. 월 1회 갱신된다.
 *
 * 적립을 계속하면 같은 카테고리에 비슷한 ETF가 여러 개 쌓인다 —
 * ③이 매달 자유롭게 고르기 때문이다. 거의 같은 지수를 추종하는 것들이라
 * 분산 효과는 없으면서 관리만 번거로워지므로, 통합할 만한지 주기적으로 본다.
 *
 * 실행은 사람이 판단한다. 여기서는 "묶을 만한 것"과 근거만 남긴다.
 */
export const consolidationSuggestions = pgTable("consolidation_suggestions", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").references(() => agentRuns.id),
  docId: integer("doc_id").references(() => researchDocs.id),
  category: categoryEnum("category").notNull(),
  /** 정리 대상 종목들 (코드 배열) */
  tickers: jsonb("tickers").notNull(),
  /** 남길 종목 — 이쪽으로 모으자는 제안 */
  keepTicker: text("keep_ticker"),
  keepName: text("keep_name"),
  /** 얼마나 겹치는지 (같은 지수 추종 여부 등) */
  overlap: text("overlap").notNull(),
  /** 지금 옮기면 생기는 비용·불이익 (실현손익, 세금, 거래비용) */
  costNote: text("cost_note").notNull(),
  rationale: text("rationale").notNull(),
  sourceUrls: jsonb("source_urls"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const purchases = pgTable("purchases", {
  id: serial("id").primaryKey(),
  boughtAt: date("bought_at").notNull(),
  category: categoryEnum("category").notNull(),
  ticker: text("ticker").notNull(),
  etfName: text("etf_name").notNull(),
  qty: integer("qty").notNull(),
  unitPrice: integer("unit_price").notNull(),
  amountKrw: integer("amount_krw").notNull(),
  recommendationId: integer("recommendation_id").references(
    () => recommendations.id,
  ),
  // 갈아타기 묶음: 같은 값을 가진 sales 1행 + purchases 1행이 한 번의 교체(매도→매수)다.
  // 일반 매수는 NULL. 형식은 actionId 관례를 따라 "sw-<timestamp>".
  switchGroupId: text("switch_group_id"),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 매도 기록. 갈아타기(교체)와 단독 매도를 함께 담는다.
 *
 * 보유(getHoldings)는 purchases 합산에서 파생되므로, 매도가 생기면 여기 수량과
 * costBasisKrw 를 차감해야 보유가 실제와 맞는다 (구현 시 getHoldings 에서 sales 를 빼줄 것).
 * 잔액(ledger)에는 매도대금(amountKrw)이 type='sell' +행으로 들어가 카테고리 재원이 된다.
 * 실현손익은 매도 시점 평단가를 costBasisKrw 로 박아 고정한다 — 이후 매수가 늘어도 안 변한다.
 */
export const sales = pgTable("sales", {
  id: serial("id").primaryKey(),
  soldAt: date("sold_at").notNull(),
  category: categoryEnum("category").notNull(),
  ticker: text("ticker").notNull(),
  etfName: text("etf_name").notNull(),
  qty: integer("qty").notNull(), // 매도 수량(양수)
  unitPrice: integer("unit_price").notNull(), // 매도 체결 단가
  amountKrw: integer("amount_krw").notNull(), // 매도대금 = qty * unitPrice (수수료·세금 전)
  // 매도 시점 평단가 기준 원가 = round(avgPrice * qty). 실현손익의 기준선(스냅샷).
  costBasisKrw: integer("cost_basis_krw").notNull(),
  // 실현손익 = amountKrw - costBasisKrw (음수면 손실). 파생값이지만 조회 편의로 저장.
  realizedPnlKrw: integer("realized_pnl_krw").notNull(),
  // 갈아타기 묶음: purchases.switchGroupId 와 같은 값이면 한 번의 교체. 단독 매도는 NULL.
  switchGroupId: text("switch_group_id"),
  // 이 매도를 제안한 ③ 추천 (수동 매도면 NULL)
  recommendationId: integer("recommendation_id").references(
    () => recommendations.id,
  ),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * 받은 분배금(배당). 총수익을 보기 위한 기록이다.
 *
 * 기본적으로 잔액(ledger)에는 영향을 주지 않는다 — 월 70만 적립 규칙과 별개다.
 * 재투자하려고 잔액에 더한 경우에는 ledger에 adjust 행이 함께 생기고 그 id를 남긴다.
 */
/**
 * 일별 종가 이력. TWR(시간가중수익률)과 기간별 수익 추이의 전제다.
 *
 * TWR은 현금흐름이 있는 날마다 평가액이 필요한데, 지금까지는 가격을 실시간으로
 * 긁어 쓰기만 하고 저장하지 않아 과거 시점 평가액을 복원할 수 없었다.
 * 공식 API(공공데이터포털)가 NAV까지 주므로 괴리율도 함께 남긴다.
 */
export const prices = pgTable(
  "prices",
  {
    ticker: text("ticker").notNull(),
    /** 기준일 (거래일). 공식 API의 basDt */
    date: date("date").notNull(),
    close: integer("close").notNull(),
    nav: integer("nav"),
    /** 괴리율(%) = (종가 − NAV)/NAV × 100. 소수 둘째 자리까지 ×100 정수로 보관 */
    premiumBp: integer("premium_bp"),
    volume: integer("volume"),
    /** official = 공공데이터포털, naver = 폴링 API */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.ticker, t.date] })],
);

export const dividends = pgTable("dividends", {
  id: serial("id").primaryKey(),
  receivedAt: date("received_at").notNull(),
  category: categoryEnum("category").notNull(),
  ticker: text("ticker").notNull(),
  etfName: text("etf_name").notNull(),
  /** 세후 실수령액. 총수익 집계의 기준값 */
  amountKrw: integer("amount_krw").notNull(),
  /** 세전 총액. 모르면 null — 그 경우 세전 뷰에서 amountKrw로 대체한다 */
  grossKrw: integer("gross_krw"),
  /** 원천징수 세액. grossKrw − amountKrw 와 맞아야 한다 */
  taxKrw: integer("tax_krw"),
  // 잔액에 더했다면 그때 만든 ledger 행
  refLedgerId: integer("ref_ledger_id"),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ledger = pgTable(
  "ledger",
  {
    id: serial("id").primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    type: ledgerTypeEnum("type").notNull(),
    category: categoryEnum("category").notNull(),
    amountKrw: integer("amount_krw").notNull(), // ± 원
    // topup 전용: 이 돈이 쓰일 매입 대상 달(YYYY-MM). purchase/adjust는 NULL (§2.2)
    month: text("month"),
    refPurchaseId: integer("ref_purchase_id"),
    // type='sell' 대금 환입 행이 가리키는 sales.id (purchase↔refPurchaseId 대칭)
    refSaleId: integer("ref_sale_id"),
    memo: text("memo"),
  },
  (t) => [
    // 충전 멱등키: 같은 달·같은 카테고리 topup은 1회만 (§2.2-5)
    uniqueIndex("ledger_topup_month_category")
      .on(t.month, t.category)
      .where(sql`${t.type} = 'topup'`),
  ],
);

export const purchaseCycles = pgTable("purchase_cycles", {
  month: text("month").primaryKey(), // 매입이 이뤄진 달 YYYY-MM
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const prompts = pgTable("prompts", {
  slot: promptSlotEnum("slot").primaryKey(),
  body: text("body").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
