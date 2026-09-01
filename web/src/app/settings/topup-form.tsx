"use client";

import { useActionState } from "react";
import { saveTopupAction } from "../actions";
import { buttonClass, inputClass } from "@/components/ui";

type State = { ok?: boolean; error?: string } | null;

export default function TopupForm({
  values,
  labels,
}: {
  values: Record<string, number>;
  labels: Record<string, string>;
}) {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_prev, formData) => (await saveTopupAction(formData)) ?? null,
    null,
  );

  const keys = Object.keys(labels);
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {keys.map((k) => (
          <label key={k} className="block">
            <span className="mb-1 block text-sm font-medium text-neutral-700">
              {labels[k]}
            </span>
            <input
              name={k}
              type="number"
              defaultValue={values[k]}
              className={inputClass}
            />
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
      </div>
      <p className="text-xs text-neutral-500">
        다음 충전부터 적용됩니다. 이미 들어간 충전은 바뀌지 않습니다.
      </p>
    </form>
  );
}
