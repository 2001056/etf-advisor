import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * codex 실행 1회의 토큰 사용량과 주간 한도 소진율.
 *
 * codex는 실행마다 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl 을 남기고,
 * 그 안에 토큰 사용량과 rate_limits가 들어 있다.
 * `--json`은 리다이렉트 환경에서 멈추는 경우가 있어 이 파일을 읽는 쪽이 안전하다.
 *
 * primary.window_minutes = 10080 (=7일)이 주간 한도 창이다.
 */

const SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

export type CodexUsage = {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  /** 주간 한도 소진율(%). codex가 정수로 반올림해서 준다 */
  weeklyUsedPercent: number | null;
  /** 한도 창 길이(분). 10080이면 주간 */
  windowMinutes: number | null;
  weeklyResetsAt: Date | null;
};

function dig(x: unknown, key: string): unknown {
  if (Array.isArray(x)) {
    for (const v of x) {
      const r = dig(v, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (key in o) return o[key];
    for (const v of Object.values(o)) {
      const r = dig(v, key);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 세션 파일 목록. 파일명이 `rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl` 형태라
 * 세션이 언제 시작됐는지 이름만으로 알 수 있다.
 */
type SessionFile = { path: string; startedAtMs: number; sizeBytes: number };

/** 우리 실행 하나가 만드는 세션은 수 MB 수준. 이보다 크면 남의 장기 세션이다. */
const MAX_SESSION_BYTES = 64 * 1024 * 1024;

function startFromName(name: string): number | null {
  const m = name.match(
    /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  // 파일명은 로컬 시각 기준으로 기록된다
  const t = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec),
  ).getTime();
  return Number.isFinite(t) ? t : null;
}

async function recentSessionFiles(): Promise<SessionFile[]> {
  const out: SessionFile[] = [];

  async function walk(dir: string, depth: number) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.name.endsWith(".jsonl")) {
        const startedAtMs = startFromName(e.name);
        if (startedAtMs === null) continue;
        try {
          const st = await stat(full);
          out.push({ path: full, startedAtMs, sizeBytes: st.size });
        } catch {
          // 무시
        }
      }
    }
  }

  await walk(SESSIONS_DIR, 0);
  return out.sort((a, b) => b.startedAtMs - a.startedAtMs);
}

async function parseSession(file: string): Promise<CodexUsage | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }

  let usage: Record<string, unknown> | null = null;
  let primary: Record<string, unknown> | null = null;

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const tu = dig(d, "total_token_usage");
    if (tu && typeof tu === "object") usage = tu as Record<string, unknown>;
    const rl = dig(d, "rate_limits");
    if (rl && typeof rl === "object") {
      const p = dig(rl, "primary");
      if (p && typeof p === "object") primary = p as Record<string, unknown>;
    }
  }

  if (!usage && !primary) return null;

  const resets = primary ? num(primary.resets_at) : null;
  return {
    totalTokens: usage ? num(usage.total_tokens) : null,
    inputTokens: usage ? num(usage.input_tokens) : null,
    outputTokens: usage ? num(usage.output_tokens) : null,
    cachedInputTokens: usage ? num(usage.cached_input_tokens) : null,
    weeklyUsedPercent: primary ? num(primary.used_percent) : null,
    windowMinutes: primary ? num(primary.window_minutes) : null,
    weeklyResetsAt: resets ? new Date(resets * 1000) : null,
  };
}

/**
 * 이 실행이 만든 세션의 사용량.
 *
 * "가장 최근 수정된 파일"로 고르면 안 된다 — 사용자가 터미널에서 따로 돌리는
 * codex 세션이 같은 시간에 갱신되면 남의 사용량을 우리 것으로 기록하게 된다.
 * 세션 시작 시각이 우리 실행 시작과 맞물리는 파일만 고른다.
 */
export async function usageSince(startedAtMs: number): Promise<CodexUsage | null> {
  const WINDOW_BEFORE = 10_000; // 실행 시작 직전에 세션이 열릴 수 있다
  const WINDOW_AFTER = 180_000; // 프로세스 기동이 늦어지는 경우까지

  const candidates = (await recentSessionFiles()).filter(
    (f) =>
      f.startedAtMs >= startedAtMs - WINDOW_BEFORE &&
      f.startedAtMs <= startedAtMs + WINDOW_AFTER &&
      f.sizeBytes <= MAX_SESSION_BYTES,
  );

  // 시작 시각이 가장 가까운 것부터
  candidates.sort(
    (a, b) =>
      Math.abs(a.startedAtMs - startedAtMs) - Math.abs(b.startedAtMs - startedAtMs),
  );

  for (const c of candidates) {
    const u = await parseSession(c.path);
    if (u) return u;
  }
  return null;
}

/**
 * 지금 기준 주간 한도 소진율.
 * 이 값은 계정 전체 기준이라 어느 세션에서 읽어도 같다 — 읽기 싼 파일부터 본다.
 */
export async function currentWeeklyUsage(): Promise<CodexUsage | null> {
  const files = (await recentSessionFiles())
    .filter((f) => f.sizeBytes <= MAX_SESSION_BYTES)
    .slice(0, 8);

  for (const f of files) {
    const u = await parseSession(f.path);
    if (u?.weeklyUsedPercent != null) return u;
  }
  return null;
}
