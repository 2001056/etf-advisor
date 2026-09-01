import { NextRequest, NextResponse } from "next/server";
import { BusyError, getRunningRun, runWeeklyResearch } from "@/server/orchestrator";

/**
 * launchd 정기 조사 트리거 (기획서 §5.1, §10).
 * 세션 쿠키가 아니라 크론 전용 시크릿 헤더로 인증한다.
 * 실행은 몇 분 걸리므로 즉시 202를 돌려주고 백그라운드에서 진행한다.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET이 설정되지 않았습니다" },
      { status: 500 },
    );
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 이미 실행 중이면 409 — launchd 쪽 재시도가 자연스러운 재시도가 된다.
  // (경합으로 빠져나가더라도 DB partial unique index가 최종 방어선이다)
  if (await getRunningRun()) {
    return NextResponse.json({ error: "busy" }, { status: 409 });
  }

  runWeeklyResearch("schedule").catch((e) => {
    if (e instanceof BusyError) return;
    console.error("[cron] 정기 조사 실패", e);
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
