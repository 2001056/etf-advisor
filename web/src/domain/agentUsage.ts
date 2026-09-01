import { and, desc, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";

/**
 * **이 앱이** 이번 주간 창에서 쓴 codex 사용량.
 *
 * codex의 주간 소진율은 ChatGPT 계정 전체 기준이라 터미널에서 쓴 양까지 섞인다.
 * 여기서는 이 앱이 돌린 실행만 골라 합산한다.
 */
export type AppWeeklyUsage = {
  windowStart: Date;
  resetsAt: Date | null;
  runCount: number;
  outputTokens: number;
  totalTokens: number;
  /** 이 앱이 올린 주간 소진율 합 (%p). 실행별 직전/직후 차이의 합 */
  deltaPercent: number;
  /** 증가분을 못 잰 실행 수 (기능 도입 전이거나 한도 초기화가 겹친 경우) */
  runsWithoutDelta: number;
};

export async function appWeeklyUsage(
  resetsAt: Date | null,
): Promise<AppWeeklyUsage> {
  // 주간 창은 재설정 시각에서 7일 뒤로 물러난 지점부터
  const windowStart = resetsAt
    ? new Date(resetsAt.getTime() - 7 * 24 * 3600 * 1000)
    : new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const [row] = await db
    .select({
      runCount: sql<number>`count(*)::int`,
      outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::bigint`,
      totalTokens: sql<number>`coalesce(sum(${agentRuns.totalTokens}), 0)::bigint`,
      deltaPercent: sql<number>`coalesce(sum(${agentRuns.weeklyDeltaPercent}), 0)::int`,
      runsWithoutDelta: sql<number>`count(*) filter (where ${agentRuns.weeklyDeltaPercent} is null)::int`,
    })
    .from(agentRuns)
    .where(gte(agentRuns.startedAt, windowStart));

  return {
    windowStart,
    resetsAt,
    runCount: Number(row?.runCount ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    totalTokens: Number(row?.totalTokens ?? 0),
    deltaPercent: Number(row?.deltaPercent ?? 0),
    runsWithoutDelta: Number(row?.runsWithoutDelta ?? 0),
  };
}

/** 에이전트별 1회 평균 출력 토큰 — "한 번 돌면 얼마나 쓰나" */
export async function perAgentAverages() {
  return db
    .select({
      agent: agentRuns.agent,
      runs: sql<number>`count(*)::int`,
      avgOutput: sql<number>`round(avg(${agentRuns.outputTokens}))::int`,
      avgDelta: sql<number>`round(avg(${agentRuns.weeklyDeltaPercent})::numeric, 2)::float8`,
    })
    .from(agentRuns)
    .where(isNotNull(agentRuns.outputTokens))
    .groupBy(agentRuns.agent);
}

export { and, desc };
