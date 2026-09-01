import { desc } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import { Card, Notice, Page } from "@/components/ui";
import { currentWeeklyUsage } from "@/server/usage";
import { appWeeklyUsage, perAgentAverages } from "@/domain/agentUsage";
import RerunButton from "./rerun";

export const dynamic = "force-dynamic";

const AGENT_LABEL: Record<string, string> = {
  weekly: "① 정기 조사",
  purchase: "② 매입시점 조사",
  recommend: "③ 추천",
};

const STATUS_LABEL: Record<string, { text: string; className: string }> = {
  running: { text: "실행 중", className: "bg-blue-100 text-blue-800" },
  done: { text: "성공", className: "bg-green-100 text-green-800" },
  failed: { text: "실패", className: "bg-red-100 text-red-800" },
  auth_failed: { text: "인증 만료", className: "bg-amber-100 text-amber-900" },
  timeout: { text: "시간 초과", className: "bg-amber-100 text-amber-900" },
};

function fmt(d: Date | null) {
  return d
    ? new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d)
    : "—";
}

export default async function RunsPage() {
  const [rows, weekly] = await Promise.all([
    db.select().from(agentRuns).orderBy(desc(agentRuns.id)).limit(50),
    currentWeeklyUsage(),
  ]);
  const [app, avgs] = await Promise.all([
    appWeeklyUsage(weekly?.weeklyResetsAt ?? null),
    perAgentAverages(),
  ]);

  const runningRow = rows.find((r) => r.status === "running");
  const busy = Boolean(runningRow);
  const stuckMinutes = runningRow
    ? Math.floor((Date.now() - runningRow.startedAt.getTime()) / 60_000)
    : null;
  const authFailed = rows.find((r) => r.status === "auth_failed");

  return (
    <Page current="/runs">
      <h1 className="text-xl font-bold">실행 이력</h1>

      {authFailed && (
        <Notice kind="error">
          Codex 로그인이 만료되어 조사가 실패했습니다. 터미널에서{" "}
          <code>codex login</code> 을 다시 실행하세요.
        </Notice>
      )}

      {(app.runCount > 0 || avgs.length > 0) && (
        <Card title="이 사이트 에이전트 사용량">
          {app.runCount === 0 && (
            <p className="mb-3 text-sm text-neutral-500">
              이번 주간 창(
              {new Intl.DateTimeFormat("ko-KR", {
                timeZone: "Asia/Seoul",
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }).format(app.windowStart)}
              ~)에는 아직 실행이 없습니다. 아래는 지금까지 측정된 1회 평균입니다.
            </p>
          )}
          {app.runCount > 0 && (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-neutral-200 p-4">
              <div className="text-sm text-neutral-600">에이전트 실행</div>
              <div className="mt-1 text-lg font-bold tabular-nums">
                {app.runCount}회
              </div>
            </div>
            <div className="rounded-lg border border-neutral-200 p-4">
              <div className="text-sm text-neutral-600">출력 토큰</div>
              <div className="mt-1 text-lg font-bold tabular-nums">
                {app.outputTokens.toLocaleString("ko-KR")}
              </div>
            </div>
            <div className="rounded-lg border border-neutral-200 p-4">
              <div className="text-sm text-neutral-600">주간 한도 기여분</div>
              <div className="mt-1 text-lg font-bold tabular-nums">
                +{app.deltaPercent}%p
              </div>
            </div>
          </div>
          )}
          {avgs.length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-left text-neutral-500">
                    <th className="py-2">에이전트</th>
                    <th className="text-right">측정 횟수</th>
                    <th className="text-right">1회 평균 출력</th>
                    <th className="text-right">1회 평균 한도</th>
                  </tr>
                </thead>
                <tbody>
                  {avgs.map((a) => (
                    <tr key={a.agent} className="border-b border-neutral-100">
                      <td className="py-2">{AGENT_LABEL[a.agent] ?? a.agent}</td>
                      <td className="text-right tabular-nums">{a.runs}</td>
                      <td className="text-right tabular-nums">
                        {a.avgOutput?.toLocaleString("ko-KR") ?? "—"}
                      </td>
                      <td className="text-right tabular-nums">
                        {a.avgDelta != null ? `+${a.avgDelta}%p` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-neutral-500">
            이 사이트가 돌린 에이전트만 집계합니다. 한도 기여분은 실행 직전·직후
            소진율의 차이를 더한 값이라, 터미널에서 따로 쓴 codex 사용량은 섞이지
            않습니다.
            {app.runsWithoutDelta > 0 &&
              ` (${app.runsWithoutDelta}회는 기준선을 못 잡아 기여분 집계에서 빠졌습니다)`}
          </p>
        </Card>
      )}

      {weekly?.weeklyUsedPercent != null && (
        <Card title="Codex 주간 한도 (계정 전체)">
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold tabular-nums">
              {weekly.weeklyUsedPercent}%
            </span>
            <span className="text-sm text-neutral-500">사용</span>
            {weekly.weeklyResetsAt && (
              <span className="ml-auto text-xs text-neutral-500">
                {new Intl.DateTimeFormat("ko-KR", {
                  timeZone: "Asia/Seoul",
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(weekly.weeklyResetsAt)}{" "}
                재설정
              </span>
            )}
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-neutral-200">
            <div
              className={`h-full rounded-full ${
                weekly.weeklyUsedPercent >= 85
                  ? "bg-red-500"
                  : weekly.weeklyUsedPercent >= 60
                    ? "bg-amber-500"
                    : "bg-neutral-800"
              }`}
              style={{ width: `${Math.min(100, weekly.weeklyUsedPercent)}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            ChatGPT 계정 전체 기준입니다 — 이 사이트의 조사뿐 아니라 터미널에서 쓰는
            codex 사용량까지 함께 반영됩니다. codex가 정수로 반올림해 주기 때문에
            작은 실행은 0%p로 보일 수 있습니다.
          </p>
        </Card>
      )}

      <Card title="수동 실행">
        <RerunButton busy={busy} stuckMinutes={stuckMinutes} />
        <p className="mt-3 text-xs text-neutral-500">
          정기 조사는 월/목 07:30에 자동으로 돕니다. 실패했거나 지금 당장
          최신화하고 싶을 때 여기서 다시 돌리세요.
        </p>
      </Card>

      <Card title={`최근 ${rows.length}건`}>
        {rows.length === 0 ? (
          <p className="text-sm text-neutral-600">아직 실행 기록이 없습니다.</p>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => {
              const s = STATUS_LABEL[r.status] ?? {
                text: r.status,
                className: "bg-neutral-100 text-neutral-700",
              };
              return (
                <div
                  key={r.id}
                  className="rounded-lg border border-neutral-200 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={`rounded px-2 py-0.5 text-xs ${s.className}`}>
                      {s.text}
                    </span>
                    <span className="font-medium">
                      {AGENT_LABEL[r.agent] ?? r.agent}
                    </span>
                    <span className="text-neutral-500">
                      {r.trigger === "schedule" ? "정기" : "수동"}
                    </span>
                    <span className="ml-auto text-xs text-neutral-500">
                      {fmt(r.startedAt)} → {fmt(r.finishedAt)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-neutral-500">
                    {r.totalTokens != null && (
                      <span
                        className="tabular-nums"
                        title="총합은 캐시된 입력 토큰까지 포함해 크게 나온다. 실제 작업량은 출력 토큰이 잘 보여준다."
                      >
                        {r.outputTokens != null && (
                          <>출력 {r.outputTokens.toLocaleString("ko-KR")}토큰</>
                        )}
                        <span className="text-neutral-400">
                          {" "}
                          / 총 {r.totalTokens.toLocaleString("ko-KR")}
                        </span>
                      </span>
                    )}
                    {r.weeklyDeltaPercent != null && (
                      <span className="tabular-nums">
                        이번 실행 주간한도 <b>+{r.weeklyDeltaPercent}%p</b>
                      </span>
                    )}
                    {r.weeklyUsedPercent != null && (
                      <span className="tabular-nums">
                        실행 후 누적 {r.weeklyUsedPercent}%
                      </span>
                    )}
                  </div>
                  {r.logTail && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-neutral-500">
                        로그 보기
                      </summary>
                      <pre className="mt-2 max-h-56 overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
                        {r.logTail}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </Page>
  );
}
