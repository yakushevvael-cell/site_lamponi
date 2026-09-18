import { PageHeader } from "@/components/page-header";
import { WarehouseSuppliesWorkspace } from "@/components/warehouse-supplies-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function SuppliesPage() {
  await requirePagePermission("/warehouse/supplies", ["warehouse.supply", "warehouse.tasks"]);
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Поставки"
        description="Скан листа подбора открывает задание: QR, короба и акт приёма-передачи"
      />
      {/* Задание выбирает только лист подбора — параметр в адресе убран. */}
      <WarehouseSuppliesWorkspace />
    </main>
  );
}
