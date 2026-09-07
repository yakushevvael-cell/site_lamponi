import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth-forms";
import { getAppUser, hasAnyUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await getAppUser();
  if (user) redirect(user.status === "active" ? "/" : "/access-pending");
  // Пустая система: первым делом заводим администратора, а не показываем вход.
  if (!(await hasAnyUser())) redirect("/register");

  const params = await searchParams;
  const next = params.next && params.next.startsWith("/") && !params.next.startsWith("//") ? params.next : "/";
  return <LoginForm next={next} />;
}
