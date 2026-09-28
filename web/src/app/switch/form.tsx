"use client";

import { FormEvent, startTransition, useActionState, useState } from "react";
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

type Option = { value: string; label: string };

const keyOf = (h: Holding) => `${h.category}::${h.ticker}`;

/**
 * 갈아타기 폼. 매도 종목은 보유분 중에서만 고른다(그 선택이 매도 카테고리를 정한다).
 * 매수는 후보 검색으로 고르고, 매수 카테고리를 따로 고를 수 있다 — 다르면 매도대금 전액이
 * 매수 카테고리로 옮겨진다. 서버가 한 번에 실행한다.
 *
 * 화면에 보이는 값이 곧 제출되는 값이어야 한다: 값에 따라 안내가 바뀌는 select 는 전부
 * 상태로 제어하고, 안내·최대 수량·경고는 그 상태에서만 계산한다. 폼 action 으로 넘기면
 * React 가 실행 뒤(실패해도) 폼을 비워 select 가 첫 항목으로 돌아가므로 직접 제출한다.
 */
export default function SwitchForm({
  today,
  holdings,
  candidates,
  categories,
  active,
  roleCategory,
  roleOptions,
  seats,
}: {
  today: string;
  holdings: Holding[];
  candidates: Candidate[];
  categories: Option[];
  /** 활성 카테고리(월 충전액 > 0) — 매수 카테고리 기본값을 정한다 */
  active: string[];
  /** 자리(공격·안정)를 두는 카테고리 */
  roleCategory: string;
  roleOptions: Option[];
  /** 지금 자리가 정해진 보유 종목 — 키는 `카테고리::종목코드` */
  seats: Record<string, string>;
}) {
  const router = useRouter();
  const [sellKey, setSellKey] = useState("");
  // 직접 고른 매수 카테고리는 고를 때의 매도 종목에만 붙는다 — 매도 종목이 바뀌면 기본값으로
  const [buyCatPick, setBuyCatPick] = useState<{
    sellKey: string;
    value: string;
  } | null>(null);
  const [buyTicker, setBuyTicker] = useState("");
  const [seat, setSeat] = useState("");
  // 성공했을 때만 올려 폼을 새로 그린다(입력칸·종목 검색 비우기)
  const [formKey, setFormKey] = useState(0);

  // 고른 보유가 새로고침으로 사라졌으면(전량 매도 등) 첫 보유로 — select 표시와 안내가 늘 같은 종목
  const selected = holdings.find((h) => keyOf(h) === sellKey) ?? holdings[0];
  const effectiveSellKey = selected ? keyOf(selected) : "";
  // 매수 카테고리 기본값: 매도 종목의 카테고리가 적립 중(활성)이면 그대로, 아니면 첫 활성 카테고리
  const defaultBuyCat =
    selected && !active.includes(selected.category)
      ? (active[0] ?? selected.category)
      : (selected?.category ?? "");
  const buyCat =
    buyCatPick && buyCatPick.sellKey === effectiveSellKey
      ? buyCatPick.value
      : defaultBuyCat;
  const cross = !!selected && buyCat !== selected.category;
  const existingSeat =
    buyCat === roleCategory && buyTicker.trim()
      ? seats[`${buyCat}::${buyTicker.trim()}`]
      : undefined;
  const seatLabel = (v: string) =>
    roleOptions.find((o) => o.value === v)?.label ?? v;

  const [state, dispatch, pending] = useActionState<State, FormData>(
    async (_p, fd) => {
      const res = (await switchAction(fd)) ?? null;
      if (res?.ok) {
        // 성공했을 때만 처음 상태로 — 실패하면 입력을 그대로 두어 고쳐서 다시 낼 수 있게
        setSellKey("");
        setBuyCatPick(null);
        setBuyTicker("");
        setSeat("");
        setFormKey((k) => k + 1);
        router.refresh();
      }
      return res;
    },
    null,
  );

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd));
  };

  if (holdings.length === 0) {
    return (
      <Notice>
        보유 종목이 없어 갈아탈 수 없습니다. 먼저 매입을 기록하세요.
      </Notice>
    );
  }

  return (
    <form key={formKey} onSubmit={onSubmit} className="space-y-6">
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
              value={effectiveSellKey}
              onChange={(e) => {
                setSellKey(e.target.value);
                setBuyCatPick(null);
              }}
              className={inputClass}
            >
              {holdings.map((h) => {
                const key = keyOf(h);
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
            — 고른 매수 카테고리 잔액으로 삽니다
          </span>
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              매수 카테고리
            </span>
            <select
              name="buyCategory"
              required
              value={buyCat}
              onChange={(e) =>
                setBuyCatPick({ sellKey: effectiveSellKey, value: e.target.value })
              }
              className={inputClass}
            >
              {categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            {cross && selected && (
              <>
                <span className="mt-1 block text-xs text-amber-700">
                  매도대금 전액이 {CATEGORY_LABEL[buyCat]} 잔액으로 옮겨집니다
                </span>
                {/* 경고가 보일 때만 실린다 — 서버는 이 값이 없거나 다르면 이전을 거부한다 */}
                <input
                  type="hidden"
                  name="crossConfirm"
                  value={`${selected.category}>${buyCat}`}
                />
              </>
            )}
          </label>
          {buyCat === roleCategory &&
            (existingSeat ? (
              <div className="block">
                <span className="mb-1 block text-sm font-medium text-neutral-700">
                  자리
                </span>
                <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                  {seatLabel(existingSeat)}
                </p>
                <span className="mt-1 block text-xs text-neutral-500">
                  이미 자리가 정해진 종목입니다. 바꾸려면 설정 화면에서 바꾸세요.
                </span>
              </div>
            ) : (
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-neutral-700">
                  자리 <span className="text-neutral-400">(선택)</span>
                </span>
                <select
                  name="role"
                  value={seat}
                  onChange={(e) => setSeat(e.target.value)}
                  className={inputClass}
                >
                  <option value="">지정 안 함</option>
                  {roleOptions.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-neutral-500">
                  고르면 새로 사는 종목의 자리로 저장됩니다. 설정 화면에서도 바꿀 수
                  있습니다.
                </span>
              </label>
            ))}
          <div className="sm:col-span-2">
            <TickerPicker
              candidates={candidates}
              tickerName="buyTicker"
              etfNameName="buyEtfName"
              onTickerChange={setBuyTicker}
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
        매도 대금은 매도 종목의 카테고리 잔액으로 환입됩니다. 매수 카테고리가
        다르면 대금 전액이 매수 카테고리 잔액으로 옮겨져 매수 재원이 되고, 쓰고
        남은 돈도 매수 카테고리에 남습니다. 매도·매수는 한 번에 처리되며, 하나라도
        실패하면 둘 다 취소됩니다.
      </p>
    </form>
  );
}
