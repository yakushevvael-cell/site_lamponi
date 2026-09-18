import { PageHeader } from "@/components/page-header";
import { WarehouseScanWorkspace } from "@/components/warehouse-scan-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function ScanPage() {
  await requirePagePermission("/warehouse/scan", "warehouse.scan");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Сканирование и этикетки"
        description="Скан листа подбора открывает задание, скан УИН печатает этикетку"
      />
      {/* Задание берётся только из листа подбора: параметр в адресе больше
          ничего не выбирает — иначе стол легко открыть по чужой партии. */}
      <WarehouseScanWorkspace />
    </main>
  );
}
