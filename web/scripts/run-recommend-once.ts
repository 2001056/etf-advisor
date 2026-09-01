/** 추천 흐름 수동 실행 (검증·비상용) — pnpm run recommend:once */
import { runRecommendFlow, tickersToResearch } from "../src/server/orchestrator";

async function main() {
  const tickers = await tickersToResearch();
  console.log(`재조사 대상 ${tickers.length}종목: ${tickers.join(", ")}`);
  const res = await runRecommendFlow();
  console.log("결과:", JSON.stringify(res));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
