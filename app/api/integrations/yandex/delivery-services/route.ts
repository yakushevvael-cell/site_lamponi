/**
 * Справочник служб доставки Маркета.
 *
 * Нужен ровно для одного поля в форме подключения: код службы, которым Маркет
 * помечает трек-номер заказа. Искать его вручную негде, поэтому список
 * приходит из самого Маркета, а службы Яндекса показываются первыми.
 */
import { getMarketplaceCredentials } from "@/lib/credentials";
import { authorizeApi } from "@/lib/app-auth";
import { getRuntimeEnv } from "@/lib/runtime-env";
import { getYandexDeliveryServices, YandexApiError } from "@/lib/yandex";

export async function GET() {
  const auth = await authorizeApi(true);
  if ("response" in auth) return auth.response;
  const runtime = getRuntimeEnv();
  if (!runtime.DB) return Response.json({ error: "База данных недоступна." }, { status: 500 });

  const credentials = await getMarketplaceCredentials(runtime.DB, runtime, "yandex");
  if (!credentials.YANDEX_API_KEY) {
    return Response.json({ error: "Сначала сохраните Api-Key Яндекс Маркета." }, { status: 400 });
  }

  try {
    const services = await getYandexDeliveryServices(credentials.YANDEX_API_KEY);
    const yandexOwn = services.filter((service) => /яндекс|yandex/i.test(service.name));
    return Response.json({
      ok: true,
      // Служб в справочнике сотни; на экране нужны только свои.
      suggested: yandexOwn,
      count: services.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Справочник служб доставки недоступен.";
    const status = error instanceof YandexApiError && error.status < 500 ? error.status : 502;
    return Response.json({ error: message }, { status });
  }
}
