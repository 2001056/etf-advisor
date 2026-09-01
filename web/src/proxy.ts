import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "etf_session";
// /api/cron/*은 세션 대신 크론 전용 시크릿 헤더로 인증한다 (기획서 §5.1)
const PUBLIC_PATHS = ["/login", "/setup", "/api/cron"];

// 모든 페이지·API를 로그인 뒤에 둔다 (기획서 §9).
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await jwtVerify(
        token,
        new TextEncoder().encode(process.env.SESSION_SECRET),
      );
      return NextResponse.next();
    } catch {
      // 만료·위조 → 로그인으로
    }
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
