import { IntegrationsWorkspace } from "@/components/integrations-workspace";
import { PageHeader } from "@/components/page-header";
import { requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requirePageUser("/settings", true);
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Подключения" description="API-ключи, режим синхронизации и готовность площадок" />
      <IntegrationsWorkspace />
    </main>
  );
}
