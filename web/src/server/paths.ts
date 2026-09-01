import path from "node:path";
import os from "node:os";

/** 프로젝트 루트 (web/의 부모). launchd로 띄워도 cwd에 의존하지 않도록 고정 해석. */
export const PROJECT_ROOT =
  process.env.ETF_ADVISOR_ROOT ??
  path.join(os.homedir(), "Projects", "etf-advisor");

export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const RESEARCH_DIR = path.join(DATA_DIR, "research");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const TMP_DIR = path.join(DATA_DIR, "tmp");

/** launchd 환경에서도 codex를 찾게 해주는 래퍼 (기획서 §10) */
export const AGENT_WRAPPER = path.join(PROJECT_ROOT, "scripts", "run-agent.sh");

export function researchPath(dateKey: string, type: string, runId: number) {
  const [y, m] = dateKey.split("-");
  return path.join(
    RESEARCH_DIR,
    y,
    m,
    `${dateKey}_${type}_${runId}.md`,
  );
}
