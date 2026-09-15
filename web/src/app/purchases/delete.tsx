"use client";

import { useActionState } from "react";
import { deletePurchaseAction } from "../actions";

type State = { ok?: true; error?: string } | null;

export default function DeletePurchaseButton({ id }: { id: number }) {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_p, fd) => (await deletePurchaseAction(fd)) ?? null,
    null,
  );

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button
        disabled={pending}
        className="text-xs text-red-600 hover:underline disabled:opacity-50"
      >
        {pending ? "삭제 중…" : "삭제"}
      </button>
      {state?.error && (
        <p className="mt-1 text-xs text-red-600">{state.error}</p>
      )}
    </form>
  );
}
