"use client";

import { useActionState } from "react";
import { loginAction } from "../actions";
import { buttonClass, Field, inputClass, Notice } from "@/components/ui";

type State = { error?: string } | null;

export default function LoginForm() {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_prev, formData) => (await loginAction(formData)) ?? null,
    null,
  );

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <form
        action={action}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-bold">ETF 매입 도우미</h1>
        {state?.error && <Notice kind="error">{state.error}</Notice>}
        <Field label="비밀번호">
          <input
            name="password"
            type="password"
            autoFocus
            required
            className={inputClass}
          />
        </Field>
        <button className={`${buttonClass} w-full`} disabled={pending}>
          {pending ? "확인 중…" : "로그인"}
        </button>
      </form>
    </main>
  );
}
