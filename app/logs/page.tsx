import { PageHeader } from "@/components/page-header";
import { SyncLogWorkspace } from "@/components/sync-log-workspace";
import { requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
  await requirePageUser("/logs");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Журнал выгрузки"
        description="Что и на какой склад отправлено: ОСВ, резерв, расчёт, переданное значение и ответ API"
      />
      <SyncLogWorkspace />
    </main>
  );
}
