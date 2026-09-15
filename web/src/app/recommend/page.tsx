import Link from "next/link";
import { redirect } from "next/navigation";
import { getBalances, isOnboarded, runLazyTopup } from "@/domain/ledger";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  Category,
  dateKeyKST,
  formatKRW,
} from "@/domain/money";
import { computeRefQty, isDrift } from "@/domain/recommendation";
import { getAllPrompts } from "@/domain/prompts";
import { acceptedRecommendationIds } from "@/domain/purchases";
import {
  getRunningRun,
  latestRecommendation,
  tickersToResearch,
} from "@/server/orchestrator";
import { getRealtimePrices, RealtimePrice } from "@/server/livePrice";
import { Card, Notice, Page } from "@/components/ui";
import Runner from "./runner";
import AcceptForm from "./accept";

export const dynamic = "force-dynamic";

/** 기준 시각을 KST 시:분으로 */
function hhmmKST(d: Date): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** "9/11" — KST 기준 */
function mdKST(d: Date): string {
  const [, m, day] = dateKeyKST(d).split("-");
  return `${Number(m)}/${Number(day)}`;
}

/**
 * 저장된 기준 시각 표기. 오늘이 아니면 날짜를 앞에 붙인다 —
 * 시·분만 보이면 지난 영업일 종가가 오늘 값처럼 읽힌다.
 */
function stampKST(d: Date | null): string {
  if (!d) return "";
  return dateKeyKST(d) === dateKeyKST()
    ? hhmmKST(d)
    : `${mdKST(d)} ${hhmmKST(d)}`;
}

/** 방금 조회한 시세를 뭐라고 부를지 — 휴장일 종가를 "지금 시세"로 보여주지 않는다 */
function quoteLabel(q: RealtimePrice): string {
  if (dateKeyKST(q.pricedAt) !== dateKeyKST()) return `${mdKST(q.pricedAt)} 종가`;
  return q.marketStatus === "OPEN"
    ? `지금 시세 ${hhmmKST(q.pricedAt)}`
    : `오늘 종가 ${hhmmKST(q.pricedAt)}`;
}

export default async function RecommendPage() {
  if (!(await isOnboarded())) redirect("/onboarding");
  await runLazyTopup();

  const [balances, running, latest, tickers, prompts] = await Promise.all([
    getBalances(),
    getRunningRun(),
    latestRecommendation(),
    tickersToResearch(),
    getAllPrompts(),
  ]);

  const placeholders = (["purchase", "recommend"] as const).filter(
    (s) => prompts[s].isPlaceholder,
  );

  // 저장된 기준가는 추천을 돌린 시점의 값이다. 화면을 여는 지금 값도 같이 보여준다.
  const quoteTickers = [
    ...new Set(
      (latest?.picks ?? [])
        .flatMap((p) => [p.ticker, p.sellTicker])
        .filter((t): t is string => Boolean(t)),
    ),
  ];
  const [acceptedIds, now] = await Promise.all([
    acceptedRecommendationIds(latest?.picks.map((p) => p.id) ?? []),
    quoteTickers.length
      ? getRealtimePrices(quoteTickers)
      : Promise.resolve(new Map<string, RealtimePrice>()),
  ]);
  // 렌더 시점 조회라 두 탭을 열면 TOCTOU가 남는다 — 최종 방어는 DB 유니크다
  const accepted = new Set(acceptedIds);

  type Pick = NonNullable<typeof latest>["picks"][number];
  /** 조사가에서 ±30% 넘게 벌어진 시세는 오파싱으로 보고 화면에서도 버린다 */
  const nowOf = (p: Pick) => {
    const q = p.ticker ? (now.get(p.ticker) ?? null) : null;
    if (!q) return null;
    return isDrift(q.price, p.researchPrice ?? p.refPrice) ? null : q;
  };
  /** 지금 시세로 다시 세어 본 수량 — 표시 전용이라 저장된 refQty는 건드리지 않는다 */
  const nowQtyOf = (p: Pick) => {
    const price = nowOf(p)?.price;
    if (!price) return 0;
    const sellPrice = p.sellTicker
      ? (now.get(p.sellTicker)?.price ?? p.sellRefPrice)
      : null;
    const proceeds = p.sellQty && sellPrice ? p.sellQty * sellPrice : 0;
    return computeRefQty(p.budgetKrw, proceeds, price);
  };

  return (
    <Page current="/">
      <h1 className="text-xl font-bold">매입 추천</h1>

      {placeholders.length > 0 && (
        <Notice kind="warn">
          아직 자리표시자 프롬프트로 돌아갑니다 (
          {placeholders.map((s) => (s === "purchase" ? "②" : "③")).join(", ")}).
          결과 품질을 원하시면{" "}
          <Link href="/settings" className="underline">
            설정
          </Link>
          에서 직접 쓴 프롬프트를 넣으세요.
        </Notice>
      )}

      <Card title="추천 실행">
        <Runner busyAtLoad={Boolean(running)} />
        <p className="mt-4 text-xs text-neutral-500">
          이번에 재조사할 종목 {tickers.length}개
          {tickers.length > 0 && `: ${tickers.join(", ")}`}
          {tickers.length === 0 &&
            " — 조사 문서와 보유 종목이 아직 없어 ②가 조사 대상을 찾지 못합니다. 먼저 정기 조사를 한 번 돌리세요."}
        </p>
      </Card>

      <Card title="카테고리별 현재 잔액 = 이번 회차 배정 금액">
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
          추천 에이전트는 이 잔액을 그대로 배정 금액으로 받아 카테고리별로 몇 주를
          살 수 있는지 계산합니다. 이월된 잔돈이 포함된 값이며, 카테고리 간 이동은
          없습니다. 가격·수량은 참고치이므로 최종 확인은 증권사 앱에서 하세요.
        </p>
      </Card>

      {latest && (
        <Card
          title={`추천 결과 (${stampKST(latest.run.finishedAt)})`}
        >
          <Notice kind="warn">
            가격·수량은 조사 시점의 참고치입니다. 최종 확인과 실제 주문은 증권사
            앱에서 하세요.
          </Notice>

          {latest.picks.some((p) => p.category === "high_div" && p.skipped) &&
            latest.picks.some((p) => !p.skipped) && (
              <div className="mt-3">
                <Notice>
                  고배당을 건너뛰어서 그 잔액이 <b>배당성장·자산성장에 5:3으로
                  나눠</b> 배정되었습니다. 실제 자금 이동은 매입을 기록할 때
                  모자란 만큼만 일어나고, 기록하지 않으면 고배당에 그대로
                  남습니다.
                </Notice>
              </div>
            )}

          <div className="mt-4 space-y-4">
            {latest.picks.length === 0 && (
              <p className="text-sm text-neutral-500">
                추천 항목이 저장되지 않았습니다. 실행 이력에서 로그를 확인하세요.
              </p>
            )}
            {latest.picks.map((p) => (
              <div
                key={p.id}
                className="rounded-lg border border-neutral-200 p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <span className="rounded bg-neutral-900 px-2 py-0.5 text-xs text-white">
                      {CATEGORY_LABEL[p.category as Category]}
                    </span>
                    {p.skipped ? (
                      <span className="ml-2 font-semibold text-amber-700">
                        이번 달 건너뜀
                      </span>
                    ) : p.sellTicker ? (
                      <span className="ml-2 font-semibold">
                        <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">
                          갈아타기
                        </span>{" "}
                        <span className="text-red-600">{p.sellTicker}</span> 팔고{" "}
                        {p.etfName}
                        <span className="ml-1 text-neutral-400">{p.ticker}</span>{" "}
                        사기
                      </span>
                    ) : (
                      <>
                        <span className="ml-2 font-semibold">{p.etfName}</span>
                        <span className="ml-1 text-neutral-400">{p.ticker}</span>
                      </>
                    )}
                  </div>
                  <div className="text-sm tabular-nums text-neutral-600">
                    배정 {formatKRW(p.budgetKrw)}
                  </div>
                </div>

                {p.skipped ? (
                  <p className="mt-2 text-sm text-amber-700">
                    잔액 {formatKRW(p.budgetKrw)} 전액이 다음 달로 이월됩니다 (다른
                    카테고리로 옮기지 않습니다).
                  </p>
                ) : (
                  <div className="mt-2 space-y-1">
                    <p className="text-sm">
                      <b className="tabular-nums">{p.refQty ?? "?"}주</b>
                      {p.refPrice != null && (
                        <span className="text-neutral-500">
                          {" "}
                          × {p.refPrice.toLocaleString("ko-KR")}원 ={" "}
                          {((p.refQty ?? 0) * p.refPrice).toLocaleString("ko-KR")}원
                        </span>
                      )}
                      <span
                        className={`ml-2 rounded px-1.5 py-0.5 text-xs ${
                          p.priceSource === "realtime"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-neutral-100 text-neutral-600"
                        }`}
                      >
                        {p.priceSource === "realtime"
                          ? `실시간 ${stampKST(p.pricedAt)} 기준`
                          : "조사 문서 기준"}
                      </span>
                      {p.refPrice === p.researchPrice &&
                        p.sellRefPrice !== p.sellResearchPrice && (
                          <span className="ml-1 text-xs text-neutral-500">
                            (매도가만 실시간)
                          </span>
                        )}
                      {p.priceSource === "realtime" &&
                        p.researchPrice != null &&
                        p.refPrice != null &&
                        p.researchPrice !== p.refPrice && (
                          <span className="ml-1 text-xs text-neutral-400">
                            조사 {p.researchPrice.toLocaleString("ko-KR")}원 →
                            실시간 {p.refPrice.toLocaleString("ko-KR")}원
                          </span>
                        )}
                    </p>
                    {nowOf(p) ? (
                      <p className="text-xs text-blue-700 tabular-nums">
                        {quoteLabel(nowOf(p)!)}{" "}
                        {nowOf(p)!.price.toLocaleString("ko-KR")}원 → 살 수 있는
                        수량 {nowQtyOf(p)}주
                        {!accepted.has(p.id) && (
                          <span className="ml-1 text-neutral-500">
                            아래 기록 폼은 이 줄의 값으로 채웠습니다
                          </span>
                        )}
                      </p>
                    ) : (
                      !accepted.has(p.id) && (
                        <p className="text-xs text-neutral-500">
                          기록 폼은 저장된 값으로 채웠습니다
                        </p>
                      )
                    )}
                    {p.refPrice != null && (
                      <p className="text-xs text-neutral-500 tabular-nums">
                        배정 {p.budgetKrw.toLocaleString("ko-KR")}원 − 매수{" "}
                        {((p.refQty ?? 0) * p.refPrice).toLocaleString("ko-KR")}원 ={" "}
                        <b className="text-neutral-700">
                          {(
                            p.budgetKrw - (p.refQty ?? 0) * p.refPrice
                          ).toLocaleString("ko-KR")}
                          원
                        </b>{" "}
                        다음 달 이월
                      </p>
                    )}
                  </div>
                )}

                <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-700">
                  {p.rationale}
                </p>

                {Array.isArray(p.sourceUrls) && p.sourceUrls.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs">
                    {(p.sourceUrls as string[])
                      .filter((u) => typeof u === "string")
                      .slice(0, 5)
                      .map((u, i) => (
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

                {!p.skipped &&
                  (accepted.has(p.id) ? (
                    <p className="mt-3 border-t border-neutral-100 pt-3 text-sm text-green-700">
                      <span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-800">
                        기록 완료
                      </span>{" "}
                      이 추천은 이미 매입으로 기록되었습니다.
                    </p>
                  ) : (
                    <AcceptForm
                      id={p.id}
                      // 수량과 단가는 같은 시점 값으로 짝을 맞춘다 —
                      // 섞으면 화면 어느 줄과도 맞지 않는 세 번째 조합이 된다
                      defaultQty={nowOf(p) ? nowQtyOf(p) : (p.refQty ?? 0)}
                      defaultPrice={nowOf(p)?.price ?? p.refPrice ?? 0}
                      sellTicker={p.sellTicker}
                      sellDefaultQty={p.sellQty}
                      sellDefaultPrice={
                        (nowOf(p) && p.sellTicker
                          ? now.get(p.sellTicker)?.price
                          : null) ?? p.sellRefPrice
                      }
                    />
                  ))}
              </div>
            ))}
          </div>
        </Card>
      )}
    </Page>
  );
}
