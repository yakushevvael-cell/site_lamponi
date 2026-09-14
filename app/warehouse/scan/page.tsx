import { PageHeader } from "@/components/page-header";
import { WarehouseScanWorkspace } from "@/components/warehouse-scan-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function ScanPage({ searchParams }: { searchParams: Promise<{ task?: string }> }) {
  await requirePagePermission("/warehouse/scan", "warehouse.scan");
  const params = await searchParams;
  const taskId = Number(params.task);
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Сканирование и этикетки"
        description="Скан УИН — печать этикетки. Wildberries и Ozon в одном окне"
      />
      <WarehouseScanWorkspace initialTaskId={Number.isFinite(taskId) && taskId > 0 ? Math.trunc(taskId) : null} />
    </main>
  );
}
