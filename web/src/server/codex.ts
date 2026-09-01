import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { AGENT_WRAPPER, LOG_DIR, TMP_DIR } from "./paths";

/**
 * 에이전트가 쓸 모델·성능 설정 (실측 2026-08-27, ~/.codex/models_cache.json 기준).
 *
 * - gpt-5.6-sol: "Latest frontier agentic coding model" — 카탈로그상 priority 1의 최상위 모델.
 *   (gpt-5.6-pro는 ChatGPT 계정으로 호출 불가 — 400 오류)
 * - service_tier "priority": 카탈로그에 이름이 그대로 "Fast", 설명은 "1.5x speed, increased usage"
 * - 추론 강도 사다리: low < medium < high < xhigh < max < ultra
 *
 * 전역 ~/.codex/config.toml을 물려받지 않고 여기서 못박는다 —
 * 다른 작업 때문에 전역 설정을 바꿔도 조사 품질이 조용히 흔들리면 안 되기 때문.
 */
export const CODEX_MODEL = process.env.CODEX_MODEL ?? "gpt-5.6-sol";
export const CODEX_EFFORT = process.env.CODEX_EFFORT ?? "xhigh";
export const CODEX_SERVICE_TIER = process.env.CODEX_SERVICE_TIER ?? "priority";

/**
 * 하드 타임아웃. 조사 프롬프트가 종목당 10여 개 항목을 웹에서 확인하므로
 * 종목이 많으면 15분으로는 부족하다. 타임아웃은 그때까지의 작업을 통째로 버리므로
 * 넉넉하게 두고, 필요하면 AGENT_TIMEOUT_MIN으로 조정한다.
 */
export const HARD_TIMEOUT_MS =
  (Number(process.env.AGENT_TIMEOUT_MIN) || 30) * 60 * 1000;

export type CodexResult = {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** -o로 받은 마지막 메시지 본문 */
  output: string;
  logPath: string;
};

/**
 * codex 인증 프리플라이트 (기획서 §5.5-3).
 * OAuth 만료가 가장 흔한 장애라 일반 실패와 구분해 기록한다.
 */
export function checkCodexAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(AGENT_WRAPPER, ["codex", "login", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && /Logged in/i.test(out));
    });
  });
}

/**
 * codex exec 헤드리스 실행 (기획서 §5).
 * 웹 검색은 `-c tools.web_search=true`로 켠다 — M0에서 실동작 확인됨.
 */
export async function runCodex(opts: {
  runId: number;
  prompt: string;
  /** JSON 응답을 강제할 스키마 (③ 추천에서 사용) */
  outputSchema?: unknown;
  signal?: AbortSignal;
}): Promise<CodexResult> {
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(TMP_DIR, { recursive: true });

  const logPath = path.join(LOG_DIR, `run-${opts.runId}.log`);
  const outPath = path.join(TMP_DIR, `run-${opts.runId}.out`);
  const schemaPath = path.join(TMP_DIR, `run-${opts.runId}.schema.json`);

  const args = [
    "codex",
    "exec",
    "--skip-git-repo-check",
    "-m",
    CODEX_MODEL,
    "-c",
    `model_reasoning_effort="${CODEX_EFFORT}"`,
    "-c",
    `service_tier="${CODEX_SERVICE_TIER}"`,
    "-c",
    "tools.web_search=true",
    "-o",
    outPath,
  ];

  if (opts.outputSchema) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(schemaPath, JSON.stringify(opts.outputSchema, null, 2));
    args.push("--output-schema", schemaPath);
  }

  args.push(opts.prompt);

  const log = createWriteStream(logPath, { flags: "a" });
  log.write(
    `\n=== run ${opts.runId} 시작 ${new Date().toISOString()} ` +
      `| ${CODEX_MODEL} effort=${CODEX_EFFORT} tier=${CODEX_SERVICE_TIER} ===\n`,
  );

  const result = await new Promise<Omit<CodexResult, "output" | "logPath">>(
    (resolve) => {
      const child = spawn(AGENT_WRAPPER, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, HARD_TIMEOUT_MS);

      const onAbort = () => {
        timedOut = true;
        child.kill("SIGKILL");
      };
      opts.signal?.addEventListener("abort", onAbort);

      child.stdout.on("data", (d) => log.write(d));
      child.stderr.on("data", (d) => log.write(d));

      child.on("error", (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        log.write(`\n[spawn error] ${String(err)}\n`);
        log.end(); // 이걸 빼면 spawn 실패마다 파일 디스크립터가 샌다
        resolve({ ok: false, exitCode: null, timedOut });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        log.write(`\n=== 종료 code=${code} timedOut=${timedOut} ===\n`);
        log.end();
        resolve({ ok: code === 0 && !timedOut, exitCode: code, timedOut });
      });
    },
  );

  let output = "";
  try {
    output = await readFile(outPath, "utf8");
  } catch {
    // 출력 파일이 없으면 실패로 간주 (아래에서 ok와 함께 판단)
  }

  await rm(outPath, { force: true }).catch(() => {});
  await rm(schemaPath, { force: true }).catch(() => {});

  return { ...result, output, logPath };
}

/** 실패 시 UI에 보여줄 로그 꼬리 */
export async function tailLog(logPath: string, lines = 40): Promise<string> {
  try {
    const content = await readFile(logPath, "utf8");
    return content.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}
