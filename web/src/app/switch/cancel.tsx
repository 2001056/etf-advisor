"use client";

import { useActionState } from "react";
import { cancelSwitchAction } from "../actions";

type State = { ok?: true; error?: string } | null;

/** 갈아타기 묶음 취소 버튼. 매수·매도·원장이 함께 사라지므로 한 번 더 묻는다. */
export default function CancelSwitchButton({
  groupId,
  summary,
}: {
  groupId: string;
  summary: string;
}) {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_p, fd) => (await cancelSwitchAction(fd)) ?? null,
    null,
  );

  return (
    <form action={action}>
      <input type="hidden" name="groupId" value={groupId} />
      <button
        disabled={pending}
        onClick={(e) => {
          if (
            !confirm(
              `${summary} 갈아타기를 취소합니다.\n매도·매수 기록과 원장 반영이 되돌아갑니다(잔액이 부족하면 취소가 거부됩니다). 계속할까요?`,
            )
          ) {
            e.preventDefault();
          }
        }}
        className="mt-1 block text-xs text-red-600 hover:underline disabled:opacity-50"
      >
        {pending ? "취소 중…" : "이 갈아타기 취소"}
      </button>
      {state?.error && (
        <p className="mt-1 text-xs text-red-600">{state.error}</p>
      )}
    </form>
  );
}
