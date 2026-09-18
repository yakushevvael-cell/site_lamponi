/**
 * Справочники ГИИС ДМДК для выпадающих списков в настройках.
 *
 * Значения должны приходить из самой ГИИС, иначе реквизиты спецификации не
 * совпадут с системой. Но каждый запрос к сервису интеграции подписывается
 * УКЭП, а подпись живёт в отдельном модуле с сертификатом организации: пока
 * его нет, обновить справочники нечем. В этом случае страница настроек
 * остаётся рабочей — идентификаторы можно ввести вручную из личного кабинета,
 * а когда сертификат появится, списки заполнятся сами.
 */
import { authorizeApi } from "@/lib/app-auth";
import { loadDictionaries, loadGeneralSettings } from "@/lib/dmdk";

export const dynamic = "force-dynamic";

/** Чего не хватает, чтобы вообще обратиться к сервису интеграции. */
function blockers(general: Awaited<ReturnType<typeof loadGeneralSettings>>) {
  const missing: string[] = [];
  if (!general.serviceUrl) missing.push("адрес сервиса интеграции");
  if (!general.ogrn) missing.push("ОГРН организации");
  if (!general.signerUrl) missing.push("адрес подписного модуля");
  if (!general.signingEnabled) missing.push("подписание включено");
  return missing;
}

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const [general, dictionaries] = await Promise.all([loadGeneralSettings(), loadDictionaries()]);
  return Response.json({ dictionaries, blockers: blockers(general) });
}

export async function POST() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;

  const general = await loadGeneralSettings();
  const missing = blockers(general);
  if (missing.length) {
    return Response.json(
      {
        error: `Справочники не обновить: не настроено — ${missing.join(", ")}.`,
        hint: "До подключения подписи реквизиты можно ввести вручную: их учётные номера видно в личном кабинете ГИИС.",
        blockers: missing,
      },
      { status: 503 },
    );
  }

  // Подписной модуль настроен, но сам обмен с сервисом интеграции включается
  // следующим этапом — вместе с проверкой УИН при сканировании.
  return Response.json(
    {
      error: "Обмен с сервисом интеграции ещё не включён.",
      hint: "Подпись настроена. Загрузка справочников подключается вместе с проверкой УИН на этапе «только чтение».",
      blockers: [],
    },
    { status: 503 },
  );
}
