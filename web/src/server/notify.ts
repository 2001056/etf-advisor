import { spawn } from "node:child_process";

/**
 * 실패 알림 (기획서 §3 후순위 항목, 결정 7).
 * 맥 알림 센터로 띄운다 — 외부 서비스 의존이 없고 1인용에 충분하다.
 * 대시보드 표시가 1차 수단이고 이건 보조다. 실패해도 본 흐름을 막지 않는다.
 */
export async function notify(title: string, message: string): Promise<void> {
  try {
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(
      `ETF 매입 도우미 — ${title}`,
    )}`;
    await new Promise<void>((resolve) => {
      const child = spawn("/usr/bin/osascript", ["-e", script], {
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5_000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  } catch {
    // 알림 실패는 무시 — 대시보드가 1차 수단
  }
  console.warn(`[notify] ${title}: ${message}`);
}
