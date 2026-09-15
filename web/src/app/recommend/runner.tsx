"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startRecommendAction } from "../actions";
import { buttonClass, Notice } from "@/components/ui";

type Status = {
  running: { id: number; agent: string } | null;
  log: string;
};

const AGENT_LABEL: Record<string, string> = {
  weekly: "정기 조사 중…",
  purchase: "매입 시점 조사 중… (종목 전체 재조사)",
  recommend: "추천 고르는 중…",
};

export default function Runner({ busyAtLoad }: { busyAtLoad: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [watching, setWatching] = useState(busyAtLoad);
  const [force, setForce] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!watching) return;
    let alive = true;

    const tick = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        const data: Status = await res.json();
        if (!alive) return;
        setStatus(data);
        if (!data.running) {
          setWatching(false);
          router.refresh();
        }
      } catch {
        // 폴링 실패는 조용히 넘어간다 — 다음 주기에 다시 시도
      }
    };

    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [watching, router]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.log]);

  const start = () => {
    setError(null);
    setWatching(true);
    startTransition(async () => {
      const res = await startRecommendAction(force);
      if (res?.error) {
        setError(res.error);
        setWatching(false);
      }
      router.refresh();
    });
  };

  const busy = watching || pending;

  return (
    <div className="space-y-4">
      {error && <Notice kind="error">{error}</Notice>}

      <button onClick={start} disabled={busy} className={buttonClass}>
        {busy ? "실행 중…" : "매입 추천 받기"}
      </button>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            disabled={busy}
            className="h-4 w-4"
          />
          장 운영시간이 아니어도 그래도 실행
        </label>
        <p className="text-xs text-neutral-500">
          평일 09:00~15:30(KST) 밖에서는 기본으로 막습니다. 공휴일은 판별하지
          않으므로 휴장일에는 막히지 않습니다.
        </p>
      </div>

      {busy && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-neutral-700">
            {status?.running
              ? (AGENT_LABEL[status.running.agent] ?? "실행 중…")
              : "시작하는 중…"}
          </p>
          <p className="text-xs text-neutral-500">
            조사와 추천을 이어서 돌립니다. 웹 검색을 하기 때문에 몇 분 걸릴 수
            있습니다. 이 화면을 닫아도 계속 진행됩니다.
          </p>
          {status?.log && (
            <pre
              ref={logRef}
              className="max-h-56 overflow-auto rounded-lg bg-neutral-900 p-3 text-xs leading-relaxed text-neutral-100"
            >
              {status.log}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
