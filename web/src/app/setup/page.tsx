import { redirect } from "next/navigation";
import { isPasswordSet } from "@/lib/auth";
import SetupForm from "./form";

// 이게 없으면 빌드 시점의 DB 상태로 리다이렉트가 정적으로 구워져,
// 비밀번호를 지운 뒤에는 /login ↔ /setup 무한 루프에 빠진다.
export const dynamic = "force-dynamic";

export default async function SetupPage() {
  if (await isPasswordSet()) redirect("/login");
  return <SetupForm />;
}
