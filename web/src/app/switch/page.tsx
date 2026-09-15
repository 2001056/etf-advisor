import { redirect } from "next/navigation";
import { isOnboarded } from "@/domain/ledger";
import { getHoldings, listSales } from "@/domain/purchases";
import { tickerCandidates } from "@/domain/tickers";
import { CATEGORY_LABEL, Category, dateKeyKST } from "@/domain/money";
import { Card, Page } from "@/components/ui";
import SwitchForm from "./form";
import CancelSwitchButton from "./cancel";

export const dynamic = "force-dynamic";

export default async function SwitchPage() {
  if (!(await isOnboarded())) redirect("/onboarding");

  const [holdings, candidates, sales] = await Promise.all([
    getHoldings(),
    tickerCandidates(),
    listSales(50),
  ]);

  return (
    <Page current="/switch">
      <h1 className="text-xl font-bold">갈아타기</h1>

      <Card title="종목 교체 (매도 → 매수)">
        <SwitchForm
          today={dateKeyKST()}
          holdings={holdings}
          candidates={candidates}
        />
      </Card>

      <Card title={`매도 내역 (${sales.length}건)`}>
        {sales.length === 0 ? (
          <p className="text-sm text-neutral-500">아직 매도 기록이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-2">매도일</th>
                  <th>구분</th>
                  <th>종목</th>
                  <th className="text-right">수량</th>
                  <th className="text-right">단가</th>
                  <th className="text-right">실현손익</th>
                  <th>유형</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id} className="border-b border-neutral-100">
                    <td className="py-2">{s.soldAt}</td>
                    <td>{CATEGORY_LABEL[s.category as Category]}</td>
                    <td>
                      {s.etfName}{" "}
                      <span className="text-neutral-400">{s.ticker}</span>
                    </td>
                    <td className="text-right tabular-nums">{s.qty}</td>
                    <td className="text-right tabular-nums">
                      {s.unitPrice.toLocaleString("ko-KR")}
                    </td>
                    <td
                      className={`text-right tabular-nums ${
                        s.realizedPnlKrw >= 0 ? "text-green-700" : "text-red-600"
                      }`}
                    >
                      {s.realizedPnlKrw >= 0 ? "+" : ""}
                      {s.realizedPnlKrw.toLocaleString("ko-KR")}
                    </td>
                    <td>
                      {s.switchGroupId ? (
                        <>
                          <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-800">
                            갈아타기
                          </span>
                          <CancelSwitchButton
                            groupId={s.switchGroupId}
                            summary={`${s.soldAt} ${s.etfName}(${s.ticker}) ${s.qty}주 매도로 시작한`}
                          />
                        </>
                      ) : (
                        <span className="text-xs text-neutral-400">단독</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </Page>
  );
}
