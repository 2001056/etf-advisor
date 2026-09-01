/**
 * 공식 시세 API 매핑 확정용 진단 — DATA_GO_KR_KEY를 넣은 뒤 한 번 돌린다.
 *   pnpm run check:official
 * 원본 응답의 필드명을 그대로 찍어주므로, officialQuote.ts의 mapItem 후보를 좁힐 수 있다.
 */
import { fetchOfficialRaw, getOfficialQuotes, hasOfficialKey } from "../src/server/officialQuote";

async function main() {
  if (!hasOfficialKey()) {
    console.log("DATA_GO_KR_KEY가 없습니다.");
    console.log("발급: https://www.data.go.kr/data/15094806/openapi.do (무료·자동승인)");
    console.log("발급 후 web/.env.local 에 DATA_GO_KR_KEY=... 를 넣고 다시 실행하세요.");
    process.exit(0);
  }

  console.log("=== 원본 응답 필드 확인 (133690) ===");
  const raw = (await fetchOfficialRaw({ likeSrtnCd: "133690" })) as Record<string, unknown>;
  const items = (raw as any)?.response?.body?.items?.item;
  const first = Array.isArray(items) ? items[0] : items;

  if (!first) {
    console.log("항목이 비었습니다. 전체 응답:");
    console.log(JSON.stringify(raw, null, 1).slice(0, 1500));
    process.exit(1);
  }

  console.log("사용 가능한 필드:");
  for (const [k, v] of Object.entries(first)) {
    console.log(`  ${k.padEnd(22)} = ${String(v).slice(0, 40)}`);
  }

  console.log("\n=== 매핑 결과 ===");
  const m = await getOfficialQuotes(["133690", "446720", "490600"]);
  if (m.size === 0) {
    console.log("  매핑 실패 — 위 필드명을 보고 officialQuote.ts의 mapItem을 고치세요.");
    process.exit(1);
  }
  let bad = 0;
  for (const [t, q] of m) {
    const prem = q.premium === null ? "?" : `${q.premium.toFixed(3)}%`;
    console.log(
      `  ${t} ${q.name}\n` +
        `     종가 ${q.price.toLocaleString("ko-KR")}  NAV ${q.nav?.toLocaleString("ko-KR") ?? "—"}  괴리율 ${prem}\n` +
        `     전일대비 ${q.change ?? "—"} (${q.changePct ?? "—"}%)  거래량 ${q.volume?.toLocaleString("ko-KR") ?? "—"}\n` +
        `     순자산 ${q.netAssetTotal ? (q.netAssetTotal / 1e12).toFixed(2) + "조원" : "—"}  기초지수 ${q.indexName || "—"}  기준일 ${q.baseDate}`,
    );
    if (q.nav === null) { bad++; console.log("     ⚠ NAV 없음"); }
    if (q.premium !== null && Math.abs(q.premium) > 5) {
      bad++; console.log("     ⚠ 괴리율이 비정상적으로 큽니다 — 계산 확인 필요");
    }
  }

  console.log("\n=== 항등식 자가검증 ===");
  const { checkPremiumIdentity } = await import("../src/domain/dataChecks");
  for (const [t, q] of m) {
    const issue = checkPremiumIdentity(t, q.price, q.nav, q.premium);
    console.log(`  ${t}: ${issue ? "불일치 — " + issue.message : "괴리율 = (종가−NAV)/NAV 일치"}`);
    if (issue) bad++;
  }

  console.log(`\n=== ${bad === 0 ? "이상 없음" : bad + "건 확인 필요"} ===`);
  process.exit(bad === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
