import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns } from "@/db/schema";
import { tailLog } from "@/server/codex";

/** 진행 상태 폴링 (기획서 §5.5-6) */
export async function GET() {
  const rows = await db
    .select()
    .from(agentRuns)
    .orderBy(desc(agentRuns.id))
    .limit(4);

  const running = rows.find((r) => r.status === "running") ?? null;
  const log = running?.logPath ? await tailLog(running.logPath, 25) : "";

  return NextResponse.json({
    running: running
      ? { id: running.id, agent: running.agent, startedAt: running.startedAt }
      : null,
    log,
    recent: rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      status: r.status,
      actionId: r.actionId,
      finishedAt: r.finishedAt,
    })),
  });
}
