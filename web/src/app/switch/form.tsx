"use client";

import { useActionState, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { switchAction } from "../actions";
import { buttonClass, inputClass, Notice } from "@/components/ui";
import TickerPicker, { Candidate } from "@/components/TickerPicker";

type Holding = {
  category: string;
  ticker: string;
  etfName: string;
  qty: number;
  avgPrice: number;
};

type State = { ok?: true; error?: string } | null;

const CATEGORY_LABEL: Record<string, string> = {
  div_growth: "배당성장",
  asset_growth: "자산성장",
  high_div: "고배당",
};

/**
 * 갈아타기 폼. 매도 종목은 보유분 중에서만 고른다(그 선택이 카테고리를 정한다).
 * 매수는 후보 검색으로 고르고, 서버에서 같은 카테고리로 묶어 한 번에 실행한다.
 */
export default function SwitchForm({
  today,
  holdings,
  candidates,
}: {
  today: string;
  holdings: Holding[];
  candidates: Candidate[];
}) {
  const router = useRouter();
  const [sellKey, setSellKey] = useState(
    holdings[0] ? `${holdings[0].category}::${holdings[0].ticker}` : "",
  );
  const selected = useMemo(
    () => holdings.find((h) => `${h.category}::${h.ticker}` === sellKey),
    [holdings, sellKey],
  );
  const [state, action, pending] = useActionState<State, FormData>(
    async (_p, fd) => {
      const res = (await switchAction(fd)) ?? null;
      if (res?.ok) router.refresh();
      return res;
    },
    null,
  );

  if (holdings.length === 0) {
    return (
      <Notice>
        보유 종목이 없어 갈아탈 수 없습니다. 먼저 매입을 기록하세요.
      </Notice>
    );
  }

  return (
    <form action={action} className="space-y-6">
      {/* 매도 */}
      <div className="space-y-4 rounded-lg border border-neutral-200 p-4">
        <h3 className="text-sm font-semibold text-neutral-800">팔 종목 (매도)</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              보유 종목
            </span>
            <select
              name="sell"
              required
              value={sellKey}
              onChange={(e) => setSellKey(e.target.value)}
              className={inputClass}
            >
              {holdings.map((h) => {
                const key = `${h.category}::${h.ticker}`;
                return (
                  <option key={key} value={key}>
                    {CATEGORY_LABEL[h.category]} · {h.etfName} ({h.ticker}) · 보유{" "}
                    {h.qty}주 · 평단 {h.avgPrice.toLocaleString("ko-KR")}원
                  </option>
                );
              })}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              매도 수량
              {selected && (
                <span className="text-neutral-400"> (최대 {selected.qty}주)</span>
              )}
            </span>
            <input
              name="sellQty"
              type="number"
              min={1}
              max={selected?.qty}
              required
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              매도 단가(원)
            </span>
            <input
              name="sellUnitPrice"
              type="number"
              min={1}
              required
              placeholder={
                selected ? `평단 ${selected.avgPrice.toLocaleString("ko-KR")}` : ""
              }
              className={inputClass}
            />
          </label>
        </div>
      </div>

      {/* 매수 */}
      <div className="space-y-4 rounded-lg border border-neutral-200 p-4">
        <h3 className="text-sm font-semibold text-neutral-800">
          살 종목 (매수){" "}
          <span className="font-normal text-neutral-500">
            — 같은 카테고리 안에서 교체됩니다
          </span>
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TickerPicker
              candidates={candidates}
              tickerName="buyTicker"
              etfNameName="buyEtfName"
            />
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              매수 수량
            </span>
            <input
              name="buyQty"
              type="number"
              min={1}
              required
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              매수 단가(원)
            </span>
            <input
              name="buyUnitPrice"
              type="number"
              min={1}
              required
              className={inputClass}
            />
          </label>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            실행일
          </span>
          <input
            name="executedAt"
            type="date"
            defaultValue={today}
            required
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            메모
          </span>
          <input
            name="memo"
            placeholder="갈아타는 이유 등 (선택)"
            className={inputClass}
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button disabled={pending} className={buttonClass}>
          {pending ? "처리 중…" : "갈아타기 실행"}
        </button>
        {state?.ok && (
          <span className="text-sm text-green-700">갈아타기를 기록했습니다</span>
        )}
        {state?.error && (
          <span className="text-sm text-red-600">{state.error}</span>
        )}
      </div>

      <p className="text-xs text-neutral-500">
        매도 대금은 해당 카테고리 잔액으로 환입돼 매수 재원이 됩니다. 매도·매수는
        한 번에 처리되며, 하나라도 실패하면 둘 다 취소됩니다.
      </p>
    </form>
  );
}
