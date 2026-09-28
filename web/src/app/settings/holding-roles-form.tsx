"use client";

import { useActionState } from "react";
import { saveHoldingRolesAction } from "../actions";
import { buttonClass, inputClass } from "@/components/ui";

type State = { ok?: boolean; error?: string } | null;

type Row = {
  key: string; // 카테고리::종목코드
  ticker: string;
  etfName: string;
  qty: number;
  role: string; // 지금 자리, 없으면 ""
  source: "override" | "recommendation" | null;
};

const SOURCE_LABEL = {
  override: "직접 지정",
  recommendation: "추천 기록",
} as const;

/**
 * 보유 종목마다 자리(공격·안정)를 정한다. 바꾼 줄만 저장된다.
 * 추천 없이 산 종목은 여기서 정해야 ④·⑤와 대시보드가 자리를 안다.
 */
export default function HoldingRolesForm({
  rows,
  roleOptions,
}: {
  rows: Row[];
  roleOptions: { value: string; label: string }[];
}) {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_prev, formData) => {
      try {
        return (await saveHoldingRolesAction(formData)) ?? null;
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    null,
  );

  // 저장 뒤 서버 값이 바뀌면 다시 그려 select 가 실제 자리를 보이게 한다
  // (미정을 골라도 추천 기록이 있으면 그 자리로 돌아가는 경우)
  const formKey = rows.map((r) => `${r.key}=${r.role}`).join("|");

  return (
    <form key={formKey} action={action} className="space-y-4">
      <div className="divide-y divide-neutral-100">
        {rows.map((r) => (
          <label
            key={r.key}
            className="flex flex-wrap items-center gap-3 py-2"
          >
            <span className="min-w-48 flex-1 text-sm">
              {r.etfName} <span className="text-neutral-400">{r.ticker}</span>
              <span className="ml-2 text-xs text-neutral-500">
                보유 {r.qty}주
                {r.source && ` · ${SOURCE_LABEL[r.source]}`}
              </span>
            </span>
            <select
              name={`seat:${r.key}`}
              defaultValue={r.role}
              className={`${inputClass} sm:w-48`}
            >
              {roleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
              <option value="">미정</option>
            </select>
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
    </form>
  );
}
