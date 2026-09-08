import { redirect } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { UsersWorkspace } from "@/components/users-workspace";
import { hasManagerAccess, requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  // Управление пользователями открыто полному доступу — так же, как это
  // обещает пункт меню и описание уровня прав внутри страницы.
  const user = await requirePageUser("/users");
  if (!hasManagerAccess(user)) redirect("/");
  return <main className="min-h-svh bg-background"><PageHeader title="Пользователи" description="Заявки на регистрацию и доступ к сервису" /><UsersWorkspace /></main>;
}
