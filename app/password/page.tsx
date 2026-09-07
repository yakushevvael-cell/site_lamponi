import { redirect } from "next/navigation";

import { ChangePasswordForm } from "@/components/auth-forms";
import { getAppUser } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { loginPath } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function PasswordPage() {
  const user = await getAppUser();
  if (!user) redirect(loginPath("/password"));

  const runtime = getRuntimeEnv();
  const row = await runtime.DB?.prepare("SELECT must_change_password AS mustChange FROM app_users WHERE email = ?")
    .bind(user.email)
    .first<{ mustChange: number }>();

  return <ChangePasswordForm forced={Boolean(row?.mustChange)} />;
}
