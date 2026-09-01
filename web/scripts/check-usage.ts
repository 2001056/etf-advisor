/** 사용량 수집 검증 — pnpm run check:usage (codex 세션 기록 필요) */
import { currentWeeklyUsage, usageSince } from "../src/server/usage";

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
}

async function main() {
  console.log("=== 현재 주간 한도 ===");
  const t0 = Date.now();
  const cur = await currentWeeklyUsage();
  const ms = Date.now() - t0;
  check("사용률 읽힘", cur?.weeklyUsedPercent != null, `${cur?.weeklyUsedPercent}% (${ms}ms)`);
  check("주간 창(10080분)", cur?.windowMinutes === 10080, String(cur?.windowMinutes));
  check("느리지 않음(3초 이내)", ms < 3000, `${ms}ms`);
  if (cur?.weeklyResetsAt) {
    console.log("   재설정:", cur.weeklyResetsAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }));
  }

  console.log("\n=== 실행 매칭: 아주 먼 과거는 매칭되면 안 됨 ===");
  const bogus = await usageSince(Date.now() + 86_400_000); // 내일
  check("미래 시각엔 매칭 없음", bogus === null);

  console.log("\n=== 실행 매칭: 세션 파일 시작 시각으로 특정 ===");
  // 실제 세션 파일 하나를 골라 그 시작 시각으로 조회하면 그 세션이 나와야 한다
  const { readdir, stat } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const base = path.join(os.homedir(), ".codex", "sessions");

  async function findOne(dir: string, depth = 0): Promise<string | null> {
    if (depth > 4) return null;
    let es;
    try { es = await readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of es.sort((a, b) => (a.name < b.name ? 1 : -1))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        const r = await findOne(full, depth + 1);
        if (r) return r;
      } else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        const st = await stat(full);
        if (st.size < 64 * 1024 * 1024) return e.name;
      }
    }
    return null;
  }

  const name = await findOne(base);
  if (!name) {
    console.log("   (세션 파일 없음 — 건너뜀)");
  } else {
    const m = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/)!;
    const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    const hit = await usageSince(t);
    check("해당 세션이 매칭됨", hit !== null, name.slice(0, 34));
    if (hit) {
      console.log(`   토큰 ${hit.totalTokens?.toLocaleString("ko-KR")} / 출력 ${hit.outputTokens?.toLocaleString("ko-KR")}`);
      check("남의 장기 세션(1억 토큰 이상)을 잡지 않음", (hit.totalTokens ?? 0) < 100_000_000);
    }
    // 그 시각에서 한참 벗어나면 매칭되면 안 된다
    const far = await usageSince(t - 3 * 3600_000);
    check("3시간 어긋난 시각엔 안 잡힘", far === null || far.totalTokens !== hit?.totalTokens);
  }

  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
