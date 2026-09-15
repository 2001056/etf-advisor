"use client";

import { useActionState } from "react";
import { addPurchaseAction } from "../actions";
import { buttonClass, Field, inputClass } from "@/components/ui";
import TickerPicker, { Candidate } from "@/components/TickerPicker";

/** seq: 성공 횟수 — 폼을 다시 그려 비우는 key 로 쓴다 */
type State = { ok?: true; error?: string; seq?: number } | null;

/**
 * 수기 매입 폼. 잔액 초과·빈칸 같은 입력 오류는 서버 예외 화면이 아니라
 * 폼 아래 메시지로 돌아온다 (§5 A2).
 */
export default function PurchaseForm({
  today,
  categories,
  candidates,
}: {
  today: string;
  categories: { value: string; label: string }[];
  candidates: Candidate[];
}) {
  // 수기 매입에는 추천 유니크가 없다 — 성공하면 seq 를 올려 폼을 새로 그린다.
  // "추가"를 한 번 더 눌러 같은 건이 그대로 다시 기록되는 것을 막는다.
  const [state, action, pending] = useActionState<State, FormData>(
    async (prev, fd) => {
      const res = (await addPurchaseAction(fd)) ?? null;
      return { ...res, seq: (prev?.seq ?? 0) + (res?.ok ? 1 : 0) };
    },
    null,
  );

  return (
    <form
      key={state?.seq ?? 0}
      action={action}
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
        <select name="category" required className={inputClass}>
          {categories.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="sm:col-span-2">
        <TickerPicker candidates={candidates} categoryName="category" />
      </div>
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
