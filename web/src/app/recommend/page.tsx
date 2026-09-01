import Link from "next/link";
import { redirect } from "next/navigation";
import { getBalances, isOnboarded, runLazyTopup } from "@/domain/ledger";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  Category,
  formatKRW,
} from "@/domain/money";
import { getAllPrompts } from "@/domain/prompts";
import {
  getRunningRun,
  latestRecommendation,
  tickersToResearch,
} from "@/server/orchestrator";
import { Card, Notice, Page } from "@/components/ui";
import Runner from "./runner";
import AcceptForm from "./accept";

export const dynamic = "force-dynamic";

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
          title={`추천 결과 (${latest.run.finishedAt?.toLocaleString("ko-KR") ?? ""})`}
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
                    </p>
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

                {!p.skipped && (
                  <AcceptForm
                    id={p.id}
                    defaultQty={p.refQty ?? 0}
                    defaultPrice={p.refPrice ?? 0}
                    sellTicker={p.sellTicker}
                    sellDefaultQty={p.sellQty}
                    sellDefaultPrice={p.sellRefPrice}
                  />
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </Page>
  );
}
