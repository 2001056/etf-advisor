import { NextRequest, NextResponse } from "next/server";
import { BusyError, getRunningRun, runWatch } from "@/server/orchestrator";

/** ④ 보유 점검 트리거 — launchd가 매일 13:00에 부른다 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET 없음" }, { status: 500 });
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (await getRunningRun()) {
    return NextResponse.json({ error: "busy" }, { status: 409 });
  }

  runWatch("schedule").catch((e) => {
    if (e instanceof BusyError) return;
    console.error("[cron] 보유 점검 실패", e);
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
