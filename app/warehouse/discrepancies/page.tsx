import { PageHeader } from "@/components/page-header";
import { WarehouseDiscrepanciesWorkspace } from "@/components/warehouse-discrepancies-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function DiscrepanciesPage() {
  await requirePagePermission("/warehouse/discrepancies", ["warehouse.problems.release", "warehouse.reports"]);
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Расхождения"
        description="Где учёт 1С и склад разошлись: что заблокировано и сколько заказов сорвалось"
      />
      <WarehouseDiscrepanciesWorkspace />
    </main>
  );
}
