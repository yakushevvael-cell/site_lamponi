import { OsvUploadWorkspace } from "@/components/osv-upload-workspace";
import { PageHeader } from "@/components/page-header";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  await requirePagePermission("/upload", "warehouse.osv");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Загрузка ОСВ"
        description="Обновление физического остатка производственного склада"
      />
      <OsvUploadWorkspace />
    </main>
  );
}
