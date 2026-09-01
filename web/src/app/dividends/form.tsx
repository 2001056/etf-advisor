"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { addDividendAction, deleteDividendAction } from "../actions";
import { buttonClass, inputClass } from "@/components/ui";
import TickerPicker, { Candidate } from "@/components/TickerPicker";

type State = { ok?: boolean; error?: string } | null;

export function AddDividendForm({
  today,
  categories,
  holdings,
}: {
  today: string;
  categories: { value: string; label: string }[];
  holdings: Candidate[];
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<State, FormData>(
    async (_p, fd) => {
      const res = (await addDividendAction(fd)) ?? null;
      if (res?.ok) router.refresh();
      return res;
    },
    null,
  );

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            받은 날
          </span>
          <input
            name="receivedAt"
            type="date"
            defaultValue={today}
            required
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            구분
          </span>
          <select name="category" required className={inputClass}>
            {categories.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            금액 (세후 실수령)
          </span>
          <input
            name="amountKrw"
            type="number"
            min={1}
            required
            placeholder="예: 12500"
            className={inputClass}
          />
        </label>

        <div className="sm:col-span-2">
          <TickerPicker candidates={holdings} categoryName="category" />
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            세전 총액 <span className="text-neutral-400">(선택)</span>
          </span>
          <input
            name="grossKrw"
            type="number"
            min={0}
            placeholder="모르면 비워두세요"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            세액 <span className="text-neutral-400">(선택)</span>
          </span>
          <input
            name="taxKrw"
            type="number"
            min={0}
            placeholder="원천징수액"
            className={inputClass}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-neutral-700">
            메모
          </span>
          <input name="memo" className={inputClass} />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button disabled={pending} className={buttonClass}>
          {pending ? "저장 중…" : "분배금 기록"}
        </button>
        {state?.ok && <span className="text-sm text-green-700">저장했습니다</span>}
        {state?.error && (
          <span className="text-sm text-red-600">{state.error}</span>
        )}
      </div>
    </form>
  );
}

export function DeleteDividendButton({ id }: { id: number }) {
  const router = useRouter();
  const [, action, pending] = useActionState<State, FormData>(
    async (_p, fd) => {
      const res = (await deleteDividendAction(fd)) ?? null;
      router.refresh();
      return res;
    },
    null,
  );

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button
        disabled={pending}
        className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-red-700 disabled:opacity-50"
      >
        {pending ? "…" : "삭제"}
      </button>
    </form>
  );
}
