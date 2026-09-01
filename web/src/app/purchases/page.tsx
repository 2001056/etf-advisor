import { redirect } from "next/navigation";
import {
  addPurchaseAction,
  closeCycleAction,
  deletePurchaseAction,
} from "../actions";
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
import {
  buttonClass,
  Card,
  Field,
  inputClass,
  Notice,
  Page,
} from "@/components/ui";
import TickerPicker from "@/components/TickerPicker";

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
        <form action={addPurchaseAction} className="grid gap-4 sm:grid-cols-3">
          <Field label="매입일">
            <input
              name="boughtAt"
              type="date"
              defaultValue={dateKeyKST()}
              required
              className={inputClass}
            />
          </Field>
          <Field label="구분">
            <select name="category" required className={inputClass}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]} (잔액 {formatKRW(balances[c as Category])})
                </option>
              ))}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <TickerPicker candidates={candidates} categoryName="category" />
          </div>
          <Field label="수량(주)">
            <input
              name="qty"
              type="number"
              min={1}
              required
              className={inputClass}
            />
          </Field>
          <Field label="매입 단가(원)" hint="평단가는 자동으로 계산됩니다">
            <input
              name="unitPrice"
              type="number"
              min={1}
              required
              className={inputClass}
            />
          </Field>
          <div className="sm:col-span-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" name="skipLedger" className="size-4" />
              기존 보유분 (잔액에서 차감하지 않음)
            </label>
            <button className={buttonClass}>추가</button>
          </div>
        </form>
      </Card>

      <Card title={`${monthKeyKST()} 매입 마감`}>
        {cycle ? (
          <Notice>
            {monthKeyKST()} 매입이 마감되었습니다. 다음날 다음 달 충전이
            들어옵니다.
          </Notice>
        ) : (
          <form action={closeCycleAction} className="space-y-3">
            <p className="text-sm text-neutral-600">
              이번 달 매입을 전부 기록했으면 마감하세요. 마감 다음날 남은 잔액에
              월 충전액이 더해집니다.
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
                      <form action={deletePurchaseAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className="text-xs text-red-600 hover:underline">
                          삭제
                        </button>
                      </form>
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
