/** 추천 흐름 수동 실행 (검증·비상용) — pnpm run recommend:once */
import { runRecommendFlow, tickersToResearch } from "../src/server/orchestrator";

async function main() {
  const tickers = await tickersToResearch();
  console.log(`재조사 대상 ${tickers.length}종목: ${tickers.join(", ")}`);
  // 수동 실행은 장마감 가드를 일부러 넘긴다
  const flow = runRecommendFlow({ force: true });
  if ("blocked" in flow) {
    console.error(flow.blocked);
    process.exit(1);
  }
  console.log("결과:", JSON.stringify(await flow.started));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
