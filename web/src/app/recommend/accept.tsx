"use client";

import { useActionState } from "react";
import { acceptRecommendationAction } from "../actions";
import { inputClass } from "@/components/ui";

type State = { ok?: boolean; error?: string } | null;

/** 실제로 산 뒤 이 폼으로 확정하면 매입 기록 + 잔액 차감이 한 번에 된다. */
export default function AcceptForm({
  id,
  defaultQty,
  defaultPrice,
}: {
  id: number;
  defaultQty: number;
  defaultPrice: number;
}) {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_prev, formData) => (await acceptRecommendationAction(formData)) ?? null,
    null,
  );

  // 1주도 못 사는데 폼을 그리면 기본값이 없는 수량을 채워 넣게 된다.
  if (defaultQty <= 0) {
    return (
      <p className="mt-3 border-t border-neutral-100 pt-3 text-sm text-amber-700">
        지금 시세로는 배정액으로 1주도 살 수 없습니다 — 기록할 수량이 없습니다.
      </p>
    );
  }

  if (state?.ok) {
    return (
      <p className="mt-3 text-sm text-green-700">
        매입 기록에 저장했습니다. 잔액이 차감되었습니다.
      </p>
    );
  }

  return (
    <form
      action={action}
      className="mt-3 flex flex-wrap items-end gap-2 border-t border-neutral-100 pt-3"
    >
      <input type="hidden" name="recommendationId" value={id} />

      <div>
        <span className="mb-1 block text-xs text-neutral-500">실제 수량</span>
        <input
          name="qty"
          type="number"
          min={1}
          required
          defaultValue={defaultQty}
          className={`${inputClass} w-24`}
        />
      </div>
      <div>
        <span className="mb-1 block text-xs text-neutral-500">체결 단가</span>
        <input
          name="unitPrice"
          type="number"
          min={1}
          required
          defaultValue={defaultPrice || undefined}
          className={`${inputClass} w-32`}
        />
      </div>
      <button
        disabled={pending}
        className="rounded-lg border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "저장 중…" : "샀음 — 기록하기"}
      </button>
      {state?.error && (
        <span className="text-sm text-red-600">{state.error}</span>
      )}
    </form>
  );
}
