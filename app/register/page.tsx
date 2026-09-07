import { redirect } from "next/navigation";

import { RegisterForm } from "@/components/auth-forms";
import { getAppUser, hasAnyUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  const user = await getAppUser();
  if (user) redirect(user.status === "active" ? "/" : "/access-pending");
  const firstUser = !(await hasAnyUser());
  return <RegisterForm firstUser={firstUser} />;
}
