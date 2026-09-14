import { PageHeader } from "@/components/page-header";
import { WarehouseTasksWorkspace } from "@/components/warehouse-tasks-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function WarehousePage() {
  await requirePagePermission("/warehouse", "warehouse.tasks");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Сборка и задания"
        description="Заказы приходят по таймеру из WB и Ozon — в кабинет продавца заходить не нужно"
      />
      <WarehouseTasksWorkspace />
    </main>
  );
}
