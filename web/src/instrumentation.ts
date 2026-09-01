/**
 * 서버 인스턴스가 뜰 때 한 번, 요청 처리 전에 실행된다.
 *
 * 실행 도중 서버가 끊기면 `agent_runs`에 `running` 행이 남는데,
 * partial unique index가 running을 1개로 강제하므로 그 행 하나가
 * 이후 모든 실행을 영구히 막는다. 시작할 때 정리해준다 (기획서 §5.5-7).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { reapOrphanRuns } = await import("@/server/orchestrator");
    await reapOrphanRuns();
  } catch (e) {
    // DB가 아직 안 떴을 수 있다 — 앱 기동 자체를 막지는 않는다
    console.error("[instrumentation] 고아 실행 정리 실패", e);
  }
}
