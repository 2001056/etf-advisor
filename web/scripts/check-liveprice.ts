/** 실시간 시세 조회 검증 — pnpm run check:live (네트워크 필요) */
import { getLivePrices, getRealtimePrices } from "../src/server/livePrice";

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
}

async function main() {
  console.log("=== 여러 종목 한 번에 ===");
  const t0 = Date.now();
  const m = await getLivePrices(["133690", "446720", "490600"]);
  const ms = Date.now() - t0;
  check("3종목 모두 조회", m.size === 3, `size=${m.size}, ${ms}ms`);
  for (const [t, v] of m) {
    console.log(`   ${t}  ${v.price.toLocaleString("ko-KR")}원  전일대비 ${v.change ?? "?"}  ${v.marketStatus}  ${v.tradedAt.toISOString()}`);
    check(`  ${t} 가격이 양수`, v.price > 0);
  }

  console.log("\n=== 캐시 동작 (두 번째는 네트워크 없이) ===");
  const t1 = Date.now();
  const m2 = await getLivePrices(["133690", "446720", "490600"]);
  const ms2 = Date.now() - t1;
  check("캐시 히트로 즉시 반환", ms2 < 30, `${ms2}ms`);
  check("값 동일", m2.get("133690")?.price === m.get("133690")?.price);

  console.log("\n=== 없는 종목코드는 그냥 빠진다 (예외 아님) ===");
  const m3 = await getLivePrices(["999999"]);
  check("빈 결과", m3.size === 0);

  console.log("\n=== 형식이 이상한 입력만 걸러낸다 (정상 1 + 이상 1) ===");
  const m4 = await getLivePrices(["069500", "abc!"]);
  check("정상 코드는 남는다", m4.has("069500"), `size=${m4.size}`);
  check("이상한 코드만 빠진다", m4.size === 1 && !m4.has("abc!"));

  console.log("\n=== 빈 배열 ===");
  const m5 = await getLivePrices([]);
  check("빈 결과", m5.size === 0);

  console.log("\n=== 실시간 전용 조회 (공식 API를 건너뛴다) ===");
  const r = await getRealtimePrices(["069500", "133690"]);
  check("2종목 조회", r.size === 2, `size=${r.size}`);
  for (const t of ["069500", "133690"]) {
    const v = r.get(t);
    console.log(
      `   ${t}  ${v?.price.toLocaleString("ko-KR") ?? "?"}원  ${v?.marketStatus ?? "?"}  기준 ${v?.pricedAt.toISOString() ?? "?"}`,
    );
    check(`  ${t} 가격이 양수`, (v?.price ?? 0) > 0);
    check(
      `  ${t} 기준 시각 존재`,
      v?.pricedAt instanceof Date && !Number.isNaN(v.pricedAt.getTime()),
    );
  }

  console.log("\n=== 실시간 조회도 형식 이상만 걸러낸다 (정상 1 + 이상 1) ===");
  const r2 = await getRealtimePrices(["133690", "12"]);
  check("정상 코드는 남는다", r2.has("133690"), `size=${r2.size}`);
  check("짧은 코드만 빠진다", r2.size === 1 && !r2.has("12"));
  check("빈 배열", (await getRealtimePrices([])).size === 0);

  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
