"use client";

import { useActionState } from "react";
import { saveGrowthRolesAction } from "../actions";
import { buttonClass, inputClass } from "@/components/ui";

type State = { ok?: boolean; error?: string } | null;

/**
 * 자산성장을 두 자리로 나눠 담을 때 각 자리의 비중.
 * 합이 100%가 아니면 서버가 거절한다 — 배정액이 잔액을 벗어나면 안 되기 때문.
 */
export default function GrowthRolesForm({
  values,
  labels,
  hints,
}: {
  values: Record<string, number>;
  labels: Record<string, string>;
  hints: Record<string, string>;
}) {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_prev, formData) => {
      try {
        return (await saveGrowthRolesAction(formData)) ?? null;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    null,
  );

  const keys = Object.keys(labels);
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {keys.map((k) => (
          <label key={k} className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              {labels[k]} (%)
            </span>
            <input
              name={k}
              type="number"
              min={1}
              max={99}
              step={1}
              defaultValue={Math.round(values[k] * 100)}
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-neutral-500">
              {hints[k]}
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button disabled={pending} className={buttonClass}>
          {pending ? "저장 중…" : "저장"}
        </button>
        {state?.ok && (
          <span className="text-xs text-green-700">저장했습니다</span>
        )}
        {state?.error && (
          <span className="text-xs text-red-600">{state.error}</span>
        )}
      </div>
      <p className="text-xs text-neutral-500">
        두 자리의 합은 100%여야 합니다. 다음 추천부터 적용됩니다.
      </p>
    </form>
  );
}
