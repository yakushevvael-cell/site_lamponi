import { DmdkWorkspace } from "@/components/dmdk-workspace";
import { PageHeader } from "@/components/page-header";
import { requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

/**
 * Страница ГИИС ДМДК доступна только владельцу.
 *
 * Здесь задаются реквизиты, по которым уходят спецификации: ошибка в
 * грузополучателе или контракте останавливает отгрузку целиком, а увидеть её
 * можно уже после того, как товар уехал.
 */
export default async function DmdkPage() {
  await requirePageUser("/dmdk", true);
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="ГИИС ДМДК" description="Реквизиты спецификаций по площадкам, подпись и справочники" />
      <DmdkWorkspace />
    </main>
  );
}
