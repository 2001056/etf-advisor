"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteAllResearchDocsAction, deleteResearchDocAction } from "../actions";

/** 문서 1건 삭제. 되돌릴 수 없으므로 한 번 더 눌러야 실행된다. */
export function DeleteDocButton({
  id,
  title,
  redirectToList = false,
}: {
  id: number;
  title: string;
  redirectToList?: boolean;
}) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("id", String(id));
      if (redirectToList) fd.set("redirect", "list");
      const res = await deleteResearchDocAction(fd);
      if (res && "error" in res && res.error) setError(String(res.error));
      router.refresh();
    });
  };

  if (error) return <span className="text-xs text-red-600">{error}</span>;

  return armed ? (
    <span className="flex items-center gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
        title={`${title} 삭제`}
      >
        {pending ? "지우는 중…" : "정말 삭제"}
      </button>
      <button
        onClick={() => setArmed(false)}
        className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
      >
        취소
      </button>
    </span>
  ) : (
    <button
      onClick={() => setArmed(true)}
      className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-red-700"
    >
      삭제
    </button>
  );
}

/** 문서 전체 삭제 */
export function DeleteAllDocsButton({ count }: { count: number }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [pending, start] = useTransition();
  const [done, setDone] = useState<number | null>(null);

  const run = () => {
    start(async () => {
      const res = await deleteAllResearchDocsAction();
      setDone(res?.deleted ?? 0);
      setArmed(false);
      router.refresh();
    });
  };

  if (done !== null) {
    return <span className="text-xs text-neutral-500">{done}건 삭제됨</span>;
  }

  return armed ? (
    <span className="flex items-center gap-1">
      <button
        onClick={run}
        disabled={pending}
        className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {pending ? "지우는 중…" : `${count}건 전부 삭제`}
      </button>
      <button
        onClick={() => setArmed(false)}
        className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
      >
        취소
      </button>
    </span>
  ) : (
    <button
      onClick={() => setArmed(true)}
      className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-red-700"
    >
      전체 삭제
    </button>
  );
}
