import Link from "next/link";
import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, researchDocs } from "@/db/schema";
import { getBalances, getCycle, isOnboarded, runLazyTopup } from "@/domain/ledger";
import { getHoldings, holdingRoles } from "@/domain/purchases";
import { GROWTH_ROLE_LABEL } from "@/domain/recommendation";
import { getQuotes } from "@/domain/quotes";
import { getLivePrices } from "@/server/livePrice";
import { dividendsByTicker, returnByCategory } from "@/domain/dividends";
import { getPerformance } from "@/domain/performance";
import { snapshotPrices } from "@/domain/prices";
import { computeDrift, targetsFromTopup } from "@/domain/drift";
import { openAlerts } from "@/server/watch";
import { openConsolidations } from "@/server/consolidate";
import { getMonthlyTopup } from "@/domain/ledger";
import { dividendTotals } from "@/domain/dividends";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  Category,
  dateKeyKST,
  formatKRW,
  monthKeyKST,
} from "@/domain/money";
import { buttonClass, Card, Notice, Page } from "@/components/ui";

export const dynamic = "force-dynamic";

const signed = (n: number) =>
  `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("ko-KR")}`;
const signColor = (n: number) => (n >= 0 ? "text-red-600" : "text-blue-600");
const pctText = (p: number | null) =>
  p === null ? "—" : `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(2)}%`;

export default async function DashboardPage() {
  if (!(await isOnboarded())) redirect("/onboarding");
  await runLazyTopup();

  const [balances, holdings, cycle, quotes, lastRun, lastDoc] =
    await Promise.all([
      getBalances(),
      getHoldings(),
      getCycle(),
      getQuotes(),
      db
        .select()
        .from(agentRuns)
        .orderBy(desc(agentRuns.id))
        .limit(1)
        .then((r) => r[0] ?? null),
      db
        .select({
          docDate: researchDocs.docDate,
          id: researchDocs.id,
          parseProblems: researchDocs.parseProblems,
        })
        .from(researchDocs)
        .orderBy(desc(researchDocs.docDate), desc(researchDocs.id))
        .limit(1)
        .then((r) => r[0] ?? null),
    ]);

  const total = CATEGORIES.reduce((s, c) => s + balances[c], 0);
  const day = Number(dateKeyKST().slice(8, 10));
  const inWindow = day >= 15 && day <= 20;

  // 조사 문서 가격은 마지막 조사 시점 스냅샷이라, 보유 종목은 현재가를 한 번 긁어와 덮어쓴다.
  // 실패하면 조용히 조사 문서 값으로 되돌아간다.
  const live = await getLivePrices(holdings.map((h) => h.ticker));

  // 오늘자 종가를 남겨둔다 — TWR과 기간 추이는 과거 평가액이 있어야 계산된다.
  // 실패해도 화면을 막지 않는다.
  void snapshotPrices(holdings.map((h) => h.ticker)).catch(() => {});

  const enriched = holdings.map((h) => {
    const q = quotes.get(h.ticker);
    const l = live.get(h.ticker);

    const price = l?.price ?? q?.price ?? null;
    const value = price != null ? price * h.qty : null;
    // 분배율은 실시간 소스에 없으므로 조사 문서 값을 쓴다
    const dividend =
      value != null && q?.distYield != null
        ? Math.round((value * q.distYield) / 100)
        : null;

    return { ...h, quote: q ?? null, live: l ?? null, price, value, dividend };
  });

  // 총수익 = 평가손익 + 받은 분배금
  const priceOf = (t: string) =>
    live.get(t)?.price ?? quotes.get(t)?.price ?? null;
  const [alerts, consolidations, roles] = await Promise.all([
    openAlerts(),
    openConsolidations(),
    holdingRoles(),
  ]);
  const [ret, divByTicker, divTotals, topup] = await Promise.all([
    returnByCategory(holdings, priceOf),
    dividendsByTicker(),
    dividendTotals(),
    getMonthlyTopup(),
  ]);

  // 목표 비중 대비 실제 비중 이탈 — 현재 상태만 보여주고 리밸런싱 규칙은 두지 않는다
  const drift = computeDrift(
    Object.fromEntries(
      CATEGORIES.map((c) => [
        c,
        ret.rows.find((r) => r.category === c)?.valueKrw ?? 0,
      ]),
    ) as Record<Category, number>,
    targetsFromTopup(topup),
  );
  const summary = ret.total;

  // 연환산 수익률(XIRR) — 적립식에서는 "돈이 얼마나 오래 일했는지"가 반영돼야 한다
  const perf = await getPerformance({
    marketValue: summary.valueKrw,
    cashBalance: total,
    partial: summary.partial,
  });

  const anyLive = enriched.some((h) => h.live);
  const liveAt = enriched.find((h) => h.live)?.live ?? null;

  const totalValue = enriched.reduce((s, h) => s + (h.value ?? 0), 0);
  const totalDividend = enriched.reduce((s, h) => s + (h.dividend ?? 0), 0);
  const totalCost = enriched.reduce((s, h) => s + h.costKrw, 0);
  const hasValues = enriched.some((h) => h.value != null);

  return (
    <Page current="/">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">대시보드</h1>
        <span className="text-sm text-neutral-500">{dateKeyKST()}</span>
      </div>

      {inWindow && !cycle && (
        <Notice kind="warn">
          이번 달 매입 기간(15~20일)입니다. 매입 후 기록하고 마감을 누르면
          다음날 다음 달 충전이 들어옵니다.
        </Notice>
      )}

      {lastRun?.status === "auth_failed" && (
        <Notice kind="error">
          Codex 로그인이 만료되어 조사가 실패했습니다. 터미널에서{" "}
          <code>codex login</code> 을 다시 실행하세요.
        </Notice>
      )}

      {alerts.length > 0 && alerts.some((a) => a.severity !== "info") && (
        <Card
          title="보유 종목 점검"
          action={
            <span className="text-xs text-neutral-500">매일 13:00 자동 점검</span>
          }
        >
          <div className="space-y-3">
            {alerts
              .filter((a) => a.severity !== "info")
              .map((a) => (
                <div
                  key={a.id}
                  className={`rounded-lg border p-4 ${
                    a.severity === "danger"
                      ? "border-red-300 bg-red-50"
                      : a.severity === "unknown"
                        ? "border-neutral-300 bg-neutral-50"
                        : "border-amber-300 bg-amber-50"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        a.severity === "danger"
                          ? "bg-red-600 text-white"
                          : a.severity === "unknown"
                            ? "bg-neutral-500 text-white"
                            : "bg-amber-500 text-white"
                      }`}
                    >
                      {a.severity === "danger"
                        ? "위험"
                        : a.severity === "unknown"
                          ? "확인 불가"
                          : "주의"}
                    </span>
                    <span className="font-semibold">{a.etfName}</span>
                    <span className="text-neutral-500">{a.ticker}</span>
                    <span className="text-xs text-neutral-500">
                      {CATEGORY_LABEL[a.category as Category]}
                    </span>
                    <span
                      className={`ml-auto rounded px-2 py-0.5 text-xs ${
                        a.action === "sell"
                          ? "bg-red-100 text-red-800"
                          : a.action === "stop_buying"
                            ? "bg-amber-100 text-amber-900"
                            : "bg-neutral-100 text-neutral-700"
                      }`}
                    >
                      {a.action === "sell"
                        ? "매도·교체 검토"
                        : a.action === "stop_buying"
                          ? "신규 매수 중단"
                          : "보유 유지"}
                    </span>
                  </div>

                  <p className="mt-2 text-sm font-medium">{a.issue}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">
                    {a.rationale}
                  </p>

                  {a.replacementTicker && (
                    <p className="mt-2 text-sm">
                      <b>대체 후보</b> — {a.replacementName ?? ""}{" "}
                      <span className="text-neutral-500">
                        {a.replacementTicker}
                      </span>{" "}
                      <Link href="/switch" className="ml-1 underline">
                        갈아타기 기록하기
                      </Link>
                    </p>
                  )}

                  {Array.isArray(a.sourceUrls) &&
                    (a.sourceUrls as string[]).length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-xs">
                        {(a.sourceUrls as string[]).slice(0, 4).map((u, i) => (
                          <li key={`${u}-${i}`}>
                            <a
                              href={u}
                              target="_blank"
                              rel="noreferrer"
                              className="text-blue-700 underline"
                            >
                              {u}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                </div>
              ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            매도는 되돌리기 어렵고 세금·재매수 비용이 따릅니다. 근거를 직접 확인하고
            판단하세요 — 이 경고는 참고 자료입니다.
          </p>
        </Card>
      )}

      <Card
        title={`카테고리별 잔액 · 합계 ${formatKRW(total)}`}
        action={
          <Link href="/recommend" className={buttonClass}>
            매입 추천 받기
          </Link>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3">
          {CATEGORIES.map((c) => (
            <div key={c} className="rounded-lg border border-neutral-200 p-4">
              <div className="text-sm text-neutral-600">{CATEGORY_LABEL[c]}</div>
              <div className="mt-1 text-lg font-bold tabular-nums">
                {formatKRW(balances[c])}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          {cycle
            ? `${monthKeyKST()} 매입 마감됨 — 다음날 충전 예정`
            : `${monthKeyKST()} 아직 마감 전`}
        </p>
      </Card>

      {summary.costKrw > 0 && (
        <Card
          title="총수익"
          action={
            <Link
              href="/dividends"
              className="text-sm text-neutral-500 hover:underline"
            >
              분배금 기록
            </Link>
          }
        >
          {(perf.security.annualPct !== null ||
            perf.portfolio.annualPct !== null) && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border-2 border-neutral-800 p-4">
                <div className="text-sm font-medium text-neutral-800">
                  연환산 수익률 · 투자된 돈 기준
                </div>
                <div
                  className={`mt-1 text-2xl font-bold tabular-nums ${
                    (perf.security.annualPct ?? 0) >= 0
                      ? "text-red-600"
                      : "text-blue-600"
                  }`}
                >
                  {perf.security.annualPct === null
                    ? "—"
                    : `${perf.security.annualPct >= 0 ? "+" : "−"}${Math.abs(perf.security.annualPct).toFixed(2)}%`}
                </div>
                <div className="text-xs text-neutral-500">
                  매입·분배금 흐름 기준 (XIRR)
                  {perf.security.usedFallback && " · 근사값"}
                </div>
              </div>

              <div className="rounded-lg border border-neutral-200 p-4">
                <div className="text-sm text-neutral-600">
                  연환산 수익률 · 넣은 돈 전체 기준
                </div>
                <div
                  className={`mt-1 text-2xl font-bold tabular-nums ${
                    (perf.portfolio.annualPct ?? 0) >= 0
                      ? "text-red-600"
                      : "text-blue-600"
                  }`}
                >
                  {perf.portfolio.annualPct === null
                    ? "—"
                    : `${perf.portfolio.annualPct >= 0 ? "+" : "−"}${Math.abs(perf.portfolio.annualPct).toFixed(2)}%`}
                </div>
                <div className="text-xs text-neutral-500">
                  안 쓰고 남긴 잔액까지 포함
                  {perf.portfolio.usedFallback && " · 근사값"}
                </div>
              </div>
            </div>
          )}

          <div className="mb-4 rounded-lg border border-neutral-200 p-4">
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-sm text-neutral-600">
                시간가중수익률 (TWR)
              </span>
              {perf.twr ? (
                <>
                  <span
                    className={`text-lg font-bold tabular-nums ${signColor(perf.twr.cumulativePct)}`}
                  >
                    누적 {perf.twr.cumulativePct >= 0 ? "+" : "−"}
                    {Math.abs(perf.twr.cumulativePct).toFixed(2)}%
                  </span>
                  {perf.twr.annualPct !== null && (
                    <span className="text-sm text-neutral-500 tabular-nums">
                      연환산 {perf.twr.annualPct >= 0 ? "+" : "−"}
                      {Math.abs(perf.twr.annualPct).toFixed(2)}%
                    </span>
                  )}
                  <span className="text-xs text-neutral-400">
                    {perf.twr.days}일 · 납입 시점 영향 제거
                  </span>
                </>
              ) : (
                <span className="text-sm text-neutral-400">
                  {perf.twrReason ?? "계산할 수 없습니다"}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              내가 언제 얼마를 넣었는지와 무관한 &lsquo;종목 자체의 성과&rsquo;입니다.
              위 연환산 수익률(XIRR)이 본인 성과에 가깝고, 이건 보조 지표입니다.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-neutral-200 p-4">
              <div className="text-sm text-neutral-600">주가 손익</div>
              <div
                className={`mt-1 text-xl font-bold tabular-nums ${signColor(summary.priceGainKrw)}`}
              >
                {signed(summary.priceGainKrw)}
              </div>
              <div className="text-xs text-neutral-500 tabular-nums">
                {pctText(summary.priceGainPct)}
              </div>
            </div>

            <div className="rounded-lg border border-neutral-200 p-4">
              <div className="text-sm text-neutral-600">배당 수익 (세후)</div>
              <div className="mt-1 text-xl font-bold tabular-nums text-green-700">
                {signed(summary.dividendKrw)}
              </div>
              <div className="text-xs text-neutral-500 tabular-nums">
                {pctText(summary.dividendPct)}
                {divTotals.tax > 0 &&
                  ` · 세전 ${divTotals.gross.toLocaleString("ko-KR")} − 세금 ${divTotals.tax.toLocaleString("ko-KR")}`}
              </div>
            </div>

            <div className="rounded-lg border-2 border-neutral-800 p-4">
              <div className="text-sm font-medium text-neutral-800">
                합계 수익
              </div>
              <div
                className={`mt-1 text-xl font-bold tabular-nums ${signColor(summary.totalKrw)}`}
              >
                {signed(summary.totalKrw)}
              </div>
              <div className="text-xs text-neutral-600 tabular-nums">
                누적 · 원금 대비 {pctText(summary.totalPct)}
              </div>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-2">구분</th>
                  <th className="text-right">매입원금</th>
                  <th className="text-right">평가액</th>
                  <th className="text-right">주가 손익</th>
                  <th className="text-right">배당 수익</th>
                  <th className="text-right">합계 수익</th>
                  <th className="text-right">수익률</th>
                </tr>
              </thead>
              <tbody>
                {ret.rows.map((r) => (
                  <tr key={r.category} className="border-b border-neutral-100">
                    <td className="py-2">{CATEGORY_LABEL[r.category]}</td>
                    {r.costKrw === 0 ? (
                      <td className="text-right text-neutral-400" colSpan={6}>
                        보유 없음
                      </td>
                    ) : (
                      <>
                        <td className="text-right tabular-nums">
                          {r.costKrw.toLocaleString("ko-KR")}
                        </td>
                        <td className="text-right tabular-nums">
                          {r.valueKrw.toLocaleString("ko-KR")}
                          {r.partial && (
                            <span
                              className="ml-1 text-xs text-amber-600"
                              title="현재가를 못 구한 종목이 있어 원금으로 계산했습니다"
                            >
                              *
                            </span>
                          )}
                        </td>
                        <td
                          className={`text-right tabular-nums ${signColor(r.priceGainKrw)}`}
                        >
                          {signed(r.priceGainKrw)}
                        </td>
                        <td className="text-right tabular-nums text-green-700">
                          {r.dividendKrw > 0 ? signed(r.dividendKrw) : "—"}
                        </td>
                        <td
                          className={`text-right font-semibold tabular-nums ${signColor(r.totalKrw)}`}
                        >
                          {signed(r.totalKrw)}
                        </td>
                        <td
                          className={`text-right tabular-nums ${signColor(r.totalKrw)}`}
                        >
                          {pctText(r.totalPct)}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className="py-2">합계</td>
                  <td className="text-right tabular-nums">
                    {summary.costKrw.toLocaleString("ko-KR")}
                  </td>
                  <td className="text-right tabular-nums">
                    {summary.valueKrw.toLocaleString("ko-KR")}
                  </td>
                  <td
                    className={`text-right tabular-nums ${signColor(summary.priceGainKrw)}`}
                  >
                    {signed(summary.priceGainKrw)}
                  </td>
                  <td className="text-right tabular-nums text-green-700">
                    {signed(summary.dividendKrw)}
                  </td>
                  <td
                    className={`text-right tabular-nums ${signColor(summary.totalKrw)}`}
                  >
                    {signed(summary.totalKrw)}
                  </td>
                  <td
                    className={`text-right tabular-nums ${signColor(summary.totalKrw)}`}
                  >
                    {pctText(summary.totalPct)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="mt-3 text-xs text-neutral-500">
            <b>연환산 수익률</b>은 납입 시점을 반영한 XIRR입니다 — 적립식에서는
            같은 70만원이라도 3년 전 넣은 돈과 이번 달 넣은 돈의 무게가 다르기 때문에,
            아래의 &lsquo;원금 대비&rsquo; 비율보다 이쪽이 실제 성과에 가깝습니다.
            <b> 투자된 돈 기준</b>은 실제로 매수에 들어간 돈만, <b>넣은 돈 전체 기준</b>은
            아직 안 쓰고 남긴 잔액까지 포함합니다(잔액을 놀린 대가가 반영됨).
            두 값은 서로 다른 질문에 답하므로 합산되지 않습니다.
            {" "}합계 수익 = 주가 손익 + 배당 수익이며, 분배금은 잔액에 더해지지 않고
            수익으로만 잡힙니다. 평가액은 현재가 기준 참고치입니다.
            {summary.partial &&
              " (*) 표시는 현재가를 못 구해 원금으로 계산한 항목이라, 연환산 수익률도 그만큼 부정확합니다."}
          </p>
        </Card>
      )}

      {drift.measurable && (
        <Card title="목표 비중 대비 현재 비중">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-2">구분</th>
                  <th className="text-right">평가액</th>
                  <th className="text-right">현재 비중</th>
                  <th className="text-right">목표</th>
                  <th className="text-right">이탈</th>
                  <th className="w-40">　</th>
                  <th className="text-right">맞추려면</th>
                </tr>
              </thead>
              <tbody>
                {drift.rows.map((r) => {
                  const over = r.driftPp >= 0;
                  const w = Math.min(100, (Math.abs(r.driftPp) / 15) * 100);
                  return (
                    <tr key={r.category} className="border-b border-neutral-100">
                      <td className="py-2">{CATEGORY_LABEL[r.category]}</td>
                      <td className="text-right tabular-nums">
                        {r.valueKrw.toLocaleString("ko-KR")}
                      </td>
                      <td className="text-right font-medium tabular-nums">
                        {r.actualPct.toFixed(1)}%
                      </td>
                      <td className="text-right tabular-nums text-neutral-500">
                        {r.targetPct.toFixed(0)}%
                      </td>
                      <td
                        className={`text-right tabular-nums ${
                          Math.abs(r.driftPp) < 0.05
                            ? "text-neutral-400"
                            : over
                              ? "text-amber-700"
                              : "text-blue-700"
                        }`}
                      >
                        {Math.abs(r.driftPp) < 0.05
                          ? "—"
                          : `${over ? "+" : "−"}${Math.abs(r.driftPp).toFixed(1)}%p`}
                      </td>
                      <td>
                        {/* 가운데를 목표로 두고 좌우로 벌어지는 막대 */}
                        <div className="relative h-2 w-full rounded-full bg-neutral-100">
                          <div className="absolute left-1/2 top-0 h-2 w-px bg-neutral-400" />
                          <div
                            className={`absolute top-0 h-2 ${over ? "left-1/2 rounded-r-full bg-amber-400" : "right-1/2 rounded-l-full bg-blue-400"}`}
                            style={{ width: `${w / 2}%` }}
                          />
                        </div>
                      </td>
                      <td
                        className={`text-right tabular-nums ${r.gapKrw > 0 ? "text-neutral-700" : "text-neutral-400"}`}
                      >
                        {Math.abs(r.gapKrw) < 1000
                          ? "—"
                          : r.gapKrw > 0
                            ? `+${r.gapKrw.toLocaleString("ko-KR")}`
                            : `${r.gapKrw.toLocaleString("ko-KR")}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            목표 비중은 설정의 월 충전액에서 나옵니다(현재 {drift.rows.map((r) => `${r.targetPct.toFixed(0)}`).join("/")}).
            &lsquo;맞추려면&rsquo;은 지금 비중을 목표로 되돌리는 데 필요한 금액입니다 — 양수면 더 사야 하는 쪽입니다.
            <b> 언제 리밸런싱할지는 정해두지 않았습니다</b> — 달력 기준·임계값 기준 중
            무엇이 나은지 근거를 찾지 못해, 현재 상태만 보여주고 판단은 남겨둡니다.
          </p>
        </Card>
      )}

      <Card title="보유 현황">
        {enriched.length === 0 ? (
          <p className="text-sm text-neutral-500">
            아직 매입 기록이 없습니다.{" "}
            <Link href="/purchases" className="underline">
              매입 기록에서 추가
            </Link>
            하세요.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-2">구분</th>
                  <th>종목</th>
                  <th className="text-right">보유수량</th>
                  <th className="text-right">평단가</th>
                  <th className="text-right">매입원금</th>
                  <th className="text-right">현재가</th>
                  <th className="text-right">현재금액</th>
                  <th className="text-right">받은 분배금</th>
                  <th className="text-right">배당금 예상(연)</th>
                </tr>
              </thead>
              <tbody>
                {enriched.map((h) => (
                  <tr
                    key={`${h.category}-${h.ticker}`}
                    className="border-b border-neutral-100"
                  >
                    <td className="py-2">
                      {CATEGORY_LABEL[h.category]}
                      {roles.get(`${h.category}::${h.ticker}`) && (
                        <span className="ml-1 rounded bg-indigo-100 px-1.5 py-0.5 text-xs text-indigo-800">
                          {
                            GROWTH_ROLE_LABEL[
                              roles.get(`${h.category}::${h.ticker}`)!
                            ]
                          }
                        </span>
                      )}
                    </td>
                    <td>
                      {h.etfName}{" "}
                      <span className="text-neutral-400">{h.ticker}</span>
                    </td>
                    <td className="text-right tabular-nums">{h.qty}주</td>
                    <td className="text-right tabular-nums">
                      {h.avgPrice.toLocaleString("ko-KR")}
                    </td>
                    <td className="text-right tabular-nums">
                      {h.costKrw.toLocaleString("ko-KR")}
                    </td>
                    <td className="text-right tabular-nums">
                      {h.price != null ? (
                        <>
                          {h.price.toLocaleString("ko-KR")}
                          {h.live ? (
                            h.live.change != null && h.live.change !== 0 ? (
                              <span
                                className={`ml-1 text-xs ${
                                  h.live.change > 0
                                    ? "text-red-600"
                                    : "text-blue-600"
                                }`}
                              >
                                {h.live.change > 0 ? "▲" : "▼"}
                                {Math.abs(h.live.change).toLocaleString("ko-KR")}
                              </span>
                            ) : null
                          ) : (
                            <span
                              className="ml-1 text-xs text-amber-600"
                              title={`${h.quote?.asOf ?? ""} 조사 문서 기준`}
                            >
                              (문서)
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      {h.value != null ? (
                        <>
                          {h.value.toLocaleString("ko-KR")}
                          {h.costKrw > 0 && (
                            <span
                              className={`ml-1 text-xs ${
                                h.value >= h.costKrw
                                  ? "text-red-600"
                                  : "text-blue-600"
                              }`}
                            >
                              {h.value >= h.costKrw ? "+" : ""}
                              {(
                                ((h.value - h.costKrw) / h.costKrw) *
                                100
                              ).toFixed(1)}
                              %
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums text-green-700">
                      {(() => {
                        const got = divByTicker.get(`${h.category}:${h.ticker}`);
                        return got ? `+${got.toLocaleString("ko-KR")}` : "—";
                      })()}
                    </td>
                    <td className="text-right tabular-nums">
                      {h.dividend != null ? (
                        <>
                          {h.dividend.toLocaleString("ko-KR")}
                          {h.quote?.distYieldStale && h.quote.distYieldAsOf && (
                            <span
                              className="ml-1 text-xs text-amber-600"
                              title={`분배율 ${h.quote.distYield}% — ${h.quote.distYieldAsOf} 조사 문서 값`}
                            >
                              ({Number(h.quote.distYieldAsOf.slice(5, 7))}/
                              {Number(h.quote.distYieldAsOf.slice(8, 10))} 기준)
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-neutral-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {hasValues && (
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-2" colSpan={4}>
                      합계
                    </td>
                    <td className="text-right tabular-nums">
                      {totalCost.toLocaleString("ko-KR")}
                    </td>
                    <td />
                    <td className="text-right tabular-nums">
                      {totalValue.toLocaleString("ko-KR")}
                      {totalCost > 0 && (
                        <span
                          className={`ml-1 text-xs ${
                            totalValue >= totalCost
                              ? "text-red-600"
                              : "text-blue-600"
                          }`}
                        >
                          {totalValue >= totalCost ? "+" : ""}
                          {(
                            ((totalValue - totalCost) / totalCost) *
                            100
                          ).toFixed(1)}
                          %
                        </span>
                      )}
                    </td>
                    <td className="text-right tabular-nums text-green-700">
                      {summary.dividendKrw > 0
                        ? `+${summary.dividendKrw.toLocaleString("ko-KR")}`
                        : "—"}
                    </td>
                    <td className="text-right tabular-nums">
                      {totalDividend.toLocaleString("ko-KR")}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
            <p className="mt-3 text-xs text-neutral-500">
              {anyLive ? (
                <>
                  현재가는 화면을 열 때 네이버 금융에서 가져옵니다
                  {liveAt && (
                    <>
                      {" "}
                      (
                      {new Intl.DateTimeFormat("ko-KR", {
                        timeZone: "Asia/Seoul",
                        hour: "2-digit",
                        minute: "2-digit",
                      }).format(liveAt.tradedAt)}{" "}
                      기준
                      {liveAt.marketStatus === "OPEN" ? " · 장중" : " · 장마감"})
                    </>
                  )}
                  . 30초간 캐시하며, 못 가져온 종목은 <b>(문서)</b> 표시와 함께
                  마지막 조사 값을 씁니다. 배당금 예상액은 조사 문서의 분배율
                  기준입니다.
                </>
              ) : hasValues ? (
                `현재가를 가져오지 못해 ${lastDoc?.docDate ?? ""} 조사 문서 값을 쓰고 있습니다.`
              ) : (
                "보유 종목의 현재가는 화면을 열 때 가져옵니다. 배당금 예상액은 조사 문서가 있어야 계산됩니다."
              )}
            </p>
          </div>
        )}
      </Card>

      {consolidations.length > 0 && (
        <Card
          title="종목 정리 검토"
          action={
            <span className="text-xs text-neutral-500">매월 1회 자동 검토</span>
          }
        >
          <div className="space-y-3">
            {consolidations.map((c) => (
              <div
                key={c.id}
                className="rounded-lg border border-neutral-200 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-neutral-900 px-2 py-0.5 text-xs text-white">
                    {CATEGORY_LABEL[c.category as Category]}
                  </span>
                  <span className="text-sm font-medium">
                    {(c.tickers as string[]).join(" · ")}
                  </span>
                  {c.keepTicker && (
                    <span className="ml-auto rounded bg-green-100 px-2 py-0.5 text-xs text-green-800">
                      {c.keepName ?? c.keepTicker} 로 모으기
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm">
                  <b>겹침</b> {c.overlap}
                </p>
                <p className="mt-1 text-sm text-amber-800">
                  <b>옮길 때 비용</b> {c.costNote}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-700">
                  {c.rationale}
                </p>
                {Array.isArray(c.sourceUrls) &&
                  (c.sourceUrls as string[]).length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-xs">
                      {(c.sourceUrls as string[]).slice(0, 4).map((u, i) => (
                        <li key={`${u}-${i}`}>
                          <a
                            href={u}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-700 underline"
                          >
                            {u}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            제안일 뿐 실행은 직접 판단하세요. 굳이 팔지 않고 <b>신규 매수만 한쪽으로
            모으는</b> 방법도 있습니다 — 그러면 실현손익·거래비용이 들지 않습니다.
          </p>
        </Card>
      )}

      <Card
        title="에이전트 상태"
        action={
          <Link href="/runs" className="text-sm text-neutral-500 hover:underline">
            실행 이력
          </Link>
        }
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-neutral-500">마지막 조사 문서</dt>
            <dd className="mt-0.5">
              {lastDoc ? (
                <Link href={`/docs/${lastDoc.id}`} className="underline">
                  {lastDoc.docDate}
                </Link>
              ) : (
                <span className="text-neutral-400">
                  아직 없음 — 월/목 07:30에 자동 실행됩니다
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">마지막 실행</dt>
            <dd className="mt-0.5">
              {lastRun ? (
                <>
                  {lastRun.status === "running" ? "실행 중" : lastRun.status}{" "}
                  <span className="text-neutral-400">
                    (
                    {new Intl.DateTimeFormat("ko-KR", {
                      timeZone: "Asia/Seoul",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(lastRun.startedAt)}
                    )
                  </span>
                </>
              ) : (
                <span className="text-neutral-400">없음</span>
              )}
            </dd>
          </div>
        </dl>
      </Card>
    </Page>
  );
}
