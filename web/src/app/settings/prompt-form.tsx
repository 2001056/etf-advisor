"use client";

import { useActionState } from "react";
import { savePromptAction } from "../actions";
import { buttonClass, inputClass } from "@/components/ui";

type State = { ok?: boolean; error?: string } | null;

export default function PromptForm({
  slot,
  body,
  isPlaceholder,
  updatedAt,
}: {
  slot: string;
  body: string;
  isPlaceholder: boolean;
  updatedAt: string | null;
}) {
  const [state, action, pending] = useActionState<State, FormData>(
    async (_prev, formData) => (await savePromptAction(formData)) ?? null,
    null,
  );

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slot" value={slot} />
      <textarea
        name="body"
        defaultValue={body}
        rows={10}
        className={`${inputClass} font-mono text-xs leading-relaxed`}
      />
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending} className={buttonClass}>
          {pending ? "저장 중…" : "저장"}
        </button>
        {isPlaceholder ? (
          <span className="text-xs text-amber-700">
            자리표시자입니다 — 직접 쓴 프롬프트로 바꾸세요
          </span>
        ) : (
          <span className="text-xs text-neutral-500">
            마지막 저장 {updatedAt}
          </span>
        )}
        {state?.ok && (
          <span className="text-xs text-green-700">저장했습니다</span>
        )}
        {state?.error && (
          <span className="text-xs text-red-600">{state.error}</span>
        )}
      </div>
      <p className="text-xs text-neutral-500">
        출력 형식(frontmatter·고정 헤딩·데이터 표)은 시스템이 자동으로 뒤에
        붙입니다. 무엇을 조사할지·어떻게 고를지만 쓰세요. 비우고 저장하면
        자리표시자로 돌아갑니다.
      </p>
    </form>
  );
}
