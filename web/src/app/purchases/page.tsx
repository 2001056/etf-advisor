import { redirect } from "next/navigation";
import { closeCycleAction } from "../actions";
import { getBalances, getCycle, isOnboarded } from "@/domain/ledger";
import { listPurchases } from "@/domain/purchases";
import { tickerCandidates } from "@/domain/tickers";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  Category,
  dateKeyKST,
  formatKRW,
  monthKeyKST,
} from "@/domain/money";
import { buttonClass, Card, Notice, Page } from "@/components/ui";
import PurchaseForm from "./form";
import DeletePurchaseButton from "./delete";

export const dynamic = "force-dynamic";

export default async function PurchasesPage() {
  if (!(await isOnboarded())) redirect("/onboarding");

  const [rows, balances, cycle, candidates] = await Promise.all([
    listPurchases(),
    getBalances(),
    getCycle(),
    tickerCandidates(),
  ]);

  return (
    <Page current="/purchases">
      <h1 className="text-xl font-bold">매입 기록</h1>

      <Card title="매입 추가">
        <PurchaseForm
          today={dateKeyKST()}
          categories={CATEGORIES.map((c) => ({
            value: c,
            label: `${CATEGORY_LABEL[c]} (잔액 ${formatKRW(balances[c as Category])})`,
          }))}
          candidates={candidates}
        />
      </Card>

      <Card title={`${monthKeyKST()} 매입 마감`}>
        {cycle ? (
          <Notice>
            {monthKeyKST()} 매입이 마감되었습니다. 마감 24시간 뒤 다음 달
            충전이 들어옵니다(매일 16:00 자동 작업 또는 화면을 열 때 반영).
          </Notice>
        ) : (
          <form action={closeCycleAction} className="space-y-3">
            <p className="text-sm text-neutral-600">
              이번 달 매입을 전부 기록했으면 마감하세요. 남은 잔액에 월 충전액이
              더해지는 시점은 마감 시각으로부터 24시간 뒤입니다(달력상 다음날이
              아닙니다). 그 뒤 화면을 열거나 매일 16:00 자동 작업이 돌면
              반영됩니다.
            </p>
            <button className={buttonClass}>이번 달 매입 마감</button>
          </form>
        )}
      </Card>

      <Card title={`전체 내역 (${rows.length}건)`}>
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500">아직 기록이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-2">매입일</th>
                  <th>구분</th>
                  <th>종목</th>
                  <th className="text-right">수량</th>
                  <th className="text-right">단가</th>
                  <th className="text-right">금액</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100">
                    <td className="py-2">{r.boughtAt}</td>
                    <td>{CATEGORY_LABEL[r.category as Category]}</td>
                    <td>
                      {r.etfName}{" "}
                      <span className="text-neutral-400">{r.ticker}</span>
                    </td>
                    <td className="text-right tabular-nums">{r.qty}</td>
                    <td className="text-right tabular-nums">
                      {r.unitPrice.toLocaleString("ko-KR")}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.amountKrw.toLocaleString("ko-KR")}
                    </td>
                    <td className="text-right">
                      {r.switchGroupId ? (
                        <span className="text-xs text-neutral-400">
                          갈아타기 묶음 — /switch 에서 취소
                        </span>
                      ) : (
                        <DeletePurchaseButton id={r.id} />
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
