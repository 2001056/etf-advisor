"use client";

import { useActionState } from "react";
import { setupAction } from "../actions";
import { buttonClass, Field, inputClass, Notice } from "@/components/ui";

type State = { error?: string } | null;

export default function SetupForm() {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_prev, formData) => (await setupAction(formData)) ?? null,
    null,
  );

  return (
    <main className="flex flex-1 items-center justify-center px-4">
      <form
        action={action}
        className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-bold">최초 설정</h1>
          <p className="mt-1 text-sm text-neutral-600">
            이 사이트에서 쓸 비밀번호를 정하세요. 혼자 쓰는 사이트지만 로그인은
            항상 필요합니다.
          </p>
        </div>
        {state?.error && <Notice kind="error">{state.error}</Notice>}
        <Field label="비밀번호" hint="8자 이상. 패스워드 매니저 생성을 권장합니다.">
          <input
            name="password"
            type="password"
            autoFocus
            required
            minLength={8}
            className={inputClass}
          />
        </Field>
        <Field label="비밀번호 확인">
          <input
            name="password2"
            type="password"
            required
            minLength={8}
            className={inputClass}
          />
        </Field>
        <button className={`${buttonClass} w-full`} disabled={pending}>
          {pending ? "설정 중…" : "설정하고 시작"}
        </button>
      </form>
    </main>
  );
}
