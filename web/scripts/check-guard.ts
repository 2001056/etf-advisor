/**
 * 검증 스크립트 공용 가드 검증 — pnpm run check:guard
 *
 * 실DB에 붙지 않는다. 행 수를 가짜로 넣어 exit 2 경로와 통과 경로를 둘 다 밟는다.
 */
import { GUARD_EXIT_CODE, guardAgainstRealData, guardMessage } from "./lib/guard";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) {
    console.log(
      `      기대=${JSON.stringify(expected)}\n      실제=${JSON.stringify(actual)}`,
    );
  }
}

/** 가짜 행 수로 가드를 돌리고 (종료코드, 사용자에게 보인 메시지)를 돌려준다 */
async function run(rows: number, allowWipe?: string) {
  const exits: number[] = [];
  const messages: string[] = [];
  await guardAgainstRealData({
    countRows: async () => rows,
    allowWipe,
    exit: (c) => exits.push(c),
    onMessage: (m) => messages.push(m),
  });
  return { exits, messages };
}

async function main() {
  console.log("=== 데이터가 있으면 막는다 ===");
  const blocked = await run(1);
  check("종료코드 2", blocked.exits, [GUARD_EXIT_CODE]);
  check("메시지 1건", blocked.messages.length, 1);
  check(
    "  중단 사유를 말한다",
    blocked.messages[0]?.includes("테이블을 비우므로 중단합니다"),
    true,
  );
  check(
    "  검증용 DB로 실행하는 법을 알려준다",
    blocked.messages[0]?.includes("etf_advisor_test"),
    true,
  );
  check("많이 있어도 막는다", (await run(37)).exits, [GUARD_EXIT_CODE]);

  console.log("\n=== 빈 DB는 통과 ===");
  const empty = await run(0);
  check("종료하지 않는다", empty.exits, []);
  check("메시지도 없다", empty.messages, []);

  console.log("\n=== ALLOW_WIPE=1 이면 데이터가 있어도 통과 ===");
  const forced = await run(5, "1");
  check("종료하지 않는다", forced.exits, []);
  check("메시지도 없다", forced.messages, []);

  console.log("\n=== 대조군: ALLOW_WIPE 가 1이 아니면 막는다 ===");
  check('"0"은 허용이 아니다', (await run(5, "0")).exits, [GUARD_EXIT_CODE]);
  check('"true"도 허용이 아니다', (await run(5, "true")).exits, [GUARD_EXIT_CODE]);
  check('빈 문자열도 허용이 아니다', (await run(5, "")).exits, [GUARD_EXIT_CODE]);

  console.log("\n=== 대조군: 음수·0 행이면 ALLOW_WIPE 와 무관하게 통과 ===");
  check("행 0 + ALLOW_WIPE 없음", (await run(0)).exits, []);

  console.log("\n=== 메시지에 실행한 스크립트 이름이 들어간다 ===");
  check(
    "스크립트 경로 표기",
    guardMessage("scripts/check-accept.ts").includes(
      "pnpm exec tsx scripts/check-accept.ts",
    ),
    true,
  );

  console.log(`\n=== 결과: ${failed === 0 ? "전부 통과" : `${failed}건 실패`} ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
