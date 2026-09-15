import { NextRequest, NextResponse } from "next/server";
import { runLazyTopup } from "@/domain/ledger";
import { snapshotPrices } from "@/domain/prices";
import { getHoldings } from "@/domain/purchases";

/**
 * 가격 이력 적재 + 월 충전 트리거 — launchd가 장 마감 후 매일 16:00에 부른다.
 * codex를 부르지 않으므로 실행 잠금과 무관하고 agent_runs에도 남기지 않는다.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET 없음" }, { status: 500 });
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 한쪽이 실패해도 다른 쪽은 진행한다
  let pricedRows: number | null = null;
  let priceError: string | null = null;
  try {
    const holdings = await getHoldings();
    pricedRows = await snapshotPrices(holdings.map((h) => h.ticker));
  } catch (e) {
    priceError = e instanceof Error ? e.message : String(e);
    console.error("[cron] 가격 적재 실패", e);
  }

  let topupRows: number | null = null;
  let topupError: string | null = null;
  try {
    topupRows = await runLazyTopup();
  } catch (e) {
    topupError = e instanceof Error ? e.message : String(e);
    console.error("[cron] 월 충전 실패", e);
  }

  const ok = priceError === null && topupError === null;
  return NextResponse.json(
    { ok, pricedRows, priceError, topupRows, topupError },
    { status: ok ? 200 : 500 },
  );
}
