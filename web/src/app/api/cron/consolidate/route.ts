import { NextRequest, NextResponse } from "next/server";
import { BusyError, getRunningRun, runConsolidate } from "@/server/orchestrator";

/** ⑤ 종목 정리 검토 트리거 — 매월 1일 13:30 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET 없음" }, { status: 500 });
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (await getRunningRun()) {
    return NextResponse.json({ error: "busy" }, { status: 409 });
  }
  runConsolidate("schedule").catch((e) => {
    if (e instanceof BusyError) return;
    console.error("[cron] 종목 정리 검토 실패", e);
  });
  return NextResponse.json({ ok: true }, { status: 202 });
}
