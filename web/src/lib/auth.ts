import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { db } from "@/db";
import { settings } from "@/db/schema";

const PW_KEY = "password_hash";
export const SESSION_COOKIE = "etf_session";
const SESSION_DAYS = 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET이 설정되지 않았습니다 (.env.local)");
  return new TextEncoder().encode(s);
}

export async function isPasswordSet(): Promise<boolean> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, PW_KEY))
    .limit(1);
  return rows.length > 0;
}

export async function setPassword(plain: string): Promise<void> {
  if (plain.length < 8) throw new Error("비밀번호는 8자 이상이어야 합니다");
  const digest = await hash(plain);
  await db
    .insert(settings)
    .values({ key: PW_KEY, value: { hash: digest } })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: { hash: digest }, updatedAt: new Date() },
    });
}

export async function verifyPassword(plain: string): Promise<boolean> {
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, PW_KEY))
    .limit(1);
  if (!rows.length) return false;
  const { hash: digest } = rows[0].value as { hash: string };
  try {
    return await verify(digest, plain);
  } catch {
    return false;
  }
}

export async function createSession(): Promise<void> {
  const token = await new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // 로컬/사설망 전제라 HTTPS가 없다 — Secure를 켜면 쿠키가 저장되지 않는다 (기획서 §9)
    secure: false,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    await jwtVerify(token, secret());
    return true;
  } catch {
    return false;
  }
}

export async function isLoggedIn(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? verifySessionToken(token) : false;
}

/** 로그인 후에만 실행돼야 하는 서버 액션의 최상단 가드. */
export async function requireSession(): Promise<void> {
  if (!(await isLoggedIn())) {
    // 렌더 시점 게이팅은 보안 경계가 아니다 — 액션 안에서 직접 확인한다.
    throw new Error("로그인이 필요합니다");
  }
}

/**
 * 로그인 시도 제한 (§9) — 상주 단일 프로세스라 메모리로 충분.
 * 전역 카운터로 두면 같은 망의 누군가가 5번 틀려 주인을 계속 잠글 수 있어 출발지별로 센다.
 */
const attemptsByKey = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

function prune(key: string): number[] {
  const now = Date.now();
  const list = (attemptsByKey.get(key) ?? []).filter((t) => now - t <= WINDOW_MS);
  if (list.length) attemptsByKey.set(key, list);
  else attemptsByKey.delete(key);
  return list;
}

export function tooManyAttempts(key = "unknown"): boolean {
  return prune(key).length >= MAX_PER_WINDOW;
}

export function recordFailedAttempt(key = "unknown"): void {
  const list = prune(key);
  list.push(Date.now());
  attemptsByKey.set(key, list);
  console.warn(`[auth] 로그인 실패 (${key}) ${new Date().toISOString()}`);
}
