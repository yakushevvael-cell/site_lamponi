import { OsvUploadWorkspace } from "@/components/osv-upload-workspace";
import { PageHeader } from "@/components/page-header";
import { requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function UploadPage() {
  await requirePageUser("/upload");
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
