import { PageHeader } from "@/components/page-header";
import { WarehouseSuppliesWorkspace } from "@/components/warehouse-supplies-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function SuppliesPage({ searchParams }: { searchParams: Promise<{ task?: string }> }) {
  await requirePagePermission("/warehouse/supplies", ["warehouse.supply", "warehouse.tasks"]);
  const params = await searchParams;
  const taskId = Number(params.task);
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Поставки"
        description="Один склад — одна поставка: QR, короба и акт приёма-передачи"
      />
      <WarehouseSuppliesWorkspace initialTaskId={Number.isFinite(taskId) && taskId > 0 ? Math.trunc(taskId) : null} />
    </main>
  );
}
