import { PageHeader } from "@/components/page-header";
import { UsersWorkspace } from "@/components/users-workspace";
import { requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  await requirePageUser("/users", true);
  return <main className="min-h-svh bg-background"><PageHeader title="Пользователи" description="Заявки на регистрацию и доступ к сервису" /><UsersWorkspace /></main>;
}
