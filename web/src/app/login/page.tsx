import { redirect } from "next/navigation";
import { isLoggedIn, isPasswordSet } from "@/lib/auth";
import LoginForm from "./form";

export default async function LoginPage() {
  if (!(await isPasswordSet())) redirect("/setup");
  if (await isLoggedIn()) redirect("/");
  return <LoginForm />;
}
