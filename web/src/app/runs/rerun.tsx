"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { clearStuckRunsAction, rerunWeeklyAction } from "../actions";
import { buttonClass } from "@/components/ui";

type State = { ok?: boolean; error?: string; cleared?: number } | null;

export default function RerunButton({
  busy,
  stuckMinutes,
}: {
  busy: boolean;
  stuckMinutes: number | null;
}) {
  const router = useRouter();

  const [state, action, pending] = useActionState<State, FormData>(async () => {
    const res = (await rerunWeeklyAction()) ?? null;
    router.refresh();
    return res;
  }, null);

  const [clearState, clearAction, clearing] = useActionState<State, FormData>(
    async () => {
      const res = (await clearStuckRunsAction()) ?? null;
      router.refresh();
      return res;
    },
    null,
  );

  // 하드 타임아웃(15분)을 크게 넘겼는데도 running이면 뭔가 잘못된 것이다
  const looksStuck = busy && stuckMinutes !== null && stuckMinutes > 20;

  return (
    <div className="space-y-3">
      <form action={action} className="flex flex-wrap items-center gap-3">
        <button disabled={pending || busy} className={buttonClass}>
          {pending ? "시작하는 중…" : "정기 조사 지금 실행"}
        </button>
        {busy && (
          <span className="text-sm text-neutral-500">
            조사 실행 중입니다 — 몇 분 걸리며, 끝나면 아래 목록에 나타납니다
            {stuckMinutes !== null && ` (${stuckMinutes}분 경과)`}
          </span>
        )}
        {state?.ok && !busy && (
          <span className="text-sm text-neutral-500">
            조사를 시작했습니다. 새로고침하면 진행 상태가 보입니다.
          </span>
        )}
        {state?.error && (
          <span className="text-sm text-red-600">{state.error}</span>
        )}
      </form>

      {looksStuck && (
        <form action={clearAction} className="flex items-center gap-3">
          <button
            disabled={clearing}
            className="rounded-lg border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {clearing ? "해제 중…" : "막힌 실행 해제"}
          </button>
          <span className="text-xs text-neutral-500">
            타임아웃을 한참 넘겼습니다. 해제하면 다시 실행할 수 있습니다.
          </span>
        </form>
      )}

      {clearState?.ok && (
        <span className="text-sm text-green-700">
          {clearState.cleared}건을 해제했습니다.
        </span>
      )}
    </div>
  );
}
