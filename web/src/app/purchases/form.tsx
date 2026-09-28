"use client";

import { FormEvent, startTransition, useActionState, useState } from "react";
import { addPurchaseAction } from "../actions";
import { buttonClass, Field, inputClass } from "@/components/ui";
import TickerPicker, { Candidate } from "@/components/TickerPicker";

type State = { ok?: true; error?: string } | null;

type Option = { value: string; label: string };

/**
 * 수기 매입 폼. 잔액 초과·빈칸 같은 입력 오류는 서버 예외 화면이 아니라
 * 폼 아래 메시지로 돌아온다 (§5 A2).
 *
 * 구분·자리 select 는 상태로 제어해 화면 값과 제출 값이 같게 한다. 폼 action 으로 넘기면
 * React 가 실행 뒤(실패해도) 폼을 비우므로 직접 제출하고, 성공했을 때만 비운다.
 */
export default function PurchaseForm({
  today,
  categories,
  candidates,
  roleCategory,
  roleOptions,
  seats,
}: {
  today: string;
  categories: Option[];
  candidates: Candidate[];
  /** 자리(공격·안정)를 두는 카테고리 — 이 구분일 때만 자리 칸을 보인다 */
  roleCategory: string;
  roleOptions: Option[];
  /** 지금 자리가 정해진 보유 종목 — 키는 `카테고리::종목코드` */
  seats: Record<string, string>;
}) {
  const firstCat = categories[0]?.value ?? "";
  const [cat, setCat] = useState(firstCat);
  const [ticker, setTicker] = useState("");
  const [seat, setSeat] = useState("");
  // 수기 매입에는 추천 유니크가 없다 — 성공하면 formKey 를 올려 폼을 새로 그린다.
  // "추가"를 한 번 더 눌러 같은 건이 그대로 다시 기록되는 것을 막는다.
  const [formKey, setFormKey] = useState(0);

  const existingSeat =
    cat === roleCategory && ticker.trim()
      ? seats[`${cat}::${ticker.trim()}`]
      : undefined;
  const seatLabel = (v: string) =>
    roleOptions.find((o) => o.value === v)?.label ?? v;

  const [state, dispatch, pending] = useActionState<State, FormData>(
    async (_prev, fd) => {
      const res = (await addPurchaseAction(fd)) ?? null;
      if (res?.ok) {
        setCat(firstCat);
        setTicker("");
        setSeat("");
        setFormKey((k) => k + 1);
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

  return (
    <form
      key={formKey}
      onSubmit={onSubmit}
      className="grid gap-4 sm:grid-cols-3"
    >
      <Field label="매입일">
        <input
          name="boughtAt"
          type="date"
          defaultValue={today}
          required
          className={inputClass}
        />
      </Field>
      <Field label="구분">
        <select
          name="category"
          required
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          className={inputClass}
        >
          {categories.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2">
        <TickerPicker
          candidates={candidates}
          onCategoryPicked={setCat}
          onTickerChange={setTicker}
        />
      </div>
      {cat === roleCategory &&
        (existingSeat ? (
          <Field
            label="자리"
            hint="이미 자리가 정해진 종목입니다. 바꾸려면 설정 화면에서 바꾸세요"
          >
            <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
              {seatLabel(existingSeat)}
            </p>
          </Field>
        ) : (
          <Field
            label="자리 (선택)"
            hint="고르면 이 종목의 자리로 저장됩니다. 설정 화면에서도 바꿀 수 있습니다"
          >
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
          </Field>
        ))}
      <Field label="수량(주)">
        <input name="qty" type="number" min={1} required className={inputClass} />
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
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input type="checkbox" name="allowOverBalance" className="size-4" />
          잔액 초과 허용 (고배당 건너뜀 달의 재배분 매입 등 — 잔액이 음수가 될 수
          있습니다)
        </label>
        <button disabled={pending} className={buttonClass}>
          {pending ? "저장 중…" : "추가"}
        </button>
      </div>
      {state?.ok && (
        <p className="sm:col-span-3 text-sm text-green-700">
          매입을 기록했습니다.
        </p>
      )}
      {state?.error && (
        <p className="sm:col-span-3 text-sm text-red-600">{state.error}</p>
      )}
    </form>
  );
}
