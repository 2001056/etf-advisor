import { redirect } from "next/navigation";
import { isOnboarded } from "@/domain/ledger";
import { listDividends } from "@/domain/dividends";
import { tickerCandidates } from "@/domain/tickers";
import { getHoldings } from "@/domain/purchases";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  Category,
  dateKeyKST,
  formatKRW,
} from "@/domain/money";
import { Card, Notice, Page } from "@/components/ui";
import { AddDividendForm, DeleteDividendButton } from "./form";

export const dynamic = "force-dynamic";

export default async function DividendsPage() {
  if (!(await isOnboarded())) redirect("/onboarding");

  const [rows, holdings, candidates] = await Promise.all([
    listDividends(),
    getHoldings(),
    tickerCandidates(),
  ]);

  const total = rows.reduce((s, r) => s + r.amountKrw, 0);
  const reinvested = rows
    .filter((r) => r.refLedgerId !== null)
    .reduce((s, r) => s + r.amountKrw, 0);

  const byCategory = CATEGORIES.map((c) => ({
    category: c,
    total: rows
      .filter((r) => r.category === c)
      .reduce((s, r) => s + r.amountKrw, 0),
  }));

  // 올해 받은 금액
  const thisYear = dateKeyKST().slice(0, 4);
  const yearTotal = rows
    .filter((r) => r.receivedAt.startsWith(thisYear))
    .reduce((s, r) => s + r.amountKrw, 0);

  return (
    <Page current="/dividends">
      <h1 className="text-xl font-bold">분배금</h1>

      <Card title={`누적 ${formatKRW(total)}`}>
        <div className="grid gap-3 sm:grid-cols-3">
          {byCategory.map((b) => (
            <div
              key={b.category}
              className="rounded-lg border border-neutral-200 p-4"
            >
              <div className="text-sm text-neutral-600">
                {CATEGORY_LABEL[b.category]}
              </div>
              <div className="mt-1 text-lg font-bold tabular-nums">
                {formatKRW(b.total)}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-neutral-500 tabular-nums">
          {thisYear}년 {formatKRW(yearTotal)}
          {reinvested > 0 && ` · 잔액에 더한 금액 ${formatKRW(reinvested)}`}
        </p>
      </Card>

      <Card title="분배금 기록하기">
        <AddDividendForm
          today={dateKeyKST()}
          categories={CATEGORIES.map((c) => ({
            value: c,
            label: CATEGORY_LABEL[c],
          }))}
          holdings={candidates}
        />
      </Card>

      <Card title={`받은 내역 ${rows.length}건`}>
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-500">
            아직 기록이 없습니다. 증권사 앱에서 분배금이 입금되면 여기에 적어두세요
            — 대시보드의 총수익에 반영됩니다.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-neutral-500">
                  <th className="py-2">받은 날</th>
                  <th>구분</th>
                  <th>종목</th>
                  <th className="text-right">금액</th>
                  <th>메모</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-neutral-100">
                    <td className="py-2 tabular-nums">{r.receivedAt}</td>
                    <td>{CATEGORY_LABEL[r.category as Category]}</td>
                    <td>
                      {r.etfName}{" "}
                      <span className="text-neutral-400">{r.ticker}</span>
                    </td>
                    <td className="text-right tabular-nums">
                      {r.amountKrw.toLocaleString("ko-KR")}
                      {r.refLedgerId !== null && (
                        <span
                          className="ml-1 text-xs text-green-700"
                          title="잔액에 더해진 금액"
                        >
                          재투자
                        </span>
                      )}
                    </td>
                    <td className="text-neutral-500">{r.memo}</td>
                    <td className="text-right">
                      <DeleteDividendButton id={r.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Notice>
        세후 실수령액을 적으시면 됩니다. &lsquo;잔액에 더하기&rsquo;를 체크한
        기록을 삭제하면 잔액에서도 함께 빠집니다.
      </Notice>
    </Page>
  );
}
