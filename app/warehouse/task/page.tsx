import { PageHeader } from "@/components/page-header";
import { WarehouseTaskView } from "@/components/warehouse-task-view";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function TaskPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  await requirePagePermission("/warehouse", ["warehouse.tasks", "warehouse.pick"]);
  const params = await searchParams;
  const taskId = Number(params.id);
  if (!Number.isFinite(taskId) || taskId <= 0) {
    return (
      <main className="min-h-svh bg-background">
        <PageHeader title="Задание" description="Не указан номер задания" />
        <p className="p-6 text-sm text-muted-foreground">Откройте задание из списка.</p>
      </main>
    );
  }
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Задание на сборку" description="Маршрут по ячейкам, отметки «собрано» и «не найден»" />
      <WarehouseTaskView taskId={Math.trunc(taskId)} />
    </main>
  );
}
